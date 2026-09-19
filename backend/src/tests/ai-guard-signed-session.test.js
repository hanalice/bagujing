/**
 * B31 / P0-5：签名开关打开时，有登录会话也必须验签。
 * 用例 ID 与 docs/test_cases.md §2.19 对齐。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-b31-${process.pid}.ndjson`);
const CLIENT_ID = 'web';
const CLIENT_SECRET = 'change_me';

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

function applyBaseEnv({ requireSigned } = {}) {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
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
  if (requireSigned === undefined) {
    delete process.env.AI_REQUIRE_SIGNED_HEADERS;
  } else {
    process.env.AI_REQUIRE_SIGNED_HEADERS = requireSigned;
  }
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

function hmacHex(secret, payload) {
  return createHmac('sha256', String(secret ?? '')).update(String(payload ?? ''), 'utf8').digest('hex');
}

/**
 * 构造符合 Guard HMAC 契约的六元组签名头。
 * @param {{ method: string, path: string, body: unknown, signatureOverride?: string }} opts
 */
function buildSignedHeaders({ method, path: reqPath, body, signatureOverride }) {
  const ts = String(Date.now());
  const nonce = randomUUID();
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
 * 构造可调用 createAiGuard().middleware 的假 HTTP 对象。
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
      if (key === 'x-request-id') return 'test-req-b31';
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
      return name === 'X-Request-Id' ? 'test-req-b31' : undefined;
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

describe('B31/P0-5: 签名开关打开时有会话也验签', () => {
  saveEnv();

  afterEach(() => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-GUARD-SIG-01: 默认未开签名：有会话可无签名头放行', async () => {
    applyBaseEnv({ requireSigned: undefined });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'hello' },
      headers: { origin: 'http://localhost' },
      user: { clientId: CLIENT_ID },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });

    assert.equal(nextCount, 1);
    assert.equal(http.statusCalls.includes(401), false);
    assert.equal(http.jsonCalls.some((p) => p?.code === 401), false);
  });

  it('UT-GUARD-SIG-02: 开关 true + 有会话 + 缺签名头 → 401', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    const guard = createAiGuard({ jwtSecret: 'test' });

    // 组 1：全部 HMAC 头缺失；Bearer 不能替代 HMAC
    const missingAll = mockHttp({
      body: { message: 'burn-quota' },
      headers: {
        origin: 'http://localhost',
        authorization: 'Bearer any-jwt-cannot-bypass-hmac',
      },
      user: { clientId: CLIENT_ID },
    });
    let nextAll = 0;
    await guard.middleware(missingAll.req, missingAll.res, () => { nextAll += 1; });
    assert.equal(nextAll, 0);
    assert.equal(missingAll.statusCode, 401);
    assert.deepEqual(missingAll.jsonCalls[0], { code: 401, message: 'Missing AI auth headers' });

    // 组 2：仅缺 x-signature（其余五头齐全）
    const partialHeaders = buildSignedHeaders({
      method: 'POST',
      path: '/api/chat',
      body: { message: 'burn-quota' },
    });
    delete partialHeaders['x-signature'];
    const missingSig = mockHttp({
      body: { message: 'burn-quota' },
      headers: partialHeaders,
      user: { clientId: CLIENT_ID },
    });
    let nextSig = 0;
    await guard.middleware(missingSig.req, missingSig.res, () => { nextSig += 1; });
    assert.equal(nextSig, 0);
    assert.equal(missingSig.statusCode, 401);
    assert.deepEqual(missingSig.jsonCalls[0], { code: 401, message: 'Missing AI auth headers' });

    const audits = await readAuditLines(2);
    const rejectReasons = audits
      .filter((row) => row.decision === 'reject')
      .map((row) => row.reason);
    assert.ok(rejectReasons.includes('missing_headers'));
    assert.equal(rejectReasons.filter((r) => r === 'missing_headers').length >= 2, true);
  });

  it('UT-GUARD-SIG-03: 开关 true + 有会话 + 合法 HMAC → next', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const body = { message: 'signed-ok' };
    const headers = buildSignedHeaders({ method: 'POST', path: '/api/chat', body });
    const http = mockHttp({ body, headers, user: { clientId: CLIENT_ID } });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });

    assert.equal(nextCount, 1);
    assert.equal(http.statusCalls.includes(401), false);
    assert.equal(http.statusCalls.includes(403), false);
    assert.equal(http.jsonCalls.length, 0);

    // 放行路径不应落 reject 审计；若文件尚未写出则允许不存在
    if (fs.existsSync(AUDIT_FILE)) {
      const raw = fs.readFileSync(AUDIT_FILE, 'utf8').trim();
      const rows = raw ? raw.split('\n').map((line) => JSON.parse(line)) : [];
      const badRejectReasons = new Set(['missing_headers', 'invalid_signature', 'body_hash_mismatch']);
      const bad = rows.filter(
        (row) => row.decision === 'reject' && badRejectReasons.has(row.reason),
      );
      assert.equal(bad.length, 0);
    }
  });

  it('UT-GUARD-SIG-04: 开关 true + 有会话 + 伪造签名 → 401', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const body = { message: 'forged' };
    const headers = buildSignedHeaders({
      method: 'POST',
      path: '/api/chat',
      body,
      signatureOverride: 'deadbeef',
    });
    const http = mockHttp({ body, headers, user: { clientId: CLIENT_ID } });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });

    assert.equal(nextCount, 0);
    assert.equal(http.statusCode, 401);
    assert.deepEqual(http.jsonCalls[0], { code: 401, message: 'Invalid signature' });

    const audits = await readAuditLines(1);
    assert.ok(audits.some((row) => row.decision === 'reject' && row.reason === 'invalid_signature'));
  });

  it('UT-GUARD-SIG-05: 开关 true + 无会话仍强制验签（对照）', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'anon' },
      headers: {
        'x-client-id': CLIENT_ID,
        origin: 'http://localhost',
      },
      user: null,
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });

    assert.equal(nextCount, 0);
    assert.equal(http.statusCode, 401);
    const audits = await readAuditLines(1);
    assert.ok(audits.some((row) => row.decision === 'reject' && row.reason === 'missing_headers'));
  });

  it('UT-GUARD-SIG-06: 开关 true 时 chat 与 generate 两条 AI 路由均验签', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    const guard = createAiGuard({ jwtSecret: 'test' });

    const chat = mockHttp({
      path: '/api/chat',
      body: { message: 'x' },
      headers: { origin: 'http://localhost' },
      user: { clientId: CLIENT_ID },
    });
    let chatNext = 0;
    await guard.middleware(chat.req, chat.res, () => { chatNext += 1; });
    assert.equal(chatNext, 0);
    assert.equal(chat.statusCode, 401);
    assert.deepEqual(chat.jsonCalls[0], { code: 401, message: 'Missing AI auth headers' });

    const generate = mockHttp({
      path: '/api/problems/1/answer/generate',
      body: { force: false },
      headers: { origin: 'http://localhost' },
      user: { clientId: CLIENT_ID },
    });
    let generateNext = 0;
    await guard.middleware(generate.req, generate.res, () => { generateNext += 1; });
    assert.equal(generateNext, 0);
    assert.equal(generate.statusCode, 401);
    assert.deepEqual(generate.jsonCalls[0], { code: 401, message: 'Missing AI auth headers' });

    const audits = await readAuditLines(2);
    const missing = audits.filter(
      (row) => row.decision === 'reject' && row.reason === 'missing_headers',
    );
    assert.ok(missing.length >= 2);
    const routes = new Set(missing.map((row) => row.route));
    assert.ok(routes.has('chat'));
    assert.ok(routes.has('answer_generate'));
  });

  it('UT-GUARD-SIG-07: 开关 true + 有会话 + body hash 不匹配 → 401', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    const guard = createAiGuard({ jwtSecret: 'test' });
    const body = { message: 'hash-mismatch' };
    const headers = buildSignedHeaders({ method: 'POST', path: '/api/chat', body });
    // 声称的 hash 与真实 body 不一致，但签名仍按声称的 hash 计算，以通过 HMAC 前的形式校验
    const claimedHash = '0'.repeat(64);
    const ts = headers['x-ts'];
    const nonce = headers['x-nonce'];
    const signatureBase = `${ts}.${nonce}.POST./api/chat.${claimedHash}`;
    headers['x-body-sha256'] = claimedHash;
    headers['x-signature'] = hmacHex(CLIENT_SECRET, signatureBase);

    const http = mockHttp({ body, headers, user: { clientId: CLIENT_ID } });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });

    assert.equal(nextCount, 0);
    assert.equal(http.statusCode, 401);
    assert.deepEqual(http.jsonCalls[0], { code: 401, message: 'Body hash mismatch' });

    const audits = await readAuditLines(1);
    assert.ok(audits.some((row) => row.decision === 'reject' && row.reason === 'body_hash_mismatch'));
  });

  it('UT-GUARD-SIG-08: 开关 true 时验签拒答发生在限流之前', async () => {
    applyBaseEnv({ requireSigned: 'true' });
    process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1';
    process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1';
    const guard = createAiGuard({ jwtSecret: 'test' });

    for (let i = 0; i < 2; i += 1) {
      const http = mockHttp({
        body: { message: `no-sig-${i}` },
        headers: { origin: 'http://localhost' },
        user: { clientId: CLIENT_ID },
      });
      let nextCount = 0;
      await guard.middleware(http.req, http.res, () => { nextCount += 1; });
      assert.equal(nextCount, 0);
      assert.equal(http.statusCode, 401);
      assert.equal(http.statusCalls.includes(429), false);
      assert.deepEqual(http.jsonCalls[0], { code: 401, message: 'Missing AI auth headers' });
    }

    const audits = await readAuditLines(2);
    const missing = audits.filter(
      (row) => row.decision === 'reject' && row.reason === 'missing_headers',
    );
    assert.equal(missing.length >= 2, true);
    assert.equal(
      audits.some((row) => row.reason === 'rate_client_minute' || row.reason === 'rate_ip_minute'),
      false,
    );
  });
});
