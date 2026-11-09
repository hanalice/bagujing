import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s13-${process.pid}.ndjson`);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'security-ai-guard.md');

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
  'AI_MAX_COMPLETION_TOKENS',
  'AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS',
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

const nowDayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const nextUtcMidnight = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

/** 内存 mock Redis：INCR/INCRBY/DECR/PEXPIRE/GET/SET，供 S13 注入。 */
function createMockRedis() {
  const store = new Map();
  const incrCalls = [];
  const incrbyCalls = [];
  const decrCalls = [];
  const pexpireCalls = [];
  const getEntry = (key) => {
    let entry = store.get(key);
    if (!entry) {
      entry = { count: 0, expireAt: Number.POSITIVE_INFINITY };
      store.set(key, entry);
    }
    return entry;
  };
  return {
    store,
    incrCalls,
    incrbyCalls,
    decrCalls,
    pexpireCalls,
    getCount(key) {
      const entry = store.get(key);
      return entry ? entry.count : 0;
    },
    async incr(key) {
      const entry = getEntry(key);
      entry.count += 1;
      incrCalls.push({ key, count: entry.count, delta: 1 });
      return entry.count;
    },
    async incrby(key, delta) {
      const entry = getEntry(key);
      const amount = Number(delta) || 0;
      entry.count += amount;
      incrbyCalls.push({ key, count: entry.count, delta: amount });
      return entry.count;
    },
    async decr(key) {
      const entry = getEntry(key);
      entry.count -= 1;
      decrCalls.push({ key, count: entry.count });
      return entry.count;
    },
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return String(entry.count);
    },
    async set(key, value) {
      store.set(key, { count: Number(value) || 0, expireAt: Number.POSITIVE_INFINITY });
      return 'OK';
    },
    async pexpire(key, ttlMs) {
      pexpireCalls.push({ key, ttlMs: Number(ttlMs), at: Date.now() });
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

function mockHttp({
  path: reqPath = '/api/chat',
  body = { message: 'hi' },
  clientId = 'web',
  userId,
} = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const req = {
    method: 'POST',
    path: reqPath,
    body,
    headers: { origin: 'http://localhost' },
    user: userId === undefined ? { clientId } : { clientId, id: userId },
    ip: '127.0.0.1',
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req-s13';
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
      return name === 'X-Request-Id' ? 'test-req-s13' : undefined;
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

function applyBaseEnv() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  delete process.env.REDIS_URL;
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '20';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '1000000';
  process.env.AI_MAX_COMPLETION_TOKENS = '4096';
  process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
}

/** mock dbPool：可配置 ai_clients 日请求限额与审计汇总。 */
function createMockDbPool({ dailyRequestLimit = 1, requestCount = 0, tokenSum = 0 } = {}) {
  const queries = [];
  const pool = {
    withConnection: async (fn) => {
      const db = {
        async get(sql, params) {
          queries.push({ sql: String(sql), params });
          if (String(sql).includes('COUNT(*)') || String(sql).includes('ai_audit_logs')) {
            return { request_count: requestCount, token_sum: tokenSum };
          }
          if (String(sql).includes('ai_clients')) {
            return { daily_token_limit: 1000000, daily_request_limit: dailyRequestLimit };
          }
          return undefined;
        },
        async run() {
          return { changes: 0 };
        },
      };
      return fn(db);
    },
  };
  return { pool, queries };
}

describe('S13: 有 Redis 时日配额预扣/回补走 Redis', () => {
  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-QUOTA-REDIS-01: 注入 mock Redis 后全局请求预扣走 INCR', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '2';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const dayKey = nowDayKey();
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
    assert.match(String(admitted[2].message || ''), /Quota exceeded/);

    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'global_daily_request_limit'), true);
    assert.equal(audits.some((row) => row.reason === 'rate_client_minute'), false);
    assert.equal(audits.some((row) => row.reason === 'concurrency_limit'), false);

    const greqKey = [...redis.store.keys()].find((k) => k.includes('q:greq:') && k.includes(dayKey));
    assert.ok(greqKey, '须有含 q:greq: 与 dayKey 的键');
    assert.ok(redis.incrCalls.some((c) => String(c.key).includes('q:greq:')));
    assert.equal(redis.getCount(greqKey), 2);
  });

  it('UT-QUOTA-REDIS-02: 全局 token 预扣走 INCRBY 且键含 dayKey', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '500';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const dayKey = nowDayKey();
    const now = Date.now();

    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    const projected = first.req.aiGuard.projectedTokens;

    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'global_daily_token_limit'), true);

    const gtokCall = redis.incrbyCalls.find((c) => String(c.key).includes('q:gtok:') && String(c.key).includes(dayKey));
    assert.ok(gtokCall, '须对 q:gtok:+dayKey 调用 incrby');
    assert.equal(gtokCall.delta, projected);
    const firstExpire = redis.pexpireCalls.find((c) => String(c.key).includes('q:gtok:'));
    assert.ok(firstExpire);
    assert.ok(firstExpire.ttlMs > 0 && firstExpire.ttlMs <= 48 * 3600 * 1000);
    // 以 pexpire 调用时刻校验覆盖到次日（避免测试侧 now 与中间件时钟漂移导致偶发失败）
    assert.ok(firstExpire.at + firstExpire.ttlMs >= nextUtcMidnight(firstExpire.at));
    assert.ok(now + firstExpire.ttlMs + 2000 >= nextUtcMidnight(now), '相对测试 now 亦须覆盖次日（含文档允许的小缓冲）');
  });

  it('UT-QUOTA-REDIS-03: client 侧请求/token 键随预扣更新', async () => {
    applyBaseEnv();
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const dayKey = nowDayKey();
    const http = mockHttp({ clientId: 'web' });
    let nextCalled = 0;
    await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 1);
    const projected = http.req.aiGuard.projectedTokens;

    assert.ok(
      redis.incrCalls.some((c) => String(c.key).includes('q:creq:') && String(c.key).includes(dayKey) && String(c.key).includes('web')),
    );
    assert.ok(
      redis.incrbyCalls.some(
        (c) =>
          String(c.key).includes('q:ctok:') &&
          String(c.key).includes(dayKey) &&
          String(c.key).includes('web') &&
          c.delta === projected,
      ),
    );
  });

  it('UT-QUOTA-REDIS-04: finalize 回补（upstreamReached:false）走 Redis INCRBY 负增量', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '500';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    const projected = first.req.aiGuard.projectedTokens;
    const longHtml = `<p>${'x'.repeat(2048)}</p>`;
    await first.req.aiGuard.finalize({
      status: 'ok',
      reason: 'cached_answer',
      completionText: longHtml,
      upstreamReached: false,
    });

    const audits = await readAuditLines(1);
    const cached = audits.find((row) => row.reason === 'cached_answer');
    assert.ok(cached);
    assert.equal(cached.totalTokens, 0);

    const refundCalls = redis.incrbyCalls.filter(
      (c) => (String(c.key).includes('q:gtok:') || String(c.key).includes('q:ctok:')) && c.delta === -projected,
    );
    assert.ok(refundCalls.length >= 2, '须对 gtok/ctok 回补 projectedTokens');
    for (const key of redis.store.keys()) {
      if (String(key).includes('q:gtok:') || String(key).includes('q:ctok:')) {
        assert.ok(redis.getCount(key) >= 0);
      }
    }

    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1, '回补后第二次须再次准入');
    assert.notEqual(second.statusCode, 429);
  });

  it('UT-QUOTA-REDIS-05: 成功路径按 delta 调整 Redis token', async () => {
    applyBaseEnv();
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const http = mockHttp();
    let nextCalled = 0;
    await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 1);
    const projected = http.req.aiGuard.projectedTokens;
    const dayKey = nowDayKey();
    const gtokKey = [...redis.store.keys()].find((k) => k.includes('q:gtok:') && k.includes(dayKey));
    const afterPre = redis.getCount(gtokKey);

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: `<p>${'y'.repeat(4096)}</p>`,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });

    const audits = await readAuditLines(1);
    assert.equal(audits[0].token_source, 'upstream');
    assert.equal(audits[0].totalTokens, 15);

    const expectedDelta = 15 - projected;
    assert.equal(redis.getCount(gtokKey), afterPre + expectedDelta);
    const ctokKey = [...redis.store.keys()].find((k) => k.includes('q:ctok:') && k.includes(dayKey));
    assert.equal(redis.getCount(ctokKey), afterPre + expectedDelta);
  });

  it('UT-QUOTA-REDIS-06: 超限预扣回滚，计数不永久占满', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '1';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const dayKey = nowDayKey();

    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);

    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);

    const greqKey = [...redis.store.keys()].find((k) => k.includes('q:greq:') && k.includes(dayKey));
    assert.equal(redis.getCount(greqKey), 1, '失败路径不得留下幽灵 +1');
  });

  it('UT-QUOTA-REDIS-07: 无 Redis 时仍用进程内 Map', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '2';
    delete process.env.REDIS_URL;
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
    assert.equal(statuses[2].nextCalled, 0);
    assert.equal(statuses[2].status, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'global_daily_request_limit'), true);
  });

  it('UT-QUOTA-REDIS-08: 有 dbPool 时 SQL 限额校验保留', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '10000';
    const redis = createMockRedis();
    // 第一次：审计汇总 0、限额 1 → 准入；第二次：汇总已为 1 → client 日请求超限
    let round = 0;
    const queries = [];
    const pool = {
      withConnection: async (fn) => {
        const db = {
          async get(sql, params) {
            queries.push({ sql: String(sql), params });
            if (String(sql).includes('ai_audit_logs') || String(sql).includes('COUNT(*)')) {
              return { request_count: round === 0 ? 0 : 1, token_sum: 0 };
            }
            if (String(sql).includes('ai_clients')) {
              return { daily_token_limit: 1000000, daily_request_limit: 1 };
            }
            return undefined;
          },
          async run() {
            return { changes: 0 };
          },
        };
        return fn(db);
      },
    };
    const guard = createAiGuard({ jwtSecret: 'test', redis, dbPool: pool });

    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    round = 1;

    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => row.reason === 'client_daily_request_limit'), true);
    assert.ok(queries.some((q) => /ai_clients|ai_audit_logs/.test(q.sql)));
    assert.ok(
      redis.incrCalls.some((c) => String(c.key).includes('q:greq:')) ||
        redis.incrbyCalls.some((c) => String(c.key).includes('q:')),
    );
  });

  it('UT-QUOTA-REDIS-09: 日键与 TTL 覆盖到次日', async () => {
    applyBaseEnv();
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const now = Date.now();
    const dayKey = nowDayKey(now);
    const http = mockHttp();
    await guard.middleware(http.req, http.res, () => {});

    const quotaKeys = [...redis.store.keys()].filter((k) =>
      /q:(greq|gtok|creq|ctok):/.test(k),
    );
    assert.ok(quotaKeys.length >= 4);
    for (const key of quotaKeys) {
      assert.ok(String(key).includes(dayKey), `键须含 dayKey: ${key}`);
    }
    assert.ok(redis.pexpireCalls.length >= 1);
    for (const call of redis.pexpireCalls.filter((c) => String(c.key).startsWith('q:'))) {
      assert.ok(call.ttlMs > 0 && call.ttlMs <= 48 * 3600 * 1000);
      assert.ok(call.at + call.ttlMs >= nextUtcMidnight(call.at));
      assert.ok(now + call.ttlMs + 2000 >= nextUtcMidnight(now), '相对测试 now 亦须覆盖次日（含文档允许的小缓冲）');
      assert.notEqual(call.ttlMs, 60 * 1000, '不得误用分钟级 TTL');
    }
  });

  it('UT-QUOTA-REDIS-10: 不改代码默认限额数字', () => {
    for (const key of [
      'AI_GLOBAL_DAILY_REQUEST_LIMIT',
      'AI_GLOBAL_DAILY_TOKEN_LIMIT',
      'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
      'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
    ]) {
      delete process.env[key];
    }
    delete process.env.REDIS_URL;
    const guard = createAiGuard({ jwtSecret: 'test' });
    assert.equal(guard.config.globalDailyRequestLimit, 5000);
    assert.equal(guard.config.globalDailyTokenLimit, 500000);
    assert.equal(guard.config.dailyRequestLimitPerClient, 200);
    assert.equal(guard.config.dailyTokenLimitPerClient, 50000);
  });

  it('UT-QUOTA-REDIS-11: 配额 Redis 键与 B51/B52 键隔离', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '1';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });

    const first = mockHttp();
    await guard.middleware(first.req, first.res, () => {});
    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((row) => /^global_daily_/.test(row.reason)), true);

    const quotaOps = [
      ...redis.incrCalls,
      ...redis.incrbyCalls,
      ...redis.decrCalls,
    ].filter((c) => /q:/.test(String(c.key)));
    assert.ok(quotaOps.length >= 1);
    for (const call of quotaOps) {
      const key = String(call.key);
      assert.equal(/rl:/.test(key), false);
      assert.equal(/^cc:/.test(key) || /:cc:/.test(key), false);
    }
  });

  it('UT-QUOTA-REDIS-12: 不做：不实现月配额 / 用户·角色配额', async () => {
    applyBaseEnv();
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    for (const userId of [101, 202]) {
      const http = mockHttp({ userId });
      let nextCalled = 0;
      await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
      assert.equal(nextCalled, 1);
    }
    const keys = [...redis.store.keys()].join(',');
    assert.equal(/q:m/.test(keys), false);
    assert.equal(/user\.|role:|:101|:202/.test(keys) && /q:.*:101/.test(keys), false);
    // 键仅含 client/全局日桶，不含按 user.id 分桶
    assert.equal([...redis.store.keys()].some((k) => /q:.*:101\b/.test(k)), false);
  });

  it('UT-QUOTA-REDIS-13: 不做：不要求生产必须 Redis / 真集群压测', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '1';
    delete process.env.REDIS_URL;
    const guard = createAiGuard({ jwtSecret: 'test' });
    const first = mockHttp();
    await guard.middleware(first.req, first.res, () => {});
    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);
  });

  it('UT-QUOTA-REDIS-14: 可选文档：清单「有 Redis 时日配额计数」已完成', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');
    const lines = doc.split('\n').filter((l) => /^-\s\[[ x]\]/.test(l));
    assert.ok(
      lines.some((l) => /^-\s\[x\]/.test(l) && /日配额/.test(l) && (/Redis|q:|S13/.test(l))),
      '清单须勾选有 Redis 时日配额',
    );
    assert.equal(
      lines.some((l) => /^-\s\[x\]/.test(l) && /用户级.*配额/.test(l)),
      false,
    );
  });

  it('SEC-QUOTA-REDIS-01: 有 mock Redis：全局日请求超限 429 且不进业务', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '1';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);

    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);
    assert.match(String(second.jsonCalls[0]?.message || ''), /Quota exceeded/);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((r) => r.reason === 'global_daily_request_limit'), true);
    assert.ok([...redis.store.keys()].some((k) => k.includes('q:greq:') && k.includes(nowDayKey())));
  });

  it('SEC-QUOTA-REDIS-02: 有 mock Redis：全局日 token 超限 429', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '500';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((r) => r.reason === 'global_daily_token_limit'), true);
  });

  it('SEC-QUOTA-REDIS-03: cached_answer / upstreamReached:false 回补后可再准入', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '500';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const first = mockHttp({ path: '/api/problems/1/answer/generate', body: { force: false } });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    await first.req.aiGuard.finalize({
      status: 'ok',
      reason: 'cached_answer',
      completionText: `<p>${'z'.repeat(2048)}</p>`,
      upstreamReached: false,
    });
    const audits = await readAuditLines(1);
    assert.equal(audits[0].totalTokens, 0);
    const second = mockHttp({ path: '/api/problems/1/answer/generate', body: { force: false } });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1);
  });

  it('SEC-QUOTA-REDIS-04: generate 路由同等受 Redis 日配额约束', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '1';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const chat = mockHttp({ path: '/api/chat' });
    let chatNext = 0;
    await guard.middleware(chat.req, chat.res, () => { chatNext += 1; });
    assert.equal(chatNext, 1);

    const gen = mockHttp({ path: '/api/problems/9/answer/generate', body: { force: false } });
    let genNext = 0;
    await guard.middleware(gen.req, gen.res, () => { genNext += 1; });
    assert.equal(genNext, 0);
    assert.equal(gen.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((r) => r.reason === 'global_daily_request_limit'), true);
  });

  it('SEC-QUOTA-REDIS-05: 无 Redis：内存 Map 超限行为保持', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '1';
    delete process.env.REDIS_URL;
    const guard = createAiGuard({ jwtSecret: 'test' });
    const first = mockHttp();
    await guard.middleware(first.req, first.res, () => {});
    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 0);
    assert.equal(second.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((r) => r.reason === 'global_daily_request_limit'), true);
  });

  it('IT-QUOTA-REDIS-01: 成功结算 delta 后二次准入窗口正确', async () => {
    applyBaseEnv();
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '900';
    process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
    const redis = createMockRedis();
    const guard = createAiGuard({ jwtSecret: 'test', redis });
    const first = mockHttp();
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    await first.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: `<p>${'w'.repeat(4096)}</p>`,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const audits = await readAuditLines(1);
    assert.equal(audits[0].token_source, 'upstream');
    assert.equal(audits[0].totalTokens, 15);

    const second = mockHttp();
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1);
    assert.notEqual(second.statusCode, 429);
  });

  it('IT-QUOTA-REDIS-02: 有 dbPool：client 日限额 SQL 拒答仍优先可观测', async () => {
    applyBaseEnv();
    const redis = createMockRedis();
    const { pool, queries } = createMockDbPool({ dailyRequestLimit: 1, requestCount: 1 });
    const guard = createAiGuard({ jwtSecret: 'test', redis, dbPool: pool });
    const http = mockHttp();
    let nextCalled = 0;
    await guard.middleware(http.req, http.res, () => { nextCalled += 1; });
    assert.equal(nextCalled, 0);
    assert.equal(http.statusCode, 429);
    const audits = await readAuditLines(1);
    assert.equal(audits.some((r) => r.reason === 'client_daily_request_limit'), true);
    assert.ok(queries.some((q) => /ai_clients|ai_audit_logs/.test(q.sql)));
  });
});
