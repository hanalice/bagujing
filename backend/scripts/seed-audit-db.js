import sqlite3 from 'sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbFile = path.join(__dirname, '../db/bagujing.dev.sqlite3');

const db = new sqlite3.Database(dbFile);

const defaultClient = {
    id: 'web',
    name: 'Default Web Client',
    token_limit: 50000,
    request_limit: 200
};

db.serialize(() => {
    db.run(
        `INSERT OR IGNORE INTO ai_clients (client_id, client_name, daily_token_limit, daily_request_limit) VALUES (?, ?, ?, ?)`,
        [defaultClient.id, defaultClient.name, defaultClient.token_limit, defaultClient.request_limit],
        (err) => {
            if (err) {
                console.error('Failed to insert default client:', err.message);
                process.exit(1);
            }
            console.log('Default client "web" ensured in ai_clients table.');
            db.close();
        }
    );
});
