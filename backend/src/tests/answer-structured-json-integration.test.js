import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  invokeRoute,
  readAuditLines,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { getProblemDetailById, upsertProblemAnswerById } from '../db/problem-detail-repo.js';
import { serializeStructuredAnswer } from '../answer-structured.js';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
let modelCalls;
/** @type {() => string} */
let nextContent;

const VALID_JSON = JSON.stringify({
  summary: '短结论',
  keyPoints: ['要点一', '要点二'],
  nextStep: '去练一道题',
});

// 安装可按用例切换 content 的非流式 OpenAI stub。
function installControllableFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  nextContent = () => VALID_JSON;
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    modelCalls.push(request);
    const content = nextContent();
    return new Response(JSON.stringify({
      id: 'chatcmpl-structured',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('C41 / P1-4: 解析 JSON 三字段生成 / 502 不入库集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installControllableFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    nextContent = () => VALID_JSON;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    // 清空题 42 缓存答案，避免跨用例污染
    await pool.withConnection((db) => db.run(
      `UPDATE problem_details SET answer_html = NULL WHERE id = 42`,
    ));
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

  it('IT-ANSWER-JSON-01: 合法 JSON：200 返回三字段并入库派生内容', async () => {
    const before = await getProblemDetailById(pool, 42);
    assert.equal(before?.answer == null || before.answer === '', true);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json?.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.id, 42);
    assert.equal(json.data.summary, '短结论');
    assert.equal(json.data.nextStep, '去练一道题');
    assert.deepEqual(json.data.keyPoints, ['要点一', '要点二']);

    const expectedStored = serializeStructuredAnswer({
      summary: '短结论',
      keyPoints: ['要点一', '要点二'],
      nextStep: '去练一道题',
    });
    assert.equal(json.data.answer, expectedStored);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, expectedStored);
    const roundTrip = JSON.parse(after.answer);
    assert.equal(roundTrip.summary, '短结论');
    assert.deepEqual(roundTrip.keyPoints, ['要点一', '要点二']);
    assert.equal(roundTrip.nextStep, '去练一道题');

    assert.equal(modelCalls.length, 1);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
    assert.equal(audit.upstreamReached, true);
  });

  it('IT-ANSWER-JSON-02: 模型吐整篇 HTML：502 且不入库', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: 'OLD-ANSWER-MARKER',
      keyPoints: [],
    });
    nextContent = () => '<p>结论</p><ul><li>点</li></ul>';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json?.code, 502);
    assert.notEqual(json?.code, 0);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, 'OLD-ANSWER-MARKER');
    assert.equal(after.answer.includes('<p>'), false);

    assert.equal(modelCalls.length, 1);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.equal(audit.reason, 'invalid_structured_answer');
    assert.notEqual(audit.reason, 'generated_answer');
  });

  it('IT-ANSWER-JSON-03: 缺字段 / keyPoints 非字符串数组：502 不入库', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: 'OLD-ANSWER-MARKER',
      keyPoints: [],
    });

    const payloads = [
      JSON.stringify({ summary: '结论', keyPoints: ['a'] }),
      JSON.stringify({ summary: '结论', keyPoints: {}, nextStep: '下一步' }),
      JSON.stringify({ summary: '', keyPoints: ['a'], nextStep: '下一步' }),
    ];

    for (const content of payloads) {
      modelCalls.length = 0;
      try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
      nextContent = () => content;

      const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
      assert.equal(response.statusCode, 502);
      const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
      assert.equal(json?.code, 502);

      const after = await getProblemDetailById(pool, 42);
      assert.equal(after.answer, 'OLD-ANSWER-MARKER');
      assert.equal(modelCalls.length, 1);

      const [audit] = await readAuditLines(1);
      assert.notEqual(audit.reason, 'generated_answer');
      assert.equal(audit.status, 'error');
    }
  });

  it('IT-ANSWER-JSON-04: 校验失败不消耗「成功生成」业务缓存语义', async () => {
    nextContent = () => '<p>脏 HTML</p>';
    const first = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(first.statusCode, 502);
    const mid = await getProblemDetailById(pool, 42);
    assert.equal(mid?.answer == null || mid.answer === '', true);
    assert.equal(String(mid?.answer || '').includes('<p>脏 HTML</p>'), false);

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    nextContent = () => VALID_JSON;
    const second = await invokeRoute(app, '/api/problems/42/answer/generate', { force: false });
    assert.equal(second.statusCode, 200);
    const json = second.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json?.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, '短结论');
    assert.equal(modelCalls.length, 1);
    assert.equal(String(json.data.answer || '').includes('<p>脏 HTML</p>'), false);
  });

  it('IT-ANSWER-JSON-05: cached_answer 早退不受本项强制改写（residual）', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: 'LEGACY-HTML-ANSWER',
      keyPoints: [],
    });
    modelCalls.length = 0;

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: false });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json?.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, 'LEGACY-HTML-ANSWER');
    assert.equal(modelCalls.length, 0);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('IT-ANSWER-JSON-06: generate system 上游第 1 条已切 JSON 契约', async () => {
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);
    const messages = modelCalls[0].messages;
    assert.equal(messages[0].role, 'system');
    const system = messages[0].content;
    assert.ok(system.includes('JSON'));
    assert.ok(system.includes('summary'));
    assert.ok(system.includes('keyPoints'));
    assert.ok(system.includes('nextStep'));
    assert.equal(system.includes('请直接输出可用于前端展示的 HTML 片段'), false);
    assert.equal(system.includes('仅 body 内'), false);
    assert.equal(system.includes('<p>/<h3>/<ul>/<li>'), false);
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[2].role, 'user');

    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.data.summary, '短结论');
    assert.deepEqual(json.data.keyPoints, ['要点一', '要点二']);
    assert.equal(json.data.nextStep, '去练一道题');
  });

  it('SEC-ANSWER-JSON-01: 失败路径禁止把模型 HTML 写入 answer（防存储型脏数据）', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: 'SAFE-OLD',
      keyPoints: [],
    });
    nextContent = () => '<script>steal()</script><p onclick="x">正文</p>';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.notEqual(json?.code, 0);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, 'SAFE-OLD');
    assert.equal(/<\/?script/i.test(after.answer), false);
    assert.equal(after.answer.includes('<p onclick'), false);
  });

  it('SEC-ANSWER-JSON-02: 客户端不得用 body 字段伪造三字段绕过模型', async () => {
    nextContent = () => '<p>非法 HTML</p>';
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {
      force: true,
      summary: '客户端伪造结论',
      keyPoints: ['伪造要点'],
      nextStep: '伪造下一步',
      answer: '客户端伪造答案',
    });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.notEqual(json?.code, 0);
    assert.notEqual(json?.data?.summary, '客户端伪造结论');
    assert.equal(modelCalls.length, 1);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after?.answer == null || after.answer === '', true);
    assert.notEqual(after?.answer, '客户端伪造答案');
    assert.notEqual(after?.answer, '客户端伪造结论');
  });
});
