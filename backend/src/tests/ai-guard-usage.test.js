/**
 * C51 / P1-6：finalize 有上游 usage 则回写审计，否则标记估算。
 * 用例 ID 对齐 docs/test_cases.md §2.26。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-c51-${process.pid}.ndjson`);

const ENV_KEYS = [
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_MAX_COMPLETION_TOKENS',
  'AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
];

const savedEnv = {};

function saveEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

/** 与 ai-guard 内部 estimateTokensByText 一致：ceil(len/4)，至少 1 */
function estimateTokensByText(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

async function readAuditLines(expectedCount, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim() : '';
    const lines = raw ? raw.split('\n') : [];
    if (lines.length >= expectedCount) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`审计日志在 ${timeoutMs}ms 内未写满 ${expectedCount} 条`);
}

function mockHttp({ method, path: reqPath, body }) {
  let statusCode = 200;
  const jsonCalls = [];
  const req = {
    method,
    path: reqPath,
    body,
    headers: {},
    user: { clientId: 'web' },
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req-c51';
      return '';
    },
  };
  const res = {
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader() {},
    getHeader(name) {
      return name === 'X-Request-Id' ? 'test-req-c51' : undefined;
    },
    once() {},
  };
  return {
    req,
    res,
    jsonCalls,
    get statusCode() {
      return statusCode;
    },
  };
}

function configureUsageEnv({ globalTokenLimit = 100000 } = {}) {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_MAX_COMPLETION_TOKENS = '4096';
  process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = String(globalTokenLimit);
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';
}

describe('C51 / P1-6: 上游 usage 回写审计与估算打标', () => {
  saveEnv();

  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-USAGE-01: 双字段 usage 齐全 → 审计回写 upstream', async () => {
    configureUsageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const completionText = 'abcd'.repeat(50);
    const http = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'usage-up' } });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText,
      upstreamReached: true,
      upstreamStatus: 200,
      usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 },
    });

    const [row] = await readAuditLines(1);
    assert.equal(row.decision, 'allow');
    assert.equal(row.reason, 'stream_done');
    assert.equal(row.promptTokens, 123);
    assert.equal(row.completionTokens, 45);
    assert.equal(row.totalTokens, 168);
    assert.equal(row.token_source, 'upstream');
    assert.notEqual(row.completionTokens, estimateTokensByText(completionText));
  });

  it('UT-USAGE-02: 无 usage → 估算并标 estimate（residual）', async () => {
    configureUsageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const completionText = 'hello-world-estimate';
    const http = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'usage-up' } });
    await guard.middleware(http.req, http.res, () => {});
    const expectedPrompt = http.req.aiGuard.promptTokens;
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText,
      upstreamReached: true,
      upstreamStatus: 200,
    });

    const [row] = await readAuditLines(1);
    assert.equal(row.completionTokens, estimateTokensByText(completionText));
    assert.equal(row.promptTokens, expectedPrompt);
    assert.ok(Number.isFinite(row.promptTokens) && row.promptTokens > 0);
    assert.equal(row.totalTokens, row.promptTokens + row.completionTokens);
    assert.equal(row.token_source, 'estimate');
  });

  it('UT-USAGE-03: 仅有单侧 usage 字段 → 整段落估算', async () => {
    configureUsageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const completionText = 'partial-usage-text';
    const cases = [
      { prompt_tokens: 50 },
      { completion_tokens: 50 },
    ];

    for (const usage of cases) {
      try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
      const http = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'partial' } });
      await guard.middleware(http.req, http.res, () => {});
      http.req.aiGuard.finalize({
        status: 'ok',
        reason: 'stream_done',
        completionText,
        upstreamReached: true,
        usage,
      });
      const [row] = await readAuditLines(1);
      assert.equal(row.token_source, 'estimate');
      assert.equal(row.completionTokens, estimateTokensByText(completionText));
      assert.notEqual(row.completionTokens, 50);
    }
  });

  it('UT-USAGE-04: usage 非有限/负数 → 估算', async () => {
    configureUsageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const completionText = 'bad-usage-text';
    const cases = [
      { prompt_tokens: NaN, completion_tokens: 1 },
      { prompt_tokens: 1, completion_tokens: -1 },
      { prompt_tokens: 'x', completion_tokens: 1 },
      null,
      {},
    ];

    for (const usage of cases) {
      try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
      const http = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'bad' } });
      await guard.middleware(http.req, http.res, () => {});
      assert.doesNotThrow(() => {
        http.req.aiGuard.finalize({
          status: 'ok',
          reason: 'stream_done',
          completionText,
          upstreamReached: true,
          usage,
        });
      });
      const [row] = await readAuditLines(1);
      assert.equal(row.token_source, 'estimate');
      assert.equal(row.completionTokens, estimateTokensByText(completionText));
      assert.equal(row.decision, 'allow');
    }
  });

  it('UT-USAGE-05: generate 路径：usage 优先于 completionText 估算', async () => {
    configureUsageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const completionText = JSON.stringify({
      summary: '很长结论'.repeat(20),
      keyPoints: ['a'.repeat(40), 'b'.repeat(40)],
      nextStep: '下一步'.repeat(20),
    });
    assert.ok(estimateTokensByText(completionText) >= 20);

    const http = mockHttp({
      method: 'POST',
      path: '/api/problems/1/answer/generate',
      body: { force: true },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'generated_answer',
      completionText,
      upstreamReached: true,
      upstreamStatus: 200,
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    });

    const [row] = await readAuditLines(1);
    assert.equal(row.reason, 'generated_answer');
    assert.equal(row.promptTokens, 11);
    assert.equal(row.completionTokens, 7);
    assert.equal(row.totalTokens, 18);
    assert.equal(row.token_source, 'upstream');
    assert.notEqual(row.completionTokens, estimateTokensByText(completionText));
  });

  it('UT-USAGE-06: cached_answer + usage 仍记零（与 A7 合取）', async () => {
    configureUsageEnv({ globalTokenLimit: 500 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const longHtml = `<p>${'缓存解析内容'.repeat(80)}</p>`;
    const http = mockHttp({
      method: 'POST',
      path: '/api/problems/1/answer/generate',
      body: { force: false },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'cached_answer',
      completionText: longHtml,
      upstreamReached: false,
      usage: { prompt_tokens: 999, completion_tokens: 999 },
    });

    const [row] = await readAuditLines(1);
    assert.equal(row.promptTokens, 0);
    assert.equal(row.completionTokens, 0);
    assert.equal(row.totalTokens, 0);
    assert.notEqual(row.token_source === 'upstream' && row.totalTokens > 0, true);
  });

  it('UT-USAGE-07: upstream 回写后配额按实际 usage 结算', async () => {
    // 预扣约 prompt+400；若误按很长 completionText 估算则第二次 429
    configureUsageEnv({ globalTokenLimit: 500 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const longCompletion = 'x'.repeat(4000);

    const first = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    first.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: longCompletion,
      upstreamReached: true,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const [row] = await readAuditLines(1);
    assert.equal(row.token_source, 'upstream');
    assert.equal(row.totalTokens, 15);

    const second = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1, '按小 usage 结算后第二次仍可准入');
    assert.notEqual(second.statusCode, 429);
  });
});
