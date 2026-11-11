/**
 * S15：无效 client token 风控计数按 clientId 聚合，达到阈值才 403。
 * 用例 ID 与 docs/test_cases.md §2.46 对齐。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s15-${process.pid}.ndjson`);
const CLIENT_ID = 'web';
const CLIENT_SECRET = 'change_me';
/** 单测注入的阈值，低于生产默认 6，缩短用例 */
const BRUTE_THRESHOLD = 3;

const ENV_KEYS = [
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_CLIENT_CREDENTIALS',
  'AI_ALLOWED_ORIGINS',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
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

function applyBaseEnv() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'true';
  process.env.AI_CLIENT_CREDENTIALS = `${CLIENT_ID}:${CLIENT_SECRET}`;
  process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';
}

/** 审计异步落盘，读取前轮询至期望条数 */
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

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

/**
 * 构造六元组齐全但 client token 错误、且每次 signature 不同的假请求头。
 * @param {{ body?: unknown, signature?: string }} [opts]
 */
function buildBadTokenHeaders({ body = { message: 'probe' }, signature } = {}) {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const bodyHash = sha256Hex(JSON.stringify(body ?? {}));
  return {
    'x-client-id': CLIENT_ID,
    'x-client-token': 'wrong-token-value',
    'x-ts': ts,
    'x-nonce': nonce,
    'x-signature': signature ?? `sig-${randomUUID().replace(/-/g, '')}`,
    'x-body-sha256': bodyHash,
    origin: 'http://localhost',
  };
}

/**
 * 构造可调用 createAiGuard().middleware 的假 HTTP 对象。
 * @param {{ method?: string, path?: string, body?: unknown, headers?: Record<string, string>, user?: object|null }} opts
 */
function mockHttp({
  method = 'POST',
  path: reqPath = '/api/chat',
  body = { message: 'probe' },
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
      if (key === 'x-request-id') return 'test-req-s15';
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
      return name === 'X-Request-Id' ? 'test-req-s15' : undefined;
    },
    once() {},
  };

  return {
    req,
    res,
    jsonCalls,
    statusCalls,
    get statusCode() {
      return statusCode;
    },
  };
}

describe('S15: 无效 client token 按 clientId 聚合风控', () => {
  saveEnv();

  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-TOKEN-BRUTE-01: 未达阈值时每次仍 401 / invalid_client_token（签名头各不相同）', async () => {
    applyBaseEnv();
    const guard = createAiGuard({ jwtSecret: 'test', clientTokenBruteThreshold: BRUTE_THRESHOLD });
    const reasons = [];
    for (let i = 0; i < BRUTE_THRESHOLD - 1; i += 1) {
      const body = { message: `probe-${i}` };
      const http = mockHttp({
        body,
        headers: buildBadTokenHeaders({ body, signature: `unique-sig-${i}-${randomUUID()}` }),
      });
      let nextCount = 0;
      await guard.middleware(http.req, http.res, () => { nextCount += 1; });
      assert.equal(nextCount, 0);
      assert.equal(http.statusCode, 401);
      assert.deepEqual(http.jsonCalls[0], { code: 401, message: 'Invalid client token' });
    }
    const audits = await readAuditLines(BRUTE_THRESHOLD - 1);
    for (const row of audits) {
      assert.equal(row.decision, 'reject');
      assert.equal(row.reason, 'invalid_client_token');
      reasons.push(row.reason);
    }
    assert.equal(reasons.length, BRUTE_THRESHOLD - 1);
  });

  it('UT-TOKEN-BRUTE-02: 连续失败且签名不同，达到阈值后 403 / client_token_bruteforce', async () => {
    applyBaseEnv();
    const guard = createAiGuard({ jwtSecret: 'test', clientTokenBruteThreshold: BRUTE_THRESHOLD });
    const statuses = [];
    for (let i = 0; i < BRUTE_THRESHOLD; i += 1) {
      const body = { message: `burst-${i}` };
      const http = mockHttp({
        body,
        headers: buildBadTokenHeaders({ body, signature: `burst-sig-${i}-${randomUUID()}` }),
      });
      let nextCount = 0;
      await guard.middleware(http.req, http.res, () => { nextCount += 1; });
      assert.equal(nextCount, 0);
      statuses.push(http.statusCode);
    }
    assert.deepEqual(statuses.slice(0, BRUTE_THRESHOLD - 1), Array(BRUTE_THRESHOLD - 1).fill(401));
    assert.equal(statuses[BRUTE_THRESHOLD - 1], 403);

    const audits = await readAuditLines(BRUTE_THRESHOLD);
    assert.equal(audits[BRUTE_THRESHOLD - 1].reason, 'client_token_bruteforce');
    assert.equal(audits[BRUTE_THRESHOLD - 1].decision, 'reject');
    for (let i = 0; i < BRUTE_THRESHOLD - 1; i += 1) {
      assert.equal(audits[i].reason, 'invalid_client_token');
    }
  });

  it('UT-TOKEN-BRUTE-03: 达阈值后的拒绝 JSON 为 Client temporarily blocked', async () => {
    applyBaseEnv();
    const guard = createAiGuard({ jwtSecret: 'test', clientTokenBruteThreshold: BRUTE_THRESHOLD });
    let lastHttp;
    for (let i = 0; i < BRUTE_THRESHOLD; i += 1) {
      const body = { message: `msg-${i}` };
      lastHttp = mockHttp({
        body,
        headers: buildBadTokenHeaders({ body, signature: `final-sig-${i}` }),
      });
      await guard.middleware(lastHttp.req, lastHttp.res, () => {});
    }
    assert.equal(lastHttp.statusCode, 403);
    assert.deepEqual(lastHttp.jsonCalls[0], {
      code: 403,
      message: 'Client temporarily blocked',
    });
  });

  it('UT-TOKEN-BRUTE-04: 不做：默认阈值仍为 6；不改签名默认；不要求 Redis 共享', async () => {
    applyBaseEnv();
    const guardDefault = createAiGuard({ jwtSecret: 'test' });
    // 通过行为锁默认阈值：连续 5 次不同签名仍 401，第 6 次 403
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const body = { message: `def-${i}` };
      const http = mockHttp({
        body,
        headers: buildBadTokenHeaders({ body, signature: `def-sig-${i}` }),
      });
      await guardDefault.middleware(http.req, http.res, () => {});
      statuses.push(http.statusCode);
    }
    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(statuses[5], 403);

    // 签名默认仍为 false（未设 env 时）
    delete process.env.AI_REQUIRE_SIGNED_HEADERS;
    const guardOff = createAiGuard({ jwtSecret: 'test' });
    const openHttp = mockHttp({
      body: { message: 'no-sig' },
      headers: { origin: 'http://localhost' },
    });
    let nextCount = 0;
    await guardOff.middleware(openHttp.req, openHttp.res, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
    assert.equal(openHttp.statusCalls.includes(401), false);
  });
});
