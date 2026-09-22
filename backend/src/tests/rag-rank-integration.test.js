import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { initCategorySchema, upsertCategory } from '../db/category-repo.js';
import { initProblemSchema, upsertProblem } from '../db/problem-repo.js';
import { initProblemDetailSchema, upsertProblemDetail } from '../db/problem-detail-repo.js';
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

// 写入可区分标题命中 / 要点命中 / 置顶题的隔离 fixture。
async function seedRankIntegrationDatabase() {
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
    ) VALUES ('web', 'RAG rank IT client', 1000000, 10000);
  `));

  await upsertCategory(pool, {
    id: 1,
    name: '后端开发',
    groupName: '服务端',
    groupDesc: '短分类描述',
    count: 10,
  });

  await upsertProblem(pool, {
    id: 101,
    groupId: 1,
    type: 1,
    brief_name: '锁关键字标题命中题',
    keyPoints: ['互斥'],
    companies: ['测试'],
  });
  await upsertProblem(pool, {
    id: 102,
    groupId: 1,
    type: 1,
    brief_name: '无关标题题面',
    keyPoints: ['锁关键字要点'],
    companies: ['测试'],
  });

  await upsertProblem(pool, {
    id: 201,
    groupId: 1,
    type: 1,
    brief_name: '预算高分关键字题',
    keyPoints: ['预算高分关键字补充'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 202,
    groupId: 1,
    type: 1,
    brief_name: '预算低分无关题',
    keyPoints: ['预算高分关键字仅要点'],
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
  await upsertProblem(pool, {
    id: 43,
    groupId: 1,
    type: 1,
    brief_name: '请对比几种锁的实现',
    keyPoints: ['悲观锁'],
    companies: [],
  });
  await upsertProblemDetail(pool, {
    id: 42,
    group_id: 1,
    name: '线程模型对比',
  });

  await pool.closeAll();
}

// 生成带 chat_ai / study 的测试 JWT（与 helper 密钥一致）。
function makeToken(permissions = ['chat_ai', 'study']) {
  return jwt.sign({
    id: 1,
    username: 'rag-rank-tester',
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

describe('C21 / P1-2: 规则打分排序与 chat SSE / 预算集成', () => {
  before(async () => {
    configureRouteTestEnv();
    process.env.AI_PROMPT_MAX_CHARS = '8000';
    process.env.AI_PROMPT_MAX_DESC_CHARS = '240';

    await seedRankIntegrationDatabase();
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  beforeEach(() => {
    modelCalls.length = 0;
    process.env.AI_PROMPT_MAX_CHARS = '8000';
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  after(() => {
    restoreFetch?.();
    restoreTestEnv(savedEnv);
    removeTestFiles();
  });

  it('IT-RAG-RANK-01: chat 无 id：SSE snippets 按规则分降序', async () => {
    const keyword = '锁关键字';
    const response = await invokeRoute('/api/chat', { message: keyword });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');

    const events = getSseEvents(response);
    assert.deepEqual(events.map((e) => e.type), ['context', 'delta', 'done']);
    const snippets = events[0].snippets;
    assert.ok(Array.isArray(snippets));
    const indexA = snippets.findIndex((s) => Number(s.id) === 101);
    const indexB = snippets.findIndex((s) => Number(s.id) === 102);
    assert.ok(indexA >= 0 && indexB >= 0);
    assert.ok(indexA < indexB);

    assert.equal(modelCalls.length, 1);
    const contextContent = modelCalls[0].messages[1].content;
    assert.ok(contextContent.indexOf('锁关键字标题命中题') < contextContent.indexOf('无关标题题面'));

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'stream_done');
  });

  it('IT-RAG-RANK-02: chat 指定 problemId 置顶后仍保持 SSE 协议', async () => {
    const response = await invokeRoute('/api/chat', {
      message: '请对比几种锁',
      context: { problemId: 42, categoryId: 1 },
    });
    assert.equal(response.statusCode, 200);
    const events = getSseEvents(response);
    assert.deepEqual(events.map((e) => e.type), ['context', 'delta', 'done']);
    const snippets = events[0].snippets;
    assert.equal(snippets[0]?.type, 'problem');
    assert.equal(Number(snippets[0]?.id), 42);
    for (const snip of snippets.slice(1)) {
      if (snip.type === 'problem') assert.notEqual(Number(snip.id), 42);
    }

    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].messages.length, 3);
    const contextContent = modelCalls[0].messages[1].content;
    assert.ok(contextContent.includes('#42') || contextContent.includes('线程模型对比'));
    const firstBullet = contextContent.split('\n').find((line) => line.startsWith('- '));
    assert.ok(firstBullet.includes('#42') || firstBullet.includes('线程模型对比'));
  });

  it('IT-RAG-RANK-03: 收紧预算时只从已排序队尾丢条', async () => {
    const wide = await invokeRoute('/api/chat', { message: '预算高分关键字' });
    const wideEvents = getSseEvents(wide);
    const wideSnippets = wideEvents[0].snippets;
    const indexH = wideSnippets.findIndex((s) => Number(s.id) === 201);
    const indexL = wideSnippets.findIndex((s) => Number(s.id) === 202);
    assert.ok(indexH >= 0 && indexL >= 0);
    assert.ok(indexH < indexL);

    const wideContext = modelCalls[0].messages[1].content;
    const hMarker = '预算高分关键字题';
    const lMarker = '预算低分无关题';
    assert.ok(wideContext.includes(hMarker));
    assert.ok(wideContext.includes(lMarker));

    const systemLen = modelCalls[0].messages[0].content.length;
    const userLen = modelCalls[0].messages[2].content.length;
    const hBulletLine = wideContext.split('\n').find((line) => line.includes(hMarker));
    const emptyWrap = '相关背景知识片段（可参考）：\n<context>\n\n</context>'.length;
    process.env.AI_PROMPT_MAX_CHARS = String(systemLen + userLen + emptyWrap + hBulletLine.length + 8);

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    const tight = await invokeRoute('/api/chat', { message: '预算高分关键字' });
    assert.equal(tight.statusCode, 200);
    const tightEvents = getSseEvents(tight);
    assert.deepEqual(tightEvents.map((e) => e.type), ['context', 'delta', 'done']);
    const tightSnippets = tightEvents[0].snippets;
    const tightIndexH = tightSnippets.findIndex((s) => Number(s.id) === 201);
    const tightIndexL = tightSnippets.findIndex((s) => Number(s.id) === 202);
    assert.ok(tightIndexH >= 0);
    if (tightIndexL >= 0) assert.ok(tightIndexH < tightIndexL);

    assert.equal(modelCalls.length, 1);
    const tightContext = modelCalls[0].messages[1].content;
    assert.ok(tightContext.includes(hMarker));
    assert.equal(tightContext.includes(lMarker), false);
  });

  it('IT-RAG-RANK-04: generate 路径不因 C21 改为主聊天打分', async () => {
    const response = await invokeRoute('/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const jsonEntry = response.callOrder.find((entry) => entry.op === 'json');
    assert.equal(jsonEntry?.payload?.code, 0);
    assert.equal(jsonEntry?.payload?.data?.cached, false);

    const invokeCalls = modelCalls.filter((c) => !c.stream);
    const streamCalls = modelCalls.filter((c) => c.stream);
    assert.equal(invokeCalls.length, 1);
    assert.equal(streamCalls.length, 0);
  });

  it('SEC-RAG-RANK-01: 客户端不得注入分数或改写排序', async () => {
    const keyword = '锁关键字';
    const baseline = await invokeRoute('/api/chat', { message: keyword });
    const baselineIds = getSseEvents(baseline)[0].snippets.map((s) => String(s.id));

    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }

    const forged = await invokeRoute('/api/chat', {
      message: keyword,
      snippets: [{ type: 'problem', id: 99999, brief_name: '伪造高分', score: 9999 }],
      scores: { 102: 9999, 101: 0 },
      rank: [102, 101],
      context: {
        snippets: [{ type: 'problem', id: 99999, brief_name: '伪造高分', score: 9999 }],
      },
    });
    assert.equal(forged.statusCode, 200);
    const events = getSseEvents(forged);
    assert.deepEqual(events.map((e) => e.type), ['context', 'delta', 'done']);
    const snippets = events[0].snippets;
    assert.equal(snippets.some((s) => Number(s.id) === 99999), false);
    assert.deepEqual(snippets.map((s) => String(s.id)), baselineIds);
    assert.equal(modelCalls.length, 1);
  });
});
