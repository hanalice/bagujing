/**
 * D21 / P1-5：主备 Base URL failover 路由集成。
 * 用例 ID 对齐 docs/test_cases.md §3.18。
 * 按 fetch URL 前缀区分主/备；chat 探针 SSE write 帧。
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

const PRIMARY = 'http://primary-failover.invalid/v1';
const BACKUP = 'http://backup-failover.invalid/v1';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
/** @type {Array<{ kind: 'primary'|'backup'|'other', stream: boolean, url: string }>} */
let modelCalls;
/** @type {'fail'|'ok'|'mid-fail'} */
let primaryStreamMode;
/** @type {'fail'|'ok'} */
let backupStreamMode;
/** @type {'fail'|'ok'} */
let primaryGenerateMode;
/** @type {'fail'|'ok'} */
let backupGenerateMode;
/** @type {string} */
let generateContent;
/** @type {string} */
let streamChunkText;

const OK_JSON = JSON.stringify({
  summary: 'd21-ok',
  keyPoints: ['fk1'],
  nextStep: 'fn1',
});

function classifyUrl(url) {
  const s = String(url);
  if (s.startsWith(PRIMARY) || s.includes('primary-failover.invalid')) return 'primary';
  if (s.startsWith(BACKUP) || s.includes('backup-failover.invalid')) return 'backup';
  return 'other';
}

function installFailoverFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  primaryStreamMode = 'ok';
  backupStreamMode = 'ok';
  primaryGenerateMode = 'ok';
  backupGenerateMode = 'ok';
  generateContent = OK_JSON;
  streamChunkText = 'backup-delta';

  const encoder = new TextEncoder();

  function sseOkBody(text) {
    const events = [
      `data: ${JSON.stringify({
        id: 'chatcmpl-d21',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: 'chatcmpl-d21',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];
    return new ReadableStream({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
  }

  // 先交出含文本的 SSE chunk，再在下一次 pull 时 error，确保 handler 已写出 delta 后再失败。
  function sseMidFailBody(text) {
    let phase = 0;
    return new ReadableStream({
      async pull(controller) {
        if (phase === 0) {
          phase = 1;
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({
            id: 'chatcmpl-d21',
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
          })}\n\n`));
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
        controller.error(new Error('mid-stream upstream fail'));
      },
    });
  }

  globalThis.fetch = async (url, init = {}) => {
    const kind = classifyUrl(url);
    const request = JSON.parse(String(init.body || '{}'));
    const isStream = Boolean(request.stream);
    modelCalls.push({ kind, stream: isStream, url: String(url) });

    if (isStream) {
      const mode = kind === 'backup' ? backupStreamMode : primaryStreamMode;
      if (mode === 'fail') {
        return new Response(JSON.stringify({ error: { message: 'stream fail' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (mode === 'mid-fail') {
        return new Response(sseMidFailBody('HELLO'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      const text = kind === 'backup' ? streamChunkText : 'primary-delta';
      return new Response(sseOkBody(text), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    const mode = kind === 'backup' ? backupGenerateMode : primaryGenerateMode;
    if (mode === 'fail') {
      // 用网络错语义：无 HTTP status → D11 不重试，primary 仅 1 次
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    }
    return new Response(JSON.stringify({
      id: 'chatcmpl-d21',
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

function jsonPayload(response) {
  return response.callOrder.find((entry) => entry.op === 'json')?.payload;
}

function countBy(kind, stream) {
  return modelCalls.filter((c) => c.kind === kind && c.stream === stream).length;
}

describe('D21 / P1-5: 主备 Base URL failover 集成', () => {
  before(async () => {
    configureRouteTestEnv();
    process.env.OPENAI_BASE_URL = PRIMARY;
    process.env.OPENAI_BASE_URL_FALLBACK = BACKUP;
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installFailoverFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    if (app?.aiGuard?.flushAudit) {
      await app.aiGuard.flushAudit();
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    resetUpstreamRetryForTests();
    setUpstreamRetryForTests({ jitterMs: [0, 0], sleep: async () => {} });
    resetUpstreamCircuitForTests();
    process.env.OPENAI_BASE_URL = PRIMARY;
    process.env.OPENAI_BASE_URL_FALLBACK = BACKUP;
    primaryStreamMode = 'ok';
    backupStreamMode = 'ok';
    primaryGenerateMode = 'ok';
    backupGenerateMode = 'ok';
    generateContent = OK_JSON;
    streamChunkText = 'backup-delta';
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

  it('IT-FAILOVER-01: chat：主在首 delta 前失败 → 备用流式成功', async () => {
    primaryStreamMode = 'fail';
    backupStreamMode = 'ok';
    streamChunkText = 'from-backup';

    const response = await invokeRoute(app, '/api/chat', { message: 'failover-chat-ok' });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type'] || ''), /text\/event-stream/);

    assert.equal(countBy('primary', true), 1);
    assert.equal(countBy('backup', true), 1);
    assert.equal(modelCalls.filter((c) => c.stream).length, 2);

    const events = getSseEvents(response);
    assert.ok(events.some((e) => e.type === 'delta' && String(e.text || '').includes('from-backup')));
    assert.ok(events.some((e) => e.type === 'done'));
    assert.ok(!events.some((e) => e.type === 'error'));
    assert.equal(response.callOrder.filter((e) => e.op === 'json').length, 0);

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 'ok');
    assert.notEqual(lines[0].upstreamReached, false);
  });

  it('IT-FAILOVER-02: chat：已推 delta 后主失败 → 不切备、发 error', async () => {
    primaryStreamMode = 'mid-fail';
    backupStreamMode = 'ok';

    const response = await invokeRoute(app, '/api/chat', { message: 'failover-chat-mid' });
    assert.match(String(response.headers['content-type'] || ''), /text\/event-stream/);

    const events = getSseEvents(response);
    const deltaIdx = events.findIndex((e) => e.type === 'delta');
    const errorIdx = events.findIndex((e) => e.type === 'error');
    assert.ok(deltaIdx >= 0);
    assert.ok(errorIdx > deltaIdx);
    assert.equal(countBy('backup', true), 0);
    assert.ok(!events.some((e) => e.type === 'done'));

    const lines = await readAuditLines(1);
    assert.equal(lines[0].status, 'error');
  });

  it('IT-FAILOVER-03: generate：主 invoke 失败 → 备用成功入库', async () => {
    primaryGenerateMode = 'fail';
    backupGenerateMode = 'ok';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = jsonPayload(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, 'd21-ok');
    assert.deepEqual(json.data.keyPoints, ['fk1']);
    assert.equal(json.data.nextStep, 'fn1');

    assert.equal(countBy('primary', false), 1);
    assert.equal(countBy('backup', false), 1);

    const detail = await getProblemDetailById(pool, 42);
    assert.ok(detail?.answer && String(detail.answer).includes('d21-ok'));

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].status, 'ok');
    assert.equal(lines[0].reason, 'generated_answer');
    assert.notEqual(lines[0].upstreamReached, false);
  });

  it('IT-FAILOVER-04: 未配置备用：主失败行为与无 failover 一致', async () => {
    delete process.env.OPENAI_BASE_URL_FALLBACK;
    process.env.OPENAI_BASE_URL = PRIMARY;
    primaryStreamMode = 'fail';
    primaryGenerateMode = 'fail';

    const chat = await invokeRoute(app, '/api/chat', { message: 'no-fallback-chat' });
    assert.match(String(chat.headers['content-type'] || ''), /text\/event-stream/);
    const chatEvents = getSseEvents(chat);
    assert.ok(chatEvents.some((e) => e.type === 'error'));
    assert.ok(!chatEvents.some((e) => e.type === 'done'));
    assert.equal(countBy('backup', true), 0);

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-NO-FB',
    });
    const gen = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.notEqual(gen.statusCode, 200);
    const body = jsonPayload(gen);
    assert.notEqual(body.code, 0);
    assert.equal(countBy('backup', false), 0);

    const detail = await getProblemDetailById(pool, 42);
    assert.equal(detail.answer, 'PRE-NO-FB');
  });

  it('IT-FAILOVER-05: 不做：第二请求仍从主 URL 起调', async () => {
    // 请求 1：主败备成
    primaryGenerateMode = 'fail';
    backupGenerateMode = 'ok';
    await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });

    // 请求 2：主改为成功，备计数归零
    modelCalls.length = 0;
    primaryGenerateMode = 'ok';
    backupGenerateMode = 'ok';
    if (app?.aiGuard?.flushAudit) {
      await app.aiGuard.flushAudit();
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls[0]?.kind, 'primary');
    assert.equal(countBy('backup', false), 0);
  });

  it('IT-FAILOVER-06: 对照：缓存早退不触发主备切换', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: '<p>cached-d21</p>',
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = jsonPayload(response);
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(countBy('primary', false), 0);
    assert.equal(countBy('backup', false), 0);

    const lines = await readAuditLines(1);
    assert.equal(lines[0].reason, 'cached_answer');
    assert.equal(lines[0].upstreamReached, false);
  });

  it('SEC-FAILOVER-01: failover 不得绕过 Guard 或重复 finalize', async () => {
    primaryGenerateMode = 'fail';
    backupGenerateMode = 'ok';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(jsonPayload(response).code, 0);

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'generated_answer');
    await new Promise((resolve) => setTimeout(resolve, 80));
    const allLines = fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(allLines.length, 1);
  });

  it('SEC-FAILOVER-02: 熔断 open 时不得借 failover 打备用', async () => {
    setUpstreamCircuitForTests({
      failureThreshold: 1,
      openDurationMs: 60_000,
      consecutiveFailures: 1,
    });
    assert.equal(getUpstreamCircuit().isOpen(), true);

    modelCalls.length = 0;
    const gen = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(gen.statusCode, 503);
    assert.equal(jsonPayload(gen).reason, 'circuit_open');
    assert.equal(modelCalls.length, 0);

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    const chat = await invokeRoute(app, '/api/chat', { message: 'circuit-open-chat' });
    const events = getSseEvents(chat);
    assert.ok(events.some((e) => e.type === 'error' && e.reason === 'circuit_open'));
    assert.equal(modelCalls.length, 0);
  });
});
