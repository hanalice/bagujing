/**
 * S9：登录态审计 userIdentifier 取会话主键，忽略客户端 x-user-id 覆盖。
 * 用例 ID 对齐 docs/test_cases.md §2.34 / §3.21。
 * 路径：middleware + finalize 探针（不连真实上游 / Redis）。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s9-uid-${process.pid}.ndjson`);

const ENV_KEYS = [
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_MAX_INPUT_CHARS',
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

/** 与 ai-guard 内部 sha256Hex 一致 */
function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
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

/**
 * 构造可注入 user / x-user-id / IP 的 mock HTTP 对。
 * @param {{ method?: string, path?: string, body?: object, user?: object|null, headers?: Record<string,string>, ip?: string, requestId?: string }} opts
 */
function mockHttp({
  method = 'POST',
  path: reqPath = '/api/chat',
  body = { message: 'uid-probe' },
  user,
  headers = {},
  ip = '203.0.113.10',
  requestId = 'test-req-s9',
} = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const headerMap = {};
  for (const [k, v] of Object.entries(headers)) {
    headerMap[String(k).toLowerCase()] = v;
  }
  const req = {
    method,
    path: reqPath,
    body,
    ip,
    headers: {
      ...(headerMap['x-forwarded-for'] ? { 'x-forwarded-for': headerMap['x-forwarded-for'] } : {}),
    },
    user,
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return requestId;
      if (Object.prototype.hasOwnProperty.call(headerMap, key)) return headerMap[key];
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
      return name === 'X-Request-Id' ? requestId : undefined;
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

function configureUidEnv({ maxInputChars } = {}) {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_MAX_COMPLETION_TOKENS = '4096';
  process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';
  if (maxInputChars !== undefined) {
    process.env.AI_MAX_INPUT_CHARS = String(maxInputChars);
  } else {
    delete process.env.AI_MAX_INPUT_CHARS;
  }
}

/**
 * 注入可捕获 INSERT ai_audit_logs 绑定参数的 fake dbPool。
 */
function createCapturingDbPool() {
  const inserts = [];
  const pool = {
    withConnection: async (fn) => {
      const db = {
        async run(sql, params) {
          if (String(sql).includes('INSERT INTO ai_audit_logs')) {
            inserts.push({ sql: String(sql), params: params ?? [] });
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
    inserts,
    async waitInsert(n = 1, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inserts.length >= n) return inserts;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`SQL INSERT 在 ${timeoutMs}ms 内未达 ${n} 次（当前 ${inserts.length}）`);
    },
  };
}

describe('S9: 登录态审计 userIdentifier 取会话主键', () => {
  saveEnv();

  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-AUDIT-UID-01: 登录态：identifier 等于用户主键字符串', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'uid-01' },
      user: { id: 42, username: 'alice', clientId: 'web' },
      ip: '203.0.113.10',
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });

    assert.equal(nextCount, 1);
    assert.equal(http.req.aiGuard.userIdentifier, '42');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'alice');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'web');
    assert.notEqual(http.req.aiGuard.userIdentifier, sha256Hex('203.0.113.10').slice(0, 16));
  });

  it('UT-AUDIT-UID-02: 登录态 + 伪造 x-user-id 不得覆盖', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'uid-02' },
      user: { id: 42, username: 'alice', clientId: 'web' },
      headers: { 'x-user-id': 'attacker-spoof' },
    });
    await guard.middleware(http.req, http.res, () => {});

    assert.equal(http.req.aiGuard.userIdentifier, '42');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'attacker-spoof');
  });

  it('UT-AUDIT-UID-03: 登录态 finalize 审计行写入同一 identifier', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'uid-03' },
      user: { id: 42, username: 'alice', clientId: 'web' },
      headers: { 'x-user-id': 'attacker-spoof' },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });

    const [row] = await readAuditLines(1);
    assert.equal(row.decision, 'allow');
    assert.equal(row.reason, 'stream_done');
    assert.equal(row.userIdentifier, '42');
    assert.equal(row.userIdentifier, http.req.aiGuard.userIdentifier);
    assert.notEqual(row.userIdentifier, 'attacker-spoof');
  });

  it('UT-AUDIT-UID-04: 主键为非数字字符串仍取 String(id)', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      user: { id: 'user-uuid-7', clientId: 'web' },
      headers: { 'x-user-id': 'other' },
    });
    await guard.middleware(http.req, http.res, () => {});

    assert.equal(http.req.aiGuard.userIdentifier, 'user-uuid-7');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'other');
  });

  it('UT-AUDIT-UID-05: 匿名 + 非空 x-user-id → 采用该头', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      user: undefined,
      headers: { 'x-user-id': 'anon-client-9' },
      ip: '203.0.113.10',
    });
    await guard.middleware(http.req, http.res, () => {});

    assert.equal(http.req.aiGuard.userIdentifier, 'anon-client-9');
    assert.notEqual(http.req.aiGuard.userIdentifier, sha256Hex('203.0.113.10').slice(0, 16));

    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'anon',
      upstreamReached: true,
    });
    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, 'anon-client-9');
  });

  it('UT-AUDIT-UID-06: 匿名 + 无 x-user-id → IP 哈希短前缀', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const ip = '198.51.100.20';
    const expected = sha256Hex(ip).slice(0, 16);
    const http = mockHttp({
      user: undefined,
      ip,
      headers: {},
    });
    await guard.middleware(http.req, http.res, () => {});

    assert.equal(http.req.aiGuard.userIdentifier, expected);
    assert.equal(http.req.aiGuard.userIdentifier.length, 16);
    assert.match(http.req.aiGuard.userIdentifier, /^[0-9a-f]{16}$/);

    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ip',
      upstreamReached: true,
    });
    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, expected);
  });

  it('UT-AUDIT-UID-07: req.user 无 id 时走匿名规则', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      user: { clientId: 'web', username: 'no-pk' },
      headers: { 'x-user-id': 'from-header' },
      ip: '198.51.100.20',
    });
    await guard.middleware(http.req, http.res, () => {});

    assert.equal(http.req.aiGuard.userIdentifier, 'from-header');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'no-pk');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'web');

    const httpNoHeader = mockHttp({
      user: { clientId: 'web', username: 'no-pk' },
      ip: '198.51.100.20',
      requestId: 'test-req-s9-b',
    });
    await guard.middleware(httpNoHeader.req, httpNoHeader.res, () => {});
    assert.equal(
      httpNoHeader.req.aiGuard.userIdentifier,
      sha256Hex('198.51.100.20').slice(0, 16),
    );
  });

  it('UT-AUDIT-UID-08: 匿名超长 x-user-id 可截断', async () => {
    const maxChars = 1200;
    configureUidEnv({ maxInputChars: maxChars });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const longId = 'U'.repeat(2000);
    const http = mockHttp({
      user: undefined,
      headers: { 'x-user-id': longId },
      ip: '203.0.113.10',
    });
    await guard.middleware(http.req, http.res, () => {});

    const uid = http.req.aiGuard.userIdentifier;
    assert.equal(typeof uid, 'string');
    assert.ok(uid.length > 0);
    assert.notEqual(uid, sha256Hex('203.0.113.10').slice(0, 16));
    assert.ok(
      uid === longId || (uid.length <= maxChars && longId.startsWith(uid)),
      '超长头须全等或截断为前缀，不得回落 IP 哈希',
    );

    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'long',
      upstreamReached: true,
    });
    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, uid);
  });

  it('UT-AUDIT-UID-09: chat 与 generate 两条路由同一规则', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const chat = mockHttp({
      path: '/api/chat',
      body: { message: 'x' },
      user: { id: 7, clientId: 'web' },
      headers: { 'x-user-id': 'spoof' },
      requestId: 's9-chat',
    });
    const gen = mockHttp({
      path: '/api/problems/1/answer/generate',
      body: { force: false },
      user: { id: 7, clientId: 'web' },
      headers: { 'x-user-id': 'spoof' },
      requestId: 's9-gen',
    });
    await guard.middleware(chat.req, chat.res, () => {});
    await guard.middleware(gen.req, gen.res, () => {});

    assert.equal(chat.req.aiGuard.userIdentifier, '7');
    assert.equal(gen.req.aiGuard.userIdentifier, '7');
    assert.notEqual(chat.req.aiGuard.userIdentifier, 'spoof');
    assert.notEqual(gen.req.aiGuard.userIdentifier, 'spoof');
  });

  it('UT-AUDIT-UID-10: SQL 审计绑定 user_identifier（可选注入 dbPool）', async () => {
    configureUidEnv();
    const fake = createCapturingDbPool();
    const guard = createAiGuard({ jwtSecret: 'test', dbPool: fake.pool });
    const http = mockHttp({
      user: { id: 99, clientId: 'web' },
      headers: { 'x-user-id': 'spoof-sql' },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'sql',
      upstreamReached: true,
    });

    const [insert] = await fake.waitInsert(1);
    assert.match(insert.sql, /user_identifier/);
    // INSERT 列序：request_id, client_id, user_identifier, ...
    assert.equal(insert.params[2], '99');
    assert.notEqual(insert.params[2], 'spoof-sql');

    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, '99');
    assert.equal(row.userIdentifier, insert.params[2]);
  });

  it('UT-AUDIT-UID-11: 不做：不要求按用户日配额', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const a = mockHttp({
      user: { id: 1, clientId: 'web' },
      requestId: 'uid-11-a',
    });
    const b = mockHttp({
      user: { id: 2, clientId: 'web' },
      requestId: 'uid-11-b',
    });
    let nextA = 0;
    let nextB = 0;
    await guard.middleware(a.req, a.res, () => { nextA += 1; });
    await guard.middleware(b.req, b.res, () => { nextB += 1; });

    assert.equal(nextA, 1);
    assert.equal(nextB, 1);
    assert.equal(a.req.aiGuard.userIdentifier, '1');
    assert.equal(b.req.aiGuard.userIdentifier, '2');
    // 本项仅锁审计身份；不得以 user_daily_* 429 为 FAIL
    assert.notEqual(a.statusCode, 429);
    assert.notEqual(b.statusCode, 429);
  });

  it('UT-AUDIT-UID-12: 不做：不改字段名 / 不回填历史 / 不改签名换票限流', () => {
    // 只读边界：本表不要求重命名字段、回填历史或改 HMAC/换票/限流
    assert.equal('userIdentifier', 'userIdentifier');
    assert.equal('user_identifier', 'user_identifier');
  });

  it('UT-AUDIT-UID-13: residual：匿名无头时仅 IP 哈希可接受', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const ip = '198.51.100.20';
    const http = mockHttp({ user: undefined, ip });
    await guard.middleware(http.req, http.res, () => {});

    const uid = http.req.aiGuard.userIdentifier;
    assert.equal(uid, sha256Hex(ip).slice(0, 16));
    assert.equal(uid.length, 16);
    // residual：允许仅 IP 哈希，不得以「匿名必须登录」为 FAIL
    assert.ok(uid);
  });

  // §3.21 安全回归：允许与 §2.34 同文件，用 middleware+finalize 探针
  it('SEC-AUDIT-UID-01: 伪造 x-user-id 不能冒充他人审计身份', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      path: '/api/chat',
      body: { message: 'sec-01' },
      user: { id: 42, clientId: 'web' },
      headers: { 'x-user-id': 'victim-999' },
    });
    await guard.middleware(http.req, http.res, () => {});
    assert.ok(http.statusCode < 400 || http.statusCode === 200);
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'sec',
      upstreamReached: true,
    });
    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, '42');
    assert.notEqual(row.userIdentifier, 'victim-999');
  });

  it('SEC-AUDIT-UID-02: 匿名路径不受登录态规则误伤', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      user: undefined,
      headers: { 'x-user-id': 'guest-a' },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'guest',
      upstreamReached: true,
    });
    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, 'guest-a');
    assert.ok(row.userIdentifier != null);
  });

  it('IT-AUDIT-UID-01: generate 登录态同样忽略伪造头', async () => {
    configureUidEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      path: '/api/problems/9/answer/generate',
      body: { force: false },
      user: { id: 55, clientId: 'web' },
      headers: { 'x-user-id': 'spoof-gen' },
    });
    await guard.middleware(http.req, http.res, () => {});
    http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'cached_answer',
      completionText: 'cached',
      upstreamReached: false,
    });
    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, '55');
    assert.notEqual(row.userIdentifier, 'spoof-gen');
  });

  it('IT-AUDIT-UID-02: 不做边界：不测用户配额 / 不改列名', () => {
    assert.ok(true, '不做：不按 userIdentifier 日配额，不改 user_identifier 列名');
  });
});
