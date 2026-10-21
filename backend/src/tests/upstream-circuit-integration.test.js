/**
 * D12 / P1-5：进程内连续失败熔断路由集成。
 * 用例 ID 对齐 docs/test_cases.md §3.17。
 * 上游 stub 经 fetch；熔断短路时 invoke 次数为 0。
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
import {
  getUpstreamCircuit,
  resetUpstreamCircuitForTests,
  setUpstreamCircuitForTests,
} from '../upstream-circuit.js';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
/** @type {Array<{ stream?: boolean, httpStatus: number }>} */
let modelCalls;
/** @type {() => number} */
let nextGenerateStatus;
/** @type {string} */
let generateContent;
/** @type {number} */
let fakeNow;

const OK_JSON = JSON.stringify({
  summary: 'd12-ok',
  keyPoints: ['ck1'],
  nextStep: 'cn1',
});

// 安装 OpenAI 兼容 fetch stub（非流式按 nextGenerateStatus）。
function installFetchStub() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  nextGenerateStatus = () => 200;
  generateContent = OK_JSON;

  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    if (request.stream) {
      modelCalls.push({ stream: true, httpStatus: 200 });
      return new Response(JSON.stringify({ error: { message: 'unexpected stream' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
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
      id: 'chatcmpl-d12',
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

function countGenerateInvokes() {
  return modelCalls.filter((c) => c.stream === false).length;
}

function jsonPayload(response) {
  return response.callOrder.find((entry) => entry.op === 'json')?.payload;
}

/**
 * 等前序请求的审计 NDJSON 落盘后再删文件。
 * appendAudit 走异步队列，未等齐就 unlink 时，迟到的 server_error 会写进下一次断言。
 */
async function discardSettledAudit(count) {
  await readAuditLines(count);
  try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* 文件可能已被清空 */ }
}

describe('D12 / P1-5: generate 进程内熔断集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installFetchStub();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    resetUpstreamRetryForTests();
    setUpstreamRetryForTests({ jitterMs: [0, 0], sleep: async () => {} });
    resetUpstreamCircuitForTests();
    fakeNow = 1_000_000;
    setUpstreamCircuitForTests({
      failureThreshold: 2,
      openDurationMs: 5_000,
      now: () => fakeNow,
    });
    nextGenerateStatus = () => 200;
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
    resetUpstreamCircuitForTests();
    globalThis.fetch = originalFetch;
    restoreTestEnv(savedEnv);
    if (pool) await pool.closeAll();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-CIRCUIT-01: generate：连续失败达阈值后下一请求零 invoke', async () => {
    nextGenerateStatus = () => 503;

    const r1 = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(r1.statusCode, 500);
    assert.equal(countGenerateInvokes(), 3);
    assert.notEqual(jsonPayload(r1).code, 0);

    modelCalls.length = 0;
    const r2 = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(r2.statusCode, 500);
    assert.equal(countGenerateInvokes(), 3);
    assert.equal(getUpstreamCircuit().getState(), 'open');

    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-D12-SNAP',
    });

    modelCalls.length = 0;
    const r3 = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(countGenerateInvokes(), 0);
    assert.equal(r3.statusCode, 503);
    const body = jsonPayload(r3);
    assert.notEqual(body.code, 0);
    assert.equal(body.reason, 'circuit_open');
    assert.match(String(body.message || ''), /circuit/i);

    const detail = await getProblemDetailById(pool, 42);
    assert.equal(detail.answer, 'PRE-D12-SNAP');
  });

  it('IT-CIRCUIT-02: generate：窗口结束后恢复可生成', async () => {
    nextGenerateStatus = () => 503;
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(getUpstreamCircuit().getState(), 'open');
    const openUntil = getUpstreamCircuit().getSnapshot().openUntil;

    fakeNow = openUntil;
    nextGenerateStatus = () => 200;
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = jsonPayload(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, 'd12-ok');
    assert.deepEqual(json.data.keyPoints, ['ck1']);
    assert.equal(json.data.nextStep, 'cn1');
    assert.equal(countGenerateInvokes(), 1);

    const detail = await getProblemDetailById(pool, 42);
    assert.ok(detail?.answer && String(detail.answer).includes('d12-ok'));

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 'ok');
    assert.equal(lines[0].reason, 'generated_answer');
    assert.equal(getUpstreamCircuit().getState(), 'closed');
  });

  it('IT-CIRCUIT-03: open 时 finalize 不计上游触达', async () => {
    nextGenerateStatus = () => 503;
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(getUpstreamCircuit().isOpen(), true);

    modelCalls.length = 0;
    await discardSettledAudit(2);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(countGenerateInvokes(), 0);
    assert.equal(response.statusCode, 503);

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 'error');
    assert.equal(lines[0].reason, 'circuit_open');
    assert.equal(lines[0].upstreamReached, false);
    assert.notEqual(lines[0].reason, 'generated_answer');
  });

  it('IT-CIRCUIT-04: 对照：缓存早退不经过熔断计数', async () => {
    setUpstreamCircuitForTests({
      failureThreshold: 2,
      openDurationMs: 5_000,
      now: () => fakeNow,
      consecutiveFailures: 1,
    });
    assert.equal(getUpstreamCircuit().getSnapshot().consecutiveFailures, 1);
    assert.equal(getUpstreamCircuit().getState(), 'closed');

    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: '<p>cached-d12</p>',
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = jsonPayload(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(countGenerateInvokes(), 0);
    assert.equal(getUpstreamCircuit().getSnapshot().consecutiveFailures, 1);

    const lines = await readAuditLines(1);
    assert.equal(lines[0].reason, 'cached_answer');
    assert.equal(lines[0].upstreamReached, false);
  });

  it('IT-CIRCUIT-05: 成功生成清零计数，避免误打开', async () => {
    setUpstreamCircuitForTests({
      failureThreshold: 3,
      openDurationMs: 5_000,
      now: () => fakeNow,
    });
    nextGenerateStatus = () => 503;

    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(getUpstreamCircuit().getSnapshot().consecutiveFailures, 2);
    assert.equal(getUpstreamCircuit().getState(), 'closed');

    nextGenerateStatus = () => 200;
    modelCalls.length = 0;
    const ok = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(ok.statusCode, 200);
    assert.equal(countGenerateInvokes(), 1);
    assert.equal(getUpstreamCircuit().getSnapshot().consecutiveFailures, 0);

    nextGenerateStatus = () => 503;
    modelCalls.length = 0;
    const fail = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(fail.statusCode, 500);
    assert.equal(countGenerateInvokes(), 3);
    assert.equal(getUpstreamCircuit().getSnapshot().consecutiveFailures, 1);
    assert.equal(getUpstreamCircuit().getState(), 'closed');

    // 仍允许进入 invoke（未 open）
    modelCalls.length = 0;
    nextGenerateStatus = () => 200;
    const again = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(again.statusCode, 200);
    assert.equal(countGenerateInvokes(), 1);
  });

  it('SEC-CIRCUIT-01: 熔断短路不得绕过 Guard 准入', async () => {
    nextGenerateStatus = () => 503;
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(getUpstreamCircuit().isOpen(), true);

    modelCalls.length = 0;
    await discardSettledAudit(2);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 503);
    assert.equal(countGenerateInvokes(), 0);

    // 经完整中间件链：有审计 finalize 一行；无二次预扣（单行）
    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'circuit_open');
    assert.equal(lines[0].upstreamReached, false);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const allLines = fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(allLines.length, 1);
  });

  it('SEC-CIRCUIT-02: 不做跨 worker：本集成不要求 Redis 共享熔断', async () => {
    const prevRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      nextGenerateStatus = () => 503;
      await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
      await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
      assert.equal(getUpstreamCircuit().isOpen(), true);

      modelCalls.length = 0;
      const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
      assert.equal(countGenerateInvokes(), 0);
      assert.equal(response.statusCode, 503);
      // 不连接真实 Redis、不断言其它 worker；仅本进程短路
      assert.equal(process.env.REDIS_URL, undefined);
    } finally {
      if (prevRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prevRedis;
    }
  });
});
