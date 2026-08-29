import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promptBudget } from '../prompt-budget.js';
import fs from 'node:fs';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  installMockModelFetch,
  invokeRoute,
  readAuditLines,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';

const savedEnv = saveTestEnv();
let app;
let restoreFetch;
let modelCalls;

// 从 OpenAI 兼容请求中计算最终发往模型的消息字符数。
const getMessageChars = (request) => request.messages
  .reduce((total, message) => total + String(message.content).length, 0);

// 从响应记录中提取 SSE data 帧并解析成事件对象。
const getSseEvents = (response) => response.callOrder
  .filter((entry) => entry.op === 'write')
  .map((entry) => JSON.parse(entry.data.slice('data: '.length)));

describe('C1 / P1-3: Prompt 预算与模型调用/审计集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  beforeEach(() => {
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  after(() => {
    restoreFetch?.();
    restoreTestEnv(savedEnv);
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-PROMPT-BUDGET-01: /api/chat 预算 prompt 保持 SSE 协议并降低可审计 token', async () => {
    modelCalls.length = 0;
    const response = await invokeRoute(app, '/api/chat', {
      message: '如何设计缓存一致性？',
      context: { categoryId: 1, problemId: 42 },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    assert.equal(modelCalls.length, 1);

    const request = modelCalls[0];
    const budgetedChars = getMessageChars(request);
    const snippets = [
      {
        type: 'category',
        id: 1,
        name: '后端开发',
        groupName: '服务端',
        groupDesc: `面试缓存分类描述${'很长'.repeat(3000)}尾部_GROUP_SENTINEL`,
        count: 42,
      },
      {
        type: 'problem',
        id: 42,
        brief_name: '缓存一致性设计',
        keyPoints: Array.from({ length: 120 }, (_, index) => `缓存要点${index}`),
      },
    ];
    const prettyJsonChars = JSON.stringify(snippets, null, 2).length;
    assert.ok(budgetedChars <= promptBudget.maxChars);
    assert.ok(budgetedChars < prettyJsonChars);
    assert.ok(request.messages[1].content.includes('- 题目 #42'));
    assert.equal(request.messages[1].content.includes('尾部_GROUP_SENTINEL'), false);

    const [audit] = await readAuditLines(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const auditLines = fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim().split('\n').filter(Boolean);
    assert.equal(auditLines.length, 1);
    assert.equal(audit.reason, 'stream_done');
    assert.equal(audit.promptTokens, Math.max(1, Math.ceil(budgetedChars / 4)));
    assert.ok(audit.promptTokens < Math.ceil(prettyJsonChars / 4));
    assert.equal(audit.totalTokens, audit.promptTokens + audit.completionTokens);
  });

  it('IT-PROMPT-BUDGET-02: /answer/generate 同样应用 snippet 裁剪和总预算', async () => {
    modelCalls.length = 0;
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });

    assert.equal(response.statusCode, 200);
    assert.equal(response.callOrder.filter((entry) => entry.op === 'json').length, 1);
    assert.equal(response.callOrder.find((entry) => entry.op === 'json').payload.code, 0);
    assert.equal(response.callOrder.find((entry) => entry.op === 'json').payload.data.cached, false);
    assert.equal(modelCalls.length, 1);

    const request = modelCalls[0];
    assert.equal(request.messages[0].role, 'system');
    assert.equal(request.messages[1].role, 'user');
    assert.ok(request.messages[1].content.includes('- 题目 #42'));
    assert.equal(request.messages[1].content.includes('尾部_GROUP_SENTINEL'), false);
    assert.ok(getMessageChars(request) <= promptBudget.maxChars);
    assert.equal(request.messages[1].content.includes('"groupDesc"'), false);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
    assert.ok(audit.promptTokens > 0);
  });
});
