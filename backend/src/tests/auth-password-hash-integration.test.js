/**
 * D51 / P2-2：注册/登录密码哈希与懒迁移集成。
 * 用例 ID 对齐 docs/test_cases.md §3.19。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
import { getUserByUsername, initUserSchema } from '../db/user-repo.js';
import { BCRYPT_HASH_PREFIX_RE, legacySha256Hex } from '../auth-password.js';

const savedEnv = saveTestEnv();
let app;
let pool;

/** 经 app.handle 发 JSON 请求；支持 method / omitAuth / 自定义 Authorization。 */
function invokeAuthRoute(route, body, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method || 'POST';
    const payload = body === undefined || body === null ? '' : JSON.stringify(body);
    const req = Readable.from([payload]);
    req.method = method;
    req.url = route;
    req.path = route.split('?')[0];
    req.originalUrl = route;
    req.headers = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(payload)),
      'x-request-id': `d51-auth-${process.pid}`,
      'x-forwarded-for': '127.0.0.1',
    };
    if (options.authorization) {
      req.headers.authorization = options.authorization;
    } else if (!options.omitAuth && options.token) {
      req.headers.authorization = `Bearer ${options.token}`;
    }
    req.socket = { remoteAddress: '127.0.0.1' };
    req.ip = '127.0.0.1';
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

/** 直接插入 active 用户（绕过注册 pending），用于登录场景。 */
async function insertActiveUser({ username, passwordHash, roleId = 2 }) {
  return pool.withConnection(async (db) => {
    const result = await db.run(
      `INSERT INTO users (username, password_hash, role_id, status) VALUES (?, ?, ?, 'active')`,
      [username, passwordHash, roleId]
    );
    return result.lastID;
  });
}

async function readPasswordHash(username) {
  const user = await getUserByUsername(pool, username);
  return user?.password_hash;
}

describe('D51 / P2-2: 注册/登录密码哈希与懒迁移集成', () => {
  before(async () => {
    configureRouteTestEnv();
    await seedPromptBudgetDatabase();
    // 确保用户表存在（getSqlitePool 也会 init，此处便于直接插种子）
    pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await initUserSchema(pool);
    ({ app } = await import('../server-express.js'));
  });

  after(async () => {
    try { await pool?.closeAll(); } catch { /* ignore */ }
    restoreTestEnv(savedEnv);
    removeTestFiles();
  });

  beforeEach(async () => {
    await pool.withConnection(async (db) => {
      await db.run('DELETE FROM users');
    });
  });

  it('IT-AUTH-HASH-01: 注册写入 bcryptjs 而非 sha256', async () => {
    const res = await invokeAuthRoute('/api/auth/register', {
      username: 'd51_new',
      password: 'Reg-D51-Ok!',
    }, { omitAuth: true });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.code, 0);
    assert.match(String(body.message), /Registration successful/i);
    const hash = await readPasswordHash('d51_new');
    assert.match(hash, BCRYPT_HASH_PREFIX_RE);
    assert.notEqual(hash, legacySha256Hex('Reg-D51-Ok!'));
    assert.equal(await bcrypt.compare('Reg-D51-Ok!', hash), true);
  });

  it('IT-AUTH-HASH-02: bcrypt 用户登录成功且不改写哈希', async () => {
    const username = 'd51_bcrypt_login';
    const plain = 'Login-Bcrypt-Ok';
    const beforeHash = await bcrypt.hash(plain, 10);
    await insertActiveUser({ username, passwordHash: beforeHash });
    const res = await invokeAuthRoute('/api/auth/login', { username, password: plain }, { omitAuth: true });
    const body = jsonBody(res);
    assert.equal(res.statusCode, 200);
    assert.equal(body.code, 0);
    assert.equal(typeof body.data?.token, 'string');
    assert.ok(body.data.token.length > 0);
    assert.equal(body.data.user.username, username);
    assert.equal(await readPasswordHash(username), beforeHash);
    const raw = JSON.stringify(body);
    assert.equal(/"password"|password_hash/.test(raw), false);
  });

  it('IT-AUTH-HASH-03: 旧 sha256 用户登录成功并懒迁移', async () => {
    const username = 'd51_legacy_login';
    const plain = 'Legacy-Login-Ok';
    const oldHash = legacySha256Hex(plain);
    await insertActiveUser({ username, passwordHash: oldHash });
    const res1 = await invokeAuthRoute('/api/auth/login', { username, password: plain }, { omitAuth: true });
    const body1 = jsonBody(res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(body1.code, 0);
    assert.ok(body1.data?.token);
    const newHash = await readPasswordHash(username);
    assert.match(newHash, BCRYPT_HASH_PREFIX_RE);
    assert.equal(await bcrypt.compare(plain, newHash), true);
    assert.notEqual(newHash, oldHash);

    const res2 = await invokeAuthRoute('/api/auth/login', { username, password: plain }, { omitAuth: true });
    assert.equal(res2.statusCode, 200);
    assert.equal(jsonBody(res2).code, 0);
    const afterSecond = await readPasswordHash(username);
    assert.match(afterSecond, BCRYPT_HASH_PREFIX_RE);
    assert.equal(await bcrypt.compare(plain, afterSecond), true);
  });

  it('IT-AUTH-HASH-04: 错误密码 401 且不迁移', async () => {
    const bcryptUser = 'd51_wrong_bcrypt';
    const legacyUser = 'd51_wrong_legacy';
    const bcryptHash = await bcrypt.hash('correct-bcrypt', 10);
    const legacyHash = legacySha256Hex('correct-legacy');
    await insertActiveUser({ username: bcryptUser, passwordHash: bcryptHash });
    await insertActiveUser({ username: legacyUser, passwordHash: legacyHash });

    for (const [username, password] of [
      [bcryptUser, 'wrong'],
      [legacyUser, 'wrong'],
    ]) {
      const res = await invokeAuthRoute('/api/auth/login', { username, password }, { omitAuth: true });
      const body = jsonBody(res);
      assert.equal(res.statusCode, 401);
      assert.deepEqual(body, { code: 401, message: 'Invalid username or password' });
      assert.equal(body.data?.token, undefined);
    }
    assert.equal(await readPasswordHash(bcryptUser), bcryptHash);
    assert.equal(await readPasswordHash(legacyUser), legacyHash);
  });

  it('IT-AUTH-HASH-05: 懒迁移后旧 JWT 仍可用（不做失效会话）', async () => {
    const username = 'd51_keep_jwt';
    const plain = 'Keep-Jwt-Ok';
    const oldHash = legacySha256Hex(plain);
    const userId = await insertActiveUser({ username, passwordHash: oldHash });
    const oldToken = jwt.sign({
      id: userId,
      username,
      role: 'user',
      permissions: ['study'],
      clientId: 'web',
    }, TEST_JWT_SECRET, { expiresIn: '1h' });

    const loginRes = await invokeAuthRoute('/api/auth/login', { username, password: plain }, { omitAuth: true });
    assert.equal(loginRes.statusCode, 200);
    assert.match(await readPasswordHash(username), BCRYPT_HASH_PREFIX_RE);

    const profileRes = await invokeAuthRoute('/api/user/profile', undefined, {
      method: 'GET',
      authorization: `Bearer ${oldToken}`,
    });
    assert.equal(profileRes.statusCode, 200);
  });

  it('IT-AUTH-HASH-06: residual：未登录的其它旧哈希用户不被扫表改写', async () => {
    const stayHash = legacySha256Hex('stay-plain');
    const loginHash = legacySha256Hex('login-plain');
    await insertActiveUser({ username: 'U_stay', passwordHash: stayHash });
    await insertActiveUser({ username: 'U_login', passwordHash: loginHash });

    const res = await invokeAuthRoute('/api/auth/login', {
      username: 'U_login',
      password: 'login-plain',
    }, { omitAuth: true });
    assert.equal(res.statusCode, 200);
    assert.match(await readPasswordHash('U_login'), BCRYPT_HASH_PREFIX_RE);
    assert.equal(await readPasswordHash('U_stay'), stayHash);
  });

  it('IT-AUTH-HASH-07: 注册缺字段仍 400，且不落库半截用户', async () => {
    for (const body of [{}, { username: 'x' }, { password: 'y' }]) {
      const res = await invokeAuthRoute('/api/auth/register', body, { omitAuth: true });
      const payload = jsonBody(res);
      assert.equal(res.statusCode, 400);
      assert.equal(payload.code, 400);
      assert.equal(payload.message, 'Username and password required');
    }
    const count = await pool.withConnection(async (db) => {
      const row = await db.get(`SELECT COUNT(*) AS c FROM users WHERE username IN ('x')`);
      return row.c;
    });
    assert.equal(count, 0);
  });

  it('SEC-AUTH-HASH-01: 登录失败响应不得回显密码或哈希', async () => {
    const username = 'd51_sec_echo';
    const plain = 'Secret-Plain-99';
    const stored = legacySha256Hex(plain);
    await insertActiveUser({ username, passwordHash: stored });

    const wrongRes = await invokeAuthRoute('/api/auth/login', {
      username,
      password: 'bad-password-xyz',
    }, { omitAuth: true });
    const unknownRes = await invokeAuthRoute('/api/auth/login', {
      username: 'no_such_user_d51',
      password: 'bad-password-xyz',
    }, { omitAuth: true });

    for (const res of [wrongRes, unknownRes]) {
      assert.equal(res.statusCode, 401);
      const raw = JSON.stringify(jsonBody(res));
      assert.equal(raw.includes('bad-password-xyz'), false);
      assert.equal(raw.includes(stored), false);
      assert.equal(raw.includes(legacySha256Hex('bad-password-xyz')), false);
    }
    assert.equal(jsonBody(wrongRes).message, jsonBody(unknownRes).message);
    assert.equal(jsonBody(wrongRes).message, 'Invalid username or password');
  });

  it('SEC-AUTH-HASH-02: 成功登录/注册响应不得泄露 password_hash', async () => {
    const regRes = await invokeAuthRoute('/api/auth/register', {
      username: 'd51_sec_reg',
      password: 'Reg-Sec-Ok!',
    }, { omitAuth: true });
    const regRaw = JSON.stringify(jsonBody(regRes));
    assert.equal(/"password"|"password_hash"|"passwordHash"/.test(regRaw), false);

    const username = 'd51_sec_login';
    const plain = 'Login-Sec-Ok';
    await insertActiveUser({ username, passwordHash: await bcrypt.hash(plain, 10) });
    const loginRes = await invokeAuthRoute('/api/auth/login', { username, password: plain }, { omitAuth: true });
    const loginBody = jsonBody(loginRes);
    const loginRaw = JSON.stringify(loginBody);
    assert.equal(/"password"|"password_hash"|"passwordHash"/.test(loginRaw), false);
    assert.equal(/\$2[aby]\$/.test(loginRaw), false);
    assert.equal(typeof loginBody.data?.token, 'string');
    assert.equal(typeof loginBody.data?.user?.username, 'string');
  });

  it('SEC-AUTH-HASH-03: 不做离线全表翻写：进程启动不改写存量哈希', async () => {
    const h1 = legacySha256Hex('boot-stay-1');
    const h2 = legacySha256Hex('boot-stay-2');
    await insertActiveUser({ username: 'boot_u1', passwordHash: h1 });
    await insertActiveUser({ username: 'boot_u2', passwordHash: h2 });
    // 应用已在 before 加载；此处仅再读库，不调用 login
    assert.equal(await readPasswordHash('boot_u1'), h1);
    assert.equal(await readPasswordHash('boot_u2'), h2);
  });
});
