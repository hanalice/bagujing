/**
 * @file verify-db.js
 * @description 数据库安全与审计状态诊断排查脚本
 *
 * 【设计意图】
 * 1. 快速检查本地 SQLite 数据库中 `ai_clients`（客户端凭证与配额表）是否存在预期记录。
 * 2. 读取并打印最近 5 条 `ai_audit_logs`（AI 网关请求审计流水），用于在开发调试时
 *    即时确认放行/拦截决策、Token 统计、耗时等数据是否正常持久化。
 *
 * 【使用方式】
 * - node scripts/verify-db.js
 */

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
