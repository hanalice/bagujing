/**
 * S10：cached_answer 三字段顶层回传集成（鉴权 → Guard → handler）。
 * 用例 ID 对齐 docs/test_cases.md §3.22。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  invokeRoute,
  makeTestToken,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { getProblemDetailById, upsertProblemDetail } from '../db/problem-detail-repo.js';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
let modelCalls;
/** @type {() => string} */
let getGenerateContent;

/** 断言响应 data 无可用顶层三字段。 */
function assertNoTopLevelStructured(data) {
  assert.ok(data.summary === undefined || data.summary === null);
  assert.ok(data.keyPoints === undefined || data.keyPoints === null);
  assert.ok(data.nextStep === undefined || data.nextStep === null);
}

/** 安装可切换 content 的 OpenAI 兼容 fetch stub。 */
function installFlexibleGenerateFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  getGenerateContent = () => JSON.stringify({
    summary: 'forced',
    keyPoints: ['n'],
    nextStep: 'x',
  });

  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    modelCalls.push(request);
    if (request.stream) {
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-s10-it',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: getGenerateContent() },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('S10: cached_answer 三字段顶层回传集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installFlexibleGenerateFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 40));
    try { fs.writeFileSync(TEST_AUDIT_PATH, ''); } catch { /* ignore */ }
    getGenerateContent = () => JSON.stringify({
      summary: 'forced',
      keyPoints: ['n'],
      nextStep: 'x',
    });
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    restoreTestEnv(savedEnv);
    if (pool) await pool.closeAll();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-CACHE-STRUCT-01: 库内三字段 JSON：缓存命中 HTTP 200 且顶层含三字段', async () => {
    const stored = '{"summary":"集成缓存","keyPoints":["a"],"nextStep":"下一步"}';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: stored,
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {}, {
      token: makeTestToken(['chat_ai', 'study']),
    });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(json.data.summary, '集成缓存');
    assert.deepEqual(json.data.keyPoints, ['a']);
    assert.equal(json.data.nextStep, '下一步');
    assert.equal(json.data.answer, stored);
    assert.equal(modelCalls.length, 0);

    const deadline = Date.now() + 3000;
    let audit;
    while (Date.now() < deadline) {
      const raw = fs.existsSync(TEST_AUDIT_PATH) ? fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim() : '';
      const lines = raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
      audit = [...lines].reverse().find(
        (row) => row.reason === 'cached_answer' && row.upstreamReached === false,
      );
      if (audit) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(audit, '须出现 cached_answer 且 upstreamReached:false 的审计行');
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('IT-CACHE-STRUCT-02: 库内旧 HTML：缓存命中无三字段、零次模型调用', async () => {
    const legacyHtml = '<p>IT-legacy</p>';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: legacyHtml,
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, legacyHtml);
    assertNoTopLevelStructured(json.data);
    assert.equal(modelCalls.length, 0);
    assert.notEqual(response.statusCode, 502);
  });

  it('IT-CACHE-STRUCT-03: 连续两次缓存命中均带回三字段且始终不调模型', async () => {
    const stored = '{"summary":"集成缓存","keyPoints":["a"],"nextStep":"下一步"}';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: stored,
    });

    for (let i = 0; i < 2; i += 1) {
      const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
      assert.equal(response.statusCode, 200);
      const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
      assert.equal(json.data.cached, true);
      assert.equal(json.data.summary, '集成缓存');
      assert.deepEqual(json.data.keyPoints, ['a']);
      assert.equal(json.data.nextStep, '下一步');
    }
    assert.equal(modelCalls.length, 0);
  });

  it('IT-CACHE-STRUCT-04: 对照：force:true 仍走生成且 cached===false（不做边界）', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: '{"summary":"集成缓存","keyPoints":["a"],"nextStep":"下一步"}',
    });
    getGenerateContent = () => JSON.stringify({
      summary: 'forced',
      keyPoints: ['n'],
      nextStep: 'x',
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.ok(modelCalls.filter((c) => !c.stream).length >= 1);
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, 'forced');
  });

  it('IT-CACHE-STRUCT-05: 解析失败缓存不得 502、不得污染库', async () => {
    const truncated = '{"summary":"坏';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: truncated,
    });
    const before = await getProblemDetailById(pool, 42);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, truncated);
    assertNoTopLevelStructured(json.data);
    assert.equal(modelCalls.length, 0);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, before.answer);
  });

  it('SEC-CACHE-STRUCT-01: 缓存 HTML 含 script 时早退不得当成功三字段，也不得执行路径升级写入', async () => {
    const dirty = '<script>alert(1)</script><p>x</p>';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: dirty,
    });
    const before = await getProblemDetailById(pool, 42);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, dirty);
    assertNoTopLevelStructured(json.data);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, before.answer);
  });

  it('IT-CACHE-STRUCT-06: residual / 不做：不要求批量翻写旧 HTML、不测前端优先级', () => {
    assert.ok(true);
  });
});
