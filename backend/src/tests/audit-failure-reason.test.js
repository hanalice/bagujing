/**
 * S18：chat 失败 reason 拆开，并把上游状态写入 ai_audit_logs。
 * 用例 ID 对齐 docs/test_cases.md §2.44。
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyChatStreamFailure } from '../chat-failure.js';
import { createCircuitOpenError } from '../upstream-circuit.js';
import { initMafSchema } from '../db/maf-repo.js';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s18-${process.pid}.ndjson`);
const DB_FILE = path.join(os.tmpdir(), `ai-audit-s18-${process.pid}.sqlite`);

describe('S18 审计失败原因与上游列', () => {
  after(() => {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* 无文件可忽略 */ }
    try { fs.unlinkSync(DB_FILE); } catch { /* 无文件可忽略 */ }
  });

  it('UT-AUDIT-REASON-01: 空闲超时、客户端中断、熔断、上游 HTTP、其它错误分开', () => {
    const timeout = classifyChatStreamFailure(new Error('SSE idle timeout'));
    const abort = classifyChatStreamFailure(new Error('SSE idle timeout'), { aborted: true });
    const circuit = classifyChatStreamFailure(createCircuitOpenError());
    const upstream = classifyChatStreamFailure(Object.assign(new Error('rate'), { status: 429 }));
    const other = classifyChatStreamFailure(new Error('boom'));

    assert.equal(timeout.reason, 'sse_idle_timeout');
    assert.equal(timeout.upstreamStatus, null);
    assert.equal(abort.reason, 'client_abort');
    assert.equal(abort.upstreamStatus, null);
    assert.equal(circuit.reason, 'circuit_open');
    assert.equal(circuit.upstreamStatus, null);
    assert.equal(upstream.reason, 'upstream_http');
    assert.equal(upstream.upstreamStatus, 429);
    assert.equal(other.reason, 'server_error');
    assert.equal(other.upstreamStatus, null);
  });

  it('UT-AUDIT-REASON-02: 旧库补列且旧行保持空', async () => {
    const file = path.join(os.tmpdir(), `ai-audit-s18-old-${process.pid}.sqlite`);
    const pool = createSqlitePool({ filename: file, max: 1 });
    try {
      await pool.withConnection((db) => db.exec(`
        CREATE TABLE ai_audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          request_id TEXT,
          client_id TEXT,
          user_identifier TEXT,
          action_type TEXT,
          action_name TEXT,
          page_path TEXT,
          page_title TEXT,
          payload_preview TEXT,
          prompt_tokens INTEGER DEFAULT 0,
          completion_tokens INTEGER DEFAULT 0,
          total_tokens INTEGER DEFAULT 0,
          status_code INTEGER,
          decision TEXT,
          reason TEXT,
          duration_ms INTEGER DEFAULT 0,
          client_ip_hash TEXT,
          user_agent TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO ai_audit_logs (request_id, reason) VALUES ('old-1', 'stream_done');
      `));
      await initMafSchema(pool);
      await initMafSchema(pool);
      const cols = await pool.withConnection((db) => db.all('PRAGMA table_info(ai_audit_logs)'));
      const names = new Set(cols.map((col) => col.name));
      assert.equal(names.has('upstream_status'), true);
      assert.equal(names.has('upstream_reached'), true);
      assert.equal(names.has('token_source'), true);
      const old = await pool.withConnection((db) => db.get(
        'SELECT upstream_status, upstream_reached, token_source FROM ai_audit_logs WHERE request_id = ?',
        ['old-1'],
      ));
      assert.equal(old.upstream_status, null);
      assert.equal(old.upstream_reached, null);
      assert.equal(old.token_source, null);
    } finally {
      await pool.closeAll();
      try { fs.unlinkSync(file); } catch { /* 无文件可忽略 */ }
    }
  });

  it('UT-AUDIT-REASON-03: finalize 把三列写入 SQL 且与 NDJSON 一致', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
    process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '100000';
    process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '100';
    process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '100000';
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* 无文件可忽略 */ }
    try { fs.unlinkSync(DB_FILE); } catch { /* 无文件可忽略 */ }

    const pool = createSqlitePool({ filename: DB_FILE, max: 1 });
    try {
      await initMafSchema(pool);
      await pool.withConnection((db) => db.exec(`
        CREATE TABLE IF NOT EXISTS ai_clients (
          client_id TEXT,
          daily_token_limit INTEGER,
          daily_request_limit INTEGER
        );
      `));
      const guard = createAiGuard({ jwtSecret: 'test', dbPool: pool });
      let statusCode = 200;
      const req = {
        method: 'POST',
        path: '/api/chat',
        body: { message: 'audit-s18' },
        headers: {},
        user: { clientId: 'web', id: 1 },
        header(name) {
          return String(name).toLowerCase() === 'x-request-id' ? 's18-req' : '';
        },
      };
      const res = {
        status(code) { statusCode = code; return this; },
        json() { return this; },
        setHeader() {},
        getHeader(name) { return name === 'X-Request-Id' ? 's18-req' : undefined; },
        once() {},
      };
      await guard.middleware(req, res, () => {});
      assert.notEqual(statusCode, 429);
      await req.aiGuard.finalize({
        status: 'error',
        reason: 'upstream_http',
        upstreamStatus: 502,
        upstreamReached: true,
        completionText: 'partial',
      });

      const deadline = Date.now() + 2000;
      let row;
      while (Date.now() < deadline) {
        row = await pool.withConnection((db) => db.get(
          'SELECT reason, upstream_status, upstream_reached, token_source FROM ai_audit_logs WHERE request_id = ?',
          ['s18-req'],
        ));
        if (row) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const ndjson = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const audit = ndjson.find((line) => line.requestId === 's18-req');
      assert.ok(row);
      assert.ok(audit);
      assert.equal(row.reason, 'upstream_http');
      assert.equal(audit.reason, row.reason);
      assert.equal(row.upstream_status, 502);
      assert.equal(audit.upstreamStatus, row.upstream_status);
      assert.equal(row.upstream_reached, 1);
      assert.equal(audit.upstreamReached, true);
      assert.equal(typeof row.token_source, 'string');
      assert.equal(audit.token_source, row.token_source);
    } finally {
      await pool.closeAll();
    }
  });
});
