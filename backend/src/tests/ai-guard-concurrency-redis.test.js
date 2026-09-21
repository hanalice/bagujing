import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-b52-${process.pid}.ndjson`);

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

// 内存 mock：INCR/DECR + 限流所需的 PEXPIRE/PTTL，供 B52 注入而不连真实 Redis。
function createMockRedis() {
  const store = new Map();
  const incrCalls = [];
  const decrCalls = [];
  return {
    store,
    incrCalls,
    decrCalls,
    getCount(key) {
      const entry = store.get(key);
      return entry ? entry.count : 0;
    },
    async incr(key) {
      let entry = store.get(key);
      if (!entry) entry = { count: 0 };
      entry.count += 1;
      store.set(key, entry);
      incrCalls.push({ key, count: entry.count });
      return entry.count;
    },
    async decr(key) {
      let entry = store.get(key);
      if (!entry) entry = { count: 0 };
      entry.count -= 1;
      store.set(key, entry);
      decrCalls.push({ key, count: entry.count });
      return entry.count;
    },
    async set(key, value) {
      store.set(key, { count: Number(value) || 0 });
      return 'OK';
    },
    async pexpire() {
      return 1;
    },
    async pttl() {
      return 60 * 1000;
    },
  };
}

function mockHttp({ path: reqPath = '/api/chat', clientId = 'web' } = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const req = {
    method: 'POST',
    path: reqPath,
    body: { message: 'hi' },
    headers: { origin: 'http://localhost' },
    user: { clientId },
    ip: '127.0.0.1',
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req-b52';
      return this.headers[key] || '';
    },
  };
  const res = new EventEmitter();
  Object.assign(res, {
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
      return name === 'X-Request-Id' ? 'test-req-b52' : undefined;
    },
  });
  return {
    req,
    res,
    jsonCalls,
    get statusCode() {
      return statusCode;
    },
  };
}

function applyLooseEnv() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  delete process.env.REDIS_URL;
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '1000000';
}

function isCcKey(key, clientId = 'web') {
  const s = String(key);
  return s.includes('cc:') && s.includes(clientId);
}

function ccCalls(calls, clientId = 'web') {
  return calls.filter((c) => isCcKey(c.key, clientId));
}

describe('B52 / P1-7: 有 Redis 时 client 并发计数走 Redis', () => {
  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-CONC-REDIS-01: 注入 mock Redis 后准入走 INCR', async () => {
    applyLooseEnv();
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '2';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const admitted = [];
    for (let i = 0; i < 3; i += 1) {
      const http = mockHttp();
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      admitted.push({ nextCalled, status: http.statusCode, message: http.jsonCalls[0]?.message });
    }

    assert.equal(admitted[0].nextCalled, 1);
    assert.equal(admitted[1].nextCalled, 1);
    assert.equal(admitted[2].nextCalled, 0);
    assert.equal(admitted[2].status, 429);
    assert.match(String(admitted[2].message || ''), /Too many concurrent requests/);

    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'concurrency_limit'), true);
    assert.equal(audits.some((row) => row.reason === 'rate_client_minute'), false);
    assert.equal(audits.some((row) => row.reason === 'rate_client_hour'), false);
    assert.equal(audits.some((row) => row.reason === 'rate_ip_minute'), false);

    assert.ok(ccCalls(redis.incrCalls).length >= 3);
    assert.ok(ccCalls(redis.incrCalls).every((c) => isCcKey(c.key, 'web')));
    // 第三次超限：INCR 后立刻 DECR 回滚，计数不永久占满
    assert.ok(ccCalls(redis.decrCalls).length >= 1);
    assert.ok(redis.getCount('cc:web') <= 2);
  });

  it('UT-CONC-REDIS-02: close/finish 触发 Redis DECR 释放槽位', async () => {
    applyLooseEnv();
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '2';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const held = [];
    for (let i = 0; i < 2; i += 1) {
      const http = mockHttp();
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1);
      held.push(http);
    }

    const decrBefore = ccCalls(redis.decrCalls).length;
    held[0].res.emit('finish');
    await new Promise((r) => setImmediate(r));
    assert.ok(ccCalls(redis.decrCalls).length > decrBefore);

    const http3 = mockHttp();
    let next3 = 0;
    await guard.middleware(http3.req, http3.res, () => { next3 += 1; });
    assert.equal(next3, 1);
    assert.equal(http3.statusCode, 200);
  });

  it('UT-CONC-REDIS-03: releaseOnce 在 Redis 路径仍幂等', async () => {
    applyLooseEnv();
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '2';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const http = mockHttp();
    let nextCalled = 0;
    await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 1);
    assert.equal(redis.getCount('cc:web'), 1);

    http.res.emit('close');
    http.res.emit('finish');
    await new Promise((r) => setImmediate(r));

    assert.equal(ccCalls(redis.decrCalls).length, 1);
    assert.equal(redis.getCount('cc:web'), 0);

    const http2 = mockHttp();
    let next2 = 0;
    await guard.middleware(http2.req, http2.res, () => { next2 += 1; });
    assert.equal(next2, 1);
    assert.ok(ccCalls(redis.incrCalls).some((c) => c.count === 1 || c.key.includes('cc:')));
  });

  it('UT-CONC-REDIS-04: 无 Redis 时仍用进程内 Map', async () => {
    applyLooseEnv();
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '2';
    const guard = createAiGuard({ jwtSecret: 'test' });

    const held = [];
    for (let i = 0; i < 2; i += 1) {
      const http = mockHttp();
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1);
      held.push(http);
    }

    const blocked = mockHttp();
    let nextBlocked = 0;
    await guard.middleware(blocked.req, blocked.res, () => { nextBlocked += 1; });
    assert.equal(nextBlocked, 0);
    assert.equal(blocked.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'concurrency_limit'), true);

    held[0].res.emit('finish');
    const after = mockHttp();
    let nextAfter = 0;
    await guard.middleware(after.req, after.res, () => { nextAfter += 1; });
    assert.equal(nextAfter, 1);
  });

  it('UT-CONC-REDIS-05: 不改代码默认并发上限', () => {
    delete process.env.AI_MAX_CONCURRENCY_PER_CLIENT;
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.maxConcurrencyPerClient, 2);
  });

  it('UT-CONC-REDIS-06: 并发 Redis 键与 B51 限流键隔离', async () => {
    applyLooseEnv();
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '1';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const first = mockHttp();
    let next1 = 0;
    await guard.middleware(first.req, first.res, () => { next1 += 1; });
    assert.equal(next1, 1);

    const second = mockHttp();
    let next2 = 0;
    await guard.middleware(second.req, second.res, () => { next2 += 1; });
    assert.equal(next2, 0);
    assert.equal(second.statusCode, 429);

    const audits = await readAuditLines(1);
    assert.equal(audits.every((row) => row.reason === 'concurrency_limit' || row.ok !== false), true);
    assert.equal(audits.some((row) => row.reason === 'concurrency_limit'), true);
    assert.equal(audits.some((row) => String(row.reason || '').startsWith('rate_')), false);

    const concIncr = ccCalls(redis.incrCalls);
    const concDecr = ccCalls(redis.decrCalls);
    assert.ok(concIncr.length >= 1);
    assert.ok(concDecr.length >= 1);
    for (const call of [...concIncr, ...concDecr]) {
      assert.ok(isCcKey(call.key, 'web'));
      assert.equal(String(call.key).includes('rl:cmin:'), false);
      assert.equal(String(call.key).includes('rl:chour:'), false);
      assert.equal(String(call.key).includes('rl:imin:'), false);
    }
  });
});
