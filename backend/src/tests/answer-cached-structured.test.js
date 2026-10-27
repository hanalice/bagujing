/**
 * S10：cached_answer 命中且库内为三字段 JSON 时响应顶层带回 summary/keyPoints/nextStep。
 * 用例 ID 对齐 docs/test_cases.md §2.35。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  invokeRoute,
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

/** 断言响应 data 无可用顶层三字段（禁止空串/[] 冒充）。 */
function assertNoTopLevelStructured(data) {
  assert.ok(data.summary === undefined || data.summary === null);
  assert.ok(data.keyPoints === undefined || data.keyPoints === null);
  assert.ok(data.nextStep === undefined || data.nextStep === null);
}

/**
 * 轮询审计 NDJSON，直到出现匹配 predicate 的行（Guard appendFile 异步，需防前序用例迟写）。
 * @param {(row: object) => boolean} predicate
 * @param {number} [timeoutMs]
 */
async function waitForAuditMatching(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = fs.existsSync(TEST_AUDIT_PATH) ? fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim() : '';
    const lines = raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
    const hit = [...lines].reverse().find(predicate);
    if (hit) return hit;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`审计日志在 ${timeoutMs}ms 内未出现匹配行`);
}

/** 安装可切换 content 的 OpenAI 兼容 fetch stub，阻断外网。 */
function installFlexibleGenerateFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  getGenerateContent = () => JSON.stringify({
    summary: '结论',
    keyPoints: ['a'],
    nextStep: '下一步',
  });

  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    modelCalls.push(request);
    if (request.stream) {
      const events = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-s10',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-s10',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const body = new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    return new Response(JSON.stringify({
      id: 'chatcmpl-s10',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: getGenerateContent() },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('S10: cached_answer 三字段顶层回传（单元）', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installFlexibleGenerateFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    // 等待前序 finalize 的异步 append 落盘后再截断，降低串扰
    await new Promise((resolve) => setTimeout(resolve, 40));
    try { fs.writeFileSync(TEST_AUDIT_PATH, ''); } catch { /* ignore */ }
    getGenerateContent = () => JSON.stringify({
      summary: '结论',
      keyPoints: ['a'],
      nextStep: '下一步',
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

  it('UT-CACHE-STRUCT-01: 库内合法三字段 JSON：缓存命中顶层带回三字段且 cached===true', async () => {
    const stored = '{"summary":"缓存结论","keyPoints":["k1","k2"],"nextStep":"去复盘"}';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: stored,
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(json.data.summary, '缓存结论');
    assert.deepEqual(json.data.keyPoints, ['k1', 'k2']);
    assert.equal(json.data.nextStep, '去复盘');
    assert.equal(json.data.answer, stored);
    assert.equal(modelCalls.length, 0);

    const audit = await waitForAuditMatching(
      (row) => row.reason === 'cached_answer' && row.upstreamReached === false,
    );
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('UT-CACHE-STRUCT-02: 旧 HTML 缓存命中：无顶层三字段、模型调用次数为 0', async () => {
    const legacyHtml = '<p>legacy-html-cache</p><ul><li>x</li></ul>';
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

    const audit = await waitForAuditMatching(
      (row) => row.reason === 'cached_answer' && row.upstreamReached === false,
    );
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('UT-CACHE-STRUCT-03: 截断/非法 JSON 缓存：与旧 HTML 同路径（只回 answer）', async () => {
    const badAnswers = [
      '{"summary":"断',
      '{"summary":"s","keyPoints":"不是数组","nextStep":"n"}',
      '{}',
    ];
    for (const answer of badAnswers) {
      modelCalls.length = 0;
      try { fs.writeFileSync(TEST_AUDIT_PATH, ''); } catch { /* ignore */ }
      await upsertProblemDetail(pool, {
        id: 42,
        group_id: 1,
        name: '缓存一致性设计',
        answer,
      });
      const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
      assert.equal(response.statusCode, 200);
      const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
      assert.equal(json.code, 0);
      assert.equal(json.data.cached, true);
      assert.equal(json.data.answer, answer);
      assertNoTopLevelStructured(json.data);
      assert.equal(modelCalls.length, 0);
      assert.notEqual(response.statusCode, 502);
      const row = await getProblemDetailById(pool, 42);
      assert.equal(row.answer, answer);
    }
  });

  it('UT-CACHE-STRUCT-04: markdown 围栏包裹的库内 JSON 亦可解析出顶层三字段', async () => {
    const fenced = '```json\n{"summary":"围栏S","keyPoints":["K"],"nextStep":"N"}\n```';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: fenced,
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, true);
    assert.equal(json.data.summary, '围栏S');
    assert.deepEqual(json.data.keyPoints, ['K']);
    assert.equal(json.data.nextStep, 'N');
    assert.equal(modelCalls.length, 0);
  });

  it('UT-CACHE-STRUCT-05: 顶层字段与未缓存成功路径对齐（键名/形状）', async () => {
    const sameJson = '{"summary":"对齐S","keyPoints":["p1"],"nextStep":"对齐N"}';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: sameJson,
    });

    const cachedRes = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    const cachedJson = cachedRes.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(cachedJson.data.cached, true);

    getGenerateContent = () => sameJson;
    modelCalls.length = 0;
    try { fs.writeFileSync(TEST_AUDIT_PATH, ''); } catch { /* ignore */ }
    const forceRes = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    const forceJson = forceRes.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(forceJson.data.cached, false);
    assert.ok(modelCalls.filter((c) => !c.stream).length >= 1);

    for (const data of [cachedJson.data, forceJson.data]) {
      assert.equal(typeof data.summary, 'string');
      assert.ok(Array.isArray(data.keyPoints));
      assert.equal(typeof data.nextStep, 'string');
      assert.equal(typeof data.answer, 'string');
      assert.equal(typeof data.cached, 'boolean');
    }
    assert.equal(cachedJson.data.summary, forceJson.data.summary);
    assert.deepEqual(cachedJson.data.keyPoints, forceJson.data.keyPoints);
    assert.equal(cachedJson.data.nextStep, forceJson.data.nextStep);
  });

  it('UT-CACHE-STRUCT-06: 缓存命中不得写库改写 answer（不做批量翻写）', async () => {
    const stored = '{"summary":"不改写","keyPoints":["k"],"nextStep":"n"}';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: stored,
    });
    const before = await getProblemDetailById(pool, 42);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, true);
    assert.equal(modelCalls.length, 0);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, before.answer);
  });

  it('UT-CACHE-STRUCT-07: 不做：force 重生成路径不被本项改写为缓存', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: '{"summary":"旧缓存","keyPoints":["old"],"nextStep":"old-n"}',
    });
    getGenerateContent = () => JSON.stringify({
      summary: 'force-new',
      keyPoints: ['n'],
      nextStep: 'x',
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.ok(modelCalls.filter((c) => !c.stream).length >= 1);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, 'force-new');
  });

  it('UT-CACHE-STRUCT-08: 不做：upstreamReached:false 配额语义保持（与 A7 合取）', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: '{"summary":"缓存结论","keyPoints":["k1"],"nextStep":"去复盘"}',
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, true);
    assert.equal(modelCalls.length, 0);
    const audit = await waitForAuditMatching(
      (row) => row.reason === 'cached_answer' && row.upstreamReached === false,
    );
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('UT-CACHE-STRUCT-09: 不做：不测前端 normalizeStructuredAnswer 优先级', () => {
    // 本表仅锁后端 generate 缓存响应 JSON 形状；前端由 §4.3 / §4.1 覆盖
    assert.ok(true);
  });

  it('UT-CACHE-STRUCT-10: residual：存量 HTML 无顶层三字段可接受', async () => {
    const legacyHtml = '<p>legacy-html-cache</p><ul><li>x</li></ul>';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: legacyHtml,
    });
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, legacyHtml);
    assertNoTopLevelStructured(json.data);
  });
});
