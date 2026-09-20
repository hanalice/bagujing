import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-b51-${process.pid}.ndjson`);

const ENV_KEYS = [
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'REDIS_URL',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
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

// 内存 mock：实现 INCR + PEXPIRE + PTTL，供 B51 注入而不连真实 Redis。
function createMockRedis() {
  const store = new Map();
  const incrCalls = [];
  const pexpireCalls = [];
  return {
    incrCalls,
    pexpireCalls,
    async incr(key) {
      const now = Date.now();
      let entry = store.get(key);
      if (!entry || (Number.isFinite(entry.expireAt) && entry.expireAt <= now)) {
        entry = { count: 0, expireAt: Number.POSITIVE_INFINITY };
      }
      entry.count += 1;
      store.set(key, entry);
      incrCalls.push({ key, count: entry.count });
      return entry.count;
    },
    async pexpire(key, ttlMs) {
      pexpireCalls.push({ key, ttlMs });
      const entry = store.get(key);
      if (!entry) return 0;
      entry.expireAt = Date.now() + Number(ttlMs);
      return 1;
    },
    async pttl(key) {
      const entry = store.get(key);
      if (!entry) return -2;
      if (!Number.isFinite(entry.expireAt)) return -1;
      return Math.max(0, entry.expireAt - Date.now());
    },
  };
}

function mockHttp({ path: reqPath = '/api/chat', forwardedFor } = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const req = {
    method: 'POST',
    path: reqPath,
    body: { message: 'hi' },
    headers: {
      origin: 'http://localhost',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    user: { clientId: 'web' },
    ip: forwardedFor || '127.0.0.1',
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req-b51';
      if (key === 'x-forwarded-for') return this.headers['x-forwarded-for'] || '';
      return this.headers[key] || '';
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
      return name === 'X-Request-Id' ? 'test-req-b51' : undefined;
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

function applyLooseQuotaEnv() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  delete process.env.REDIS_URL;
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '20';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '1000000';
}

describe('B51 / P1-7: 有 Redis 时限流走 INCR+TTL', () => {
  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-RATE-REDIS-01: 注入 mock Redis 后 client 分钟限流走 INCR', async () => {
    applyLooseQuotaEnv();
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '2';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const admitted = [];
    for (let i = 0; i < 3; i += 1) {
      const http = mockHttp();
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      admitted.push({ nextCalled, status: http.statusCode });
    }

    assert.equal(admitted[0].nextCalled, 1);
    assert.equal(admitted[1].nextCalled, 1);
    assert.equal(admitted[2].nextCalled, 0);
    assert.equal(admitted[2].status, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_client_minute'), true);
    assert.equal(audits.some((row) => row.reason === 'concurrency_limit'), false);
    assert.ok(redis.incrCalls.some((call) => String(call.key).includes('rl:cmin:')));
    const firstCmin = redis.incrCalls.find((call) => String(call.key).includes('rl:cmin:') && call.count === 1);
    assert.ok(firstCmin);
    assert.ok(redis.pexpireCalls.some((call) => call.key === firstCmin.key && call.ttlMs === 60 * 1000));
  });

  it('UT-RATE-REDIS-02: client 小时窗口同样走 Redis', async () => {
    applyLooseQuotaEnv();
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '2';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    let lastStatus = 200;
    let lastNext = 1;
    for (let i = 0; i < 3; i += 1) {
      const http = mockHttp();
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      lastStatus = http.statusCode;
      lastNext = nextCalled;
    }
    assert.equal(lastNext, 0);
    assert.equal(lastStatus, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_client_hour'), true);
    const firstChour = redis.incrCalls.find((call) => String(call.key).includes('rl:chour:') && call.count === 1);
    assert.ok(firstChour);
    assert.ok(redis.pexpireCalls.some((call) => call.key === firstChour.key && call.ttlMs === 60 * 60 * 1000));
  });

  it('UT-RATE-REDIS-03: ip 分钟窗口走 Redis', async () => {
    applyLooseQuotaEnv();
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '2';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    let lastStatus = 200;
    for (let i = 0; i < 3; i += 1) {
      const http = mockHttp({ forwardedFor: '203.0.113.9' });
      await guard.middleware(http.req, http.res, () => {});
      lastStatus = http.statusCode;
    }
    assert.equal(lastStatus, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_ip_minute'), true);
    assert.ok(redis.incrCalls.some((call) => String(call.key).includes('rl:imin:')));
  });

  it('UT-RATE-REDIS-04: 无 Redis 时仍用进程内 Map', async () => {
    applyLooseQuotaEnv();
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '2';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
    const guard = createAiGuard({ jwtSecret: 'test' });

    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      const http = mockHttp();
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      statuses.push({ nextCalled, status: http.statusCode });
    }
    assert.equal(statuses[0].nextCalled, 1);
    assert.equal(statuses[1].nextCalled, 1);
    assert.equal(statuses[2].status, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_client_minute'), true);
  });

  it('UT-RATE-REDIS-05: 不改代码默认限流数字', () => {
    delete process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE;
    delete process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR;
    delete process.env.AI_RATE_LIMIT_IP_PER_MINUTE;
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.minuteLimitPerClient, 10);
    assert.equal(guard.config.hourLimitPerClient, 100);
    assert.equal(guard.config.minuteLimitPerIp, 30);
  });
});
