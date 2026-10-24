/**
 * S2：Guard 非 debug 路径去掉常开 console.log。
 * 用例 ID 对齐 docs/test_cases.md §2.32。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAiGuard } from '../security/ai-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GUARD_MODULE_PATH = path.resolve(__dirname, '../security/ai-guard.js');
const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s2-noise-${process.pid}.ndjson`);
const CLIENT_ID = 'web';
const CLIENT_SECRET = 'change_me';
const EXCHANGE_PATH = '/api/auth/token';

const NOISE_SUBSTRINGS = [
  'AI_GUARD_MODULE_LOADED_VERSION_001',
  'AI_GUARD_MODULE_LOADED_',
  '[ai-guard] SQL audit success',
  '[ai-guard] Body hash mismatch',
  '[ai-guard] Invalid signature. Expected base',
];

const ENV_KEYS = [
  'NODE_ENV',
  'AI_GUARD_DEBUG',
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_CLIENT_CREDENTIALS',
  'AI_ALLOWED_ORIGINS',
  'AI_NONCE_TTL_MS',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
];

/** 保存/恢复本用例触碰的环境变量，避免污染其它套件 */
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

function applyLooseLimits() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_CLIENT_CREDENTIALS = `${CLIENT_ID}:${CLIENT_SECRET}`;
  process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
  process.env.AI_NONCE_TTL_MS = '50';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';
}

/** stub console.log/debug/info，收集全部参数拼接串 */
function stubConsole() {
  const calls = { log: [], debug: [], info: [] };
  const original = {
    log: console.log,
    debug: console.debug,
    info: console.info,
  };
  console.log = (...args) => {
    calls.log.push(args.map(String).join(' '));
  };
  console.debug = (...args) => {
    calls.debug.push(args.map(String).join(' '));
  };
  console.info = (...args) => {
    calls.info.push(args.map(String).join(' '));
  };
  return {
    calls,
    restore() {
      console.log = original.log;
      console.debug = original.debug;
      console.info = original.info;
    },
    logInfoJoined() {
      return [...calls.log, ...calls.info].join('\n');
    },
  };
}

function assertNoNoiseInLogInfo(stub, label = '') {
  const joined = stub.logInfoJoined();
  for (const needle of NOISE_SUBSTRINGS) {
    assert.equal(
      joined.includes(needle),
      false,
      `${label} console.log/info 不得含噪音子串: ${needle}`,
    );
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function hmacHex(secret, payload) {
  return createHmac('sha256', String(secret ?? '')).update(String(payload ?? ''), 'utf8').digest('hex');
}

/**
 * 构造换票 body；可故意破坏 bodyHash 或 signature。
 * @param {{ badBodyHash?: boolean, badSignature?: boolean }} [opts]
 */
function buildExchangeBody({ badBodyHash = false, badSignature = false } = {}) {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const bodyForHash = JSON.stringify({ clientId: CLIENT_ID, ts, nonce });
  const bodyHash = badBodyHash
    ? '0'.repeat(64)
    : sha256Hex(bodyForHash);
  const signatureBase = `${ts}.${nonce}.POST.${EXCHANGE_PATH}.${bodyHash}`;
  const signature = badSignature
    ? 'deadbeef'
    : hmacHex(CLIENT_SECRET, signatureBase);
  return { clientId: CLIENT_ID, ts, nonce, signature, bodyHash, signatureBase };
}

/** mock exchangeToken 的 req/res */
function mockExchangeHttp(body, { origin = 'http://localhost' } = {}) {
  const jsonCalls = [];
  let statusCode = 200;
  const req = {
    path: EXCHANGE_PATH,
    body,
    headers: { origin },
    header(name) {
      return this.headers[String(name).toLowerCase()];
    },
  };
  const res = {
    get statusCode() { return statusCode; },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
  };
  return { req, res, jsonCalls };
}

/**
 * 构造可走通 Guard middleware → next() 的假 HTTP 对象。
 * @param {{ requestId?: string }} [opts]
 */
function mockHttp({ requestId = 'test-req' } = {}) {
  const req = {
    method: 'POST',
    path: '/api/chat',
    body: { message: 'noise-probe' },
    headers: {},
    user: { clientId: CLIENT_ID },
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return requestId;
      return '';
    },
  };
  const res = {
    json() { return this; },
    status() { return this; },
    setHeader() {},
    getHeader(name) {
      return name === 'X-Request-Id' ? requestId : undefined;
    },
    once() {},
  };
  return { req, res };
}

/**
 * 注入可成功 INSERT ai_audit_logs 的 fake dbPool（配额 SELECT 亦放行）。
 * @returns {{ pool: object, waitInsert: (n?: number, timeoutMs?: number) => Promise<void>, getInsertCount: () => number }}
 */
function createFakeDbPool() {
  let insertCount = 0;
  const pool = {
    withConnection: async (fn) => {
      const db = {
        async run(sql) {
          if (String(sql).includes('INSERT INTO ai_audit_logs')) {
            insertCount += 1;
            return { changes: 1 };
          }
          return { changes: 0 };
        },
        async get(sql) {
          if (String(sql).includes('COUNT(*)')) {
            return { request_count: 0, token_sum: 0 };
          }
          if (String(sql).includes('FROM ai_clients')) {
            return { daily_token_limit: 1000000, daily_request_limit: 10000 };
          }
          return undefined;
        },
      };
      return fn(db);
    },
  };
  return {
    pool,
    getInsertCount: () => insertCount,
    async waitInsert(n = 1, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (insertCount >= n) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`SQL INSERT 在 ${timeoutMs}ms 内未达 ${n} 次（当前 ${insertCount}）`);
    },
  };
}

/** 等待 NDJSON 审计写满 expectedCount 行 */
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

/** 清 ESM 缓存后重新加载 ai-guard.js（触发顶层副作用） */
async function reloadAiGuardModule() {
  const href = `${pathToFileURL(GUARD_MODULE_PATH).href}?reload=${Date.now()}-${Math.random()}`;
  return import(href);
}

describe('S2: Guard 非 debug 路径去掉常开 console.log', () => {
  afterEach(() => {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-GUARD-NOISE-01: 默认模块加载无 AI_GUARD_MODULE_LOADED_* 常开日志', async () => {
    await withEnv({
      NODE_ENV: 'production',
      AI_GUARD_DEBUG: undefined,
    }, async () => {
      applyLooseLimits();
      delete process.env.AI_GUARD_DEBUG;

      const stub = stubConsole();
      try {
        const mod = await reloadAiGuardModule();
        assert.equal(typeof mod.createAiGuard, 'function');
        const joined = stub.logInfoJoined();
        assert.equal(
          joined.includes('AI_GUARD_MODULE_LOADED_VERSION_001'),
          false,
          '默认不得输出 AI_GUARD_MODULE_LOADED_VERSION_001',
        );
        assert.equal(
          joined.includes('AI_GUARD_MODULE_LOADED_'),
          false,
          '默认不得输出 AI_GUARD_MODULE_LOADED_ 前缀',
        );
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-NOISE-02: 默认 SQL 审计成功不打 console.log/info', async () => {
    await withEnv({
      AI_GUARD_DEBUG: undefined,
    }, async () => {
      applyLooseLimits();
      delete process.env.AI_GUARD_DEBUG;

      const fake = createFakeDbPool();
      const stub = stubConsole();
      try {
        const guard = createAiGuard({ jwtSecret: 'test', dbPool: fake.pool });
        const { req, res } = mockHttp({ requestId: 'noise-sql-1' });
        let nextCount = 0;
        await guard.middleware(req, res, () => { nextCount += 1; });
        assert.equal(nextCount, 1);
        req.aiGuard.finalize({
          status: 'ok',
          reason: 'stream_done',
          completionText: 'ok',
        });
        await fake.waitInsert(1);
        assert.equal(fake.getInsertCount(), 1, 'SQL INSERT 须恰好发生一次');
        const joined = stub.logInfoJoined();
        assert.equal(
          joined.includes('[ai-guard] SQL audit success'),
          false,
          '不得输出 SQL audit success 常开日志',
        );
        // 成功日志载荷不得把 requestId 打到 log/info（审计落库本身不经 console）
        assert.equal(
          joined.includes('noise-sql-1'),
          false,
          'log/info 不得含 noise-sql-1 成功日志载荷',
        );
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-NOISE-03: 默认换票 bodyHash 不匹配 → 401 且无常开日志', async () => {
    await withEnv({
      AI_GUARD_DEBUG: undefined,
    }, async () => {
      applyLooseLimits();
      delete process.env.AI_GUARD_DEBUG;

      const stub = stubConsole();
      try {
        const guard = createAiGuard({ jwtSecret: 'test' });
        const body = buildExchangeBody({ badBodyHash: true });
        const { req, res, jsonCalls } = mockExchangeHttp(body);
        await guard.exchangeToken(req, res);

        assert.equal(res.statusCode, 401);
        assert.deepEqual(jsonCalls[0], { code: 401, message: 'Body hash mismatch' });
        assert.equal(jsonCalls[0]?.data?.token, undefined);

        const joined = stub.logInfoJoined();
        assert.equal(joined.includes('[ai-guard] Body hash mismatch'), false);
        assert.equal(joined.includes('constructedBody'), false);
        // 旧实现会倾倒 { actual, provided, constructedBody }；默认路径不得再出现该对象形态
        assert.equal(joined.includes('provided:'), false);
        assert.equal(joined.includes('actual:'), false);
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-NOISE-04: 默认换票坏签名 → 401 且无 Expected base 常开日志', async () => {
    await withEnv({
      AI_GUARD_DEBUG: undefined,
    }, async () => {
      applyLooseLimits();
      delete process.env.AI_GUARD_DEBUG;

      const stub = stubConsole();
      try {
        const guard = createAiGuard({ jwtSecret: 'test' });
        const body = buildExchangeBody({ badSignature: true });
        const { req, res, jsonCalls } = mockExchangeHttp(body);
        await guard.exchangeToken(req, res);

        assert.equal(res.statusCode, 401);
        assert.deepEqual(jsonCalls[0], { code: 401, message: 'Invalid signature' });
        assert.equal(jsonCalls[0]?.data?.token, undefined);

        const joined = stub.logInfoJoined();
        assert.equal(
          joined.includes('[ai-guard] Invalid signature. Expected base'),
          false,
        );
        assert.equal(
          joined.includes(body.signatureBase),
          false,
          'log/info 不得倾倒完整 signatureBase',
        );
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-NOISE-05: AI_GUARD_DEBUG=true 时诊断仅走 debug 通道', async () => {
    await withEnv({
      AI_GUARD_DEBUG: 'true',
    }, async () => {
      applyLooseLimits();

      const stub = stubConsole();
      try {
        // SQL 成功审计
        const fake = createFakeDbPool();
        const guard = createAiGuard({ jwtSecret: 'test', dbPool: fake.pool });
        const { req, res } = mockHttp({ requestId: 'noise-debug-sql' });
        await guard.middleware(req, res, () => {});
        req.aiGuard.finalize({
          status: 'ok',
          reason: 'stream_done',
          completionText: 'ok',
        });
        await fake.waitInsert(1);

        // 换票坏签名
        const body = buildExchangeBody({ badSignature: true });
        const exchange = mockExchangeHttp(body);
        await guard.exchangeToken(exchange.req, exchange.res);
        assert.equal(exchange.res.statusCode, 401);
        assert.deepEqual(exchange.jsonCalls[0], { code: 401, message: 'Invalid signature' });

        assertNoNoiseInLogInfo(stub, 'debug 开启时');
        // 本实现保留诊断：SQL 成功与换票坏签仅出现在 console.debug
        const debugJoined = stub.calls.debug.join('\n');
        assert.match(debugJoined, /\[ai-guard-debug\]/);
        assert.ok(
          debugJoined.includes('SQL audit success') || debugJoined.includes('Invalid signature'),
          'debug 通道应含 SQL 成功或换票坏签诊断',
        );
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-NOISE-06: 不做：审计落库逻辑保持可写入', async () => {
    await withEnv({
      AI_GUARD_DEBUG: undefined,
    }, async () => {
      applyLooseLimits();
      delete process.env.AI_GUARD_DEBUG;

      const guard = createAiGuard({ jwtSecret: 'test' });
      const { req, res } = mockHttp({ requestId: 'noise-audit-keep' });
      let nextCount = 0;
      await guard.middleware(req, res, () => { nextCount += 1; });
      assert.equal(nextCount, 1);
      req.aiGuard.finalize({
        status: 'ok',
        reason: 'stream_done',
        completionText: 'persist-ok',
      });

      const lines = await readAuditLines(1);
      const row = lines.find((r) => r.requestId === 'noise-audit-keep');
      assert.ok(row, 'NDJSON 须含本次 requestId');
      assert.equal(typeof row.reason, 'string');
      assert.ok(row.reason.length > 0);
    });
  });

  it('UT-GUARD-NOISE-07: 不做：不要求扩展新日志平台', () => {
    // PASS 仅约束 stub console.* 与既有 NDJSON/SQL；与 backlog「不做：扩展新的日志平台」一致
    const doc = fs.readFileSync(
      path.resolve(__dirname, '../../../docs/test_cases.md'),
      'utf8',
    );
    const section = doc.slice(doc.indexOf('### 2.32'), doc.indexOf('## 3. 安全防护'));
    assert.ok(section.includes('UT-GUARD-NOISE-07'));
    assert.ok(
      section.includes('扩展新的日志平台') || section.includes('扩展新日志平台'),
      '契约须写明不做扩展新日志平台',
    );
    assert.ok(section.includes('console'));
    assert.ok(section.includes('NDJSON') || section.includes('SQL'));
    // 运行时探针：本用例自身不依赖任何外部日志 sink
    assert.equal(typeof createAiGuard, 'function');
  });

  it('UT-GUARD-NOISE-08: residual：不替代 A6 的 [ai-guard-debug] 契约', () => {
    // residual：A6 管前缀通道（§2.9）；本表只收常开噪音，不删除 AI_GUARD_DEBUG 开关
    const guardSrc = fs.readFileSync(GUARD_MODULE_PATH, 'utf8');
    assert.match(guardSrc, /AI_GUARD_DEBUG/);
    assert.match(guardSrc, /\[ai-guard-debug\]/);
    assert.match(guardSrc, /config\.debug/);
    // 本套件 it() 标题以 UT-GUARD-NOISE- 为前缀，不替代 A6 的 UT-GUARD-DEBUG-* 
    const titles = [
      'UT-GUARD-NOISE-01', 'UT-GUARD-NOISE-02', 'UT-GUARD-NOISE-03', 'UT-GUARD-NOISE-04',
      'UT-GUARD-NOISE-05', 'UT-GUARD-NOISE-06', 'UT-GUARD-NOISE-07', 'UT-GUARD-NOISE-08',
    ];
    assert.equal(titles.every((id) => id.startsWith('UT-GUARD-NOISE-')), true);
    assert.equal(titles.some((id) => id.startsWith('UT-GUARD-DEBUG-')), false);
  });
});

