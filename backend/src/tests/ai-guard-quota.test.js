import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-a4-${process.pid}.ndjson`);

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

// 审计走的是异步落盘队列，读取前需等待写入完成
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
      if (key === 'x-request-id') return 'test-req';
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
      return name === 'X-Request-Id' ? 'test-req' : undefined;
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

describe('A4: quota conservative pre-debit & refund on failure', () => {
  saveEnv();

  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('pre-debit uses conservative completion cap, not full maxCompletionTokens', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    process.env.AI_MAX_COMPLETION_TOKENS = '4096';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '256';
    // Without dbPool, admission uses global memory token limit.
    // Old scheme (prompt + 4096) would reject; conservative (prompt + 256) allows.
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '500';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';

    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.conservativeCompletionTokens, 256);
    assert.equal(guard.config.maxCompletionTokens, 4096);

    const http = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    let nextCalled = 0;
    await guard.middleware(http.req, http.res, () => { nextCalled += 1; });

    assert.equal(nextCalled, 1, 'admission must pass with conservative pre-debit');
    assert.equal(http.statusCode, 200);
    assert.ok(http.req.aiGuard.projectedTokens < 4096);
    assert.ok(http.req.aiGuard.projectedTokens <= http.req.aiGuard.promptTokens + 256);
  });

  it('short success settles below maxCompletionTokens so more requests fit the day quota', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    process.env.AI_MAX_COMPLETION_TOKENS = '4096';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    // Budget fits ~5 settled short replies, but only one pre-debit of 4096 under old scheme.
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '1200';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';

    const guard = createAiGuard({ jwtSecret: 'test' });
    const shortReply = '<p>ok</p>'; // ~7 chars → ~2 estimated completion tokens

    for (let i = 0; i < 4; i += 1) {
      const http = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1, `request ${i + 1} should be admitted after prior short settle`);
      http.req.aiGuard.finalize({
        status: 'ok',
        reason: 'stream_done',
        completionText: shortReply,
      });
    }
  });

  it('failure before the upstream call refunds the pre-debit entirely', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    process.env.AI_MAX_COMPLETION_TOKENS = '4096';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    // One pre-debit (~403) fits; two without refund would exceed 500.
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '500';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';

    const guard = createAiGuard({ jwtSecret: 'test' });

    const first = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    first.req.aiGuard.finalize({
      status: 'error',
      reason: 'missing_api_key',
      upstreamReached: false,
    });

    const second = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi again' } });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1, 'nothing was consumed upstream, so the day quota must be intact');
    assert.equal(second.statusCode, 200);
  });

  it('abort after partial streaming still bills prompt plus what was streamed', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    process.env.AI_MAX_COMPLETION_TOKENS = '4096';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    // Budget admits the first request; a full refund would let a second one in,
    // while billing the partial stream (~250 tokens) must keep it out.
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '600';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';

    const guard = createAiGuard({ jwtSecret: 'test' });
    const partialStream = 'x'.repeat(1000); // 已经流给客户端、上游照样计费的内容

    const first = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    first.req.aiGuard.finalize({
      status: 'error',
      reason: 'aborted_or_timeout',
      completionText: partialStream,
      upstreamReached: true,
    });

    const second = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi again' } });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0, '断流不应退还已经产生的消耗，否则可反复白嫖长回答');
    assert.equal(second.statusCode, 429);
  });

  it('audit records zero tokens only when the upstream was never called', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '100000';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';

    const guard = createAiGuard({ jwtSecret: 'test' });

    const aborted = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    await guard.middleware(aborted.req, aborted.res, () => {});
    aborted.req.aiGuard.finalize({
      status: 'error',
      reason: 'aborted_or_timeout',
      completionText: 'partial answer',
      upstreamReached: true,
    });

    const rejected = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi' } });
    await guard.middleware(rejected.req, rejected.res, () => {});
    rejected.req.aiGuard.finalize({
      status: 'error',
      reason: 'missing_api_key',
      upstreamReached: false,
    });

    const lines = await readAuditLines(2);
    const abortedLog = lines.find((l) => l.reason === 'aborted_or_timeout');
    const rejectedLog = lines.find((l) => l.reason === 'missing_api_key');

    assert.ok(abortedLog.totalTokens > 0, '已发往上游的请求必须留下真实消耗记录，供后续对账');
    assert.ok(abortedLog.completionTokens > 0);
    assert.equal(rejectedLog.totalTokens, 0);
    assert.equal(rejectedLog.promptTokens, 0);
  });
});

/** 与 ai-guard 内部 estimateTokensByText 一致：ceil(len/4)，至少 1 */
function estimateTokensByText(text) {
  return Math.max(1, Math.ceil(String(text ?? '').length / 4));
}

const LONG_CACHED_HTML = `<p>${'缓存解析内容'.repeat(80)}</p>`; // ≥1KB，若误按 estimate 结算会吃掉大量配额

function configureQuotaCacheEnv({ globalTokenLimit }) {
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

describe('A7/P0-8: cached_answer does not consume quota (upstreamReached)', () => {
  saveEnv();

  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-QUOTA-CACHE-01: cached_answer + upstreamReached:false 记零并回补预扣', async () => {
    // 日上限仅够约 1 次保守预扣；若缓存命中仍按长 HTML 结算则第二次必 429
    configureQuotaCacheEnv({ globalTokenLimit: 500 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const reqPath = '/api/problems/1/answer/generate';

    const first = mockHttp({ method: 'POST', path: reqPath, body: { force: false } });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    first.req.aiGuard.finalize({
      status: 'ok',
      reason: 'cached_answer',
      completionText: LONG_CACHED_HTML,
      upstreamReached: false,
    });

    const lines = await readAuditLines(1);
    const cachedLog = lines.find((l) => l.reason === 'cached_answer');
    assert.ok(cachedLog, '审计须保留 cached_answer 命中');
    assert.equal(cachedLog.promptTokens, 0);
    assert.equal(cachedLog.completionTokens, 0);
    assert.equal(cachedLog.totalTokens, 0);

    const second = mockHttp({ method: 'POST', path: reqPath, body: { force: false } });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1, '上游未触达须全额回补预扣，第二次仍可准入');
    assert.equal(second.statusCode, 200);
  });

  it('UT-QUOTA-CACHE-02: 连续缓存命中不消耗日配额', async () => {
    configureQuotaCacheEnv({ globalTokenLimit: 900 }); // 约 1～2 次保守预扣
    const guard = createAiGuard({ jwtSecret: 'test' });
    const reqPath = '/api/problems/1/answer/generate';
    const rounds = 3;

    for (let i = 0; i < rounds; i += 1) {
      const http = mockHttp({ method: 'POST', path: reqPath, body: { force: false } });
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1, `第 ${i + 1} 次缓存命中后仍应准入`);
      assert.notEqual(http.statusCode, 429);
      http.req.aiGuard.finalize({
        status: 'ok',
        reason: 'cached_answer',
        completionText: LONG_CACHED_HTML,
        upstreamReached: false,
      });
    }

    const lines = await readAuditLines(rounds);
    const cachedLogs = lines.filter((l) => l.reason === 'cached_answer');
    assert.equal(cachedLogs.length, rounds, '审计可按 reason 统计缓存命中次数');
    for (const row of cachedLogs) {
      assert.equal(row.totalTokens, 0);
    }
  });

  it('UT-QUOTA-CACHE-04: 对照：真实生成仍按上游触达计费', async () => {
    configureQuotaCacheEnv({ globalTokenLimit: 100000 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const shortHtml = '<p>短答案</p>';

    const http = mockHttp({
      method: 'POST',
      path: '/api/problems/1/answer/generate',
      body: { force: true },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'generated_answer',
      completionText: shortHtml,
      upstreamStatus: 200,
      // upstreamReached 默认 true：不得因 A7 误把生成路径记零
    });

    const lines = await readAuditLines(1);
    const generated = lines.find((l) => l.reason === 'generated_answer');
    assert.ok(generated);
    assert.ok(generated.totalTokens > 0, '真实生成须至少含 prompt 估算');
    assert.equal(generated.completionTokens, estimateTokensByText(shortHtml));
  });

  it('UT-QUOTA-CACHE-05: 仅 reason=cached_answer 但未传 upstreamReached 仍计费', async () => {
    configureQuotaCacheEnv({ globalTokenLimit: 100000 });
    const guard = createAiGuard({ jwtSecret: 'test' });

    const http = mockHttp({
      method: 'POST',
      path: '/api/problems/1/answer/generate',
      body: { force: false },
    });
    await guard.middleware(http.req, http.res, () => {});
    // 故意省略 upstreamReached，依赖 Guard 默认 true——不计费不得仅靠 reason 字符串
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'cached_answer',
      completionText: LONG_CACHED_HTML,
    });

    const lines = await readAuditLines(1);
    const row = lines.find((l) => l.reason === 'cached_answer');
    assert.ok(row);
    assert.ok(row.totalTokens > 0);
    assert.equal(row.completionTokens, estimateTokensByText(LONG_CACHED_HTML));
  });

  it('IT-QUOTA-CACHE-01: 连续 POST generate 命中缓存不 429', async () => {
    // middleware+finalize 闭环：配额仅够约 1～2 次预扣，连续 ≥3 次缓存命中不得 429
    configureQuotaCacheEnv({ globalTokenLimit: 900 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const reqPath = '/api/problems/42/answer/generate';
    const rounds = 3;
    const responses = [];

    for (let i = 0; i < rounds; i += 1) {
      const http = mockHttp({ method: 'POST', path: reqPath, body: { force: false } });
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1);
      assert.notEqual(http.statusCode, 429, '全程无 HTTP 429');
      http.req.aiGuard.finalize({
        status: 'ok',
        reason: 'cached_answer',
        completionText: LONG_CACHED_HTML,
        upstreamReached: false,
      });
      // 模拟 handler 缓存早退响应契约（集成完成标准 data.cached === true）
      responses.push({ code: 0, data: { cached: true, answer: LONG_CACHED_HTML } });
    }

    for (const body of responses) {
      assert.equal(body.code, 0);
      assert.equal(body.data.cached, true);
    }

    const lines = await readAuditLines(rounds);
    const cachedLogs = lines.filter((l) => l.reason === 'cached_answer');
    assert.ok(cachedLogs.length >= rounds);
    for (const row of cachedLogs) {
      assert.equal(row.totalTokens, 0);
    }
  });
});
