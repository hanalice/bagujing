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

  it('failure/abort refunds pre-debit so daily quota can serve the next request', async () => {
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
      reason: 'aborted_or_timeout',
    });

    const second = mockHttp({ method: 'POST', path: '/api/chat', body: { message: 'hi again' } });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1, 'after failure refund, next request must still be admitted');
    assert.equal(second.statusCode, 200);
  });
});
