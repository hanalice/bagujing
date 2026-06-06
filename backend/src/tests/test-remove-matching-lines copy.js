import path from 'node:path';
import { removeMatchingLines } from '../util/remove-matching-lines.js';
import { fileURLToPath } from 'node:url';
import fs, { promises as fsp } from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTest() {
    const testDir = path.join(__dirname, 'temp_test_remove');
    
    // Ensure clean state
    if (fs.existsSync(testDir)) {
        await fsp.rm(testDir, { recursive: true, force: true });
    }
    await fsp.mkdir(testDir);

    const fileA = path.join(testDir, 'fileA.ndjson');
    const fileB = path.join(testDir, 'fileB.ndjson');
    const logFile = path.join(testDir, 'operation.log');

    // Prepare File A
    const contentA = [
        'line1',
        'line2',
        'line3',
        'line4',
        'line5',
        'line2', // Duplicate in A, should be removed if in B
        'line6'
    ].join('\n'); // Use \n, the utility handles reading lines

    // Prepare File B (lines to remove)
    const contentB = [
        'line2',
        'line4',
        'line99' // Line not in A, should be ignored
    ].join('\n');

    await fsp.writeFile(fileA, contentA);
    await fsp.writeFile(fileB, contentB);

    console.log('Created test files.');

    try {
        await removeMatchingLines(fileA, fileB, logFile);
        
        // Verify File A
        const newContentA = await fsp.readFile(fileA, 'utf8');
        const linesA = newContentA.split(/\r?\n/).filter(l => l.length > 0);
        
        // Expected: line1, line3, line5, line6
        // line2 (both instances) and line4 should be gone.
        const expectedLines = ['line1', 'line3', 'line5', 'line6'];
        
        let success = true;
        if (linesA.length !== expectedLines.length) {
            console.error(`Test Failed: Expected ${expectedLines.length} lines, got ${linesA.length}`);
            success = false;
        }
        
        for (let i = 0; i < expectedLines.length; i++) {
            if (linesA[i] !== expectedLines[i]) {
                console.error(`Test Failed: Line ${i} mismatch. Expected '${expectedLines[i]}', got '${linesA[i]}'`);
                success = false;
            }
        }

        if (success) {
            console.log('File A content verification PASSED.');
        }

        // Verify Log File
        const logContent = await fsp.readFile(logFile, 'utf8');

        if (logContent.includes('Deleted Count: 3') && 
            logContent.includes('line2') && 
            logContent.includes('line4')) {
            console.log('Log file verification PASSED.');
        } else {
            console.error('Log file verification FAILED.');
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
