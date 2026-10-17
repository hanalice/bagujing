/**
 * D11 / P1-5：同步 generate 429/5xx 有限重试路由集成。
 * 用例 ID 对齐 docs/test_cases.md §3.16。
 * 上游 stub 经 fetch（ChatOpenAI maxRetries:0 时每次 invoke ≈ 1 次 fetch）。
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
/** @type {() => number} 非流式下次 HTTP 状态；流式同理 */
let nextGenerateStatus;
/** @type {() => number} */
let nextStreamStatus;
/** @type {string} */
let generateContent;

const OK_JSON = JSON.stringify({
  summary: 'd11-ok',
  keyPoints: ['k1'],
  nextStep: 'n1',
});

// 安装可按调用序号返回 429/5xx/200 的 OpenAI 兼容 fetch stub。
function installRetryAwareFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  nextGenerateStatus = () => 200;
  nextStreamStatus = () => 200;
  generateContent = OK_JSON;

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
          id: 'chatcmpl-d11',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-d11',
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

    const status = nextGenerateStatus();
    modelCalls.push({ stream: false, httpStatus: status });
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: `generate ${status}` } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-d11',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: generateContent },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

function getSseEvents(response) {
  return response.callOrder
    .filter((entry) => entry.op === 'write')
    .map((entry) => String(entry.data))
    .join('')
    .split('\n\n')
    .map((block) => block.trim())
    .filter((block) => block.startsWith('data: '))
    .map((block) => JSON.parse(block.slice(6)));
}

function countGenerateInvokes() {
  return modelCalls.filter((c) => c.stream === false).length;
}

function countStreamCalls() {
  return modelCalls.filter((c) => c.stream === true).length;
}

describe('D11 / P1-5: generate 429/5xx 有限重试集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installRetryAwareFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    resetUpstreamRetryForTests();
    setUpstreamRetryForTests({ jitterMs: [0, 0], sleep: async () => {} });
    nextGenerateStatus = () => 200;
    nextStreamStatus = () => 200;
    generateContent = OK_JSON;
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

  it('IT-RETRY-01: generate：首调 429、次调成功 → 200 入库', async () => {
    let genIdx = 0;
    nextGenerateStatus = () => {
      genIdx += 1;
      return genIdx === 1 ? 429 : 200;
    };

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, 'd11-ok');
    assert.deepEqual(json.data.keyPoints, ['k1']);
    assert.equal(json.data.nextStep, 'n1');

    assert.equal(countGenerateInvokes(), 2);

    const detail = await getProblemDetailById(pool, 42);
    assert.ok(detail?.answer && String(detail.answer).includes('d11-ok'));

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'generated_answer');
    assert.equal(lines[0].status, 'ok');
    assert.notEqual(lines[0].upstreamReached, false);
  });

  it('IT-RETRY-02: generate：三次 503 耗尽 → 500 且不入库', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-D11-OLD',
    });
    nextGenerateStatus = () => 503;

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 500);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 500);
    assert.notEqual(json.code, 0);

    assert.equal(countGenerateInvokes(), 3);

    const detail = await getProblemDetailById(pool, 42);
    assert.equal(detail.answer, 'PRE-D11-OLD');

    const lines = await readAuditLines(1);
    assert.equal(lines[0].status, 'error');
    assert.equal(lines[0].reason, 'server_error');
    assert.notEqual(lines[0].reason, 'generated_answer');
  });

  it('IT-RETRY-03: chat SSE：上游 429 仅一次 stream、无重试', async () => {
    nextStreamStatus = () => 429;

    const response = await invokeRoute(app, '/api/chat', { message: 'retry-chat-no' });
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(countStreamCalls(), 1);
    assert.equal(countGenerateInvokes(), 0);

    const events = getSseEvents(response);
    assert.ok(events.some((e) => e.type === 'error'));
  });

  it('IT-RETRY-04: generate：400 类上游错误不重试即失败', async () => {
    nextGenerateStatus = () => 400;

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(countGenerateInvokes(), 1);
    assert.equal(response.statusCode, 500);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.notEqual(json.code, 0);
  });

  it('IT-RETRY-05: 对照：缓存早退仍零次 invoke（不与重试耦合）', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: '<p>cached-html-answer</p>',
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(countGenerateInvokes(), 0);

    const lines = await readAuditLines(1);
    assert.equal(lines[0].reason, 'cached_answer');
    assert.equal(lines[0].upstreamReached, false);
  });

  it('SEC-RETRY-01: 重试不得绕过 Guard 准入或重复 finalize', async () => {
    let genIdx = 0;
    nextGenerateStatus = () => {
      genIdx += 1;
      return genIdx === 1 ? 429 : 200;
    };

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(countGenerateInvokes(), 2);

    // 单次请求仅一行 generated_answer 审计（一次 finalize）；重试不二次预扣
    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'generated_answer');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const allLines = fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(allLines.length, 1);
  });
});
