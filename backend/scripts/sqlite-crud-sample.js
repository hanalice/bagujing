/**
 * @file sqlite-crud-sample.js
 * @description 数据库连接池与 DAO 仓储层 CRUD 代码使用范例
 *
 * 【设计意图】
 * 1. 作为开发参考示例 (Sample / Reference Code)，演示如何基于自定义 SQLite 连接池
 *    (`createSqlitePool`) 调用各 Repository 的增删改查方法。
 * 2. 演示了 Category、Problem 与 ProblemDetail 数据模型的查询与更新调用范式。
 * 3. 包含连接池的生命周期管理（使用完毕后必须显式调用 `pool.closeAll()`）。
 *
 * 【使用方式】
 * - node scripts/sqlite-crud-sample.js
 */

import path from 'path';
import { fileURLToPath } from 'url';

import readNdjson from '../src/util/read-ndjson.js';
import { createSqlitePool } from '../src/db/sqlite-pool.js';
import {
  initCategorySchema,
  upsertCategory,
  getCategoryById,
  updateCategoryCount,
  deleteCategoryById,
} from '../src/db/category-repo.js';
import { getProblemById } from '../src/db/problem-repo.js';
import { getProblemDetailById } from '../src/db/problem-detail-repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbFile = path.join(__dirname, '../db/bagujing.dev.sqlite3');
// const categoriesPath = path.join(__dirname, '../data/categories.ndjson');

const pool = createSqlitePool({
  filename: dbFile,
  max: 2,
});

async function main() {

  // const categories = await readNdjson(categoriesPath);
  // const sample = categories.slice(0, 2);

  console.log('DB:', dbFile);
  // console.log('Upserting categories:', sample.map((c) => c.id));

  // for (const c of sample) {
  //   await upsertCategory(pool, c);
  // }

  // const categoryId = 78;
  // const category = await getCategoryById(pool, categoryId);
  // console.log('Read category back:', category);

  // const problemId = 16190;
  // const problem = await getProblemById(pool, problemId);
  // console.log('Read problem back:', problem); 

  const problemDetailId = 148719;
  const detail = await getProblemDetailById(pool, problemDetailId);
  console.log('Read problem detail back:', detail);

  // await updateCategoryCount(pool, firstId, (row1?.count ?? 0) + 1);
  // const row2 = await getCategoryById(pool, firstId);
  // console.log('After update count:', row2?.count);

  // const secondId = sample[1]?.id;
  // await deleteCategoryById(pool, secondId);
  // const row3 = await getCategoryById(pool, secondId);
  // console.log('After delete second:', row3);
}

try {
  await main();
} finally {
  await pool.closeAll();
}
