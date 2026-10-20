/**
 * D51 / P2-2：密码哈希与登录懒迁移。
 * 新注册用 bcryptjs；登录先 bcrypt，失败再回退旧无盐 sha256；命中旧哈希则按用户写回 bcrypt。
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/** 与改造前 server-express hashPassword 一致的旧无盐 sha256 十六进制。 */
export function legacySha256Hex(password) {
  return crypto.createHash('sha256').update(String(password ?? '')).digest('hex');
}

/** bcryptjs 持久化串前缀（$2a$ / $2b$ / $2y$）。 */
export const BCRYPT_HASH_PREFIX_RE = /^\$2[aby]\$\d{2}\$/;

/** 默认盐轮次（bcryptjs 常见默认；契约未冻死具体值）。 */
export const BCRYPT_SALT_ROUNDS = 10;

/**
 * 新注册用哈希：bcryptjs，禁止再写无盐 sha256。
 * @param {string} password 明文密码
 * @param {number} [saltRounds]
 * @returns {Promise<string>}
 */
export async function hashPassword(password, saltRounds = BCRYPT_SALT_ROUNDS) {
  return bcrypt.hash(String(password ?? ''), saltRounds);
}

/**
 * 登录校验：先 bcrypt.compare，失败再回退 legacy sha256；
 * 仅当「bcrypt 未通过且 sha256 命中」时对该 userId 写回 bcrypt（懒迁移）。
 *
 * @param {object} params
 * @param {string} params.password 明文
 * @param {string} params.storedHash 库中 password_hash
 * @param {number|string} [params.userId] 用户 id（写回定位）
 * @param {(id: number|string, newHash: string) => Promise<unknown>} [params.updatePasswordHash] 写回回调
 * @param {object} [params.deps] 可注入 bcryptCompare / legacySha256Hex / hashPassword 便于单测计数
 * @returns {Promise<boolean>} 校验是否成功
 */
export async function verifyPasswordAndMaybeMigrate({
  password,
  storedHash,
  userId,
  updatePasswordHash,
  deps = {},
}) {
  const bcryptCompare = deps.bcryptCompare || ((plain, hash) => bcrypt.compare(plain, hash));
  const legacyHex = deps.legacySha256Hex || legacySha256Hex;
  const hashNew = deps.hashPassword || hashPassword;

  const plain = String(password ?? '');
  const stored = String(storedHash ?? '');

  let bcryptOk = false;
  try {
    bcryptOk = await bcryptCompare(plain, stored);
  } catch {
    bcryptOk = false;
  }
  if (bcryptOk) return true;

  if (stored !== legacyHex(plain)) return false;

  // 命中旧 sha256：懒迁移写回 bcrypt（仅该用户）
  if (typeof updatePasswordHash === 'function' && userId != null) {
    const newHash = await hashNew(plain);
    await updatePasswordHash(userId, newHash);
  }
  return true;
}
