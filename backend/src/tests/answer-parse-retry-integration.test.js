/**
 * S25：generate 结构化解析失败同请求再试上游（集成）。
 * 用例 ID 对齐 docs/test_cases.md §3.27。
 */
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
import { getProblemDetailById, upsertProblemDetail } from '../db/problem-detail-repo.js';
import {
  resetUpstreamRetryForTests,
  setUpstreamRetryForTests,
} from '../upstream-retry.js';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
/** @type {Array<{ stream?: boolean, httpStatus: number }>} */
let modelCalls;
/** @type {(callIndex: number) => { status?: number, content?: string }} */
let nextGenerate;
/** @type {() => number} */
let nextStreamStatus;

const OK_JSON = JSON.stringify({
  summary: '结论',
  keyPoints: ['a'],
  nextStep: '下一步',
});

const BAD_HTML = '<p>旧式整篇解析</p>';

// 安装可按调用序号返回不同 content / HTTP 状态的 OpenAI 兼容 fetch stub。
function installParseRetryFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  nextGenerate = () => ({ status: 200, content: OK_JSON });
  nextStreamStatus = () => 200;

  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    if (request.stream) {
      const status = nextStreamStatus();
      modelCalls.push({ stream: true, httpStatus: status });
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: `stream ${status}` } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const events = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-s25-it',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-s25-it',
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

    const callIndex = modelCalls.filter((c) => c.stream === false).length;
    const step = nextGenerate(callIndex) || {};
    const status = step.status ?? 200;
    modelCalls.push({ stream: false, httpStatus: status });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: `generate ${status}` } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-s25-it',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: step.content ?? OK_JSON },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function countGenerateInvokes() {
  return modelCalls.filter((c) => c.stream === false).length;
}

function countStreamCalls() {
  return modelCalls.filter((c) => c.stream === true).length;
}

function getJson(response) {
  return response.callOrder.find((entry) => entry.op === 'json')?.payload;
}

describe('S25: generate 解析失败再试上游集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installParseRetryFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    resetUpstreamRetryForTests();
    setUpstreamRetryForTests({ jitterMs: [0, 0], sleep: async () => {} });
    nextGenerate = () => ({ status: 200, content: OK_JSON });
    nextStreamStatus = () => 200;
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: null,
    });
  });

  after(async () => {
    resetUpstreamRetryForTests();
    globalThis.fetch = originalFetch;
    restoreTestEnv(savedEnv);
    if (pool) await pool.closeAll();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-PARSE-RETRY-01: generate：首调非法 JSON、次调合法 → 200 入库一次', async () => {
    nextGenerate = (i) => (i === 0
      ? { content: BAD_HTML }
      : { content: OK_JSON });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = getJson(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, '结论');
    assert.deepEqual(json.data.keyPoints, ['a']);
    assert.equal(json.data.nextStep, '下一步');
    assert.equal(countGenerateInvokes(), 2);

    const row = await getProblemDetailById(pool, 42);
    const stored = JSON.parse(row.answer);
    assert.equal(stored.summary, '结论');
    assert.deepEqual(stored.keyPoints, ['a']);
    assert.equal(stored.nextStep, '下一步');

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'ok');
    assert.equal(audit.reason, 'generated_answer');
    assert.notEqual(audit.upstreamReached, false);
  });

  it('IT-PARSE-RETRY-02: generate：两次均非法 → 502 且不入库', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-S25-IT-OLD',
    });
    nextGenerate = () => ({ content: BAD_HTML });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.equal(getJson(response).code, 502);
    assert.notEqual(getJson(response).code, 0);
    assert.equal(countGenerateInvokes(), 2);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'PRE-S25-IT-OLD');

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.equal(audit.reason, 'invalid_structured_answer');
    assert.notEqual(audit.reason, 'generated_answer');
  });

  it('IT-PARSE-RETRY-03: 与 D11 合取：429 后再解析失败再试一次仍可成功', async () => {
    nextGenerate = (i) => {
      if (i === 0) return { status: 429 };
      if (i === 1) return { content: BAD_HTML };
      return { content: OK_JSON };
    };

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = getJson(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.summary, '结论');
    assert.equal(countGenerateInvokes(), 3);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(JSON.parse(row.answer).summary, '结论');

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
  });

  it('IT-PARSE-RETRY-04: chat SSE：不做解析失败再 stream', async () => {
    const response = await invokeRoute(app, '/api/chat', { message: 's25-it-chat' });
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(countStreamCalls(), 1);
    assert.equal(countGenerateInvokes(), 0);
  });

  it('IT-PARSE-RETRY-05: 对照：首次合法仍单次 invoke（回归 C41 成功路径）', async () => {
    nextGenerate = () => ({ content: OK_JSON });
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(getJson(response).code, 0);
    assert.equal(countGenerateInvokes(), 1);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(JSON.parse(row.answer).summary, '结论');
  });

  it('IT-PARSE-RETRY-06: 不做：schema 未放宽（再试仍拒非法 keyPoints）', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-SCHEMA',
    });
    nextGenerate = (i) => (i === 0
      ? { content: BAD_HTML }
      : { content: '{"summary":"s","keyPoints":[1],"nextStep":"n"}' });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.equal(countGenerateInvokes(), 2);
    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'PRE-SCHEMA');
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'invalid_structured_answer');
  });

  it('SEC-PARSE-RETRY-01: 解析再试不得绕过 Guard 或双次 finalize / 双计配额', async () => {
    nextGenerate = (i) => (i === 0
      ? { content: BAD_HTML }
      : { content: OK_JSON });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(countGenerateInvokes(), 2);

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'generated_answer');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const allLines = fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(allLines.length, 1);
    assert.equal(allLines.some((line) => line.includes('invalid_structured_answer')), false);
  });

  it('SEC-PARSE-RETRY-02: 两次非法时脏正文不得入库', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'SAFE',
    });
    const dirty = '<script>alert(1)</script><p>x</p>';
    nextGenerate = () => ({ content: dirty });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = getJson(response);
    assert.equal(json.data?.answer, undefined);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'SAFE');
    assert.equal(/<script/i.test(row.answer), false);
  });
});
