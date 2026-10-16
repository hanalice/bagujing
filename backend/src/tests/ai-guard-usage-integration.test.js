/**
 * C51 / P1-6：handler → finalize 上游 usage 回写审计集成。
 * 用例 ID 对齐 docs/test_cases.md §3.15。
 *
 * stream usage 挂载点：OpenAI SSE 末包 `usage` → LangChain chunk.response_metadata.usage
 * （及 usage_metadata）；handler 经 extractUpstreamUsage 读入后传入 finalize。
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
import { upsertProblemDetail } from '../db/problem-detail-repo.js';
import { serializeStructuredAnswer } from '../answer-structured-json.js';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
let modelCalls;
/** @type {{ usage: object|null, content: string, streamDelta: string }} */
let stubState;

/** 与 ai-guard 内部 estimateTokensByText 一致 */
function estimateTokensByText(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
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

// 可按用例切换 content / usage 的 OpenAI 兼容 fetch stub。
function installUsageAwareFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  stubState = {
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    content: serializeStructuredAnswer({
      summary: 's',
      keyPoints: ['k'],
      nextStep: 'n',
    }),
    streamDelta: 'ping',
  };

  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    modelCalls.push(request);
    if (request.stream) {
      const finishChunk = {
        id: 'chatcmpl-c51',
        object: 'chat.completion.chunk',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      };
      if (stubState.usage) finishChunk.usage = stubState.usage;
      const events = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-c51',
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: { role: 'assistant', content: stubState.streamDelta },
            finish_reason: null,
          }],
        })}\n\n`,
        `data: ${JSON.stringify(finishChunk)}\n\n`,
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

    const payload = {
      id: 'chatcmpl-c51',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: stubState.content },
        finish_reason: 'stop',
      }],
    };
    if (stubState.usage) payload.usage = stubState.usage;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

describe('C51 / P1-6: 上游 usage 经路由回写审计集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installUsageAwareFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    stubState.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    stubState.content = serializeStructuredAnswer({
      summary: 's',
      keyPoints: ['k'],
      nextStep: 'n',
    });
    stubState.streamDelta = 'ping';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: null,
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

  it('IT-USAGE-01: generate：invoke 带 usage → 审计 upstream', async () => {
    stubState.usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'generated_answer');
    assert.equal(lines[0].promptTokens, 100);
    assert.equal(lines[0].completionTokens, 20);
    assert.equal(lines[0].totalTokens, 120);
    assert.equal(lines[0].token_source, 'upstream');
    assert.equal(modelCalls.filter((c) => !c.stream).length, 1);
  });

  it('IT-USAGE-02: generate：invoke 无 usage → 审计 estimate（residual）', async () => {
    stubState.usage = null;
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
    assert.equal(audit.token_source, 'estimate');
    const completionText = serializeStructuredAnswer({
      summary: 's',
      keyPoints: ['k'],
      nextStep: 'n',
    });
    assert.equal(audit.completionTokens, estimateTokensByText(completionText));
    assert.equal(audit.totalTokens, audit.promptTokens + audit.completionTokens);
    assert.ok(Number.isFinite(audit.promptTokens) && audit.promptTokens > 0);
    assert.ok(Number.isFinite(audit.completionTokens) && audit.completionTokens > 0);
  });

  it('IT-USAGE-03: chat SSE：stream 结束带 usage → upstream', async () => {
    stubState.usage = { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 };
    stubState.streamDelta = 'ping';
    const response = await invokeRoute(app, '/api/chat', { message: 'usage-sse' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.deepEqual(getSseEvents(response).map((e) => e.type), ['context', 'delta', 'done']);

    const lines = await readAuditLines(1);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].reason, 'stream_done');
    assert.equal(lines[0].promptTokens, 30);
    assert.equal(lines[0].completionTokens, 8);
    assert.equal(lines[0].totalTokens, 38);
    assert.equal(lines[0].token_source, 'upstream');
  });

  it('IT-USAGE-04: chat SSE：流结束无 usage → estimate', async () => {
    stubState.usage = null;
    stubState.streamDelta = 'ping';
    const response = await invokeRoute(app, '/api/chat', { message: 'usage-sse-est' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(getSseEvents(response).map((e) => e.type), ['context', 'delta', 'done']);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'stream_done');
    assert.equal(audit.token_source, 'estimate');
    assert.equal(audit.completionTokens, estimateTokensByText('ping'));
  });

  it('IT-USAGE-05: 两条路径对照：同 completion 不同 source', async () => {
    const sameContent = serializeStructuredAnswer({
      summary: 'same',
      keyPoints: ['p'],
      nextStep: 'go',
    });
    stubState.content = sameContent;

    stubState.usage = { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 };
    const first = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(first.statusCode, 200);
    assert.equal(first.callOrder.find((e) => e.op === 'json')?.payload.code, 0);

    stubState.usage = null;
    const second = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(second.statusCode, 200);
    assert.equal(second.callOrder.find((e) => e.op === 'json')?.payload.code, 0);

    const lines = await readAuditLines(2);
    assert.equal(lines[0].token_source, 'upstream');
    assert.equal(lines[0].completionTokens, 6);
    assert.equal(lines[1].token_source, 'estimate');
    assert.equal(lines[1].completionTokens, estimateTokensByText(sameContent));
  });

  it('IT-USAGE-06: 边界：不做月结/对账报表接口', async () => {
    // PASS 判据仅约束审计字段；不得要求对账 CSV/月结 API。
    const src = fs.readFileSync(new URL('../server-express.js', import.meta.url), 'utf8');
    assert.equal(/\/api\/admin\/usage-reconcile/.test(src), false);
    assert.equal(/按用户月结/.test(src), false);
    assert.ok(true, 'C51 residual：无 usage 保持估算；本表不断言月结/对账接口');
  });
});
