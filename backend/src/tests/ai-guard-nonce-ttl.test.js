/**
 * S12：无 Redis 时 middleware 内存 nonce 按 TTL 过期淘汰。
 * 用例 ID 对齐 docs/test_cases.md §2.42 / §3.23。
 * 边界语义：`now - seenAt < nonceTtlMs` → replay_blocked；`>= nonceTtlMs` → 可再用。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s12-${process.pid}.ndjson`);
const CLIENT_ID = 'web';
const CLIENT_SECRET = 'change_me';
const EXCHANGE_PATH = '/api/auth/token';

const ENV_KEYS = [
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_CLIENT_CREDENTIALS',
  'AI_ALLOWED_ORIGINS',
  'AI_NONCE_TTL_MS',
  'AI_MAX_CLOCK_SKEW_MS',
  'REDIS_URL',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
];

const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalDateNow = Date.now;

/** 恢复 env 与 Date.now，并清理审计文件。 */
function restoreAll() {
  Date.now = originalDateNow;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
}

/**
 * 放宽限流/配额，强制验签，短 nonce TTL；不注入 Redis。
 * @param {{ nonceTtlMs?: number }} [opts]
 */
function applySignedNoRedisEnv({ nonceTtlMs = 1000 } = {}) {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'true';
  process.env.AI_CLIENT_CREDENTIALS = `${CLIENT_ID}:${CLIENT_SECRET}`;
  process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
  process.env.AI_NONCE_TTL_MS = String(nonceTtlMs);
  delete process.env.REDIS_URL;
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
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

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function hmacHex(secret, payload) {
  return createHmac('sha256', String(secret ?? '')).update(String(payload ?? ''), 'utf8').digest('hex');
}

/**
 * 构造合法六元组签名头（可固定 nonce / 时钟）。
 * @param {{ method?: string, path?: string, body?: unknown, nonce: string, nowMs?: number, signatureOverride?: string }} opts
 */
function buildSignedHeaders({
  method = 'POST',
  path: reqPath = '/api/chat',
  body = { message: 'hello' },
  nonce,
  nowMs = Date.now(),
  signatureOverride,
}) {
  const ts = String(nowMs);
  const bodyHash = sha256Hex(JSON.stringify(body ?? {}));
  const signatureBase = `${ts}.${nonce}.${method.toUpperCase()}.${reqPath}.${bodyHash}`;
  const signature = signatureOverride ?? hmacHex(CLIENT_SECRET, signatureBase);
  return {
    'x-client-id': CLIENT_ID,
    'x-client-token': CLIENT_SECRET,
    'x-ts': ts,
    'x-nonce': nonce,
    'x-signature': signature,
    'x-body-sha256': bodyHash,
    origin: 'http://localhost',
  };
}

/**
 * mock middleware 用的假 HTTP 对象。
 * @param {{ method?: string, path?: string, body?: unknown, headers?: Record<string, string>, user?: object|null }} opts
 */
function mockHttp({
  method = 'POST',
  path: reqPath = '/api/chat',
  body = { message: 'hello' },
  headers = {},
  user = { clientId: CLIENT_ID },
} = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const statusCalls = [];
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[String(key).toLowerCase()] = value;
  }

  const req = {
    method,
    path: reqPath,
    body,
    headers: {
      origin: normalizedHeaders.origin,
    },
    user: user === null ? undefined : user,
    header(name) {
      const key = String(name).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(normalizedHeaders, key)) {
        return normalizedHeaders[key];
      }
      if (key === 'x-request-id') return 'test-req-s12';
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
      statusCalls.push(code);
      return this;
    },
    setHeader() {},
    getHeader(name) {
      return name === 'X-Request-Id' ? 'test-req-s12' : undefined;
    },
    once() {},
  };

  return {
    req,
    res,
    jsonCalls,
    statusCalls,
    get statusCode() { return statusCode; },
  };
}

/** 审计异步落盘，读取前轮询至期望条数。 */
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
 * 调用 middleware 一次并返回 next 次数与 HTTP 探针。
 * @param {ReturnType<typeof createAiGuard>} guard
 * @param {{ path?: string, body?: unknown, nonce: string, nowMs?: number }} opts
 */
async function invokeSigned(guard, { path: reqPath = '/api/chat', body = { message: 'hello' }, nonce, nowMs = Date.now() }) {
  const headers = buildSignedHeaders({ path: reqPath, body, nonce, nowMs });
  const http = mockHttp({ path: reqPath, body, headers });
  let nextCount = 0;
  await guard.middleware(http.req, http.res, () => { nextCount += 1; });
  return { http, nextCount };
}

/** mock Redis：SET NX PX（nonce）+ INCR/DECR/PEXPIRE/PTTL（限流/并发），不连真实实例。 */
function createMockRedis() {
  const store = new Map();
  const counters = new Map();
  const setCalls = [];
  return {
    setCalls,
    async set(key, value, ...args) {
      setCalls.push({ key, value, args });
      const nx = args.includes('NX');
      const pxIdx = args.indexOf('PX');
      const ttlMs = pxIdx >= 0 ? Number(args[pxIdx + 1]) : undefined;
      if (nx && store.has(key)) return null;
      store.set(key, { value, expireAt: Number.isFinite(ttlMs) ? Date.now() + ttlMs : Number.POSITIVE_INFINITY });
      return 'OK';
    },
    async incr(key) {
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return next;
    },
    async decr(key) {
      const next = (counters.get(key) || 0) - 1;
      counters.set(key, next);
      return next;
    },
    async pexpire() {
      return 1;
    },
    async pttl() {
      return 60000;
    },
  };
}

/**
 * 构造合法换票 body（对照 exchangeToken nonceCache TTL）。
 * @param {{ nonce: string, nowMs?: number }} opts
 */
function buildExchangeBody({ nonce, nowMs = Date.now() }) {
  const clientId = CLIENT_ID;
  const ts = String(nowMs);
  const bodyForHash = JSON.stringify({ clientId, ts, nonce });
  const bodyHash = sha256Hex(bodyForHash);
  const signatureBase = `${ts}.${nonce}.POST.${EXCHANGE_PATH}.${bodyHash}`;
  const signature = hmacHex(CLIENT_SECRET, signatureBase);
  return { clientId, ts, nonce, signature, bodyHash };
}

function mockExchangeHttp(body) {
  const jsonCalls = [];
  const statusCalls = [];
  let statusCode = 200;
  const req = {
    path: EXCHANGE_PATH,
    body,
    headers: { origin: 'http://localhost' },
    header(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
  const res = {
    get statusCode() { return statusCode; },
    status(code) {
      statusCode = code;
      statusCalls.push(code);
      return this;
    },
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
  };
  return {
    req,
    res,
    jsonCalls,
    statusCalls,
    get statusCode() { return statusCode; },
  };
}

describe('S12: 无 Redis 时 middleware 内存 nonce 按 TTL 淘汰', () => {
  afterEach(restoreAll);

  it('UT-NONCE-TTL-01: 无 Redis：TTL 内同 nonce 重放 → 401 replay_blocked', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'nonce-ttl-01';

    const first = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(first.nextCount, 1);

    clock.advance(500); // δ < nonceTtlMs
    const second = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(second.nextCount, 0);
    assert.equal(second.http.statusCode, 401);
    assert.deepEqual(second.http.jsonCalls[0], { code: 401, message: 'Replay request blocked' });

    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.decision === 'reject' && row.reason === 'replay_blocked'), true);
  });

  it('UT-NONCE-TTL-02: 无 Redis：TTL 外同 nonce 可再次 next（不再误杀）', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'nonce-ttl-02';

    const first = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(first.nextCount, 1);

    clock.set(clock.get() + 1000); // now' >= firstSeenAt + nonceTtlMs
    const third = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(third.nextCount, 1);
    assert.equal(third.http.statusCalls.includes(401), false);
    assert.equal(
      third.http.jsonCalls.some((p) => p?.message === 'Replay request blocked'),
      false,
    );
  });

  it('UT-NONCE-TTL-03: 假时钟：TTL 边界内仍拒绝、边界外放行', async () => {
    // 闭开区间：`< ttl` 拒绝，`>= ttl` 放行（与 ai-guard.js 条件 now - seenAt < nonceTtlMs 一致）
    applySignedNoRedisEnv({ nonceTtlMs: 100 });
    const t0 = 1_700_000_000_000;
    const clock = installFakeNow(t0);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'nonce-boundary';

    const atT0 = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(atT0.nextCount, 1);

    clock.set(t0 + 99);
    const inside = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(inside.nextCount, 0);
    assert.equal(inside.http.statusCode, 401);
    assert.equal(inside.http.jsonCalls[0]?.message, 'Replay request blocked');

    clock.set(t0 + 100);
    const atBoundary = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(atBoundary.nextCount, 1);
    assert.equal(
      atBoundary.http.jsonCalls.some((p) => p?.message === 'Replay request blocked'),
      false,
    );
  });

  it('UT-NONCE-TTL-04: 淘汰语义：过期后 Map 不再因旧条目拦截（可观察删除或惰性覆写）', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 100 });
    const t0 = 1_700_000_000_000;
    const clock = installFakeNow(t0);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'nonce-evict-04';

    assert.equal((await invokeSigned(guard, { nonce, nowMs: clock.get() })).nextCount, 1);

    clock.set(t0 + 100);
    const third = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(third.nextCount, 1);

    // 第四次：新窗口内立即重放 → 再次 replay_blocked，证明第三次写入已刷新
    clock.advance(1);
    const fourth = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(fourth.nextCount, 0);
    assert.equal(fourth.http.statusCode, 401);
    assert.equal(fourth.http.jsonCalls[0]?.message, 'Replay request blocked');
  });

  it('UT-NONCE-TTL-05: 与 exchangeToken 内存 nonce TTL 语义对齐（对照）', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 40 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'exchange-nonce-05';

    const firstBody = buildExchangeBody({ nonce });
    const firstHttp = mockExchangeHttp(firstBody);
    await guard.exchangeToken(firstHttp.req, firstHttp.res);
    assert.equal(firstHttp.jsonCalls[0]?.code, 0);
    assert.ok(firstHttp.jsonCalls[0]?.data?.token);

    const replayBody = buildExchangeBody({ nonce });
    const replayHttp = mockExchangeHttp(replayBody);
    await guard.exchangeToken(replayHttp.req, replayHttp.res);
    assert.equal(replayHttp.statusCode, 401);
    assert.match(String(replayHttp.jsonCalls[0]?.message ?? ''), /Replay blocked/);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const afterBody = buildExchangeBody({ nonce });
    const afterHttp = mockExchangeHttp(afterBody);
    await guard.exchangeToken(afterHttp.req, afterHttp.res);
    assert.equal(afterHttp.jsonCalls[0]?.code, 0);
    assert.ok(afterHttp.jsonCalls[0]?.data?.token);
  });

  it('UT-NONCE-TTL-06: chat 与 generate 共用无 Redis nonce 窗口', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 1000 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'nonce-cross-route';

    const chat = await invokeSigned(guard, {
      path: '/api/chat',
      body: { message: 'chat' },
      nonce,
      nowMs: clock.get(),
    });
    assert.equal(chat.nextCount, 1);

    clock.advance(10);
    const generate = await invokeSigned(guard, {
      path: '/api/problems/1/answer/generate',
      body: { force: false },
      nonce,
      nowMs: clock.get(),
    });
    assert.equal(generate.nextCount, 0);
    assert.equal(generate.http.statusCode, 401);
    assert.equal(generate.http.jsonCalls[0]?.message, 'Replay request blocked');

    clock.advance(1000);
    const afterTtl = await invokeSigned(guard, {
      path: '/api/problems/1/answer/generate',
      body: { force: false },
      nonce,
      nowMs: clock.get(),
    });
    assert.equal(afterTtl.nextCount, 1);
  });

  it('UT-NONCE-TTL-07: 有 Redis：仍走 SET NX PX，本项不改键格式', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 60000 });
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const nonce = 'nonce-redis-07';
    const nowMs = Date.now();

    const first = await invokeSigned(guard, { nonce, nowMs });
    assert.equal(first.nextCount, 1);
    assert.ok(redis.setCalls.length >= 1);
    const call = redis.setCalls[0];
    assert.match(call.key, /^nonce:web:/);
    assert.ok(call.key.includes(nonce));
    assert.equal(call.args.includes('NX'), true);
    assert.equal(call.args.includes('PX'), true);
    const pxIdx = call.args.indexOf('PX');
    assert.equal(Number(call.args[pxIdx + 1]), 60000);

    const second = await invokeSigned(guard, { nonce, nowMs });
    assert.equal(second.nextCount, 0);
    assert.equal(second.http.statusCode, 401);
    assert.equal(second.http.jsonCalls[0]?.message, 'Replay request blocked');
  });

  it('UT-NONCE-TTL-08: 不做：不改 AI_REQUIRE_SIGNED_HEADERS 默认', async () => {
    delete process.env.AI_REQUIRE_SIGNED_HEADERS;
    process.env.AI_CLIENT_CREDENTIALS = `${CLIENT_ID}:${CLIENT_SECRET}`;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost';
    delete process.env.REDIS_URL;
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
    process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
    process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
    process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
    process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';

    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.requireSignedHeaders, false);

    const http = mockHttp({
      body: { message: 'hello' },
      headers: { origin: 'http://localhost' },
      user: { clientId: CLIENT_ID },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
  });

  it('UT-NONCE-TTL-09: 不做：不引入真 Redis 集成测 / 不扩成通用 LRU', () => {
    // 本文件仅用 mock Redis 与内存 Map；PASS 不要求 docker Redis 或统一 LRU 框架。
    assert.equal(typeof createMockRedis, 'function');
    assert.equal(fs.existsSync(path.join(path.dirname(AUDIT_FILE), 'does-not-require-real-redis')), false);
  });

  it('UT-NONCE-TTL-10: residual：日切 clear 可作兜底，但不能替代 TTL', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 100 });
    // 固定在同一 UTC 日中部，推进量远小于一日，确保未触发日切 clear
    const t0 = Date.UTC(2026, 10, 5, 12, 0, 0);
    const clock = installFakeNow(t0);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'nonce-same-day-10';

    assert.equal((await invokeSigned(guard, { nonce, nowMs: clock.get() })).nextCount, 1);
    clock.set(t0 + 100);
    const afterTtl = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(afterTtl.nextCount, 1);
    assert.equal(
      afterTtl.http.jsonCalls.some((p) => p?.message === 'Replay request blocked'),
      false,
    );
  });

  it('UT-NONCE-TTL-11: residual：无 Redis 时单进程有效可接受', () => {
    applySignedNoRedisEnv({ nonceTtlMs: 100 });
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.requireSignedHeaders, true);
    // 单 Guard 实例即满足；不要求跨 worker 共享内存 nonces
    assert.ok(guard.middleware);
  });

  it('UT-NONCE-TTL-12: 公开断言不写重放利用步骤', () => {
    const source = fs.readFileSync(new URL(import.meta.url), 'utf8');
    assert.equal(/openssl\s+.*replay/i.test(source), false);
    assert.equal(/node\s+-e\s+.*x-nonce.*https?:\/\/(?!localhost)/i.test(source), false);
    assert.match(source, /replay_blocked/);
  });

  it('SEC-NONCE-TTL-01: 无 Redis：TTL 内重放被拒且不进业务', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 200 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'sec-nonce-01';

    const first = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(first.nextCount, 1);

    clock.advance(50);
    const second = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(second.nextCount, 0);
    assert.equal(second.http.statusCode, 401);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'replay_blocked'), true);
    // middleware 探针路径：401 JSON 拒答，未进入 SSE 业务
    assert.equal(second.http.statusCode, 401);
    assert.notEqual(second.http.jsonCalls[0]?.code, 0);
  });

  it('SEC-NONCE-TTL-02: 无 Redis：TTL 外同 nonce 可再次准入', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 200 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'sec-nonce-02';

    assert.equal((await invokeSigned(guard, { nonce, nowMs: clock.get() })).nextCount, 1);
    clock.advance(200);
    const third = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(third.nextCount, 1);
    assert.equal(
      third.http.jsonCalls.some((p) => p?.message === 'Replay request blocked'),
      false,
    );
  });

  it('SEC-NONCE-TTL-03: generate 路由 TTL 内重放同等拒绝', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 500 });
    const clock = installFakeNow(1_700_000_000_000);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'n1';

    const first = await invokeSigned(guard, {
      path: '/api/chat',
      body: { message: 'consume' },
      nonce,
      nowMs: clock.get(),
    });
    assert.equal(first.nextCount, 1);

    clock.advance(20);
    const replay = await invokeSigned(guard, {
      path: '/api/problems/2/answer/generate',
      body: { force: true },
      nonce,
      nowMs: clock.get(),
    });
    assert.equal(replay.nextCount, 0);
    assert.equal(replay.http.statusCode, 401);
    assert.equal(replay.http.jsonCalls[0]?.code, 401);
    assert.notEqual(replay.http.jsonCalls[0]?.code, 0);
  });

  it('SEC-NONCE-TTL-04: 对照：有 mock Redis 时仍 NX 防重放（不改键）', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 60000 });
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const nonce = 'sec-redis-04';
    const nowMs = Date.now();

    assert.equal((await invokeSigned(guard, { nonce, nowMs })).nextCount, 1);
    assert.match(redis.setCalls[0].key, new RegExp(`^nonce:${CLIENT_ID}:${nonce}$`));

    const second = await invokeSigned(guard, { nonce, nowMs });
    assert.equal(second.nextCount, 0);
    assert.equal(second.http.statusCode, 401);
  });

  it('IT-NONCE-TTL-01: 假时钟推进后签名时钟窗口仍满足', async () => {
    applySignedNoRedisEnv({ nonceTtlMs: 100 });
    process.env.AI_MAX_CLOCK_SKEW_MS = '1000';
    const t0 = 1_700_000_000_000;
    const clock = installFakeNow(t0);
    const guard = createAiGuard({ jwtSecret: 'test' });
    const nonce = 'it-clock-01';

    assert.equal((await invokeSigned(guard, { nonce, nowMs: clock.get() })).nextCount, 1);

    // 推进超过 clock skew，使旧 x-ts 必然 invalid_timestamp
    clock.set(t0 + 2000);
    const staleHeaders = buildSignedHeaders({ nonce, nowMs: t0 });
    const staleHttp = mockHttp({ headers: staleHeaders });
    let staleNext = 0;
    await guard.middleware(staleHttp.req, staleHttp.res, () => { staleNext += 1; });
    assert.equal(staleNext, 0);
    assert.equal(staleHttp.statusCode, 401);
    assert.match(String(staleHttp.jsonCalls[0]?.message ?? ''), /timestamp|Stale/i);

    // 主路径：随假时钟更新 ts 后无 replay_blocked，可 next
    const fresh = await invokeSigned(guard, { nonce, nowMs: clock.get() });
    assert.equal(fresh.nextCount, 1);
    assert.equal(
      fresh.http.jsonCalls.some((p) => p?.message === 'Replay request blocked'),
      false,
    );
  });

  it('IT-NONCE-TTL-02: 不做 / residual 边界', () => {
    applySignedNoRedisEnv({ nonceTtlMs: 100 });
    delete process.env.AI_REQUIRE_SIGNED_HEADERS;
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.requireSignedHeaders, false);
    // 不要求真 Redis / 通用 LRU / 改 Redis 键；日切 clear 可保留但不替代同日 TTL
    assert.equal(typeof guard.config.nonceTtlMs, 'number');
  });
});
