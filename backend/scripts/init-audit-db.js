import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, '../db/bagujing.dev.sqlite3');
const schemaFile = '/home/alice/.gemini/antigravity/brain/811d0b22-a025-48ca-854b-d114fcc10598/audit_schema.sql';

if (!fs.existsSync(path.dirname(dbFile))) {
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
}

const db = new sqlite3.Database(dbFile);
const schema = fs.readFileSync(schemaFile, 'utf8');

db.serialize(() => {
    db.exec(schema, (err) => {
        if (err) {
            console.error('Failed to initialize schema:', err.message);
            process.exit(1);
        }
        console.log('Database initialized successfully at', dbFile);
        db.close();
    });
});
