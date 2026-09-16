import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { upsertCategory } from '../db/category-repo.js';
import {
  PROBE_IGNORE_SYSTEM,
  PROBE_ASK_KEY,
  PROBE_CHANGE_ROLE,
  PROBE_CONTEXT_INJECT,
} from '../prompt-budget.js';
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

const USER_PROBES = [PROBE_IGNORE_SYSTEM, PROBE_ASK_KEY, PROBE_CHANGE_ROLE];

describe('B1 / P0-6: 注入结构安全', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await upsertCategory(pool, {
      id: 1,
      name: '后端开发',
      groupName: '服务端',
      groupDesc: `${PROBE_CONTEXT_INJECT} 面试缓存分类描述`,
      count: 42,
    });
    await pool.closeAll();
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

  it('SEC-PROMPT-SLOT-01: 五条探针均不进入 system', async () => {
    modelCalls.length = 0;
    const chatResponse = await invokeRoute(app, '/api/chat', {
      message: `缓存问题 ${PROBE_IGNORE_SYSTEM} ${PROBE_ASK_KEY} ${PROBE_CHANGE_ROLE}`,
      context: { categoryId: 1, problemId: 42 },
    });
    const generateResponse = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });

    assert.equal(chatResponse.statusCode, 200);
    assert.equal(generateResponse.statusCode, 200);
    assert.equal(modelCalls.length, 2);

    for (const request of modelCalls) {
      const [system, context, user] = request.messages;
      assert.equal(system.role, 'system');
      for (const probe of [...USER_PROBES, PROBE_CONTEXT_INJECT]) {
        assert.equal(system.content.includes(probe), false);
      }
      assert.equal(context.content.includes(PROBE_CONTEXT_INJECT), true);
      assert.equal(user.content.includes(PROBE_CONTEXT_INJECT), false);
    }

    const chatUser = modelCalls[0].messages[2].content;
    for (const probe of USER_PROBES) {
      assert.equal(chatUser.includes(probe), true);
      assert.equal(modelCalls[0].messages[1].content.includes(probe), false);
    }
  });
});
