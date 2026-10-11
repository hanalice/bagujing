/**
 * C41 / P1-4：解析生成结构化 JSON 与失败不入库（集成）。
 * 用例 ID 对齐 docs/test_cases.md §3.14。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createSqlitePool } from '../db/sqlite-pool.js';
import { getProblemDetailById, upsertProblemAnswerById } from '../db/problem-detail-repo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THIS_SUITE_GLOB = path.join(__dirname, 'answer-structured*.test.js');

const savedEnv = saveTestEnv();
let app;
let pool;
let modelCalls;
let restoreFetch;
let invokeContentOverride;

describe('C41 / P1-4: 解析生成结构化 JSON 与失败不入库', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    invokeContentOverride = null;
    restoreFetch = installMockModelFetch(modelCalls, {
      get invokeContent() {
        return invokeContentOverride
          ?? '{"summary":"结论S","keyPoints":["K1","K2"],"nextStep":"下一步N"}';
      },
    });
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    invokeContentOverride = null;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    // 清空题 42 答案，避免用例间缓存/落库互相污染
    await pool.withConnection(async (db) => {
      await db.run(`UPDATE problem_details SET answer_html = NULL WHERE id = 42`);
    });
  });

  after(async () => {
    restoreFetch?.();
    restoreTestEnv(savedEnv);
    if (pool) await pool.closeAll();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-GEN-STRUCT-01: 合法三字段：200 入库且响应暴露字段', async () => {
    invokeContentOverride = '{"summary":"结论S","keyPoints":["K1","K2"],"nextStep":"下一步N"}';
    const before = await getProblemDetailById(pool, 42);
    const baseline = before?.answer ?? null;

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, '结论S');
    assert.equal(json.data.nextStep, '下一步N');
    assert.equal(Array.isArray(json.data.keyPoints), true);
    assert.equal(json.data.keyPoints.join(), 'K1,K2');

    const row = await getProblemDetailById(pool, 42);
    assert.notEqual(row.answer, baseline);
    const stored = JSON.parse(row.answer);
    assert.deepEqual(stored, {
      summary: '结论S',
      keyPoints: ['K1', 'K2'],
      nextStep: '下一步N',
    });

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
    assert.equal(audit.upstreamReached, true);
    assert.equal(modelCalls.length, 1);
  });

  it('IT-GEN-STRUCT-02: 脏 HTML 非 JSON：502 且 answer 不写入', async () => {
    const BASELINE_OLD = '<p>BASELINE_OLD</p>';
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: BASELINE_OLD,
      keyPoints: ['缓存要点0'],
      companies: ['测试公司'],
    });
    invokeContentOverride = '<script>x</script><p>假解析</p>';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 502);
    assert.match(String(json.message || ''), /Invalid structured answer|Empty answer/i);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, BASELINE_OLD);
    assert.equal(row.answer.includes('<script>'), false);
    assert.equal(row.answer.includes('假解析'), false);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.notEqual(audit.reason, 'generated_answer');
  });

  it('IT-GEN-STRUCT-03: 缺字段 JSON：502 不入库', async () => {
    const BASELINE = '<p>缺字段基线</p>';
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: BASELINE,
      keyPoints: ['缓存要点0'],
    });
    invokeContentOverride = '{"summary":"有结论","keyPoints":["有点"]}';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.equal(response.callOrder.find((e) => e.op === 'json')?.payload?.code, 502);
    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, BASELINE);
    assert.equal(modelCalls.length, 1);
  });

  it('IT-GEN-STRUCT-04: keyPoints 非数组：502 不入库', async () => {
    const BASELINE = '<p>keyPoints基线</p>';
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: BASELINE,
      keyPoints: ['缓存要点0'],
    });
    invokeContentOverride = '{"summary":"S","keyPoints":"单字符串","nextStep":"N"}';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((e) => e.op === 'json')?.payload;
    assert.notEqual(json?.code, 0);
    assert.equal(Array.isArray(json?.data?.keyPoints), false);
    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, BASELINE);
  });

  it('IT-GEN-STRUCT-05: 围栏 JSON 成功路径与 Prompt 契约一致', async () => {
    invokeContentOverride = '```json\n{"summary":"围栏S","keyPoints":["围栏K"],"nextStep":"围栏N"}\n```';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((e) => e.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.summary, '围栏S');
    assert.deepEqual(json.data.keyPoints, ['围栏K']);
    assert.equal(json.data.nextStep, '围栏N');

    assert.equal(modelCalls.length, 1);
    const system = modelCalls[0].messages[0].content;
    assert.ok(system.includes('JSON'));
    assert.ok(system.includes('summary'));
    assert.ok(system.includes('keyPoints'));
    assert.ok(system.includes('nextStep'));
    assert.equal(system.includes('请直接输出可用于前端展示的 HTML 片段'), false);
    assert.equal(system.includes('<p>/<h3>/<ul>/<li>'), false);

    const { messages } = modelCalls[0];
    assert.equal(messages.length, 3);
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[2].role, 'user');
  });

  it('IT-GEN-STRUCT-06: 不做前端：本项不断言页面渲染', () => {
    const suiteFiles = [
      path.join(__dirname, 'answer-structured.test.js'),
      path.join(__dirname, 'answer-structured-integration.test.js'),
    ];
    const blob = suiteFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
    // 拆开字面量，避免本断言语句自身命中扫描；不扫后端 repo 名 getProblemDetailById
    const frontendTokens = ['.' + 'vue', 'DOM' + 'Purify', 'v-' + 'html'];
    for (const token of frontendTokens) {
      assert.equal(blob.includes(token), false, `套件不得引入前端渲染判据: ${token}`);
    }
    assert.equal(/\bfrom\s+['"][^'"]*frontend[^'"]*['"]/.test(blob), false);
    assert.ok(THIS_SUITE_GLOB.includes('answer-structured'));
  });

  it('IT-GEN-STRUCT-07: 缓存命中 residual：旧 answer 不强制三字段校验', async () => {
    const OLD_HTML = '<p>旧HTML缓存</p>';
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: OLD_HTML,
      keyPoints: ['缓存要点0'],
    });

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((e) => e.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, OLD_HTML);
    assert.equal(modelCalls.length, 0);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('SEC-GEN-STRUCT-01: 客户端 body 注入三字段不能绕过模型写入库', async () => {
    invokeContentOverride = '{"summary":"MODEL_OK","keyPoints":["MK"],"nextStep":"MN"}';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {
      force: true,
      summary: 'CLIENT_INJECT',
      keyPoints: ['CLIENT_KP'],
      nextStep: 'CLIENT_NS',
      answer: 'CLIENT_ANSWER',
    });

    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((e) => e.op === 'json')?.payload;
    assert.equal(json.data.summary, 'MODEL_OK');
    assert.deepEqual(json.data.keyPoints, ['MK']);
    assert.equal(json.data.nextStep, 'MN');
    assert.equal(String(json.data.summary).includes('CLIENT_INJECT'), false);

    const row = await getProblemDetailById(pool, 42);
    const stored = JSON.parse(row.answer);
    assert.equal(stored.summary, 'MODEL_OK');
    assert.equal(stored.summary.includes('CLIENT_INJECT'), false);
    assert.equal(modelCalls.length, 1);
  });
});
