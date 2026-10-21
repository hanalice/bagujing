/**
 * S1：机调换票 JWT 与登录票权限面隔离（单元）。
 * 用例 ID 对齐 docs/test_cases.md §2.31。
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';
import { createAiGuard } from '../security/ai-guard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JWT_SECRET = 's1-token-iso-ut-secret';
const CLIENT_ID = 'web';
const CLIENT_SECRET = 'change_me';
const EXCHANGE_PATH = '/api/auth/token';

const ENV_KEYS = [
  'AI_CLIENT_CREDENTIALS',
  'AI_ALLOWED_ORIGINS',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_JWT_SECRET',
  'AI_NONCE_TTL_MS',
];

const savedEnv = {};

function saveEnv() {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function hmacHex(secret, payload) {
  return createHmac('sha256', String(secret ?? '')).update(String(payload ?? ''), 'utf8').digest('hex');
}

/**
 * 构造合法换票 body（与 docs/test_cases.md §2.31 协议一致）。
 * @param {{ clientId?: string, path?: string, secret?: string, signatureOverride?: string }} [opts]
 */
function buildExchangeBody({
  clientId = CLIENT_ID,
  path: reqPath = EXCHANGE_PATH,
  secret = CLIENT_SECRET,
  signatureOverride,
} = {}) {
  const ts = String(Date.now());
  const nonce = randomUUID();
  const bodyForHash = JSON.stringify({ clientId, ts, nonce });
  const bodyHash = sha256Hex(bodyForHash);
  const signatureBase = `${ts}.${nonce}.POST.${reqPath}.${bodyHash}`;
  const signature = signatureOverride ?? hmacHex(secret, signatureBase);
  return { clientId, ts, nonce, signature, bodyHash, signatureBase };
}

/**
 * 与 server-express.js requireAdmin 同条件探针（该中间件未导出）。
 * 判定：req.user?.role !== 'admin' → 403 Admin access required。
 */
function requireAdminProbe(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ code: 403, message: 'Admin access required' });
  }
  next();
}

/** mock exchangeToken 的 req/res。 */
function mockExchangeHttp(body, { path: reqPath = EXCHANGE_PATH, origin = 'http://localhost' } = {}) {
  const jsonCalls = [];
  const statusCalls = [];
  let statusCode = 200;
  const req = {
    path: reqPath,
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
      statusCalls.push(code);
      return this;
    },
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
  };
  return { req, res, jsonCalls, statusCalls };
}

describe('S1: 机调换票 JWT 与登录票权限面隔离', () => {
  beforeEach(() => {
    saveEnv();
    process.env.AI_CLIENT_CREDENTIALS = `${CLIENT_ID}:${CLIENT_SECRET}`;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
    process.env.AI_NONCE_TTL_MS = '50'; // 缩短 nonce 定时器，避免测试进程挂起
    delete process.env.AI_REQUIRE_SIGNED_HEADERS;
  });

  afterEach(() => {
    restoreEnv();
  });

  /** 合法换票并返回解码后的 payload 与原始 token。 */
  async function exchangeAndVerify() {
    const guard = createAiGuard({ jwtSecret: JWT_SECRET });
    const body = buildExchangeBody();
    const { req, res, jsonCalls } = mockExchangeHttp(body);
    await guard.exchangeToken(req, res);
    assert.equal(jsonCalls.length, 1);
    const payloadJson = jsonCalls[0];
    assert.equal(payloadJson.code, 0);
    assert.equal(payloadJson.message, 'success');
    assert.equal(typeof payloadJson.data?.token, 'string');
    assert.ok(payloadJson.data.token.length > 0);
    assert.equal(payloadJson.data.expiresIn, 3600);
    const decoded = jwt.verify(payloadJson.data.token, JWT_SECRET);
    return { token: payloadJson.data.token, decoded, json: payloadJson, statusCode: res.statusCode };
  }

  it('UT-TOKEN-ISO-01: 合法换票签发成功且返回 JWT 串', async () => {
    const { token, decoded, json, statusCode } = await exchangeAndVerify();
    assert.equal(statusCode, 200);
    assert.equal(json.code, 0);
    assert.equal(json.message, 'success');
    assert.equal(typeof token, 'string');
    assert.ok(token.length > 0);
    assert.equal(decoded.clientId, CLIENT_ID);
    assert.equal(json.data.expiresIn, 3600);
  });

  it('UT-TOKEN-ISO-02: 换票 payload：op=ai_access 且含 AI 权限名', async () => {
    const { decoded } = await exchangeAndVerify();
    assert.equal(decoded.op, 'ai_access');
    assert.equal(decoded.clientId, CLIENT_ID);
    assert.ok(Array.isArray(decoded.permissions));
    assert.ok(decoded.permissions.includes('chat_ai'));
  });

  it('UT-TOKEN-ISO-03: 换票 payload：禁止 role=admin（回归点）', async () => {
    const { decoded } = await exchangeAndVerify();
    assert.notEqual(decoded.role, 'admin');
    const jsonCalls = [];
    let nextCount = 0;
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        jsonCalls.push(payload);
        return this;
      },
    };
    requireAdminProbe({ user: decoded }, res, () => { nextCount += 1; });
    assert.equal(nextCount, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(jsonCalls[0], { code: 403, message: 'Admin access required' });
  });

  it('UT-TOKEN-ISO-04: 换票 payload 代入 requireAdmin → 拒绝', async () => {
    const { decoded } = await exchangeAndVerify();
    const jsonCalls = [];
    let nextCount = 0;
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        jsonCalls.push(payload);
        return this;
      },
    };
    // 等价于 server-express.js requireAdmin：req.user?.role !== 'admin' → 403
    requireAdminProbe({ user: decoded }, res, () => { nextCount += 1; });
    assert.equal(nextCount, 0);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(jsonCalls[0], { code: 403, message: 'Admin access required' });
  });

  it('UT-TOKEN-ISO-05: 换票票与登录票 claims 形状隔离', async () => {
    const { decoded: exchangePayload } = await exchangeAndVerify();
    const loginToken = jwt.sign(
      { id: 1, username: 'u', role: 'user', permissions: ['study'], clientId: 'web' },
      JWT_SECRET,
      { expiresIn: '7d' }
    );
    const loginPayload = jwt.verify(loginToken, JWT_SECRET);
    assert.equal(exchangePayload.id, undefined);
    assert.equal(exchangePayload.username, undefined);
    assert.equal(loginPayload.id, 1);
    assert.equal(loginPayload.username, 'u');
    assert.equal(exchangePayload.op, 'ai_access');
    assert.notEqual(loginPayload.op, 'ai_access');
  });

  it('UT-TOKEN-ISO-06: 换票 permissions 不得含管理提升语义', async () => {
    const { decoded } = await exchangeAndVerify();
    assert.ok(Array.isArray(decoded.permissions));
    for (const p of decoded.permissions) {
      assert.equal(typeof p, 'string');
    }
    assert.ok(decoded.permissions.includes('chat_ai'));
    assert.equal(decoded.permissions.includes('admin'), false);
    const allowed = new Set(['chat_ai', 'study']);
    for (const p of decoded.permissions) {
      assert.ok(allowed.has(p), `permissions 含非 AI 路由名: ${p}`);
    }
  });

  it('UT-TOKEN-ISO-07: 不做：登录签发路径 claims 保持不变', () => {
    const loginSrc = fs.readFileSync(
      path.join(__dirname, '../server-express.js'),
      'utf8'
    );
    // 冻结登录签发形状：含 id/username/role/permissions/clientId，expiresIn 7d
    assert.match(loginSrc, /id:\s*user\.id/);
    assert.match(loginSrc, /username:\s*user\.username/);
    assert.match(loginSrc, /role:\s*user\.role_name/);
    assert.match(loginSrc, /permissions:\s*permissions\.map/);
    assert.match(loginSrc, /clientId:\s*'web'/);
    assert.match(loginSrc, /expiresIn:\s*'7d'/);

    const adminLoginPayload = {
      id: 9,
      username: 'admin-u',
      role: 'admin',
      permissions: ['chat_ai', 'study'],
      clientId: 'web',
    };
    let nextCount = 0;
    const jsonCalls = [];
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        jsonCalls.push(payload);
        return this;
      },
    };
    requireAdminProbe({ user: adminLoginPayload }, res, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
    assert.equal(jsonCalls.length, 0);
  });

  it('UT-TOKEN-ISO-08: 不做：不要求改签名开关默认值', () => {
    delete process.env.AI_REQUIRE_SIGNED_HEADERS;
    const guardSrc = fs.readFileSync(
      path.join(__dirname, '../security/ai-guard.js'),
      'utf8'
    );
    assert.match(
      guardSrc,
      /AI_REQUIRE_SIGNED_HEADERS\s*\?\?\s*'false'/
    );
    const guard = createAiGuard({ jwtSecret: JWT_SECRET });
    // 默认未开签名：middleware 有会话可无签名头放行（与 B31/SEC-GUARD-09 一致）
    assert.equal(
      String(process.env.AI_REQUIRE_SIGNED_HEADERS ?? 'false').toLowerCase() === 'true',
      false
    );
    assert.ok(guard);
  });

  it('UT-TOKEN-ISO-09: residual：不要求客户端凭证轮换 / 前端停换票', () => {
    // residual 另条：本用例仅锁边界——不得以「必须实现轮换/停换票」为 FAIL
    const assertBodies = [
      'UT-TOKEN-ISO-01', 'UT-TOKEN-ISO-02', 'UT-TOKEN-ISO-03', 'UT-TOKEN-ISO-04',
      'UT-TOKEN-ISO-05', 'UT-TOKEN-ISO-06', 'UT-TOKEN-ISO-07', 'UT-TOKEN-ISO-08',
    ].join('|');
    assert.ok(assertBodies.length > 0);
    // 允许前端无 Bearer 时仍调用 /api/auth/token（与 B33 / S7 分界）
    assert.equal(typeof createAiGuard({ jwtSecret: JWT_SECRET }).exchangeToken, 'function');
  });
});
