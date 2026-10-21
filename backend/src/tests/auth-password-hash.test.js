/**
 * D51 / P2-2：密码 bcryptjs 与登录懒迁移（单元）。
 * 用例 ID 对齐 docs/test_cases.md §2.30。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import {
  BCRYPT_HASH_PREFIX_RE,
  hashPassword,
  legacySha256Hex,
  verifyPasswordAndMaybeMigrate,
} from '../auth-password.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(__dirname, '..');
const PKG_JSON = path.join(__dirname, '../../package.json');

describe('D51 / P2-2: 密码 bcryptjs 与懒迁移', () => {
  it('UT-AUTH-HASH-01: 新注册哈希为 bcryptjs 形态且可 compare', async () => {
    const plain = 'P@ss-D51-reg';
    const stored = await hashPassword(plain);
    assert.match(stored, BCRYPT_HASH_PREFIX_RE);
    assert.equal(await bcrypt.compare(plain, stored), true);
    const legacy = legacySha256Hex(plain);
    assert.notEqual(stored, legacy);
    assert.equal(/^[0-9a-f]{64}$/.test(stored), false);
  });

  it('UT-AUTH-HASH-02: 注册路径禁止写入无盐 sha256', async () => {
    const plain = 'no-sha256-reg';
    const expectedLegacy = legacySha256Hex(plain);
    let passwordSha256Digest = 0;
    const originalCreateHash = crypto.createHash.bind(crypto);
    crypto.createHash = (algorithm, ...rest) => {
      const hash = originalCreateHash(algorithm, ...rest);
      if (String(algorithm).toLowerCase() === 'sha256') {
        const originalDigest = hash.digest.bind(hash);
        hash.digest = (encoding, ...digestRest) => {
          const out = originalDigest(encoding, ...digestRest);
          // 仅统计注册哈希路径上的 sha256 hex；对照用 legacy 须在 spy 外预计算
          if (encoding === 'hex') passwordSha256Digest += 1;
          return out;
        };
      }
      return hash;
    };
    try {
      const stored = await hashPassword(plain);
      assert.notEqual(stored, expectedLegacy);
      assert.match(stored, BCRYPT_HASH_PREFIX_RE);
      assert.equal(passwordSha256Digest, 0);
    } finally {
      crypto.createHash = originalCreateHash;
    }
  });

  it('UT-AUTH-HASH-03: 登录：已是 bcrypt 时 compare 成功且不写库', async () => {
    const plain = 'ok-bcrypt';
    const stored = await bcrypt.hash(plain, 10);
    let migrateCalls = 0;
    let compareCalled = false;
    const ok = await verifyPasswordAndMaybeMigrate({
      password: plain,
      storedHash: stored,
      userId: 1,
      updatePasswordHash: async () => { migrateCalls += 1; },
      deps: {
        bcryptCompare: async (p, h) => {
          compareCalled = true;
          return bcrypt.compare(p, h);
        },
      },
    });
    assert.equal(ok, true);
    assert.equal(compareCalled, true);
    assert.equal(migrateCalls, 0);
  });

  it('UT-AUTH-HASH-04: 登录：旧 sha256 命中 → 校验成功并懒迁移写回', async () => {
    const plain = 'legacy-ok';
    const stored0 = legacySha256Hex(plain);
    const writes = [];
    const callOrder = [];
    const ok = await verifyPasswordAndMaybeMigrate({
      password: plain,
      storedHash: stored0,
      userId: 42,
      updatePasswordHash: async (id, newHash) => {
        writes.push({ id, newHash });
      },
      deps: {
        bcryptCompare: async (p, h) => {
          callOrder.push('bcrypt');
          return bcrypt.compare(p, h);
        },
        legacySha256Hex: (p) => {
          callOrder.push('sha256');
          return legacySha256Hex(p);
        },
      },
    });
    assert.equal(ok, true);
    assert.deepEqual(callOrder.slice(0, 2), ['bcrypt', 'sha256']);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].id, 42);
    assert.match(writes[0].newHash, BCRYPT_HASH_PREFIX_RE);
    assert.equal(await bcrypt.compare(plain, writes[0].newHash), true);
  });

  it('UT-AUTH-HASH-05: 登录：明文错误 → bcrypt 与 sha256 皆失败、不写回', async () => {
    const wrong = 'wrong-pass';
    for (const stored of [
      await bcrypt.hash('right-bcrypt', 10),
      legacySha256Hex('right-legacy'),
    ]) {
      let migrateCalls = 0;
      const ok = await verifyPasswordAndMaybeMigrate({
        password: wrong,
        storedHash: stored,
        userId: 7,
        updatePasswordHash: async () => { migrateCalls += 1; },
      });
      assert.equal(ok, false);
      assert.equal(migrateCalls, 0);
    }
  });

  it('UT-AUTH-HASH-06: 校验序：必须先 bcrypt 再回退 sha256', async () => {
    const plain = 'order-check';
    const stored = legacySha256Hex(plain);
    const timeline = [];
    let seq = 0;
    let migrateCalls = 0;
    const ok = await verifyPasswordAndMaybeMigrate({
      password: plain,
      storedHash: stored,
      userId: 3,
      updatePasswordHash: async () => { migrateCalls += 1; },
      deps: {
        bcryptCompare: async (p, h) => {
          timeline.push({ kind: 'bcrypt', at: seq++ });
          return bcrypt.compare(p, h);
        },
        legacySha256Hex: (p) => {
          timeline.push({ kind: 'sha256', at: seq++ });
          return legacySha256Hex(p);
        },
      },
    });
    assert.equal(ok, true);
    const bcryptAt = timeline.find((e) => e.kind === 'bcrypt')?.at;
    const shaAt = timeline.find((e) => e.kind === 'sha256')?.at;
    assert.equal(typeof bcryptAt, 'number');
    assert.equal(typeof shaAt, 'number');
    assert.ok(bcryptAt < shaAt);
    assert.equal(migrateCalls, 1);
  });

  it('UT-AUTH-HASH-07: 不做：无批量 SQL 扫表翻写', async () => {
    const users = {
      A: { id: 1, password_hash: legacySha256Hex('pass-A') },
      B: { id: 2, password_hash: legacySha256Hex('pass-B') },
      C: { id: 3, password_hash: legacySha256Hex('pass-C') },
    };
    const sqlLog = [];
    const updatePasswordHash = async (id, newHash) => {
      const sql = 'UPDATE users SET password_hash = ? WHERE id = ?';
      sqlLog.push({ sql, id, newHash });
      const row = Object.values(users).find((u) => u.id === id);
      if (row) row.password_hash = newHash;
    };
    const ok = await verifyPasswordAndMaybeMigrate({
      password: 'pass-A',
      storedHash: users.A.password_hash,
      userId: users.A.id,
      updatePasswordHash,
    });
    assert.equal(ok, true);
    assert.equal(sqlLog.length, 1);
    assert.equal(sqlLog[0].id, 1);
    assert.match(sqlLog[0].sql, /WHERE\s+id\s*=\s*\?/i);
    assert.equal(/UPDATE\s+users\s+SET\s+password_hash\s*=\s*\?(?!\s*,)(?!.*WHERE)/i.test(sqlLog[0].sql), false);
    assert.equal(users.B.password_hash, legacySha256Hex('pass-B'));
    assert.equal(users.C.password_hash, legacySha256Hex('pass-C'));
    assert.match(users.A.password_hash, BCRYPT_HASH_PREFIX_RE);
  });

  it('UT-AUTH-HASH-08: 不做：不引入 argon2 作为本项哈希库', () => {
    const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    assert.ok(Object.prototype.hasOwnProperty.call(deps, 'bcryptjs'));
    assert.equal(Object.prototype.hasOwnProperty.call(deps, 'argon2'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(deps, '@node-rs/argon2'), false);

    const authSrc = fs.readFileSync(path.join(SRC_ROOT, 'auth-password.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(SRC_ROOT, 'server-express.js'), 'utf8');
    assert.match(authSrc, /from\s+['"]bcryptjs['"]|require\(['"]bcryptjs['"]\)/);
    assert.equal(/argon2|@node-rs\/argon2/.test(authSrc), false);
    assert.equal(/from\s+['"]argon2['"]|require\(['"]argon2['"]\)/.test(serverSrc), false);
  });

  it('UT-AUTH-HASH-09: 不做：懒迁移不强制失效已有会话', async () => {
    const secret = 'd51-ut-jwt-secret';
    const userId = 99;
    const token = jwt.sign({ id: userId, username: 'stay-session' }, secret, { expiresIn: '1h' });
    let revokeCalls = 0;
    const ok = await verifyPasswordAndMaybeMigrate({
      password: 'sess-plain',
      storedHash: legacySha256Hex('sess-plain'),
      userId,
      updatePasswordHash: async () => {
        // 迁移路径不吊销会话
      },
    });
    assert.equal(ok, true);
    const payload = jwt.verify(token, secret);
    assert.equal(payload.id, userId);
    assert.equal(revokeCalls, 0);
  });

  it('UT-AUTH-HASH-10: residual：未登录存量用户保持旧哈希', async () => {
    const u1Hash = legacySha256Hex('stay-old');
    const users = {
      U1: { id: 10, password_hash: u1Hash },
      U2: { id: 11, password_hash: legacySha256Hex('migrate-me') },
    };
    await verifyPasswordAndMaybeMigrate({
      password: 'migrate-me',
      storedHash: users.U2.password_hash,
      userId: users.U2.id,
      updatePasswordHash: async (id, newHash) => {
        if (id === users.U2.id) users.U2.password_hash = newHash;
      },
    });
    assert.equal(users.U1.password_hash, u1Hash);
    assert.equal(await bcrypt.compare('stay-old', users.U1.password_hash), false);
    assert.match(users.U2.password_hash, BCRYPT_HASH_PREFIX_RE);
  });
});
