import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  TEST_AUDIT_PATH,
  configureRouteTestEnv,
  installMockModelFetch,
  invokeRoute,
  removeTestFiles,
  readAuditLines,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';

const MODEL_ENV_KEYS = ['OPENAI_CHAT_MODEL', 'OPENAI_GENERATION_MODEL', 'OPENAI_MODEL'];
const savedEnv = saveTestEnv();
const savedModelEnv = Object.fromEntries(
  MODEL_ENV_KEYS.map((key) => [key, process.env[key]]),
);
let app;
let modelCalls;
let restoreFetch;

// 从 OpenAI 兼容请求中提取上游可观测的模型路由信息。
function getUpstreamModelCall(call) {
  return {
    model: call.model,
    maxTokens: call.max_tokens,
  };
}

// 解析测试响应中的 SSE data 帧，验证真实路由仍保持流式协议。
function getSseEvents(response) {
  return response.callOrder
    .filter((entry) => entry.op === 'write')
    .map((entry) => JSON.parse(entry.data.slice('data: '.length)));
}

// 恢复模型环境变量，避免本文件的路由配置泄漏到后续测试。
function restoreModelEnv() {
  for (const key of MODEL_ENV_KEYS) {
    if (savedModelEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedModelEnv[key];
  }
}

// 将本套件的默认分层模型环境重置为可区分哨兵值。
function resetDefaultModelEnv() {
  process.env.OPENAI_CHAT_MODEL = 'chat-mini-test';
  process.env.OPENAI_GENERATION_MODEL = 'generation-large-test';
  process.env.OPENAI_MODEL = 'legacy-test';
}

describe('C6 / C61 / P1-8: 模型分层路由集成', () => {
  before(async () => {
    configureRouteTestEnv();
    resetDefaultModelEnv();
    await seedPromptBudgetDatabase();
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  beforeEach(() => {
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    resetDefaultModelEnv();
  });

  after(() => {
    restoreFetch?.();
    restoreModelEnv();
    restoreTestEnv(savedEnv);
    removeTestFiles();
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-MODEL-LAYER-01: chat 路由发送 chat 专用模型并保持 SSE 协议', async () => {
    const response = await invokeRoute(app, '/api/chat', {
      message: '请简述缓存一致性',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(modelCalls.length, 1);
    assert.deepEqual(getUpstreamModelCall(modelCalls[0]), {
      model: 'chat-mini-test',
      maxTokens: 4096,
    });
    assert.deepEqual(getSseEvents(response).map((event) => event.type), [
      'context',
      'delta',
      'done',
    ]);
    assert.equal(JSON.stringify(modelCalls[0]).includes('generation-large-test'), false);
    assert.equal(JSON.stringify(modelCalls[0]).includes('legacy-test'), false);
    const [audit] = await readAuditLines(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const auditLines = fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 1);
    assert.equal(audit.reason, 'stream_done');
  });

  it('IT-MODEL-LAYER-02: force 解析使用 generation 专用模型', async () => {
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {
      force: true,
    });

    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json').payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(modelCalls.length, 1);
    assert.deepEqual(getUpstreamModelCall(modelCalls[0]), {
      model: 'generation-large-test',
      maxTokens: 4096,
    });
    assert.equal(JSON.stringify(modelCalls[0]).includes('chat-mini-test'), false);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
    assert.equal(audit.upstreamReached, true);
    assert.ok(audit.totalTokens > 0);
  });

  it('IT-MODEL-LAYER-03: 两条路由连续调用不串用模型配置', async () => {
    const requests = [
      ['/api/chat', { message: '第一次聊天' }],
      ['/api/problems/42/answer/generate', { force: true }],
      ['/api/problems/42/answer/generate', { force: true }],
      ['/api/chat', { message: '第二次聊天' }],
    ];

    const responses = [];
    for (const [route, body] of requests) {
      responses.push(await invokeRoute(app, route, body));
    }

    assert.deepEqual(
      modelCalls.map((call) => call.model),
      ['chat-mini-test', 'generation-large-test', 'generation-large-test', 'chat-mini-test'],
    );
    assert.deepEqual(
      modelCalls.map((call) => call.max_tokens),
      [4096, 4096, 4096, 4096],
    );
    assert.equal(responses[0].statusCode, 200);
    assert.equal(responses[1].statusCode, 200);
    assert.equal(responses[2].statusCode, 200);
    assert.equal(responses[3].statusCode, 200);
    assert.deepEqual(getSseEvents(responses[0]).map((event) => event.type), [
      'context',
      'delta',
      'done',
    ]);
    assert.deepEqual(getSseEvents(responses[3]).map((event) => event.type), [
      'context',
      'delta',
      'done',
    ]);
    for (const response of [responses[1], responses[2]]) {
      const json = response.callOrder.find((entry) => entry.op === 'json').payload;
      assert.equal(json.code, 0);
      assert.equal(json.data.cached, false);
    }
    const audits = await readAuditLines(4);
    assert.deepEqual(audits.map((audit) => audit.reason), [
      'stream_done',
      'generated_answer',
      'generated_answer',
      'stream_done',
    ]);
  });

  it('IT-MODEL-LAYER-04: 专用与 legacy 皆未设时 chat 保持 mini 且不串用 generation', async () => {
    delete process.env.OPENAI_CHAT_MODEL;
    delete process.env.OPENAI_MODEL;

    const response = await invokeRoute(app, '/api/chat', {
      message: '验证 chat 默认模型',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].model, 'gpt-4o-mini');
    assert.notEqual(modelCalls[0].model, 'generation-large-test');
    assert.ok(String(modelCalls[0].model).trim());
    assert.deepEqual(getSseEvents(response).map((event) => event.type), [
      'context',
      'delta',
      'done',
    ]);
  });

  it('IT-MODEL-LAYER-05: C61：仅 OPENAI_MODEL 时 chat 路由上游 model 为该值', async () => {
    process.env.OPENAI_CHAT_MODEL = '   ';
    process.env.OPENAI_MODEL = 'c61-legacy-chat';
    process.env.OPENAI_GENERATION_MODEL = 'generation-large-test';

    const response = await invokeRoute(app, '/api/chat', {
      message: '请简述 CAP',
    });

    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].model, 'c61-legacy-chat');
    assert.notEqual(modelCalls[0].model, 'generation-large-test');
    assert.notEqual(modelCalls[0].model, 'gpt-4o-mini');
    assert.ok(String(modelCalls[0].model).trim());
    assert.deepEqual(getSseEvents(response).map((event) => event.type), [
      'context',
      'delta',
      'done',
    ]);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'stream_done');
  });
});
