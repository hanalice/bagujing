import { after, before, describe, it } from 'node:test';
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

// 计算单次模型请求中所有消息 content 的 JavaScript 字符总数。
const getMessageChars = (request) => request.messages
  .reduce((total, message) => total + String(message.content).length, 0);

describe('C1 / P1-3: 超大内部 snippet 的资源边界防护', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase({ huge: true });
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  after(() => {
    restoreFetch?.();
    restoreTestEnv(savedEnv);
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('SEC-PROMPT-BUDGET-01: 数据库超大描述与要点无法突破模型 prompt 上限', async () => {
    modelCalls.length = 0;
    const chatResponse = await invokeRoute(app, '/api/chat', {
      message: '缓存一致性',
      context: { categoryId: 1, problemId: 42 },
    });
    const generateResponse = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });

    assert.equal(chatResponse.statusCode, 200);
    assert.equal(generateResponse.statusCode, 200);
    assert.equal(generateResponse.callOrder.find((entry) => entry.op === 'json').payload.code, 0);
    assert.equal(modelCalls.length, 2);
    for (const request of modelCalls) {
      assert.ok(getMessageChars(request) <= promptBudget.maxChars);
      assert.equal(request.messages.some((message) => String(message.content).includes('尾部_GROUP_SENTINEL')), false);
    }

    const chatFrames = chatResponse.callOrder
      .filter((entry) => entry.op === 'write')
      .map((entry) => JSON.parse(entry.data.slice('data: '.length)));
    assert.deepEqual(chatFrames.map((frame) => frame.type), ['context', 'delta', 'done']);
    const audits = await readAuditLines(2);
    assert.deepEqual(audits.map((audit) => audit.reason).sort(), ['generated_answer', 'stream_done']);
    assert.equal(audits.every((audit) => audit.status === 'ok'), true);
  });
});
