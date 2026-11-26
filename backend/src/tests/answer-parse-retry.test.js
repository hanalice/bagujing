/**
 * S25：generate 首次结构化解析失败时同请求再试一次上游（单元/路由级）。
 * 用例 ID 对齐 docs/test_cases.md §2.57。
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
/** @type {Array<{ stream?: boolean, httpStatus: number, messages?: unknown[] }>} */
let modelCalls;
/** @type {(callIndex: number) => { status?: number, content?: string }} */
let nextGenerate;
/** @type {() => number} */
let nextStreamStatus;

const OK_JSON = JSON.stringify({
  summary: 'ok',
  keyPoints: ['k'],
  nextStep: 'n',
});

const BAD_HTML = '<p>bad</p>';

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
      modelCalls.push({ stream: true, httpStatus: status, messages: request.messages });
      if (status !== 200) {
        return new Response(JSON.stringify({ error: { message: `stream ${status}` } }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      }
      const events = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-s25',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-s25',
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
    modelCalls.push({
      stream: false,
      httpStatus: status,
      messages: request.messages,
      content: step.content,
    });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: `generate ${status}` } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-s25',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: step.content ?? OK_JSON },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
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

describe('S25: generate 解析失败同请求再试上游', () => {
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

  it('UT-PARSE-RETRY-01: 首次非法 JSON、第二次合法 → 200 且只入库一次', async () => {
    nextGenerate = (i) => (i === 0
      ? { content: BAD_HTML }
      : { content: OK_JSON });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = getJson(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, 'ok');
    assert.deepEqual(json.data.keyPoints, ['k']);
    assert.equal(json.data.nextStep, 'n');
    assert.equal(countGenerateInvokes(), 2);

    const row = await getProblemDetailById(pool, 42);
    const stored = JSON.parse(row.answer);
    assert.equal(stored.summary, 'ok');
    assert.deepEqual(stored.keyPoints, ['k']);
    assert.equal(stored.nextStep, 'n');

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'ok');
    assert.equal(audit.reason, 'generated_answer');
  });

  it('UT-PARSE-RETRY-02: 两次均非法 → 502、reason 仍为 invalid_structured_answer、不入库', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-S25-OLD',
    });
    nextGenerate = () => ({ content: BAD_HTML });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.equal(getJson(response).code, 502);
    assert.equal(countGenerateInvokes(), 2);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'PRE-S25-OLD');

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.equal(audit.reason, 'invalid_structured_answer');
    assert.notEqual(audit.reason, 'generated_answer');
  });

  it('UT-PARSE-RETRY-03: 首次即合法：不触发二次 invoke', async () => {
    nextGenerate = (i) => {
      if (i > 0) throw new Error('不得发起第二次 invoke');
      return { content: OK_JSON };
    };

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(getJson(response).code, 0);
    assert.equal(countGenerateInvokes(), 1);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(JSON.parse(row.answer).summary, 'ok');
  });

  it('UT-PARSE-RETRY-04: 与 D11 正交：解析再试不占用 429/5xx 预算', async () => {
    const sleeps = [];
    setUpstreamRetryForTests({
      jitterMs: [0, 0],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    nextGenerate = (i) => {
      if (i === 0) return { status: 429 };
      if (i === 1) return { content: BAD_HTML };
      return { content: OK_JSON };
    };

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(getJson(response).code, 0);
    assert.equal(countGenerateInvokes(), 3);
    // 429→二次之间可有 D11 sleep；坏正文→好正文之间不得再消耗 D11 jitter
    assert.equal(sleeps.length, 1);
    assert.equal(sleeps[0], 0);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(JSON.parse(row.answer).summary, 'ok');
  });

  it('UT-PARSE-RETRY-05: 不做：chat SSE 解析/形态失败不套用本项再试', async () => {
    const response = await invokeRoute(app, '/api/chat', { message: 's25-chat-no-retry' });
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(countStreamCalls(), 1);
    assert.equal(countGenerateInvokes(), 0);
  });

  it('UT-PARSE-RETRY-06: 不做：不放宽 C41 schema（再试成功仍须三字段合法）', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-S25-SCHEMA',
    });
    nextGenerate = (i) => (i === 0
      ? { content: BAD_HTML }
      : { content: '{"summary":"s","keyPoints":"不是数组","nextStep":"n"}' });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.equal(getJson(response).code, 502);
    assert.equal(countGenerateInvokes(), 2);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'PRE-S25-SCHEMA');
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'invalid_structured_answer');
  });

  it('UT-PARSE-RETRY-07: 触发门：无正文 / reject 不走解析再试计数', async () => {
    // A) 非 D11 可重试的 400：单次 invoke，不得双次
    nextGenerate = () => ({ status: 400 });
    const badStatus = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(countGenerateInvokes(), 1);
    assert.notEqual(getJson(badStatus).code, 0);
    assert.notEqual(
      (await readAuditLines(1))[0]?.reason,
      'invalid_structured_answer',
    );

    // B) 空 content：若当作解析失败可再试至多 2 次，仍 502 不入库
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-EMPTY',
    });
    nextGenerate = () => ({ content: '' });
    const emptyRes = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(emptyRes.statusCode, 502);
    assert.ok(countGenerateInvokes() <= 2);
    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'PRE-EMPTY');
  });

  it('UT-PARSE-RETRY-08: 再试复用同请求 messages，不新开客户端请求', async () => {
    nextGenerate = (i) => (i === 0
      ? { content: BAD_HTML }
      : { content: OK_JSON });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(countGenerateInvokes(), 2);

    const first = modelCalls.filter((c) => !c.stream)[0].messages;
    const second = modelCalls.filter((c) => !c.stream)[1].messages;
    assert.equal(first.length, 3);
    assert.equal(second.length, 3);
    assert.equal(first[0].role, 'system');
    assert.equal(first[1].role, 'user');
    assert.equal(first[2].role, 'user');
    assert.deepEqual(
      first.map((m) => m.content),
      second.map((m) => m.content),
    );
  });

  it('UT-PARSE-RETRY-09: finalize / 配额：成功路径仅一次成功记账', async () => {
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

    const row = await getProblemDetailById(pool, 42);
    assert.equal(JSON.parse(row.answer).summary, 'ok');
  });

  it('UT-PARSE-RETRY-10: residual / 不做边界：不把网关外 502 当已修；禁止无限重试', async () => {
    nextGenerate = () => ({ content: BAD_HTML });
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.ok(countGenerateInvokes() <= 2);
    assert.equal(countGenerateInvokes(), 2);
  });
});
