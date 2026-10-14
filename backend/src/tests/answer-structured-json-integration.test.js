/**
 * C41 / P1-4：解析生成三字段 JSON 与失败不入库（集成）。
 * 用例 ID 对齐 docs/test_cases.md §3.14。
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
import { getProblemDetailById, upsertProblemDetail } from '../db/problem-detail-repo.js';
import { GENERATE_ANSWER_SYSTEM_PROMPT } from '../answer-structured-json.js';

const savedEnv = saveTestEnv();
let app;
let pool;
let originalFetch;
let modelCalls;
/** @type {() => string} */
let getGenerateContent;

// 安装可按用例切换 content 的 OpenAI 兼容 fetch stub。
function installFlexibleGenerateFetch() {
  originalFetch = globalThis.fetch;
  modelCalls = [];
  getGenerateContent = () => JSON.stringify({
    summary: '结论',
    keyPoints: ['a', 'b'],
    nextStep: '下一步',
  });

  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    modelCalls.push(request);
    if (request.stream) {
      const events = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-c41',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'x' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-c41',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\n`,
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

    return new Response(JSON.stringify({
      id: 'chatcmpl-c41',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: getGenerateContent() },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

describe('C41 / P1-4: 解析生成三字段 JSON 集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH });
    ({ app } = await import('../server-express.js'));
    installFlexibleGenerateFetch();
  });

  beforeEach(async () => {
    modelCalls.length = 0;
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    getGenerateContent = () => JSON.stringify({
      summary: '结论',
      keyPoints: ['a', 'b'],
      nextStep: '下一步',
    });
    // 默认清空缓存答案，避免跨用例污染缓存早退
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

  it('IT-ANSWER-JSON-01: 合法 JSON 生成入库并回传三字段', async () => {
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, false);
    assert.equal(json.data.summary, '结论');
    assert.deepEqual(json.data.keyPoints, ['a', 'b']);
    assert.equal(json.data.nextStep, '下一步');

    const row = await getProblemDetailById(pool, 42);
    const stored = JSON.parse(row.answer);
    assert.equal(stored.summary, '结论');
    assert.deepEqual(stored.keyPoints, ['a', 'b']);
    assert.equal(stored.nextStep, '下一步');
    assert.equal(/<p>|<ul>/i.test(row.answer), false);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'ok');
    assert.equal(audit.reason, 'generated_answer');
    assert.notEqual(audit.upstreamReached, false);
    assert.equal(modelCalls.filter((c) => !c.stream).length, 1);
  });

  it('IT-ANSWER-JSON-02: 模型吐 HTML：502 且 answer 不更新', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-C41-OLD',
    });
    getGenerateContent = () => '<p>旧式整篇解析</p><ul><li>x</li></ul>';

    const before = await getProblemDetailById(pool, 42);
    assert.equal(before.answer, 'PRE-C41-OLD');

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 502);
    assert.ok(typeof json.message === 'string' && json.message.length > 0);

    const after = await getProblemDetailById(pool, 42);
    assert.equal(after.answer, 'PRE-C41-OLD');
    assert.equal(modelCalls.filter((c) => !c.stream).length, 1);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.status, 'error');
    assert.notEqual(audit.reason, 'generated_answer');
    assert.ok(
      audit.reason === 'invalid_structured_answer' || audit.reason === 'empty_answer',
      `失败 reason 须为校验失败等价值，实际: ${audit.reason}`,
    );
  });

  it('IT-ANSWER-JSON-03: 缺字段 / keyPoints 非字符串数组 → 502 不入库', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'PRE-C41-OLD',
    });

    const badPayloads = [
      '{"summary":"s","nextStep":"n"}',
      '{"summary":"s","keyPoints":"不是数组","nextStep":"n"}',
    ];
    for (const payload of badPayloads) {
      modelCalls.length = 0;
      try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
      getGenerateContent = () => payload;
      const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
      assert.equal(response.statusCode, 502);
      assert.equal(response.callOrder.find((entry) => entry.op === 'json')?.payload.code, 502);
      const row = await getProblemDetailById(pool, 42);
      assert.equal(row.answer, 'PRE-C41-OLD');
      const audits = await readAuditLines(1);
      assert.equal(audits.some((a) => a.reason === 'generated_answer'), false);
    }
  });

  it('IT-ANSWER-JSON-04: 围栏 JSON 成功路径与 prompt 契约', async () => {
    getGenerateContent = () => '```json\n{"summary":"围栏结论","keyPoints":["k"],"nextStep":"n"}\n```';
    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.summary, '围栏结论');
    assert.deepEqual(json.data.keyPoints, ['k']);
    assert.equal(json.data.nextStep, 'n');

    const systemContent = modelCalls[0].messages[0].content;
    assert.match(systemContent, /summary/);
    assert.match(systemContent, /keyPoints/);
    assert.match(systemContent, /nextStep/);
    assert.equal(systemContent.includes('请直接输出可用于前端展示的 HTML 片段'), false);
    assert.equal(systemContent.includes('仅 body 内'), false);
    assert.equal(systemContent.includes('<p>/<h3>/<ul>/<li>'), false);
    assert.ok(systemContent.includes(GENERATE_ANSWER_SYSTEM_PROMPT.slice(0, 20))
      || /JSON/.test(systemContent));

    const row = await getProblemDetailById(pool, 42);
    assert.equal(JSON.parse(row.answer).summary, '围栏结论');
  });

  it('IT-ANSWER-JSON-05: 缓存早退不强制重解析旧 HTML（residual）', async () => {
    const legacyHtml = '<p>legacy</p>';
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: legacyHtml,
    });
    modelCalls.length = 0;

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: false });
    assert.equal(response.statusCode, 200);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 0);
    assert.equal(json.data.cached, true);
    assert.equal(json.data.answer, legacyHtml);
    assert.equal(modelCalls.length, 0);

    const [audit] = await readAuditLines(1);
    assert.equal(audit.reason, 'cached_answer');
    assert.equal(audit.upstreamReached, false);
  });

  it('SEC-ANSWER-JSON-01: 校验失败不得用模型原文污染 answer', async () => {
    await upsertProblemDetail(pool, {
      id: 42,
      group_id: 1,
      name: '缓存一致性设计',
      answer: 'SAFE',
    });
    getGenerateContent = () => '<script>alert(1)</script><a href="javascript:xss()">x</a>';

    const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
    assert.equal(response.statusCode, 502);
    const json = response.callOrder.find((entry) => entry.op === 'json')?.payload;
    assert.equal(json.code, 502);
    assert.equal(json.data?.answer, undefined);

    const row = await getProblemDetailById(pool, 42);
    assert.equal(row.answer, 'SAFE');
    assert.equal(/<script/i.test(row.answer), false);
    assert.equal(/javascript:/i.test(row.answer), false);
    assert.equal(/<script/i.test(JSON.stringify(json)), false);
  });
});
