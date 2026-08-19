/**
 * @file seed-audit-db.js
 * @description 客户端配额种子数据初始化脚本
 *
 * 【设计意图】
 * 1. 在本地或测试环境初次启动时，向 SQLite 的 `ai_clients` 表中注入默认的 `web` 客户端凭据。
 * 2. 初始化默认配额上限（如日 Token 上限 50,000，日请求上限 200 次），确保未配置动态用户时的基础防护可用。
 * 3. 采用 `INSERT OR IGNORE` 保证幂等性，多次执行不会覆盖已有配置。
 *
 * 【使用方式】
 * - node scripts/seed-audit-db.js
 */

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
