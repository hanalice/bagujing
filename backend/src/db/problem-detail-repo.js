const PROBLEM_DETAIL_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS problem_details (
    id INTEGER PRIMARY KEY,
    category_id INTEGER,
    type INTEGER,
    level INTEGER,
    frequency REAL,
    name_html TEXT,
    options_json TEXT,
    answer_html TEXT,
    analysis_html TEXT,
    more_ask_html TEXT,
    mindmap_text TEXT,
    keynote_html TEXT,
    kps_json TEXT,
    years_json TEXT,
    corps_json TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function toIntOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function stringifyOrNull(value) {
  if (value == null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
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

export async function initProblemDetailSchema(pool) {
  await pool.withConnection((db) => db.exec(PROBLEM_DETAIL_TABLE_SQL));
}

export async function createProblemDetailUpserter(db) {
  const stmt = await db.prepare(`
    INSERT INTO problem_details (
      id, category_id,
      name_html, options_json, answer_html, analysis_html,
      more_ask_html, mindmap_text, keynote_html,
      kps_json, years_json, corps_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      category_id = excluded.category_id,
      name_html = excluded.name_html,
      options_json = excluded.options_json,
      answer_html = excluded.answer_html,
      analysis_html = excluded.analysis_html,
      more_ask_html = excluded.more_ask_html,
      mindmap_text = excluded.mindmap_text,
      keynote_html = excluded.keynote_html,
      kps_json = excluded.kps_json,
      years_json = excluded.years_json,
      corps_json = excluded.corps_json,
      updated_at = datetime('now')
  `);

  return {
    async upsert(problem) {
      const params = [
        toIntOrNull(problem?.id),
        toIntOrNull(problem?.group_id),
        typeof problem?.name === 'string' ? problem.name : null,
        stringifyOrNull(problem?.options),
        typeof problem?.answer === 'string' ? problem.answer : null,
        typeof problem?.analysis === 'string' ? problem.analysis : null,
        typeof problem?.more_ask === 'string' ? problem.more_ask : null,
        typeof problem?.mindmap === 'string' ? problem.mindmap : null,
        typeof problem?.keynote === 'string' ? problem.keynote : null,
        stringifyOrNull(problem?.kps),
        stringifyOrNull(problem?.years),
        stringifyOrNull(problem?.corps),
      ];

      return stmt.run(params);
    },
    finalize() {
      return stmt.finalize();
    },
  };
}

export async function upsertProblemDetail(pool, problem) {
  return pool.withConnection(async (db) => {
    const upserter = await createProblemDetailUpserter(db);
    try {
      return await upserter.upsert(problem);
    } finally {
      await upserter.finalize();
    }
  });
}

function rowToProblem(row) {
  if (!row) return undefined;

  return {
    id: row.id,
    categoryId: row.category_id,
    name: row.name_html,
    answer: row.answer_html,
    analysis: row.analysis_html,
    moreAsk: row.more_ask_html,
    mindmap: row.mindmap_text,
    keynote: row.keynote_html,
    options: row?.options_json ? parseJsonArray(row.options_json) : undefined,
    keyPoints: row?.kps_json ? parseJsonArray(row.kps_json) : undefined,
    companies: row?.corps_json ? parseJsonArray(row.corps_json) : undefined,
    years: row?.years_json ? parseJsonArray(row.years_json) : undefined,
  };
}

export async function getProblemDetailById(pool, id) {
  return pool.withConnection(async (db) => {
    const row = await db.get(`SELECT * FROM problem_details WHERE id = ?`, [toIntOrNull(id)]);
    if (!row) return undefined;

    return rowToProblem(row);
  });
}

export async function upsertProblemAnswerById(pool, {
  id,
  categoryId,
  name,
  answer,
  keyPoints,
  companies,
  years,
} = {}) {
  const problemId = toIntOrNull(id);
  if (problemId == null) throw new Error('Invalid problem id');

  const answerHtml = typeof answer === 'string' ? answer.trim() : '';
  if (!answerHtml) throw new Error('Answer is empty');

  return pool.withConnection(async (db) => db.run(
    `
      INSERT INTO problem_details (id, category_id, name_html, answer_html, kps_json, years_json, corps_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        answer_html = excluded.answer_html,
        kps_json = excluded.kps_json,
        years_json = COALESCE(excluded.years_json, problem_details.years_json),
        corps_json = excluded.corps_json,
        updated_at = datetime('now')
    `,
    [
      problemId,
      toIntOrNull(categoryId),
      typeof name === 'string' ? name : null,
      answerHtml,
      stringifyOrNull(keyPoints),
      stringifyOrNull(years),
      stringifyOrNull(companies),
    ],
  ));
}
