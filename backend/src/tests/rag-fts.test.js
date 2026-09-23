import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { initCategorySchema, upsertCategory } from '../db/category-repo.js';
import { initProblemSchema, upsertProblem } from '../db/problem-repo.js';
import {
  PROBLEMS_FTS_TABLE,
  rebuildProblemsFts,
  setRagSqlTap,
  toFtsMatchQuery,
} from '../rag-fts.js';
import { scoreRagSnippet, RAG_SCORE_TITLE } from '../rag-rank.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = path.dirname(SRC_DIR);
const TEST_DB_PATH = path.join(os.tmpdir(), `rag-fts-${process.pid}.sqlite3`);
const TEST_ENV_KEYS = [
  'BAGUJING_SKIP_LISTEN',
  'ENABLE_SQLITE',
  'SQLITE_DB',
  'JWT_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'AI_REQUIRE_SIGNED_HEADERS',
];

const savedEnv = Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));

// 清理临时 SQLite 文件。
function removeDbFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
}

// 写入 C22 FTS fixture（标题命中 / 要点命中 / 置顶题）。
async function seedFtsFixture() {
  removeDbFiles();
  const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
  await initCategorySchema(pool);
  await initProblemSchema(pool);

  await upsertCategory(pool, {
    id: 7,
    name: '缓存分类',
    groupName: '后端',
    groupDesc: '分类描述',
    count: 10,
  });

  await upsertProblem(pool, {
    id: 1,
    groupId: 7,
    type: 1,
    brief_name: '缓存穿透怎么处理',
    keyPoints: ['布隆过滤器'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 2,
    groupId: 7,
    type: 1,
    brief_name: '高并发限流',
    keyPoints: ['本地缓存', '远程缓存'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 42,
    groupId: 7,
    type: 1,
    brief_name: '线程与协程对比',
    keyPoints: ['调度'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 43,
    groupId: 7,
    type: 1,
    brief_name: '分布式锁实现',
    keyPoints: ['Redlock'],
    companies: [],
  });

  await rebuildProblemsFts(pool);
  await pool.closeAll();
}

let buildRagContext;
let sqlLog;

describe('C22 / P1-2: FTS5 虚表查询与失败回退 LIKE', () => {
  before(async () => {
    for (const key of TEST_ENV_KEYS) delete process.env[key];
    process.env.BAGUJING_SKIP_LISTEN = '1';
    process.env.ENABLE_SQLITE = 'true';
    process.env.SQLITE_DB = TEST_DB_PATH;
    process.env.JWT_SECRET = 'rag-fts-unit-secret';
    process.env.OPENAI_API_KEY = 'sk-rag-fts-test';
    process.env.OPENAI_BASE_URL = 'http://rag-fts.invalid/v1';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';

    await seedFtsFixture();
    ({ buildRagContext } = await import('../server-express.js'));
  });

  beforeEach(() => {
    sqlLog = [];
    setRagSqlTap((sql, params) => {
      sqlLog.push({ sql: String(sql), params });
    });
  });

  after(() => {
    setRagSqlTap(null);
    for (const key of TEST_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    removeDbFiles();
  });

  it('UT-RAG-FTS-01: 启动创建 FTS5 虚表', async () => {
    const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await rebuildProblemsFts(pool);
    await rebuildProblemsFts(pool); // 幂等二次

    const row = await pool.withConnection((db) =>
      db.get(
        `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?`,
        [PROBLEMS_FTS_TABLE],
      ),
    );
    assert.ok(row);
    assert.equal(row.name, PROBLEMS_FTS_TABLE);
    assert.match(String(row.sql || ''), /CREATE\s+VIRTUAL\s+TABLE/i);
    assert.match(String(row.sql || ''), /fts5/i);
    await pool.closeAll();
  });

  it('UT-RAG-FTS-02: 启动从 problems 全量重建', async () => {
    const rebuildDb = path.join(os.tmpdir(), `rag-fts-rebuild-${process.pid}.sqlite3`);
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${rebuildDb}${suffix}`); } catch { /* ignore */ }
    }
    const rebuildPool = createSqlitePool({ filename: rebuildDb, max: 1 });
    await initProblemSchema(rebuildPool);
    await upsertProblem(rebuildPool, {
      id: 1,
      groupId: 1,
      type: 1,
      brief_name: '缓存穿透专题',
      keyPoints: ['哈希'],
      companies: [],
    });
    await upsertProblem(rebuildPool, {
      id: 2,
      groupId: 1,
      type: 1,
      brief_name: '无关标题',
      keyPoints: ['限流策略'],
      companies: [],
    });
    await rebuildProblemsFts(rebuildPool);

    const hitTitle = await rebuildPool.withConnection((db) =>
      db.all(
        `SELECT rowid FROM ${PROBLEMS_FTS_TABLE} WHERE ${PROBLEMS_FTS_TABLE} MATCH ?`,
        [toFtsMatchQuery('缓存穿透')],
      ),
    );
    const hitKp = await rebuildPool.withConnection((db) =>
      db.all(
        `SELECT rowid FROM ${PROBLEMS_FTS_TABLE} WHERE ${PROBLEMS_FTS_TABLE} MATCH ?`,
        [toFtsMatchQuery('限流')],
      ),
    );
    assert.ok(hitTitle.some((r) => Number(r.rowid) === 1));
    assert.ok(hitKp.some((r) => Number(r.rowid) === 2));

    await rebuildPool.withConnection((db) => db.run(`DELETE FROM problems WHERE id = ?`, [2]));
    await rebuildProblemsFts(rebuildPool);
    const afterDelete = await rebuildPool.withConnection((db) =>
      db.all(
        `SELECT rowid FROM ${PROBLEMS_FTS_TABLE} WHERE ${PROBLEMS_FTS_TABLE} MATCH ?`,
        [toFtsMatchQuery('限流')],
      ),
    );
    assert.equal(afterDelete.some((r) => Number(r.rowid) === 2), false);
    await rebuildPool.closeAll();
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${rebuildDb}${suffix}`); } catch { /* ignore */ }
    }
  });

  it('UT-RAG-FTS-03: 正常查询优先走 FTS MATCH', async () => {
    sqlLog.length = 0;
    const snippets = await buildRagContext({ message: '缓存' });
    assert.ok(snippets.length <= 6);
    assert.ok(snippets.some((s) => s.type === 'problem' && Number(s.id) === 1));

    const ftsIdx = sqlLog.findIndex((e) =>
      /problems_fts/i.test(e.sql) && /\bMATCH\b/i.test(e.sql),
    );
    assert.ok(ftsIdx >= 0, '应执行 FTS MATCH');
    const likeIdx = sqlLog.findIndex((e) =>
      /FROM\s+problems\b/i.test(e.sql)
      && /lower\(brief_name\)\s+LIKE/i.test(e.sql),
    );
    if (likeIdx >= 0) {
      assert.ok(ftsIdx < likeIdx, 'FTS 应先于 LIKE 回退');
    }

    const problems = snippets.filter((s) => s.type === 'problem');
    const indexTitle = problems.findIndex((s) => Number(s.id) === 1);
    const indexKp = problems.findIndex((s) => Number(s.id) === 2);
    assert.ok(indexTitle >= 0 && indexKp >= 0);
    assert.ok(indexTitle < indexKp);
    assert.ok(scoreRagSnippet(problems[indexTitle], '缓存') >= RAG_SCORE_TITLE);
  });

  it('UT-RAG-FTS-04: FTS 失败回退 LIKE', async () => {
    const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await pool.withConnection((db) => db.exec(`DROP TABLE IF EXISTS ${PROBLEMS_FTS_TABLE}`));
    await pool.closeAll();

    sqlLog.length = 0;
    let snippets;
    await assert.doesNotReject(async () => {
      snippets = await buildRagContext({ message: '缓存' });
    });
    assert.ok(Array.isArray(snippets));
    assert.ok(snippets.some((s) => s.type === 'problem' && Number(s.id) === 1));

    const likeIdx = sqlLog.findIndex((e) =>
      /FROM\s+problems\b/i.test(e.sql)
      && /lower\(brief_name\)\s+LIKE/i.test(e.sql),
    );
    assert.ok(likeIdx >= 0, 'FTS 失败后应执行 LIKE');

    const problems = snippets.filter((s) => s.type === 'problem');
    const scores = problems.map((s) => scoreRagSnippet(s, '缓存'));
    for (let i = 1; i < scores.length; i += 1) {
      assert.ok(scores[i - 1] >= scores[i]);
    }

    // 恢复虚表，避免后续用例受影响
    const restore = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    await rebuildProblemsFts(restore);
    await restore.closeAll();
  });

  it('UT-RAG-FTS-05: 不删除 problems 旧列', async () => {
    const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
    const cols = await pool.withConnection((db) => db.all(`PRAGMA table_info(problems)`));
    const names = new Set(cols.map((c) => c.name));
    for (const required of ['id', 'brief_name', 'key_points_json', 'category_id']) {
      assert.ok(names.has(required), `应保留列 ${required}`);
    }
    const byId = await pool.withConnection((db) =>
      db.get(`SELECT brief_name, key_points_json, category_id FROM problems WHERE id = ?`, [42]),
    );
    assert.ok(byId);
    assert.equal(byId.brief_name, '线程与协程对比');
    await pool.closeAll();
  });

  it('UT-RAG-FTS-06: 短 query 不触发 FTS 也不触发 LIKE 关键字召回', async () => {
    for (const message of ['', 'a']) {
      sqlLog.length = 0;
      const snippets = await buildRagContext({ message });
      assert.equal(
        sqlLog.some((e) => /\bMATCH\b/i.test(e.sql) && /problems_fts/i.test(e.sql)),
        false,
      );
      assert.equal(
        sqlLog.some((e) => /lower\(brief_name\)\s+LIKE/i.test(e.sql)),
        false,
      );
      assert.equal(
        sqlLog.some((e) => /FROM\s+categories\b/i.test(e.sql) && /LIKE/i.test(e.sql)),
        false,
      );
      assert.equal(
        snippets.some((s) => s.type === 'problem' && String(s.brief_name || '').includes('缓存')),
        false,
      );
    }
  });

  it('UT-RAG-FTS-07: 不做向量检索（C22 边界）', async () => {
    const sources = [
      fs.readFileSync(path.join(BACKEND_SRC, 'rag-fts.js'), 'utf8'),
      fs.readFileSync(path.join(BACKEND_SRC, 'server-express.js'), 'utf8'),
      fs.readFileSync(path.join(BACKEND_SRC, 'rag-rank.js'), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(sources, /embedding|openai\.embeddings|vector\s*search|vectordb/i);

    sqlLog.length = 0;
    await buildRagContext({ message: '缓存' });
    assert.equal(sqlLog.some((e) => /embedding|vector/i.test(e.sql)), false);
  });

  it('UT-RAG-FTS-08: 保留 LIKE 回退分支（不做删除回退）', () => {
    const ftsSrc = fs.readFileSync(path.join(BACKEND_SRC, 'rag-fts.js'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(BACKEND_SRC, 'server-express.js'), 'utf8');
    assert.match(ftsSrc, /searchProblemsLike/);
    assert.match(serverSrc, /searchProblemsFts/);
    assert.match(serverSrc, /searchProblemsLike/);
    assert.match(serverSrc, /catch\s*\{[\s\S]*searchProblemsLike/);
    assert.doesNotMatch(serverSrc, /disableLikeFallback/);
    assert.doesNotMatch(ftsSrc, /ONLY_FTS|disableLikeFallback\s*=\s*true/);
  });

  it('UT-RAG-FTS-09: 指定 problemId 仍主键取条，FTS 仅补其它候选', async () => {
    const snippets = await buildRagContext({
      message: '分布式',
      problemId: 42,
    });
    assert.equal(snippets[0]?.type, 'problem');
    assert.equal(Number(snippets[0]?.id), 42);
    const problemIds = snippets.filter((s) => s.type === 'problem').map((s) => Number(s.id));
    assert.equal(problemIds.filter((id) => id === 42).length, 1);
    assert.ok(problemIds.includes(43) || snippets.some((s) => String(s.brief_name || '').includes('分布式')));
  });
});
