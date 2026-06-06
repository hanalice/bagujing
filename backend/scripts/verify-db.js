import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, '../db/bagujing.dev.sqlite3');

const db = new sqlite3.Database(dbFile);

db.serialize(() => {
    console.log('--- AI Clients ---');
    db.all('SELECT * FROM ai_clients', (err, rows) => {
        console.log(rows);
    });

    console.log('--- AI Audit Logs ---');
    db.all('SELECT * FROM ai_audit_logs ORDER BY created_at DESC LIMIT 5', (err, rows) => {
        console.log(rows);
        db.close();
    });
});
