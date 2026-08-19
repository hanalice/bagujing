/**
 * @file import-ndjson-to-sqlite.js
 * @description 题库数据批量迁移脚本 (NDJSON -> SQLite3)
 *
 * 【设计意图】
 * 1. 本脚本负责将离线采集的 NDJSON 格式题库数据（categories / problems / problem-detail）
 *    批量、事务性地导入并构建持久化的 SQLite 关系型数据库。
 * 2. 采用流式行读取 (createNdjsonLineReader) 与分批事务 (batch transaction) 机制，
 *    避免一次性加载数万条数据导致 Node.js 进程内存溢出 (OOM)。
 * 3. 自动初始化数据库表结构 (Schema)，支持全量导入或按需单独导入（如仅导入分类或题目详情）。
 *
 * 【使用方式】
 * - npm run import-data                 # 全量导入
 * - npm run import-data:categories      # 仅导入分类
 * - npm run import-data:problems        # 仅导入题目列表
 * - npm run import-data:details         # 仅导入题目深度解析详情
 * - node scripts/import-ndjson-to-sqlite.js --batch 1000 --limit 5000  # 自定义批次与上限
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNdjsonLineReader } from '../src/util/read-ndjson.js';
import { createSqlitePool } from '../src/db/sqlite-pool.js';
import { initCategorySchema, createCategoryUpserter } from '../src/db/category-repo.js';
import { initProblemSchema, createProblemUpserter } from '../src/db/problem-repo.js';
import { initProblemDetailSchema, createProblemDetailUpserter } from '../src/db/problem-detail-repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : 'true';
    args.set(key, value);
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

async function importCategories({ pool, filePath, limit, batchSize }) {
  await initCategorySchema(pool);

  return pool.withConnection(async (db) => {
    const upserter = await createCategoryUpserter(db);
    const reader = createNdjsonLineReader(filePath);

    const categorySet = new Set();
    let count = 0;
    let inBatch = 0;

    try {
      await db.exec('BEGIN IMMEDIATE;');

      while (true) {
        const { done, value } = await reader.next();
        if (done) break;

        const line = String(value || '').trim();
        if (!line) continue;

        const obj = JSON.parse(line);
        if (obj.id && !categorySet.has(obj.id)) {
          categorySet.add(obj.id);
          await upserter.upsert({
            id: obj.id,
            name: obj.name,
            groupName: obj.groupName,
            groupDesc: obj.groupDesc,
            type: obj.type,
            count: obj.count,
            ac: obj.ac,
            nc: obj.nc,
          });

          count += 1;
          inBatch += 1;

          if (limit && count >= limit) break;

          if (inBatch >= batchSize) {
            await db.exec('COMMIT;');
            await db.exec('BEGIN IMMEDIATE;');
            inBatch = 0;
            if (count % (batchSize * 5) === 0) console.log(`[categories] imported: ${count}`);
          }
        }
      }

      await db.exec('COMMIT;');
      return count;
    } catch (e) {
      try {
        await db.exec('ROLLBACK;');
      } catch { }
      throw e;
    } finally {
      reader.close();
      await upserter.finalize();
    }
  });
}

async function importProblems({ pool, filePath, limit, batchSize }) {
  await initProblemSchema(pool);

  return pool.withConnection(async (db) => {
    const upserter = await createProblemUpserter(db);
    const reader = createNdjsonLineReader(filePath);

    let count = 0;
    let inBatch = 0;

    try {
      await db.exec('BEGIN IMMEDIATE;');

      while (true) {
        const { done, value } = await reader.next();
        if (done) break;

        const line = String(value || '').trim();
        if (!line) continue;

        const obj = JSON.parse(line);
        await upserter.upsert(obj);

        count += 1;
        inBatch += 1;

        if (limit && count >= limit) break;

        if (inBatch >= batchSize) {
          await db.exec('COMMIT;');
          await db.exec('BEGIN IMMEDIATE;');
          inBatch = 0;
          if (count % (batchSize * 5) === 0) console.log(`[problems] imported: ${count}`);
        }
      }

      await db.exec('COMMIT;');
      return count;
    } catch (e) {
      try {
        await db.exec('ROLLBACK;');
      } catch { }
      throw e;
    } finally {
      reader.close();
      await upserter.finalize();
    }
  });
}

async function importProblemDetails({ pool, filePath, limit, batchSize }) {
  await initProblemDetailSchema(pool);

  return pool.withConnection(async (db) => {
    const upserter = await createProblemDetailUpserter(db);
    const reader = createNdjsonLineReader(filePath);

    let count = 0;
    let inBatch = 0;

    try {
      await db.exec('BEGIN IMMEDIATE;');

      while (true) {
        const { done, value } = await reader.next();
        if (done) break;

        const line = String(value || '').trim();
        if (!line) continue;

        const obj = JSON.parse(line);
        await upserter.upsert(obj);

        count += 1;
        inBatch += 1;

        if (limit && count >= limit) break;

        if (inBatch >= batchSize) {
          await db.exec('COMMIT;');
          await db.exec('BEGIN IMMEDIATE;');
          inBatch = 0;
          if (count % (batchSize * 2) === 0) console.log(`[details] imported: ${count}`);
        }
      }

      await db.exec('COMMIT;');
      return count;
    } catch (e) {
      try {
        await db.exec('ROLLBACK;');
      } catch { }
      throw e;
    } finally {
      reader.close();
      await upserter.finalize();
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const dbFile = args.get('db') || path.join(__dirname, '../db/bagujing.dev.sqlite3');
  const only = (args.get('only') || 'all').toLowerCase();
  const limit = args.get('limit') ? Number(args.get('limit')) : 0;
  const batchSize = Math.max(1, Number(args.get('batch')) || 500);

  function resolveDataPath(filename) {
    const localPath = path.join(__dirname, '../data', filename);
    const crawlerPath = path.join(__dirname, '../../crawler/data', filename);
    return fs.existsSync(localPath) ? localPath : crawlerPath;
  }

  const categoriesPath = args.get('categories') || resolveDataPath('categories.ndjson');
  const problemsPath = args.get('problems') || resolveDataPath('problems.ndjson');
  const detailsPath = args.get('details') || resolveDataPath('problem-detail.ndjson');

  ensureDir(path.dirname(dbFile));

  const pool = createSqlitePool({
    filename: dbFile,
    max: 1, // single writer
  });

  console.log('DB:', dbFile);
  console.log('only:', only, 'limit:', limit || '∞', 'batch:', batchSize);

  try {
    if (only === 'all' || only === 'categories') {
      const n = await importCategories({ pool, filePath: categoriesPath, limit: limit || 0, batchSize });
      console.log(`[categories] done: ${n}`);
    }

    if (only === 'all' || only === 'problems') {
      const n = await importProblems({ pool, filePath: problemsPath, limit: limit || 0, batchSize });
      console.log(`[problems] done: ${n}`);
    }

    if (only === 'all' || only === 'details') {
      const n = await importProblemDetails({ pool, filePath: detailsPath, limit: limit || 0, batchSize });
      console.log(`[details] done: ${n}`);
    }
  } finally {
    await pool.closeAll();
  }
}

await main();
