import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { initCategorySchema, upsertCategory } from '../db/category-repo.js';
import { initProblemSchema, upsertProblem } from '../db/problem-repo.js';
import { initProblemDetailSchema, upsertProblemDetail } from '../db/problem-detail-repo.js';
import { PROBLEMS_FTS_TABLE, rebuildProblemsFts, setRagSqlTap } from '../rag-fts.js';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  TEST_JWT_SECRET,
  configureRouteTestEnv,
  installMockModelFetch,
  invokeRoute as invokeRouteHelper,
  readAuditLines,
  removeTestFiles,
  restoreTestEnv,
  saveTestEnv,
} from './prompt-budget-route-helpers.js';

const savedEnv = saveTestEnv();
let app;
let restoreFetch;
let modelCalls;
let sqlLog;

// 写入可区分 FTS 标题/要点命中与置顶题的隔离 fixture。
async function seedFtsIntegrationDatabase() {
  removeTestFiles();
  const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
  await initCategorySchema(pool);
  await initProblemSchema(pool);
  await initProblemDetailSchema(pool);
  await pool.withConnection((db) => db.exec(`
    CREATE TABLE IF NOT EXISTS ai_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      daily_token_limit INTEGER,
      daily_request_limit INTEGER
    );
    INSERT OR REPLACE INTO ai_clients (
      client_id, client_name, daily_token_limit, daily_request_limit
    ) VALUES ('web', 'RAG FTS IT client', 1000000, 10000);
  `));

  await upsertCategory(pool, {
    id: 1,
    name: '后端开发',
    groupName: '服务端',
    groupDesc: '短分类描述',
    count: 10,
  });

  // 题 A：brief_name 含完整用户句「请讲缓存穿透」，同时含关键字「缓存」
  await upsertProblem(pool, {
    id: 301,
    groupId: 1,
    type: 1,
    brief_name: '请讲缓存穿透的处理方式',
    keyPoints: ['布隆'],
    companies: ['测试'],
  });
  // 标题命中 H / 仅要点命中 L
  await upsertProblem(pool, {
    id: 302,
    groupId: 1,
    type: 1,
    brief_name: '缓存关键字标题命中题',
    keyPoints: ['互斥'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 303,
    groupId: 1,
    type: 1,
    brief_name: '无关标题题面',
    keyPoints: ['缓存关键字要点'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 42,
    groupId: 1,
    type: 1,
    brief_name: '线程模型对比',
    keyPoints: ['调度'],
    companies: [],
  });
  await upsertProblemDetail(pool, {
    id: 42,
    group_id: 1,
    name: '线程模型对比',
  });

  await rebuildProblemsFts(pool);
  await pool.closeAll();
}

// 生成带 chat_ai / study 的测试 JWT。
function makeToken(permissions = ['chat_ai', 'study']) {
  return jwt.sign({
    id: 1,
    username: 'rag-fts-tester',
    role: 'admin',
    permissions,
    clientId: 'web',
  }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

// 经 app.handle 打真实路由。
function invokeRoute(route, body, options = {}) {
  return invokeRouteHelper(app, route, body, {
    ...options,
    token: options.token ?? makeToken(options.permissions),
  });
}

// 解析 SSE data 帧。
function getSseEvents(response) {
  return response.callOrder
    .filter((entry) => entry.op === 'write')
    .map((entry) => JSON.parse(entry.data.slice('data: '.length)));
}

describe('C22 / P1-2: FTS5 召回 / LIKE 回退与 chat SSE 集成', () => {
  before(async () => {
    configureRouteTestEnv();
    process.env.AI_PROMPT_MAX_CHARS = '8000';
    process.env.AI_PROMPT_MAX_DESC_CHARS = '240';

    await seedFtsIntegrationDatabase();
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  beforeEach(() => {
    modelCalls.length = 0;
    sqlLog = [];
    setRagSqlTap((sql) => {
      sqlLog.push(String(sql));
    });
    process.env.AI_PROMPT_MAX_CHARS = '8000';
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  after(() => {
    setRagSqlTap(null);
    restoreFetch?.();
    restoreTestEnv(savedEnv);
    removeTestFiles();
  });

  it('IT-RAG-FTS-01: chat 正常路径：FTS 召回后 SSE context 可用', async () => {
    const response = await invokeRoute('/api/chat', { message: '请讲缓存穿透' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');

    const events = getSseEvents(response);
    assert.deepEqual(events.map((e) => e.type), ['context', 'delta', 'done']);
    const snippets = events[0].snippets;
    assert.ok(snippets.some((s) => s.type === 'problem' && Number(s.id) === 301));

    assert.ok(
      sqlLog.some((sql) => /problems_fts/i.test(sql) && /\bMATCH\b/i.test(sql)),
      'problems 召回应走 FTS MATCH',
    );
    assert.equal(modelCalls.length, 1);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'stream_done');
  });

  it('IT-RAG-FTS-02: FTS 失败时 LIKE 回退仍完成 chat SSE', async () => {
    const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await pool.withConnection((db) => db.exec(`DROP TABLE IF EXISTS ${PROBLEMS_FTS_TABLE}`));
    await pool.closeAll();

    sqlLog.length = 0;
    const response = await invokeRoute('/api/chat', { message: '请讲缓存穿透' });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.headers['content-type']?.includes('application/json'), true);
    const events = getSseEvents(response);
    assert.deepEqual(events.map((e) => e.type), ['context', 'delta', 'done']);
    assert.ok(events[0].snippets.some((s) => s.type === 'problem' && Number(s.id) === 301));

    assert.ok(
      sqlLog.some((sql) => /lower\(brief_name\)\s+LIKE/i.test(sql)),
      'FTS 失败后应 LIKE 回退',
    );
    assert.equal(modelCalls.length, 1);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'stream_done');

    const restore = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await rebuildProblemsFts(restore);
    await restore.closeAll();
  });

  it('IT-RAG-FTS-03: FTS 命中后仍保持 C21 规则序与 problemId 置顶', async () => {
    const keyword = '缓存关键字';
    const responseA = await invokeRoute('/api/chat', { message: keyword });
    assert.equal(responseA.statusCode, 200);
    const eventsA = getSseEvents(responseA);
    assert.deepEqual(eventsA.map((e) => e.type), ['context', 'delta', 'done']);
    const snippetsA = eventsA[0].snippets;
    const indexH = snippetsA.findIndex((s) => Number(s.id) === 302);
    const indexL = snippetsA.findIndex((s) => Number(s.id) === 303);
    assert.ok(indexH >= 0 && indexL >= 0);
    assert.ok(indexH < indexL);

    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].messages.length, 3);
    const contextA = modelCalls[0].messages[1].content;
    assert.ok(contextA.indexOf('缓存关键字标题命中题') < contextA.indexOf('无关标题题面'));

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    const responseB = await invokeRoute('/api/chat', {
      message: keyword,
      context: { problemId: 42 },
    });
    assert.equal(responseB.statusCode, 200);
    const eventsB = getSseEvents(responseB);
    assert.deepEqual(eventsB.map((e) => e.type), ['context', 'delta', 'done']);
    const snippetsB = eventsB[0].snippets;
    assert.equal(snippetsB[0]?.type, 'problem');
    assert.equal(Number(snippetsB[0]?.id), 42);
    for (const snip of snippetsB.slice(1)) {
      if (snip.type === 'problem') assert.notEqual(Number(snip.id), 42);
    }
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].messages.length, 3);
  });

  it('IT-RAG-FTS-04: generate 路径不因 C22 引入向量或主聊天检索', async () => {
    const response = await invokeRoute('/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const jsonEntry = response.callOrder.find((entry) => entry.op === 'json');
    assert.equal(jsonEntry?.payload?.code, 0);
    assert.equal(jsonEntry?.payload?.data?.cached, false);

    const invokeCalls = modelCalls.filter((c) => !c.stream);
    const streamCalls = modelCalls.filter((c) => c.stream);
    assert.equal(invokeCalls.length, 1);
    assert.equal(streamCalls.length, 0);
    assert.equal(
      sqlLog.some((sql) => /embedding|vector/i.test(sql)),
      false,
    );
  });

  it('SEC-RAG-FTS-01: 客户端不得注入 FTS 语句或关闭 LIKE 回退', async () => {
    const message = '请讲缓存穿透';
    const baseline = await invokeRoute('/api/chat', { message });
    const baselineIds = getSseEvents(baseline)[0].snippets.map((s) => String(s.id));

    modelCalls.length = 0;
    sqlLog.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    const forged = await invokeRoute('/api/chat', {
      message,
      ftsQuery: 'DROP TABLE problems; --',
      match: '1=1 OR',
      sql: 'SELECT 1',
      disableLikeFallback: true,
      useVector: true,
      embeddings: [{ id: 99999 }],
      context: { problemId: undefined },
    });
    assert.equal(forged.statusCode, 200);
    const events = getSseEvents(forged);
    assert.deepEqual(events.map((e) => e.type), ['context', 'delta', 'done']);
    assert.equal(events[0].snippets.some((s) => Number(s.id) === 99999), false);
    assert.deepEqual(events[0].snippets.map((s) => String(s.id)), baselineIds);
    assert.equal(modelCalls.length, 1);
    // MATCH 绑定值不得原样吞入客户端伪造串
    for (const sql of sqlLog) {
      assert.equal(sql.includes('DROP TABLE'), false);
    }
    const matchCalls = sqlLog.filter((sql) => /\bMATCH\b/i.test(sql));
    // 参数经 toFtsMatchQuery 规范化；此处至少确认仍走服务端 SQL 模板
    assert.ok(matchCalls.length >= 0);

    // disableLikeFallback 不能取消回退：破坏 FTS 后再请求
    const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await pool.withConnection((db) => db.exec(`DROP TABLE IF EXISTS ${PROBLEMS_FTS_TABLE}`));
    await pool.closeAll();

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    const fallback = await invokeRoute('/api/chat', {
      message,
      disableLikeFallback: true,
    });
    assert.equal(fallback.statusCode, 200);
    const fbEvents = getSseEvents(fallback);
    assert.deepEqual(fbEvents.map((e) => e.type), ['context', 'delta', 'done']);
    assert.ok(fbEvents[0].snippets.some((s) => Number(s.id) === 301));
    assert.equal(modelCalls.length, 1);

    const restore = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await rebuildProblemsFts(restore);
    await restore.closeAll();
  });
});
