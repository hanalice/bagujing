const PROBLEM_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS problems (
    id INTEGER PRIMARY KEY,
    category_id INTEGER,
    type INTEGER,
    brief_name TEXT,
    count INTEGER,
    level INTEGER,
    freq REAL,
    key_points_json TEXT,
    companies_json TEXT,
    time TEXT,
    raw_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_problems_category_id_id ON problems(category_id, id);
  CREATE INDEX IF NOT EXISTS idx_problems_brief_name ON problems(brief_name);
`;

function toIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toFloatOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringifyArrayOrNull(value) {
  if (!Array.isArray(value)) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function parseJsonArray(value) {
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToProblem(row) {
  if (!row) return undefined;

  return {
    id: row.id,
    categoryId: row.category_id,
    type: row.type,
    briefName: row.brief_name,
    count: row.count,
    level: row.level,
    freq: row.freq,
    keyPoints: parseJsonArray(row.key_points_json),
    companies: parseJsonArray(row.companies_json),
  };
}

export async function initProblemSchema(pool) {
  await pool.withConnection((db) => db.exec(PROBLEM_TABLE_SQL));
}

export async function createProblemUpserter(db) {
  const stmt = await db.prepare(`
    INSERT INTO problems (
      id, category_id, type, brief_name, count, level, freq,
      key_points_json, companies_json,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category_id = excluded.category_id,
      type = excluded.type,
      brief_name = excluded.brief_name,
      count = excluded.count,
      level = excluded.level,
      freq = excluded.freq,
      key_points_json = excluded.key_points_json,
      companies_json = excluded.companies_json,
      raw_json = excluded.raw_json,
      updated_at = datetime('now')
  `);

  return {
    async upsert(problem) {
      if (problem.brief_name) {
        const params = [
          toIntOrNull(problem?.id),
          toIntOrNull(problem?.groupId),
          toIntOrNull(problem?.type),
          typeof problem?.brief_name === 'string' ? problem.brief_name : null,
          toIntOrNull(problem?.count),
          toIntOrNull(problem?.level),
          toFloatOrNull(problem?.freq),
          stringifyArrayOrNull(firstArray(problem?.keyPoints, problem?.kps)),
          stringifyArrayOrNull(firstArray(problem?.companies, problem?.corps)),
          JSON.stringify(problem ?? null),
        ];
        return stmt.run(params);
      }
    },
    finalize() {
      return stmt.finalize();
    },
  };
}

export async function upsertProblem(pool, problem) {
  return pool.withConnection(async (db) => {
    const upserter = await createProblemUpserter(db);
    try {
      return await upserter.upsert(problem);
    } finally {
      await upserter.finalize();
    }
  });
}

export async function getProblemRawById(pool, id) {
  return pool.withConnection((db) =>
    db.get(`SELECT raw_json FROM problems WHERE id = ?`, [toIntOrNull(id)])
  );
}

export async function getProblemById(pool, id) {
  return pool.withConnection(async (db) => {
    const row = await db.get(
      `SELECT id, category_id, type, brief_name, count, level, freq, key_points_json, companies_json, raw_json FROM problems WHERE id = ?`,
      [toIntOrNull(id)]
    );

    if (!row) return undefined;

    return rowToProblem(row);
  });
}

export async function listProblems(pool, {
  categoryId,
  keyword,
  company,
  level,
  freqRange,
  keyPoint,
  limit = 10,
  cursor,
} = {}) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 10));
  const categoryIdInt = categoryId == null || categoryId === '' ? null : toIntOrNull(categoryId);
  const keywordText = typeof keyword === 'string' && keyword.trim() ? keyword.trim().toLowerCase() : null;
  const companyText = typeof company === 'string' && company.trim() ? company.trim().toLowerCase() : null;
  const levelInt = level == null || level === '' ? null : toIntOrNull(level);
  const keyPointText = typeof keyPoint === 'string' && keyPoint.trim() ? keyPoint.trim() : null;
  const cursorInt = cursor == null || cursor === '' ? null : toIntOrNull(cursor);

  let freqMin = null;
  let freqMax = null;
  if (freqRange === 'low') {
    freqMax = 0.01;
  } else if (freqRange === 'medium') {
    freqMin = 0.01;
    freqMax = 0.05;
  } else if (freqRange === 'high') {
    freqMin = 0.05;
  }

  return pool.withConnection(async (db) => {
    const params = [
      categoryIdInt,
      categoryIdInt,
      keywordText ? `%${keywordText}%` : null,
      keywordText ? `%${keywordText}%` : null,
      companyText ? `%"${companyText}%` : null,
      companyText ? `%"${companyText}%` : null,
      levelInt,
      levelInt,
      freqMin, freqMin,
      freqMax, freqMax,
      keyPointText ? `%"${keyPointText}%` : null,
      keyPointText ? `%"${keyPointText}%` : null,
      cursorInt,
      cursorInt,
      safeLimit,
    ];

    let sql = `
      SELECT id, category_id, type, brief_name, count, level, freq, key_points_json, companies_json
      FROM problems
      WHERE (? IS NULL OR category_id = ?)
        AND (? IS NULL OR lower(brief_name) LIKE ?)
        AND (? IS NULL OR lower(companies_json) LIKE ?)
        AND (? IS NULL OR level = ?)
        AND (? IS NULL OR freq >= ?)
        AND (? IS NULL OR freq < ?)
        AND (? IS NULL OR key_points_json LIKE ?)
        AND (? IS NULL OR id < ?)
      ORDER BY id DESC
      LIMIT ?
    `;

    const rows = await db.all(sql, params);
    const list = rows.map(rowToProblem);

    const nextCursor = list.length ? list[list.length - 1]?.id : null;
    return { list, nextCursor };
  });
}

export async function countProblems(pool, { categoryId, keyword, company, level, freqRange, keyPoint } = {}) {
  const categoryIdInt = categoryId == null || categoryId === '' ? null : toIntOrNull(categoryId);
  const keywordText = typeof keyword === 'string' && keyword.trim() ? keyword.trim().toLowerCase() : null;
  const companyText = typeof company === 'string' && company.trim() ? company.trim().toLowerCase() : null;
  const levelInt = level == null || level === '' ? null : toIntOrNull(level);
  const keyPointText = typeof keyPoint === 'string' && keyPoint.trim() ? keyPoint.trim() : null;

  let freqMin = null;
  let freqMax = null;
  if (freqRange === 'low') {
    freqMax = 0.01;
  } else if (freqRange === 'medium') {
    freqMin = 0.01;
    freqMax = 0.05;
  } else if (freqRange === 'high') {
    freqMin = 0.05;
  }

  return pool.withConnection(async (db) => {
    const params = [
      categoryIdInt,
      categoryIdInt,
      keywordText ? `%${keywordText}%` : null,
      keywordText ? `%${keywordText}%` : null,
      companyText ? `%"${companyText}%` : null,
      companyText ? `%"${companyText}%` : null,
      levelInt,
      levelInt,
      freqMin, freqMin,
      freqMax, freqMax,
      keyPointText ? `%"${keyPointText}%` : null,
      keyPointText ? `%"${keyPointText}%` : null,
    ];
    const row = await db.get(
      `
        SELECT COUNT(1) AS cnt
        FROM problems
        WHERE (? IS NULL OR category_id = ?)
          AND (? IS NULL OR lower(brief_name) LIKE ?)
          AND (? IS NULL OR lower(companies_json) LIKE ?)
          AND (? IS NULL OR level = ?)
          AND (? IS NULL OR freq >= ?)
          AND (? IS NULL OR freq < ?)
          AND (? IS NULL OR key_points_json LIKE ?)
      `,
      params,
    );
    return Number(row?.cnt) || 0;
  });
}

export async function listProblemCompanies(pool, { categoryId } = {}) {
  const categoryIdInt = categoryId == null || categoryId === '' ? null : toIntOrNull(categoryId);

  return pool.withConnection(async (db) => {
    const rows = await db.all(
      `
        SELECT companies_json
        FROM problems
        WHERE (? IS NULL OR category_id = ?)
      `,
      [categoryIdInt, categoryIdInt],
    );

    const companies = new Set();
    for (const row of rows) {
      const list = parseJsonArray(row?.companies_json);
      for (const item of list) {
        if (typeof item === 'string' && item.trim()) {
          companies.add(item.trim());
        }
      }
    }

    return Array.from(companies).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  });
}
export async function listProblemKeyPoints(pool, { categoryId } = {}) {
  const categoryIdInt = categoryId == null || categoryId === '' ? null : toIntOrNull(categoryId);

  return pool.withConnection(async (db) => {
    const rows = await db.all(
      `
        SELECT key_points_json
        FROM problems
        WHERE (? IS NULL OR category_id = ?)
      `,
      [categoryIdInt, categoryIdInt],
    );

    const keyPoints = new Set();
    for (const row of rows) {
      const list = parseJsonArray(row?.key_points_json);
      for (const item of list) {
        if (typeof item === 'string' && item.trim()) {
          keyPoints.add(item.trim());
        }
      }
    }

    return Array.from(keyPoints).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  });
}
