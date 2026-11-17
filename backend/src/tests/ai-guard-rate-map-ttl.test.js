/**
 * S17：无 Redis 时限流内存 Map 淘汰已过期窗口键。
 * 实现选 (A) 惰性扫：takeFixedWindow 访问时删除 now >= resetAt 的条目。
 * 用例 ID 对齐 docs/test_cases.md §2.48 / §3.26。
 * UT-RATE-TTL-05：N/A（见 UT-RATE-TTL-03/04，(A) 已覆盖「无二次 take 即消失」）。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard, takeFixedWindow } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s17-${process.pid}.ndjson`);

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
const originalDateNow = Date.now;

/** 恢复 env、Date.now，并清理审计文件。 */
function restoreAll() {
  Date.now = originalDateNow;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
}

/**
 * 放宽配额/并发；不注入 Redis；关闭验签。
 * @param {{ minute?: number, hour?: number, ipMinute?: number }} [limits]
 */
function applyNoRedisEnv({ minute = 1000, hour = 10000, ipMinute = 1000 } = {}) {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  delete process.env.REDIS_URL;
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = String(minute);
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = String(hour);
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = String(ipMinute);
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';
}

/** @param {number} value */
function installFakeNow(value) {
  let current = value;
  Date.now = () => current;
  return {
    get() { return current; },
    set(next) { current = next; },
    advance(delta) { current += delta; return current; },
  };
}

/**
 * mock middleware HTTP；可捕获 Retry-After。
 * @param {{ path?: string, forwardedFor?: string, clientId?: string, ip?: string }} [opts]
 */
function mockHttp({
  path: reqPath = '/api/chat',
  forwardedFor,
  clientId = 'web',
  ip = '127.0.0.1',
} = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const headersSet = {};
  const req = {
    method: 'POST',
    path: reqPath,
    body: { message: 'hi' },
    headers: {
      origin: 'http://localhost',
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
    user: { clientId },
    ip: forwardedFor || ip,
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req-s17';
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
    setHeader(name, value) {
      headersSet[String(name).toLowerCase()] = String(value);
    },
    getHeader(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req-s17';
      return headersSet[key];
    },
    once() {},
  };
  return {
    req,
    res,
    jsonCalls,
    headersSet,
    get statusCode() { return statusCode; },
  };
}

/** 审计异步落盘，轮询至期望条数。 */
async function readAuditLines(expectedCount, timeoutMs = 2000) {
  const deadline = originalDateNow() + timeoutMs;
  while (originalDateNow() < deadline) {
    const raw = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim() : '';
    const lines = raw ? raw.split('\n') : [];
    if (lines.length >= expectedCount) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`审计日志在 ${timeoutMs}ms 内未写满 ${expectedCount} 条`);
}

/**
 * 调用 middleware 一次。
 * @param {ReturnType<typeof createAiGuard>} guard
 * @param {Parameters<typeof mockHttp>[0]} [opts]
 */
async function invoke(guard, opts = {}) {
  const http = mockHttp(opts);
  let nextCount = 0;
  await guard.middleware(http.req, http.res, () => { nextCount += 1; });
  return { http, nextCount };
}

/** mock Redis：INCR + PEXPIRE + PTTL，不连真实实例。 */
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

describe('S17: 无 Redis 时限流内存 Map 淘汰已过期窗口键', () => {
  afterEach(restoreAll);

  it('UT-RATE-TTL-01: 无 Redis：窗口内超限仍 429 rate_client_minute', async () => {
    applyNoRedisEnv({ minute: 2, hour: 1000, ipMinute: 1000 });
    installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });

    const r1 = await invoke(guard);
    const r2 = await invoke(guard);
    const r3 = await invoke(guard);

    assert.equal(r1.nextCount, 1);
    assert.equal(r2.nextCount, 1);
    assert.equal(r3.nextCount, 0);
    assert.equal(r3.http.statusCode, 429);
    const retryAfter = Number(r3.http.headersSet['retry-after']);
    assert.ok(Number.isFinite(retryAfter) && retryAfter >= 1);
    assert.match(String(r3.http.jsonCalls[0]?.message ?? ''), /Too many requests \(client per minute\)/);

    const audits = await readAuditLines(1);
    assert.equal(
      audits.some((row) => row.decision === 'reject' && row.reason === 'rate_client_minute'),
      true,
    );
  });

  it('UT-RATE-TTL-02: 无 Redis：窗口外同 key 计数重建可再准入', async () => {
    applyNoRedisEnv({ minute: 2, hour: 1000, ipMinute: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });

    assert.equal((await invoke(guard)).nextCount, 1);
    assert.equal((await invoke(guard)).nextCount, 1);

    const maps = guard.getRateLimitMapsForTests();
    const keyA = 'chat:web:127.0.0.1';
    const entry = maps.routeClientMinute.get(keyA);
    assert.ok(entry);
    // 推进到 now' >= resetAt，旧 count 不得跨窗口残留
    clock.set(entry.resetAt);

    const r3 = await invoke(guard);
    const r4 = await invoke(guard);
    assert.equal(r3.nextCount, 1);
    assert.equal(r4.nextCount, 1);
    assert.notEqual(r3.http.statusCode, 429);
    assert.notEqual(r4.http.statusCode, 429);
  });

  it('UT-RATE-TTL-03: 核心：假时钟过期后键不在 Map（不再 take 同一 key）', () => {
    // 过程中零次对 keyA 的 take（过期后仅 take keyB 触发惰性扫）
    const store = new Map();
    const t0 = 1_000_000;
    const windowMs = 60_000;
    const keyA = 'chat:web:127.0.0.1';
    const keyB = 'chat:other:127.0.0.1';

    takeFixedWindow(store, keyA, t0, windowMs, 10);
    assert.equal(store.has(keyA), true);
    const resetAt = store.get(keyA).resetAt;
    assert.equal(resetAt, t0 + windowMs);

    const nowExpired = resetAt; // now >= resetAt
    // 禁止再对 keyA 调用 take
    takeFixedWindow(store, keyB, nowExpired, windowMs, 10);

    assert.equal(store.has(keyA), false);
    assert.equal(store.has(keyB), true);
  });

  it('UT-RATE-TTL-04: 惰性扫：take 其它 key 时清掉已过期条目', () => {
    const store = new Map();
    const t0 = 2_000_000;
    const windowMs = 60_000;
    const keyA = 'chat:web:10.0.0.1';
    const keyB = 'chat:web:10.0.0.2';
    const keyC = 'chat:web:10.0.0.3';

    takeFixedWindow(store, keyA, t0, windowMs, 5);
    // keyC 窗口更晚：resetAt = t0+30_000+windowMs，在 now' 时仍未过期
    takeFixedWindow(store, keyC, t0 + 30_000, windowMs, 5);
    const resetA = store.get(keyA).resetAt;
    const entryC = { ...store.get(keyC) };

    const nowPrime = resetA; // >= resetAt(A) 且 < resetAt(C)
    assert.ok(nowPrime < entryC.resetAt);

    const resultB = takeFixedWindow(store, keyB, nowPrime, windowMs, 5);
    assert.equal(resultB.ok, true);
    assert.equal(store.has(keyA), false);
    assert.equal(store.has(keyC), true);
    assert.equal(store.get(keyC).count, entryC.count);
    assert.equal(store.get(keyC).resetAt, entryC.resetAt);
    assert.equal(store.get(keyB).count, 1);
  });

  it('UT-RATE-TTL-05: setTimeout 路径：到期删除且无需二次 take（若选 B）', () => {
    // N/A：实现选 (A) 惰性扫；同等「无二次 take 即消失」已由 UT-RATE-TTL-03/04 覆盖
    const store = new Map();
    const t0 = 3_000_000;
    const keyA = 'chat:web:127.0.0.1';
    takeFixedWindow(store, keyA, t0, 100, 2);
    const resetAt = store.get(keyA).resetAt;
    takeFixedWindow(store, 'chat:other:1', resetAt, 100, 2);
    assert.equal(store.has(keyA), false);
  });

  it('UT-RATE-TTL-06: routeClientHour：过期键同样淘汰', async () => {
    applyNoRedisEnv({ minute: 1000, hour: 2, ipMinute: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const keyA = 'chat:web:127.0.0.1';

    assert.equal((await invoke(guard)).nextCount, 1);
    const maps = guard.getRateLimitMapsForTests();
    assert.equal(maps.routeClientHour.has(keyA), true);
    const resetAt = maps.routeClientHour.get(keyA).resetAt;

    // 推进 >= 3_600_000（或该条目 resetAt）；不再 take keyA
    clock.set(resetAt);
    // 同 client 换 IP → 另一 limitKey，触发 hour Map 惰性扫（避免未登记 clientId 在限流前 401）
    await invoke(guard, { forwardedFor: '10.0.0.99' });

    assert.equal(maps.routeClientHour.has(keyA), false);

    // 新窗口同 client 可再 take 至 limit，不应因旧 hour count 直接 429
    const rNew = await invoke(guard);
    assert.equal(rNew.nextCount, 1);
    assert.notEqual(rNew.http.statusCode, 429);
  });

  it('UT-RATE-TTL-07: routeIpMinute：过期键同样淘汰', async () => {
    applyNoRedisEnv({ minute: 1000, hour: 10000, ipMinute: 2 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const ip = '203.0.113.40';
    const ipKey = `chat:${ip}`;

    assert.equal((await invoke(guard, { forwardedFor: ip })).nextCount, 1);
    const maps = guard.getRateLimitMapsForTests();
    assert.equal(maps.routeIpMinute.has(ipKey), true);
    // 同一次写入也进了 client 分钟 Map；稍后断言未误清未过期的 client 分钟键需在扫之前留住未过期条目
    const clientKey = `chat:web:${ip}`;
    assert.equal(maps.routeClientMinute.has(clientKey), true);

    const resetAt = maps.routeIpMinute.get(ipKey).resetAt;
    clock.set(resetAt);
    // 不同 IP 触发惰性扫；不再 take 原 ip 键
    await invoke(guard, { forwardedFor: '203.0.113.99' });

    assert.equal(maps.routeIpMinute.has(ipKey), false);
    // client 分钟条目与原 IP 绑定，过期后也应被同次扫掉；另写一条未过期 client 分钟键证明隔离
    const store = maps.routeClientMinute;
    const aliveKey = 'chat:alive:keep';
    store.set(aliveKey, { count: 1, resetAt: clock.get() + 60_000 });
    takeFixedWindow(store, 'chat:trigger:x', clock.get(), 60_000, 10);
    assert.equal(store.has(aliveKey), true);

    const again = await invoke(guard, { forwardedFor: ip });
    assert.equal(again.nextCount, 1);
  });

  it('UT-RATE-TTL-08: 假时钟边界：resetAt 前仍计数、到达后淘汰', () => {
    // 边界语义与实现一致：now >= resetAt 才淘汰
    const store = new Map();
    const t0 = 5_000_000;
    const windowMs = 100;
    const key = 'chat:web:127.0.0.1';

    takeFixedWindow(store, key, t0, windowMs, 10);
    assert.equal(store.get(key).resetAt, t0 + 100);

    const at99 = takeFixedWindow(store, key, t0 + 99, windowMs, 10);
    assert.equal(at99.ok, true);
    assert.equal(store.has(key), true);
    assert.equal(store.get(key).count, 2);

    // t0+100：惰性扫删除；同 key take 重建为 count=1
    const at100 = takeFixedWindow(store, key, t0 + 100, windowMs, 10);
    assert.equal(at100.ok, true);
    assert.equal(store.get(key).count, 1);
  });

  it('UT-RATE-TTL-09: 有 Redis：仍走 INCR+TTL，本项不改键格式', async () => {
    applyNoRedisEnv({ minute: 2, hour: 1000, ipMinute: 1000 });
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    for (let i = 0; i < 3; i += 1) {
      await invoke(guard);
    }
    assert.ok(redis.incrCalls.some((c) => String(c.key).includes('rl:cmin:')));
    const first = redis.incrCalls.find((c) => String(c.key).includes('rl:cmin:') && c.count === 1);
    assert.ok(first);
    assert.ok(redis.pexpireCalls.some((c) => c.key === first.key && c.ttlMs === 60_000));
    assert.ok(redis.incrCalls.some((c) => String(c.key).includes('rl:chour:')));
    assert.ok(redis.incrCalls.some((c) => String(c.key).includes('rl:imin:')));
  });

  it('UT-RATE-TTL-10: 不做：不改默认限流数字', () => {
    delete process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE;
    delete process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR;
    delete process.env.AI_RATE_LIMIT_IP_PER_MINUTE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    delete process.env.REDIS_URL;
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.minuteLimitPerClient, 10);
    assert.equal(guard.config.hourLimitPerClient, 100);
    assert.equal(guard.config.minuteLimitPerIp, 30);
  });

  it('UT-RATE-TTL-11: 不做：不引入真 Redis 集成测 / 不扩成通用 LRU', () => {
    // 本文件仅 mock Redis / 进程内 Map；不要求 REDIS_URL 真实例或 docker Redis；
    // 不要求把 nonce/并发/配额 Map 改造成统一 LRU
    delete process.env.REDIS_URL;
    assert.equal(typeof takeFixedWindow, 'function');
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(typeof guard.getRateLimitMapsForTests, 'function');
    const maps = guard.getRateLimitMapsForTests();
    assert.ok(maps.routeClientMinute instanceof Map);
  });

  it('UT-RATE-TTL-12: residual：无 Redis 时单进程有效；公开断言不写刷量步骤', () => {
    // 单 Guard 实例即可；不要求跨 worker；注释仅含 reason / 窗口 ms / 假时钟与键形态
    applyNoRedisEnv({ minute: 2 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const maps = guard.getRateLimitMapsForTests();
    assert.ok(maps.routeClientMinute instanceof Map);
    assert.ok(maps.routeClientHour instanceof Map);
    assert.ok(maps.routeIpMinute instanceof Map);
  });

  it('SEC-RATE-TTL-01: 无 Redis：窗口内打满 → 429 rate_client_minute', async () => {
    applyNoRedisEnv({ minute: 2, hour: 1000, ipMinute: 1000 });
    installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    await invoke(guard);
    await invoke(guard);
    const third = await invoke(guard);
    assert.equal(third.nextCount, 0);
    assert.equal(third.http.statusCode, 429);
    assert.ok(Number(third.http.headersSet['retry-after']) >= 1);
    assert.match(String(third.http.jsonCalls[0]?.message ?? ''), /Too many requests \(client per minute\)/);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_client_minute'), true);
  });

  it('SEC-RATE-TTL-02: 无 Redis：窗口外同维度可再准入', async () => {
    applyNoRedisEnv({ minute: 2, hour: 1000, ipMinute: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    await invoke(guard);
    await invoke(guard);
    const keyA = 'chat:web:127.0.0.1';
    clock.set(guard.getRateLimitMapsForTests().routeClientMinute.get(keyA).resetAt);
    const again = await invoke(guard);
    assert.equal(again.nextCount, 1);
    assert.notEqual(again.http.statusCode, 429);
  });

  it('SEC-RATE-TTL-03: 过期键不滞留 Map（不再 take 同一 key）', async () => {
    applyNoRedisEnv({ minute: 10, hour: 1000, ipMinute: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const keyA = 'chat:web:127.0.0.1';
    await invoke(guard);
    const maps = guard.getRateLimitMapsForTests();
    const resetAt = maps.routeClientMinute.get(keyA).resetAt;
    clock.set(resetAt);
    // 不 take keyA：换 IP 得到另一 limitKey 触发惰性扫
    await invoke(guard, { forwardedFor: '10.0.0.77' });
    assert.equal(maps.routeClientMinute.has(keyA), false);
  });

  it('IT-RATE-TTL-01: hour / ip 窗口挂载点回归', async () => {
    // hour 触顶
    applyNoRedisEnv({ minute: 1000, hour: 2, ipMinute: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    let guard = createAiGuard({ jwtSecret: 'test' });
    await invoke(guard);
    await invoke(guard);
    const hourReject = await invoke(guard);
    assert.equal(hourReject.nextCount, 0);
    assert.equal(hourReject.http.statusCode, 429);
    let audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_client_hour'), true);

    const keyA = 'chat:web:127.0.0.1';
    const hourReset = guard.getRateLimitMapsForTests().routeClientHour.get(keyA).resetAt;
    clock.set(hourReset);
    await invoke(guard, { forwardedFor: '10.0.0.55' });
    assert.equal(guard.getRateLimitMapsForTests().routeClientHour.has(keyA), false);

    // ip 触顶 + 过期淘汰
    restoreAll();
    applyNoRedisEnv({ minute: 1000, hour: 10000, ipMinute: 2 });
    const clock2 = installFakeNow(1_700_000_000_000);
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
    guard = createAiGuard({ jwtSecret: 'test' });
    const ip = '198.51.100.7';
    const ipKey = `chat:${ip}`;
    await invoke(guard, { forwardedFor: ip });
    await invoke(guard, { forwardedFor: ip });
    const ipReject = await invoke(guard, { forwardedFor: ip });
    assert.equal(ipReject.nextCount, 0);
    assert.equal(ipReject.http.statusCode, 429);
    audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_ip_minute'), true);
    const ipReset = guard.getRateLimitMapsForTests().routeIpMinute.get(ipKey).resetAt;
    clock2.set(ipReset);
    await invoke(guard, { forwardedFor: '198.51.100.8' });
    assert.equal(guard.getRateLimitMapsForTests().routeIpMinute.has(ipKey), false);
  });

  it('IT-RATE-TTL-02: 有 Redis 对照：仍 INCR+TTL，不测内存淘汰', async () => {
    applyNoRedisEnv({ minute: 2, hour: 1000, ipMinute: 1000 });
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    let last;
    for (let i = 0; i < 3; i += 1) last = await invoke(guard);
    assert.equal(last.nextCount, 0);
    assert.equal(last.http.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'rate_client_minute'), true);
    const first = redis.incrCalls.find((c) => String(c.key).includes('rl:cmin:') && c.count === 1);
    assert.ok(first);
    assert.ok(redis.pexpireCalls.some((c) => c.key === first.key && c.ttlMs === 60_000));
  });

  it('IT-RATE-TTL-03: 不做 / residual 边界', () => {
    // 不要求改默认 10/100/30、改 Redis 键格式、真 Redis 集成、通用 LRU；单进程有效；不写刷量步骤
    delete process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE;
    delete process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR;
    delete process.env.AI_RATE_LIMIT_IP_PER_MINUTE;
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.minuteLimitPerClient, 10);
    assert.equal(guard.config.hourLimitPerClient, 100);
    assert.equal(guard.config.minuteLimitPerIp, 30);
    assert.equal(typeof guard.getRateLimitMapsForTests, 'function');
  });
});
