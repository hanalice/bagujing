import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFetchedCategories } from '../util/find-fetched-categories.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
    const testDir = path.join(__dirname, 'temp_test_find_fetched');
    
    // Ensure clean state
    if (fs.existsSync(testDir)) {
        await fsp.rm(testDir, { recursive: true, force: true });
    }
    await fsp.mkdir(testDir);

    const categoriesPath = path.join(testDir, 'categories.ndjson');
    const problemsPath = path.join(testDir, 'problems.ndjson');
    const fetchedPath = path.join(testDir, 'fetched_categories.ndjson');

    // Prepare Data
    // Case 1: id=6, count=2. Problems has 2. -> Move to fetched.
    // Case 2: id=78, count=3. Problems has 1. -> Remove from problems.
    // Case 3: id=8, count=53. Problems has 0. -> No change.
    
    const categoriesData = [
        JSON.stringify({"id":6, "count":2, "name":"MoveMe"}),
        JSON.stringify({"id":78, "count":3, "name":"CleanProblems"}),
        JSON.stringify({"id":8, "count":53, "name":"IgnoreMe"})
    ].join('\n');

    const problemsData = [
        JSON.stringify({"groupId":6, "id":101, "name":"p1"}),
        JSON.stringify({"groupId":6, "id":102, "name":"p2"}),
        JSON.stringify({"groupId":78, "id":201, "name":"p3"})
    ].join('\n');

    await fsp.writeFile(categoriesPath, categoriesData);
    await fsp.writeFile(problemsPath, problemsData);
    // fetched_categories.ndjson might not exist initially, or be empty.
    
    console.log('Created test files in ' + testDir);

    try {
        const result = await findFetchedCategories(testDir);
        console.log('Function returned:', result);

        // Verify Categories
        const newCategories = (await fsp.readFile(categoriesPath, 'utf8')).trim().split('\n').map(JSON.parse);
        // Expected: id=78 and id=8 remain. id=6 moved.
        const catIds = newCategories.map(c => c.id).sort((a,b) => a-b);
        if (JSON.stringify(catIds) === JSON.stringify([8, 78])) {
            console.log('Categories verification PASSED.');
        } else {
            console.error('Categories verification FAILED. Got ids:', catIds);
        }

        // Verify Fetched
        const newFetched = (await fsp.readFile(fetchedPath, 'utf8')).trim().split('\n').map(JSON.parse);
        // Expected: id=6
        if (newFetched.length === 1 && newFetched[0].id === 6) {
            console.log('Fetched categories verification PASSED.');
        } else {
            console.error('Fetched categories verification FAILED. Got:', newFetched);
        }

        // Verify Problems
        const newProblems = (await fsp.readFile(problemsPath, 'utf8')).trim().split('\n').map(JSON.parse);
        // Expected: groupId=6 (2 items). groupId=78 (1 item) should be removed.
        const probGroupIds = newProblems.map(p => p.groupId);
        const count6 = probGroupIds.filter(id => id === 6).length;
        const count78 = probGroupIds.filter(id => id === 78).length;

        if (count6 === 2 && count78 === 0) {
            console.log('Problems verification PASSED.');
        } else {
            console.error(`Problems verification FAILED. groupId=6 count: ${count6}, groupId=78 count: ${count78}`);
        }

    } catch (err) {
        console.error('Test execution failed:', err);
    } finally {
        // Cleanup
        // await fsp.rm(testDir, { recursive: true, force: true });
        console.log(`Test finished. Artifacts in ${testDir}`);
    }
}

runTest();
