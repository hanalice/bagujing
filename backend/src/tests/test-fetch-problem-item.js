import { fetchProblemsFromFile } from '../fetch-data/fetch-problem-item.js';

try {
  const count = await fetchProblemsFromFile(1);
  console.log(`fetched ${count} problems from file`);
} catch (error) {
  console.error('error fetching problems from file', error.message);
}