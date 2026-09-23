import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { initCategorySchema, upsertCategory } from '../db/category-repo.js';
import { initProblemSchema, upsertProblem } from '../db/problem-repo.js';
import {
  RAG_SCORE_TITLE,
  RAG_SCORE_KEYPOINTS,
  RAG_SCORE_CATEGORY_BOOST,
  scoreRagSnippet,
  scoreRagSnippets,
} from '../rag-rank.js';

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = path.dirname(SRC_DIR);
const TEST_DB_PATH = path.join(os.tmpdir(), `rag-rank-${process.pid}.sqlite3`);
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

// 写入可控 brief_name / key_points / category_id 的隔离 fixture。
async function seedRankFixture() {
  removeDbFiles();
  const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
  await initCategorySchema(pool);
  await initProblemSchema(pool);

  await upsertCategory(pool, { id: 7, name: '缓存分类', groupName: '后端', groupDesc: '分类描述', count: 10 });
  await upsertCategory(pool, { id: 8, name: '其它分类', groupName: '后端', groupDesc: '其它', count: 5 });
  await upsertCategory(pool, { id: 10, name: '一致性分类', groupName: '后端', groupDesc: '一致性主题', count: 8 });

  // UT-01：A 标题命中，B 仅要点命中
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

  // UT-02：C 仅同分类 boost，D 要点命中但异分类
  await upsertProblem(pool, {
    id: 3,
    groupId: 10,
    type: 1,
    brief_name: '完全无关标题甲',
    keyPoints: ['无关要点'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 4,
    groupId: 8,
    type: 1,
    brief_name: '完全无关标题乙',
    keyPoints: ['数据一致性'],
    companies: [],
  });

  // UT-03：E/F 标题均含 Redis，E 同分类
  await upsertProblem(pool, {
    id: 5,
    groupId: 7,
    type: 1,
    brief_name: 'Redis 持久化',
    keyPoints: ['RDB'],
    companies: [],
  });
  await upsertProblem(pool, {
    id: 6,
    groupId: 8,
    type: 1,
    brief_name: 'Redis 集群',
    keyPoints: ['槽位'],
    companies: [],
  });

  // UT-04：指定置顶题 42（标题可不含 query）
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
  await upsertProblem(pool, {
    id: 44,
    groupId: 8,
    type: 1,
    brief_name: '分布式事务',
    keyPoints: ['两阶段'],
    companies: [],
  });

  // UT-05：>6 条均可被 brief_name LIKE 命中；倒序插入 id，避免盲截断碰巧等于分数序
  for (let i = 20; i >= 10; i -= 1) {
    await upsertProblem(pool, {
      id: i,
      groupId: 7,
      type: 1,
      brief_name: i >= 17 ? `排序关键字标题强${i}` : `排序关键字弱标题${i}`,
      keyPoints: i >= 17 ? [`排序关键字额外要点${i}`] : [`其它${i}`],
      companies: [],
    });
  }

  await pool.closeAll();
}

let buildRagContext;
let invokeCount;

describe('C21 / P1-2: LIKE 召回后规则打分与指定 id 置顶', () => {
  before(async () => {
    for (const key of TEST_ENV_KEYS) delete process.env[key];
    process.env.BAGUJING_SKIP_LISTEN = '1';
    process.env.ENABLE_SQLITE = 'true';
    process.env.SQLITE_DB = TEST_DB_PATH;
    process.env.JWT_SECRET = 'rag-rank-unit-secret';
    process.env.OPENAI_API_KEY = 'sk-rag-rank-test';
    process.env.OPENAI_BASE_URL = 'http://rag-rank.invalid/v1';
    process.env.OPENAI_MODEL = 'gpt-4o-mini';
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';

    await seedRankFixture();
    ({ buildRagContext } = await import('../server-express.js'));

    invokeCount = { getLlmModel: 0, invoke: 0, stream: 0 };
  });

  after(() => {
    for (const key of TEST_ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    removeDbFiles();
  });

  it('UT-RAG-RANK-01: 标题命中分高于仅要点命中', () => {
    const query = '缓存';
    const a = {
      type: 'problem',
      id: 1,
      brief_name: '缓存穿透怎么处理',
      keyPoints: ['布隆过滤器'],
      category: 7,
    };
    const b = {
      type: 'problem',
      id: 2,
      brief_name: '高并发限流',
      keyPoints: ['本地缓存', '远程缓存'],
      category: 7,
    };
    const ranked = scoreRagSnippets([b, a], { query });
    const indexA = ranked.findIndex((s) => s.id === 1);
    const indexB = ranked.findIndex((s) => s.id === 2);
    assert.ok(indexA >= 0 && indexB >= 0);
    assert.ok(indexA < indexB);
    assert.ok(ranked[indexA].score > ranked[indexB].score);
    assert.equal(scoreRagSnippet(a, query), RAG_SCORE_TITLE);
    assert.equal(scoreRagSnippet(b, query), RAG_SCORE_KEYPOINTS);
    assert.ok(RAG_SCORE_TITLE > RAG_SCORE_KEYPOINTS);
  });

  it('UT-RAG-RANK-02: 要点命中分高于仅同分类 boost', () => {
    const query = '一致性';
    const c = {
      type: 'problem',
      id: 3,
      brief_name: '完全无关标题甲',
      keyPoints: ['无关要点'],
      category: 10,
    };
    const d = {
      type: 'problem',
      id: 4,
      brief_name: '完全无关标题乙',
      keyPoints: ['数据一致性'],
      category: 8,
    };
    const ranked1 = scoreRagSnippets([c, d], { query, categoryId: 10 });
    const ranked2 = scoreRagSnippets([c, d], { query, categoryId: 10 });
    assert.ok(ranked1.findIndex((s) => s.id === 4) < ranked1.findIndex((s) => s.id === 3));
    assert.deepEqual(ranked1.map((s) => s.id), ranked2.map((s) => s.id));
    assert.ok(scoreRagSnippet(d, query, 10) > scoreRagSnippet(c, query, 10));
    assert.equal(scoreRagSnippet(c, query, 10), RAG_SCORE_CATEGORY_BOOST);
    assert.equal(scoreRagSnippet(d, query, 10), RAG_SCORE_KEYPOINTS);
  });

  it('UT-RAG-RANK-03: 同分类 boost 在同等命中下抬升', () => {
    const query = 'Redis';
    const e = {
      type: 'problem',
      id: 5,
      brief_name: 'Redis 持久化',
      keyPoints: ['RDB'],
      category: 7,
    };
    const f = {
      type: 'problem',
      id: 6,
      brief_name: 'Redis 集群',
      keyPoints: ['槽位'],
      category: 8,
    };
    const ranked = scoreRagSnippets([f, e], { query, categoryId: 7 });
    assert.ok(ranked.findIndex((s) => s.id === 5) < ranked.findIndex((s) => s.id === 6));
    assert.equal(scoreRagSnippet(e, query, 7), RAG_SCORE_TITLE + RAG_SCORE_CATEGORY_BOOST);
    assert.equal(scoreRagSnippet(f, query, 7), RAG_SCORE_TITLE);

    // boost 不得把无标题命中的同分类题抬过标题命中的异分类题
    const sameCatNoTitle = {
      type: 'problem',
      id: 99,
      brief_name: '无关',
      keyPoints: ['x'],
      category: 7,
    };
    const otherCatTitle = {
      type: 'problem',
      id: 98,
      brief_name: 'Redis 异分类',
      keyPoints: ['y'],
      category: 8,
    };
    const mixed = scoreRagSnippets([sameCatNoTitle, otherCatTitle], { query, categoryId: 7 });
    assert.ok(mixed.findIndex((s) => s.id === 98) < mixed.findIndex((s) => s.id === 99));
  });

  it('UT-RAG-RANK-04: 指定 problemId 置顶', async () => {
    const snippets = await buildRagContext({
      message: '分布式',
      categoryId: 7,
      problemId: 42,
    });
    assert.equal(snippets[0]?.type, 'problem');
    assert.equal(Number(snippets[0]?.id), 42);
    const problemIds = snippets.filter((s) => s.type === 'problem').map((s) => Number(s.id));
    assert.equal(problemIds.filter((id) => id === 42).length, 1);
    const others = snippets.slice(1).filter((s) => s.type === 'problem');
    for (let i = 1; i < others.length; i += 1) {
      const prev = scoreRagSnippet(others[i - 1], '分布式', 7);
      const curr = scoreRagSnippet(others[i], '分布式', 7);
      assert.ok(prev >= curr);
    }
  });

  it('UT-RAG-RANK-05: 无 id 时召回后再打分截断', async () => {
    // C22 合入后主路径可为 FTS；本 ID 只锁 topK 与规则分降序（召回介质见 UT-RAG-FTS-*）。
    const snippets = await buildRagContext({ message: '排序关键字' });
    assert.ok(snippets.length <= 6);
    assert.ok(snippets.length > 0);

    const problems = snippets.filter((s) => s.type === 'problem');
    assert.ok(problems.length > 0);
    // 队首应为标题+要点双命中（强），队尾不应高于队首
    const scores = problems.map((s) => scoreRagSnippet(s, '排序关键字'));
    for (let i = 1; i < scores.length; i += 1) {
      assert.ok(scores[i - 1] >= scores[i]);
    }
    assert.ok(scores[0] >= RAG_SCORE_TITLE);
    // 不应等于「按插入倒序 id 盲截断」的前 6 个：20..15
    const ids = problems.map((s) => Number(s.id));
    assert.notDeepEqual(ids, [20, 19, 18, 17, 16, 15]);
  });

  it('UT-RAG-RANK-06: query 过短或空不打分召回', async () => {
    for (const message of ['', 'a', ' ']) {
      const snippets = await buildRagContext({ message });
      const likeOnly = snippets.filter((s) => (
        (s.type === 'problem' && String(s.brief_name || '').includes('排序关键字'))
        || (s.type === 'problem' && Number(s.id) >= 10 && Number(s.id) <= 20)
      ));
      assert.equal(likeOnly.length, 0);
    }

    const withPin = await buildRagContext({ message: 'a', problemId: 42 });
    assert.equal(Number(withPin[0]?.id), 42);
    assert.equal(withPin.some((s) => Number(s.id) === 43), false);
  });

  it('UT-RAG-RANK-07: 打分路径禁止调用主聊天模型', () => {
    const before = { ...invokeCount };
    const ranked = scoreRagSnippets([
      { type: 'problem', id: 1, brief_name: '缓存', keyPoints: [], category: 1 },
      { type: 'problem', id: 2, brief_name: '其它', keyPoints: ['缓存'], category: 1 },
    ], { query: '缓存' });
    assert.ok(ranked[0].id === 1);
    assert.equal(invokeCount.getLlmModel, before.getLlmModel);
    assert.equal(invokeCount.invoke, before.invoke);
    assert.equal(invokeCount.stream, before.stream);
    // 纯函数同步完成，不依赖 OPENAI_BASE_URL
    assert.equal(typeof ranked[0].score, 'number');
  });

  it('UT-RAG-RANK-08: 不做向量（C21 边界；FTS 属 C22）', () => {
    // C22 合入后允许 fts5/MATCH；本 ID 只锁无向量。FTS 主路径见 UT-RAG-FTS-03/07。
    const sources = [
      fs.readFileSync(path.join(BACKEND_SRC, 'rag-rank.js'), 'utf8'),
      fs.readFileSync(path.join(BACKEND_SRC, 'server-express.js'), 'utf8'),
    ].join('\n');
    assert.doesNotMatch(sources, /embedding|vector|openai\.embeddings/i);
  });
});
