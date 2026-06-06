import readNdjson from '../util/read-ndjson.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const filePath = path.join(__dirname, '../../data/categories.ndjson');
  try {
    const arr = await readNdjson(filePath);
    console.log('Read NDJSON OK. Items:', arr.length);
    process.exit(0);
  } catch (e) {
    console.error('Read NDJSON failed:', e);
    process.exit(1);
  }
}

main();
