/**
 * S1：换票 JWT 权限面隔离与管理面拒答集成。
 * 用例 ID 对齐 docs/test_cases.md §3.20。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  TEST_DB_PATH,
  TEST_JWT_SECRET,
  configureRouteTestEnv,
  createRouteResponse,
  removeTestFiles,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { initUserSchema } from '../db/user-repo.js';

const CLIENT_ID = 'web';
const CLIENT_SECRET = 'change_me';
const EXCHANGE_PATH = '/api/auth/token';

const EXTRA_ENV_KEYS = ['AI_CLIENT_CREDENTIALS', 'AI_ALLOWED_ORIGINS', 'AI_NONCE_TTL_MS'];
const savedEnv = saveTestEnv();
const savedExtra = {};
let app;
let pool;

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function hmacHex(secret, payload) {
  return createHmac('sha256', String(secret ?? '')).update(String(payload ?? ''), 'utf8').digest('hex');
}

/** 构造合法换票 body（§2.31 协议）。 */
function buildExchangeBody({ signatureOverride } = {}) {
  const clientId = CLIENT_ID;
  const ts = String(Date.now());
  const nonce = randomUUID();
  const bodyForHash = JSON.stringify({ clientId, ts, nonce });
  const bodyHash = sha256Hex(bodyForHash);
  const signatureBase = `${ts}.${nonce}.POST.${EXCHANGE_PATH}.${bodyHash}`;
  const signature = signatureOverride ?? hmacHex(CLIENT_SECRET, signatureBase);
  return { clientId, ts, nonce, signature, bodyHash, signatureBase };
}

/**
 * 经 app.handle 发请求；支持 GET/POST、Origin、自定义 Authorization。
 * @param {string} route
 * @param {object|null} body
 * @param {{ method?: string, authorization?: string, omitAuth?: boolean, origin?: string }} [options]
 */
function invokeRoute(route, body, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || (body == null && !options.forcePost ? 'GET' : 'POST');
    const payload = body === undefined || body === null ? '' : JSON.stringify(body);
    const req = Readable.from([payload]);
    req.method = method;
    req.url = route;
    req.path = route.split('?')[0];
    req.originalUrl = route;
    req.headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      'x-request-id': `s1-token-iso-${process.pid}`,
      'x-forwarded-for': '127.0.0.1',
    };
    if (options.origin) {
      req.headers.origin = options.origin;
    }
    if (options.authorization) {
      req.headers.authorization = options.authorization;
    } else if (!options.omitAuth && options.token) {
      req.headers.authorization = `Bearer ${options.token}`;
    }
    req.socket = { remoteAddress: '127.0.0.1' };
    req.ip = '127.0.0.1';
    req.query = Object.fromEntries(new URL(route, 'http://localhost').searchParams);
    req.header = function header(name) {
      return this.headers[String(name).toLowerCase()];
    };
    req.on = function on(event, listener) {
      if (event === 'close') return this;
      return Readable.prototype.on.call(this, event, listener);
    };
    req.once = function once(event, listener) {
      if (event === 'close') return this;
      return Readable.prototype.once.call(this, event, listener);
    };
    const res = createRouteResponse(resolve);
    app.handle(req, res, (error) => {
      if (error) reject(error);
      else if (!res.ended) resolve(res);
    });
  });
}

function jsonBody(res) {
  const entry = [...res.callOrder].reverse().find((e) => e.op === 'json');
  return entry?.payload;
}

async function insertUser({ username, passwordHash, roleId = 2, status = 'active' }) {
  return pool.withConnection(async (db) => {
    const result = await db.run(
      `INSERT INTO users (username, password_hash, role_id, status) VALUES (?, ?, ?, ?)`,
      [username, passwordHash, roleId, status]
    );
    return result.lastID;
  });
}

async function readUserStatus(userId) {
  return pool.withConnection(async (db) => {
    const row = await db.get('SELECT status FROM users WHERE id = ?', [userId]);
    return row?.status;
  });
}

describe('S1: 换票 JWT 权限面隔离与管理面拒答集成', () => {
  before(async () => {
    for (const key of EXTRA_ENV_KEYS) savedExtra[key] = process.env[key];
    configureRouteTestEnv();
    process.env.AI_CLIENT_CREDENTIALS = `${CLIENT_ID}:${CLIENT_SECRET}`;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
    process.env.AI_NONCE_TTL_MS = '50'; // 缩短 nonce 定时器，避免测试进程挂起
    await seedPromptBudgetDatabase();
    pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await initUserSchema(pool);
    ({ app } = await import('../server-express.js'));
  });

  after(async () => {
    try { await pool?.closeAll(); } catch { /* ignore */ }
    restoreTestEnv(savedEnv);
    for (const key of EXTRA_ENV_KEYS) {
      if (savedExtra[key] === undefined) delete process.env[key];
      else process.env[key] = savedExtra[key];
    }
    removeTestFiles();
  });

  beforeEach(async () => {
    await pool.withConnection(async (db) => {
      await db.run('DELETE FROM users');
    });
  });

  /** 合法换票拿票。 */
  async function doExchange({ signatureOverride } = {}) {
    const body = buildExchangeBody({ signatureOverride });
    const res = await invokeRoute(EXCHANGE_PATH, body, {
      method: 'POST',
      omitAuth: true,
      origin: 'http://localhost',
    });
    return { res, body: jsonBody(res), exchangeBody: body };
  }

  it('IT-TOKEN-ISO-01: 合法换票经路由返回可解码 JWT', async () => {
    const { res, body } = await doExchange();
    assert.equal(res.statusCode, 200);
    assert.equal(body.code, 0);
    assert.equal(typeof body.data?.token, 'string');
    assert.ok(body.data.token.length > 0);
    const payload = jwt.verify(body.data.token, TEST_JWT_SECRET);
    assert.equal(payload.op, 'ai_access');
    assert.notEqual(payload.role, 'admin');
  });

  it('IT-TOKEN-ISO-02: 换票 JWT 访问 pending-users → 403', async () => {
    const { body: ex } = await doExchange();
    const token = ex.data.token;
    const res = await invokeRoute('/api/admin/pending-users', null, {
      method: 'GET',
      authorization: `Bearer ${token}`,
    });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(body, { code: 403, message: 'Admin access required' });
    assert.equal(Array.isArray(body?.data), false);
  });

  it('IT-TOKEN-ISO-03: 换票 JWT 访问 audit-logs → 403', async () => {
    const { body: ex } = await doExchange();
    const token = ex.data.token;
    const res = await invokeRoute('/api/admin/audit-logs?limit=5', null, {
      method: 'GET',
      authorization: `Bearer ${token}`,
    });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 403);
    assert.equal(body.message, 'Admin access required');
    assert.equal(Array.isArray(body?.data), false);
  });

  it('IT-TOKEN-ISO-04: 换票 JWT 调用 approve-user → 403 且不改库', async () => {
    const pendingHash = await bcrypt.hash('pending-pass', 10);
    const pendingId = await insertUser({
      username: 's1_pending_p',
      passwordHash: pendingHash,
      roleId: 2,
      status: 'pending',
    });
    const { body: ex } = await doExchange();
    const token = ex.data.token;
    const res = await invokeRoute('/api/admin/approve-user', { userId: pendingId }, {
      method: 'POST',
      authorization: `Bearer ${token}`,
    });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 403);
    assert.equal(body.message, 'Admin access required');
    assert.equal(await readUserStatus(pendingId), 'pending');
  });

  it('IT-TOKEN-ISO-05: 对照：管理员登录票仍可访问管理面', async () => {
    const plain = 'Admin-S1-Ok!';
    const hash = await bcrypt.hash(plain, 10);
    await insertUser({
      username: 's1_admin',
      passwordHash: hash,
      roleId: 1,
      status: 'active',
    });
    const loginRes = await invokeRoute('/api/auth/login', {
      username: 's1_admin',
      password: plain,
    }, { method: 'POST', omitAuth: true });
    const loginBody = jsonBody(loginRes);
    assert.equal(loginRes.statusCode, 200);
    assert.equal(typeof loginBody.data?.token, 'string');
    const loginPayload = jwt.verify(loginBody.data.token, TEST_JWT_SECRET);
    assert.equal(loginPayload.role, 'admin');

    const res = await invokeRoute('/api/admin/pending-users', null, {
      method: 'GET',
      authorization: `Bearer ${loginBody.data.token}`,
    });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.code, 0);
    assert.ok(Array.isArray(body.data));
  });

  it('IT-TOKEN-ISO-06: 对照：普通用户登录票管理面仍 403', async () => {
    const plain = 'User-S1-Ok!';
    const hash = await bcrypt.hash(plain, 10);
    await insertUser({
      username: 's1_user',
      passwordHash: hash,
      roleId: 2,
      status: 'active',
    });
    const loginRes = await invokeRoute('/api/auth/login', {
      username: 's1_user',
      password: plain,
    }, { method: 'POST', omitAuth: true });
    const loginBody = jsonBody(loginRes);
    assert.equal(loginRes.statusCode, 200);
    const loginPayload = jwt.verify(loginBody.data.token, TEST_JWT_SECRET);
    assert.notEqual(loginPayload.role, 'admin');

    const res = await invokeRoute('/api/admin/pending-users', null, {
      method: 'GET',
      authorization: `Bearer ${loginBody.data.token}`,
    });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 403);
    assert.equal(body.message, 'Admin access required');
  });

  it('SEC-TOKEN-ISO-01: 机调票不能提权为 admin（安全回归）', async () => {
    const { body: ex } = await doExchange();
    const token = ex.data.token;
    const payload = jwt.verify(token, TEST_JWT_SECRET);
    assert.notEqual(payload.role, 'admin');
    assert.equal(payload.id, undefined);
    assert.equal(payload.username, undefined);

    for (const [route, method, reqBody] of [
      ['/api/admin/pending-users', 'GET', null],
      ['/api/admin/audit-logs?limit=5', 'GET', null],
      ['/api/admin/approve-user', 'POST', { userId: 1 }],
    ]) {
      const res = await invokeRoute(route, reqBody, {
        method,
        authorization: `Bearer ${token}`,
      });
      const body = jsonBody(res);
      assert.equal(res.statusCode, 403, `${route} 应为 403`);
      assert.equal(body.message, 'Admin access required');
    }
  });

  it('SEC-TOKEN-ISO-02: 换票响应与审计不得泄露 JWT_SECRET / client secret', async () => {
    const { res: okRes, body: okBody, exchangeBody } = await doExchange();
    const okRaw = JSON.stringify(okBody);
    assert.equal(okRes.statusCode, 200);
    assert.equal(okRaw.includes(TEST_JWT_SECRET), false);
    assert.equal(okRaw.includes(CLIENT_SECRET), false);
    assert.equal(okRaw.includes(exchangeBody.signatureBase), false);
    assert.deepEqual(Object.keys(okBody).sort(), ['code', 'data', 'message'].sort());
    assert.deepEqual(Object.keys(okBody.data).sort(), ['expiresIn', 'token'].sort());

    const { res: badRes, body: badBody } = await doExchange({
      signatureOverride: 'deadbeef',
    });
    const badRaw = JSON.stringify(badBody);
    assert.equal(badRes.statusCode, 401);
    assert.match(String(badBody.message), /Invalid signature/i);
    assert.equal(badRaw.includes(TEST_JWT_SECRET), false);
    assert.equal(badRaw.includes(CLIENT_SECRET), false);
    assert.equal(badRaw.includes('stack'), false);
  });

  it('SEC-TOKEN-ISO-03: 不做 / residual 边界：不测凭证轮换与部署开关', () => {
    // 本用例不断言密钥轮换、前端删除换票、改 AI_REQUIRE_SIGNED_HEADERS 默认或 Nginx
    assert.equal(process.env.AI_REQUIRE_SIGNED_HEADERS, 'false');
    assert.ok(true);
  });
});
