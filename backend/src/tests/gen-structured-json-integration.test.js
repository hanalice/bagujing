/**
 * C41 / P1-4：解析生成 JSON 三字段 / 失败不入库集成测试。
 * 用例 ID 与 docs/test_cases.md §3.14 对齐。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
import { createSqlitePool } from '../db/sqlite-pool.js';
import { getProblemDetailById, upsertProblemAnswerById } from '../db/problem-detail-repo.js';
import { GENERATE_ANSWER_SYSTEM_PROMPT } from '../structured-answer.js';

const OLD_MARKER = 'OLD_STRUCTURED_OR_HTML';
const LEGAL_JSON = JSON.stringify({
  summary: '结论文本',
  keyPoints: ['点A', '点B'],
  nextStep: '下一步文本',
});

// 安装可按 content 定制的非流式 LLM stub。
function installContentFetch(calls, contentFactory) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    calls.push(request);
    const content = typeof contentFactory === 'function'
      ? contentFactory(request)
      : contentFactory;
    return new Response(JSON.stringify({
      id: 'chatcmpl-gen-json',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => { globalThis.fetch = originalFetch; };
}

describe('C41 / P1-4: 解析生成 JSON 三字段集成', () => {
  const savedEnv = saveTestEnv();
  let app;
  let pool;
  let modelCalls;
  let restoreFetch;

  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    modelCalls = [];
    restoreFetch = installMockModelFetch(modelCalls);
  });

  beforeEach(async () => {
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    modelCalls.length = 0;
    // 默认清空答案，避免缓存早退干扰 force 路径
    await pool.withConnection((db) => db.run(
      'UPDATE problem_details SET answer_html = NULL WHERE id = ?',
      [42],
    ));
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

  it('IT-GEN-JSON-01: 合法三字段：200 入库且响应暴露字段', async () => {
    restoreFetch?.();
    restoreFetch = installContentFetch(modelCalls, LEGAL_JSON);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const payload = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(payload.code, 0);
    assert.equal(payload.data.cached, false);
    assert.equal(payload.data.summary, '结论文本');
    assert.equal(payload.data.nextStep, '下一步文本');
    assert.deepEqual(payload.data.keyPoints, ['点A', '点B']);

    const row = await getProblemDetailById(pool, 42);
    const stored = JSON.parse(row.answer);
    assert.deepEqual(stored, {
      summary: '结论文本',
      keyPoints: ['点A', '点B'],
      nextStep: '下一步文本',
    });
    assert.equal(/<p>|<ul>/i.test(row.answer), false);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'ok');
    assert.equal(audit.reason, 'generated_answer');
    assert.equal(audit.upstreamReached, true);
    assert.equal(audit.upstreamStatus, 200);
  });

  it('IT-GEN-JSON-02: 模型返回整篇 HTML：502 且不覆盖库内 answer', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: OLD_MARKER,
      keyPoints: ['k'],
      companies: ['测试公司'],
    });
    restoreFetch?.();
    restoreFetch = installContentFetch(
      modelCalls,
      '<p>结论</p><ul><li>要点</li></ul>',
    );

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const payload = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(payload.code, 502);
    assert.ok(payload.message && String(payload.message).length > 0);
    assert.equal(payload.data?.answer, undefined);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, OLD_MARKER);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.equal(audit.upstreamReached, true);
  });

  it('IT-GEN-JSON-03: JSON 缺 keyPoints：502 不入库', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: OLD_MARKER,
      keyPoints: ['k'],
      companies: ['测试公司'],
    });
    restoreFetch?.();
    restoreFetch = installContentFetch(
      modelCalls,
      JSON.stringify({ summary: 'S', nextStep: 'N' }),
    );

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    assert.equal(response.callOrder.find((e) => e.op === 'json')?.payload?.code, 502);
    assert.equal(modelCalls.length, 1);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, OLD_MARKER);
  });

  it('IT-GEN-JSON-04: keyPoints 类型错误：502 不入库', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: OLD_MARKER,
      keyPoints: ['k'],
      companies: ['测试公司'],
    });
    restoreFetch?.();
    restoreFetch = installContentFetch(
      modelCalls,
      JSON.stringify({ summary: 'S', keyPoints: '不是数组', nextStep: 'N' }),
    );

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, OLD_MARKER);
    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.equal(audit.upstreamReached, true);
  });

  it('IT-GEN-JSON-05: 围栏 JSON 成功路径与 IT-GEN-JSON-01 同构', async () => {
    restoreFetch?.();
    restoreFetch = installContentFetch(
      modelCalls,
      '```json\n{"summary":"S","keyPoints":["K"],"nextStep":"N"}\n```',
    );

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const payload = response.callOrder.find((e) => e.op === 'json')?.payload;
    assert.equal(payload.code, 0);
    assert.equal(payload.data.summary, 'S');
    assert.deepEqual(payload.data.keyPoints, ['K']);
    assert.equal(payload.data.nextStep, 'N');

    const row = await getProblemDetailById(pool, 42);
    assert.deepEqual(JSON.parse(row.answer), {
      summary: 'S',
      keyPoints: ['K'],
      nextStep: 'N',
    });
    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'generated_answer');
  });

  it('IT-GEN-JSON-06: 缓存早退不因 C41 误走解析', async () => {
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: OLD_MARKER,
      keyPoints: ['k'],
      companies: ['测试公司'],
    });
    restoreFetch?.();
    restoreFetch = installContentFetch(modelCalls, LEGAL_JSON);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', {});
    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 0);
    const payload = response.callOrder.find((e) => e.op === 'json')?.payload;
    assert.equal(payload.code, 0);
    assert.equal(payload.data.cached, true);
    assert.equal(payload.data.answer, OLD_MARKER);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('IT-GEN-JSON-07: 上游 SystemMessage 与 UT-GEN-JSON-07 文案一致', async () => {
    restoreFetch?.();
    restoreFetch = installContentFetch(modelCalls, LEGAL_JSON);

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    assert.equal(modelCalls.length, 1);
    assert.equal(modelCalls[0].messages[0].role, 'system');
    const systemContent = modelCalls[0].messages[0].content;
    assert.ok(systemContent.includes('summary'));
    assert.ok(systemContent.includes('keyPoints'));
    assert.ok(systemContent.includes('nextStep'));
    assert.match(systemContent, /JSON/i);
    assert.equal(systemContent.includes('仅 body 内'), false);
    assert.equal(
      systemContent.includes('请直接输出可用于前端展示的 HTML 片段'),
      false,
    );
    assert.equal(systemContent.includes('<p>/<h3>/<ul>/<li>'), false);
    // 常量文案应出现在 system 槽（经预算器可能附加 notice，但核心字段要求保留）
    assert.ok(systemContent.includes('keyPoints'));
    assert.equal(modelCalls[0].messages.length, 3);
    assert.equal(modelCalls[0].messages[1].role, 'user');
    assert.equal(modelCalls[0].messages[2].role, 'user');
    assert.ok(GENERATE_ANSWER_SYSTEM_PROMPT.includes('summary'));
  });

  it('SEC-GEN-JSON-01: 含 script 的脏 HTML 不得落入 answer 列', async () => {
    const cleanLegacy = '<p>clean-legacy</p>';
    await upsertProblemAnswerById(pool, {
      id: 42,
      categoryId: 1,
      name: '缓存一致性设计',
      answer: cleanLegacy,
      keyPoints: ['k'],
      companies: ['测试公司'],
    });
    restoreFetch?.();
    restoreFetch = installContentFetch(
      modelCalls,
      '<script>stealCookie()</script><a href="javascript:xss()">x</a><p>正文</p>',
    );

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, cleanLegacy);
    assert.equal(/<\/?script/i.test(row.answer), false);
    assert.equal(/javascript\s*:/i.test(row.answer), false);
  });
});
