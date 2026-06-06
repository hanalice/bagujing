const CATEGORY_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT,
    group_name TEXT,
    group_desc TEXT,
    type INTEGER,
    count INTEGER,
    ac INTEGER,
    nc INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_categories_group_name ON categories(group_name);
  CREATE INDEX IF NOT EXISTS idx_categories_name ON categories(name);
`;

function rowToCategory(row) {
  if (!row) return undefined;

  return {
    id: row.id,
    name: row.name,
    groupName: row.group_name,
    count: row.count,
  };
}

function toIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export async function initCategorySchema(pool) {
  await pool.withConnection((db) => db.exec(CATEGORY_TABLE_SQL));
}

export async function createCategoryUpserter(db) {
  const stmt = await db.prepare(`
      INSERT INTO categories (
        id, name, group_name, group_desc, type, count, ac, nc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        group_name = excluded.group_name,
        group_desc = excluded.group_desc,
        type = excluded.type,
        count = excluded.count,
        ac = excluded.ac,
        nc = excluded.nc,
        updated_at = datetime('now')
    `);
  return {
    upsert: async (c) => {
      await stmt.run([
        c.id,
        c.name ?? null,
        c.groupName ?? null,
        c.groupDesc ?? null,
        Number.isFinite(Number(c.type)) ? Number(c.type) : null,
        Number.isFinite(Number(c.count)) ? Number(c.count) : null,
        Number.isFinite(Number(c.ac)) ? Number(c.ac) : null,
        Number.isFinite(Number(c.nc)) ? Number(c.nc) : null,
      ]);
    },
    finalize: async () => {
      await stmt.finalize();
    },
  };
}

export async function countCategories(pool, { keyword, groupNames } = {}) {
  const keywordText = typeof keyword === 'string' && keyword.trim() ? keyword.trim().toLowerCase() : null;
  const groups = Array.isArray(groupNames) ? groupNames.filter(Boolean) : [];

  return pool.withConnection(async (db) => {
    const keywordLike = keywordText ? `%${keywordText}%` : null;
    let sql = `SELECT COUNT(1) AS cnt FROM categories WHERE 1=1`;
    const params = [];

    if (groups.length > 0) {
      sql += ` AND group_name IN (${groups.map(() => '?').join(',')})`;
      params.push(...groups);
    }
    if (keywordLike) {
      sql += ` AND (lower(name) LIKE ? OR lower(group_name) LIKE ?)`;
      params.push(keywordLike, keywordLike);
    }

    const row = await db.get(sql, params);
    return Number(row?.cnt) || 0;
  });
}

export async function listCategories(pool, {
  keyword,
  groupNames,
  limit = 10,
  cursor,
} = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const keywordText = typeof keyword === 'string' && keyword.trim() ? keyword.trim().toLowerCase() : null;
  const groups = Array.isArray(groupNames) ? groupNames.filter(Boolean) : [];
  const cursorInt = cursor == null || cursor === '' ? null : toIntOrNull(cursor);

  return pool.withConnection(async (db) => {
    const keywordLike = keywordText ? `%${keywordText}%` : null;
    let sql = `SELECT id, name, group_name, count FROM categories WHERE 1=1`;
    const params = [];

    if (groups.length > 0) {
      sql += ` AND group_name IN (${groups.map(() => '?').join(',')})`;
      params.push(...groups);
    }
    if (keywordLike) {
      sql += ` AND (lower(name) LIKE ? OR lower(group_name) LIKE ?)`;
      params.push(keywordLike, keywordLike);
    }
    if (cursorInt !== null) {
      sql += ` AND id < ?`;
      params.push(cursorInt);
    }

    sql += ` ORDER BY id DESC LIMIT ?`;
    params.push(safeLimit);

    const rows = await db.all(sql, params);
    const list = rows.map(rowToCategory);
    const nextCursor = list.length ? list[list.length - 1]?.id : null;
    return { list, nextCursor };
  });
}

export async function listCategoryGroupNames(pool) {
  return pool.withConnection(async (db) => {
    const rows = await db.all(
      `
        SELECT DISTINCT group_name
        FROM categories
        WHERE group_name IS NOT NULL AND trim(group_name) <> ''
        ORDER BY group_name ASC
      `,
      [],
    );

    return rows
      .map((row) => row?.group_name)
      .filter((name) => typeof name === 'string' && name.trim().length > 0);
  });
}

export async function upsertCategory(pool, c) {
  return pool.withConnection(async (db) => {
    const upserter = await createCategoryUpserter(db);
    try {
      return await upserter.upsert(c);
    } finally {
      await upserter.finalize();
    }
  });
}

export async function getCategoryById(pool, id) {
  return pool.withConnection(async (db) => {
     const row = await db.get(`SELECT id, name, group_name, count FROM categories WHERE id = ?`, [id]);
     return row;
  });
}

export async function updateCategoryCount(pool, id, nextCount) {
  return pool.withConnection((db) =>
    db.run(
      `UPDATE categories SET count = ?, updated_at = datetime('now') WHERE id = ?`,
      [Number(nextCount), Number(id)]
    )
  );
}

export async function deleteCategoryById(pool, id) {
  return pool.withConnection((db) => db.run(`DELETE FROM categories WHERE id = ?`, [id]));
}
