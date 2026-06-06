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
