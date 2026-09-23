/**
 * C22：problems 的 FTS5 虚表重建与关键字查询。
 * 查询失败时由调用方回退 LIKE；不删除 problems 旧列；不做向量检索。
 */

/** FTS5 虚表名（稳定可断言） */
export const PROBLEMS_FTS_TABLE = 'problems_fts';

/** @type {null | ((sql: string, params?: unknown[]) => void)} */
let sqlTap = null;

/**
 * 注册 SQL 旁路观察（单测 spy）；传 null 清除。
 * @param {null | ((sql: string, params?: unknown[]) => void)} fn
 */
export function setRagSqlTap(fn) {
  sqlTap = typeof fn === 'function' ? fn : null;
}

/**
 * 将 SQL 交给旁路观察（失败不影响主路径）；供 buildRagContext 等调用方复用。
 * @param {string} sql
 * @param {unknown[]} [params]
 */
export function noteRagSql(sql, params) {
  if (!sqlTap) return;
  try {
    sqlTap(sql, params);
  } catch {
    /* ignore observer errors */
  }
}

// 将 SQL 交给旁路观察（失败不影响主路径）。
function tapSql(sql, params) {
  noteRagSql(sql, params);
}

/**
 * 将文本拆成按字空格分隔串，便于 FTS5 对中文做近似子串短语匹配。
 * @param {unknown} text
 * @returns {string}
 */
export function toFtsIndexedText(text) {
  return [...String(text ?? '')]
    .filter((ch) => ch.trim() !== '')
    .join(' ');
}

/**
 * 将用户 query 规范为 FTS5 短语 MATCH 串；过滤 FTS 特殊字符。
 * @param {string} query
 * @returns {string | null} 不可用时返回 null
 */
export function toFtsMatchQuery(query) {
  const raw = String(query ?? '').trim();
  if (!raw) return null;
  // 去掉 FTS5 语法元字符，避免客户端注入或破坏 MATCH。
  const cleaned = raw.replace(/["*():^~{}[\]\\]/g, ' ');
  const chars = [...cleaned].filter((ch) => ch.trim() !== '');
  if (chars.length === 0) return null;
  return `"${chars.join(' ')}"`;
}

/**
 * 从 problems 全量重建 FTS5 虚表（幂等：可重复执行）。
 * @param {{ withConnection: (fn: (db: *) => Promise<*>) => Promise<*> }} pool
 */
export async function rebuildProblemsFts(pool) {
  if (!pool) return;

  await pool.withConnection(async (db) => {
    const dropSql = `DROP TABLE IF EXISTS ${PROBLEMS_FTS_TABLE}`;
    tapSql(dropSql);
    await db.exec(dropSql);

    const createSql = `
      CREATE VIRTUAL TABLE ${PROBLEMS_FTS_TABLE} USING fts5(
        brief_name,
        key_points_json
      )
    `;
    tapSql(createSql);
    await db.exec(createSql);

    const rows = await db.all(
      `SELECT id, brief_name, key_points_json FROM problems`,
    );
    tapSql(`SELECT id, brief_name, key_points_json FROM problems`);

    for (const row of rows) {
      const insertSql = `
        INSERT INTO ${PROBLEMS_FTS_TABLE}(rowid, brief_name, key_points_json)
        VALUES (?, ?, ?)
      `;
      const params = [
        row.id,
        toFtsIndexedText(row.brief_name),
        toFtsIndexedText(row.key_points_json ?? ''),
      ];
      tapSql(insertSql, params);
      await db.run(insertSql, params);
    }
  });
}

/**
 * 经 FTS5 MATCH 召回 problems 行；失败抛错供调用方回退 LIKE。
 * @param {{ withConnection: (fn: (db: *) => Promise<*>) => Promise<*> }} pool
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
export async function searchProblemsFts(pool, query, limit) {
  const matchQuery = toFtsMatchQuery(query);
  if (!matchQuery) return [];

  const sql = `
    SELECT p.id, p.brief_name, p.key_points_json, p.category_id
    FROM ${PROBLEMS_FTS_TABLE}
    JOIN problems p ON p.id = ${PROBLEMS_FTS_TABLE}.rowid
    WHERE ${PROBLEMS_FTS_TABLE} MATCH ?
    LIMIT ?
  `;
  const params = [matchQuery, limit];
  return pool.withConnection(async (db) => {
    tapSql(sql, params);
    return db.all(sql, params);
  });
}

/**
 * 既有 LIKE 关键字召回（FTS 失败时的回退路径）。
 * @param {{ withConnection: (fn: (db: *) => Promise<*>) => Promise<*> }} pool
 * @param {string} queryLower
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
export async function searchProblemsLike(pool, queryLower, limit) {
  const keywordLike = `%${queryLower}%`;
  const sql = `
    SELECT id, brief_name, key_points_json, category_id
    FROM problems
    WHERE lower(brief_name) LIKE ? OR lower(IFNULL(key_points_json, '')) LIKE ?
    LIMIT ?
  `;
  const params = [keywordLike, keywordLike, limit];
  return pool.withConnection(async (db) => {
    tapSql(sql, params);
    return db.all(sql, params);
  });
}
