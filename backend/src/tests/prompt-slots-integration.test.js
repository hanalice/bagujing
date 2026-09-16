import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROBE_IGNORE_SYSTEM, PROMPT_UNTRUSTED_DATA_NOTICE } from '../prompt-budget.js';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  installMockModelFetch,
  invokeRoute,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';

const savedEnv = saveTestEnv();
let app;
let restoreFetch;
let modelCalls;

const getSseEvents = (response) => response.callOrder
  .filter((entry) => entry.op === 'write')
  .map((entry) => JSON.parse(entry.data.slice('data: '.length)));

describe('B1 / P0-6: Prompt 分槽路由集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  beforeEach(() => {
    modelCalls.length = 0;
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

  it('IT-PROMPT-SLOT-01: chat 上游三条消息且攻击句不在 system', async () => {
    const response = await invokeRoute(app, '/api/chat', {
      message: `请解释缓存。${PROBE_IGNORE_SYSTEM}`,
      context: { categoryId: 1, problemId: 42 },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    assert.equal(modelCalls.length, 1);
    const { messages } = modelCalls[0];
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[2].role, 'user');
    assert.equal(messages[0].content.includes(PROMPT_UNTRUSTED_DATA_NOTICE), true);
    assert.equal(messages[0].content.includes(PROBE_IGNORE_SYSTEM), false);
    assert.equal(messages[2].content.includes(PROBE_IGNORE_SYSTEM), true);
  });

  it('IT-PROMPT-SLOT-02: generate 同样分槽', async () => {
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });

    assert.equal(response.statusCode, 200);
    assert.equal(response.callOrder.find((entry) => entry.op === 'json').payload.code, 0);
    assert.equal(modelCalls.length, 1);
    const { messages } = modelCalls[0];
    assert.equal(messages.length, 3);
    assert.match(messages[1].content, /- 题目 #42/);
    assert.match(messages[2].content, /题目：缓存一致性设计/);
  });
});
