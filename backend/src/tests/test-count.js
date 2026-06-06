import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countCategories } from "../util/count.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

countCategories().then(({ countCategories, countProblems }) => {
  console.log(`Total categories: ${countCategories}`);
  console.log(`Total problems: ${countProblems}`);
}).catch((err) => {
  console.error('error counting categories and problems', err);
});