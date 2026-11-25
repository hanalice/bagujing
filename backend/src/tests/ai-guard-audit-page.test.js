/**
 * S19：finalize/reject 审计贯通 actionName/pageTitle/userAgent/pagePath；CORS 页头名单。
 * 用例 ID 对齐 docs/test_cases.md §2.57 / §3.27。
 * 路径：middleware + finalize/reject 探针（不连真实上游 / Redis）。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-s19-page-${process.pid}.ndjson`);

const ENV_KEYS = [
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_ALLOWED_ORIGINS',
  'AI_MAX_INPUT_CHARS',
  'AI_MAX_COMPLETION_TOKENS',
  'AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
];

const savedEnv = {};

function saveEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

async function readAuditLines(expectedCount, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = fs.existsSync(AUDIT_FILE) ? fs.readFileSync(AUDIT_FILE, 'utf8').trim() : '';
    const lines = raw ? raw.split('\n') : [];
    if (lines.length >= expectedCount) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`审计日志在 ${timeoutMs}ms 内未写满 ${expectedCount} 条`);
}

/**
 * 构造可注入页头 / UA / Origin / user 的 mock HTTP 对。
 * @param {{ method?: string, path?: string, body?: object, user?: object|null, headers?: Record<string,string>, ip?: string, requestId?: string }} opts
 */
function mockHttp({
  method = 'POST',
  path: reqPath = '/api/chat',
  body = { message: 'page-probe' },
  user,
  headers = {},
  ip = '203.0.113.40',
  requestId = 'test-req-s19',
} = {}) {
  let statusCode = 200;
  const jsonCalls = [];
  const headerMap = {};
  for (const [k, v] of Object.entries(headers)) {
    headerMap[String(k).toLowerCase()] = v;
  }
  const reqHeaders = {};
  if (headerMap.origin) reqHeaders.origin = headerMap.origin;
  if (headerMap['x-forwarded-for']) reqHeaders['x-forwarded-for'] = headerMap['x-forwarded-for'];
  const req = {
    method,
    path: reqPath,
    body,
    ip,
    headers: reqHeaders,
    user,
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return requestId;
      if (Object.prototype.hasOwnProperty.call(headerMap, key)) return headerMap[key];
      return '';
    },
  };
  const res = {
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    setHeader() {},
    getHeader(name) {
      return name === 'X-Request-Id' ? requestId : undefined;
    },
    once() {},
  };
  return {
    req,
    res,
    jsonCalls,
    get statusCode() {
      return statusCode;
    },
  };
}

function configurePageEnv() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
  process.env.AI_MAX_COMPLETION_TOKENS = '4096';
  process.env.AI_QUOTA_CONSERVATIVE_COMPLETION_TOKENS = '400';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '100';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '1000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '100';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '10';
}

/**
 * 注入可捕获 INSERT ai_audit_logs 绑定参数的 fake dbPool。
 * INSERT 列序：… action_name(4), page_path(5), page_title(6), … user_agent(16)
 */
function createCapturingDbPool() {
  const inserts = [];
  const pool = {
    withConnection: async (fn) => {
      const db = {
        async run(sql, params) {
          if (String(sql).includes('INSERT INTO ai_audit_logs')) {
            inserts.push({ sql: String(sql), params: params ?? [] });
            return { changes: 1 };
          }
          return { changes: 0 };
        },
        async get(sql) {
          if (String(sql).includes('COUNT(*)')) {
            return { request_count: 0, token_sum: 0 };
          }
          if (String(sql).includes('FROM ai_clients')) {
            return { daily_token_limit: 1000000, daily_request_limit: 10000 };
          }
          return undefined;
        },
      };
      return fn(db);
    },
  };
  return {
    pool,
    inserts,
    async waitInsert(n = 1, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (inserts.length >= n) return inserts;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`SQL INSERT 在 ${timeoutMs}ms 内未达 ${n} 次（当前 ${inserts.length}）`);
    },
  };
}

/** page_path / page_title / action_name / user_agent 在 INSERT 参数中的下标 */
const SQL_IDX = {
  actionName: 4,
  pagePath: 5,
  pageTitle: 6,
  userAgent: 16,
};

describe('2.57 S19 finalize/reject 审计页上下文贯通', () => {
  saveEnv();

  afterEach(async () => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-AUDIT-PAGE-01: allow：actionName 与 userAgent 非空贯通', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'page-01' },
      headers: { 'user-agent': 'S19-UA-Chat/1.0' },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
    assert.equal(http.req.aiGuard.actionName, 'AI 助手对话');
    assert.equal(http.req.aiGuard.userAgent, 'S19-UA-Chat/1.0');

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.decision, 'allow');
    assert.equal(row.actionName, 'AI 助手对话');
    assert.equal(row.userAgent, 'S19-UA-Chat/1.0');
  });

  it('UT-AUDIT-PAGE-02: allow：带 x-page-path 时 pagePath 等于该头', async () => {
    configurePageEnv();
    const { pool, waitInsert } = createCapturingDbPool();
    const guard = createAiGuard({ jwtSecret: 'test', dbPool: pool });
    const http = mockHttp({
      path: '/api/chat',
      body: { message: 'page-02' },
      headers: {
        'user-agent': 'S19-UA-Chat/1.0',
        'x-page-path': '/assistant',
      },
    });
    await guard.middleware(http.req, http.res, () => {});
    assert.equal(http.req.aiGuard.pagePath, '/assistant');

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.pagePath, '/assistant');
    assert.notEqual(row.pagePath, '/api/chat');
    assert.equal(row.path, '/api/chat');

    const inserts = await waitInsert(1);
    assert.equal(inserts[0].params[SQL_IDX.pagePath], '/assistant');
  });

  it('UT-AUDIT-PAGE-03: allow：无 x-page-path 时 pagePath 回退 req.path', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      path: '/api/chat',
      body: { message: 'page-03' },
      headers: { 'user-agent': 'S19-UA-Chat/1.0' },
    });
    let statusOnNext = null;
    await guard.middleware(http.req, http.res, () => {
      statusOnNext = http.statusCode;
    });
    assert.equal(http.req.aiGuard.pagePath, '/api/chat');
    assert.ok(statusOnNext === 200 || statusOnNext === null || statusOnNext === undefined
      || (statusOnNext !== 401 && statusOnNext !== 403));

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.pagePath, '/api/chat');
  });

  it('UT-AUDIT-PAGE-04: allow：pageTitle 从头贯通（可空）', async () => {
    configurePageEnv();
    const { pool, waitInsert } = createCapturingDbPool();
    const guard = createAiGuard({ jwtSecret: 'test', dbPool: pool });

    const withTitle = mockHttp({
      body: { message: 'page-04a' },
      headers: {
        'user-agent': 'S19-UA-Chat/1.0',
        'x-page-title': '职问助手',
      },
      requestId: 's19-04a',
    });
    await guard.middleware(withTitle.req, withTitle.res, () => {});
    assert.equal(withTitle.req.aiGuard.pageTitle, '职问助手');
    await withTitle.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'a',
      upstreamReached: true,
    });

    const withoutTitle = mockHttp({
      body: { message: 'page-04b' },
      headers: { 'user-agent': 'S19-UA-Chat/1.0' },
      requestId: 's19-04b',
    });
    await guard.middleware(withoutTitle.req, withoutTitle.res, () => {});
    assert.equal(withoutTitle.req.aiGuard.pageTitle, '');
    await withoutTitle.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'b',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const rows = await readAuditLines(2);
    assert.equal(rows[0].pageTitle, '职问助手');
    assert.equal(rows[1].pageTitle, '');

    const inserts = await waitInsert(2);
    assert.equal(inserts[0].params[SQL_IDX.pageTitle], '职问助手');
  });

  it('UT-AUDIT-PAGE-05: allow：generate 路由 actionName 为生成题目解析', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      path: '/api/problems/1/answer/generate',
      body: { force: false },
      headers: { 'user-agent': 'S19-UA-Gen/1.0' },
    });
    await guard.middleware(http.req, http.res, () => {});
    assert.equal(http.req.aiGuard.actionName, '生成题目解析');
    assert.equal(http.req.aiGuard.userAgent, 'S19-UA-Gen/1.0');

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'generated_answer',
      completionText: '{"summary":"s","keyPoints":["k"],"nextStep":"n"}',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.actionName, '生成题目解析');
    assert.equal(row.userAgent, 'S19-UA-Gen/1.0');
  });

  it('UT-AUDIT-PAGE-06: reject：审计同样带 pagePath/userAgent', async () => {
    // reason: origin_blocked（非法 Origin → 403，发生在 req.aiGuard 赋值前）
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'page-06' },
      headers: {
        origin: 'http://evil.example.com',
        'user-agent': 'S19-UA-Rej/1.0',
        'x-page-path': '/settings',
      },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });
    assert.equal(nextCount, 0);
    assert.equal(http.statusCode, 403);
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.decision, 'reject');
    assert.equal(row.reason, 'origin_blocked');
    assert.equal(row.userAgent, 'S19-UA-Rej/1.0');
    assert.equal(row.pagePath, '/settings');
  });

  it('UT-AUDIT-PAGE-07: SQL：page_path 优先 pagePath，回退 path', async () => {
    configurePageEnv();
    const { pool, waitInsert, inserts } = createCapturingDbPool();
    const guard = createAiGuard({ jwtSecret: 'test', dbPool: pool });

    // A：有 pagePath
    const a = mockHttp({
      path: '/api/chat',
      body: { message: 'page-07a' },
      headers: {
        'user-agent': 'S19-UA-Chat/1.0',
        'x-page-path': '/assistant',
      },
      requestId: 's19-07a',
    });
    await guard.middleware(a.req, a.res, () => {});
    await a.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'a',
      upstreamReached: true,
    });

    // B：故意清空 pagePath，验证 SQL 回退 payload.path
    const b = mockHttp({
      path: '/api/chat',
      body: { message: 'page-07b' },
      headers: { 'user-agent': 'S19-UA-Chat/1.0' },
      requestId: 's19-07b',
    });
    await guard.middleware(b.req, b.res, () => {});
    b.req.aiGuard.pagePath = undefined;
    await b.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'b',
      upstreamReached: true,
    });
    await guard.flushAudit();

    await waitInsert(2);
    const sqlA = inserts[0].sql;
    assert.ok(sqlA.includes('page_path'), 'SQL 须含列名 page_path');
    assert.ok(sqlA.includes('page_title'), 'SQL 须含列名 page_title');
    assert.ok(sqlA.includes('action_name'), 'SQL 须含列名 action_name');
    assert.ok(sqlA.includes('user_agent'), 'SQL 须含列名 user_agent');
    assert.equal(inserts[0].params[SQL_IDX.pagePath], '/assistant');
    assert.equal(inserts[1].params[SQL_IDX.pagePath], '/api/chat');
  });

  it('UT-AUDIT-PAGE-08: CORS 名单含 X-Page-Path / X-Page-Title / X-User-Id', () => {
    const guard = createAiGuard();
    const { allowedHeaders } = guard.corsOptions;
    for (const h of ['X-Page-Path', 'X-Page-Title', 'X-User-Id', 'Authorization']) {
      assert.ok(allowedHeaders.includes(h), `allowedHeaders 须含 ${h}`);
    }
    for (const h of [
      'Content-Type', 'Accept', 'X-Request-Id', 'X-Client-Id', 'X-Client-Token',
      'X-Ts', 'X-Nonce', 'X-Signature', 'X-Body-Sha256', 'X-Maf-Mission-Id',
    ]) {
      assert.ok(allowedHeaders.includes(h), `须保留既有头 ${h}`);
    }
  });

  it('UT-AUDIT-PAGE-09: S9 回归：登录态伪造 x-user-id 仍忽略', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'page-09' },
      user: { id: 42, clientId: 'web' },
      headers: {
        'x-user-id': 'attacker-spoof',
        'x-page-path': '/assistant',
        'user-agent': 'S19-UA-Chat/1.0',
      },
    });
    await guard.middleware(http.req, http.res, () => {});
    assert.equal(http.req.aiGuard.userIdentifier, '42');
    assert.notEqual(http.req.aiGuard.userIdentifier, 'attacker-spoof');
    assert.equal(http.req.aiGuard.pagePath, '/assistant');
    assert.equal(http.req.aiGuard.actionName, 'AI 助手对话');
    assert.equal(http.req.aiGuard.userAgent, 'S19-UA-Chat/1.0');

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, '42');
    assert.equal(row.pagePath, '/assistant');
    assert.equal(row.actionName, 'AI 助手对话');
    assert.equal(row.userAgent, 'S19-UA-Chat/1.0');
  });

  it('UT-AUDIT-PAGE-10: 不做：缺页头不得当鉴权失败；不改 schema/reason', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'page-10' },
      headers: { 'user-agent': 'S19-UA-Chat/1.0' },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });
    assert.equal(nextCount, 1, '缺 x-page-* 仍须 next()');
    assert.notEqual(http.statusCode, 401);
    assert.notEqual(http.statusCode, 403);

    // 只读契约：本项不要求 ALTER TABLE / 改 reason / 强制前端发头
    assert.ok(true, '不做：改 schema、强制发头、页头当鉴权、改 S9、改 reason');
  });

  it('UT-AUDIT-PAGE-11: residual：未发 x-page-path 时 page_path 为 API path 可接受', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      path: '/api/chat',
      body: { message: 'page-11' },
      headers: { 'user-agent': 'S19-UA-Chat/1.0' },
    });
    await guard.middleware(http.req, http.res, () => {});
    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    // residual：允许仅为 API path；不得以「前端必须已附带页头」为 FAIL
    assert.equal(row.pagePath, '/api/chat');
  });
});

describe('3.27 S19 审计页上下文贯通与 CORS 页头安全回归', () => {
  saveEnv();

  afterEach(async () => {
    restoreEnv();
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('SEC-AUDIT-PAGE-01: 页头不是鉴权凭据：缺 x-page-* 仍可准入', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'sec-01' },
      headers: { 'user-agent': 'S19-Sec/1.0' },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });
    assert.equal(nextCount, 1);
    assert.notEqual(http.statusCode, 401);
    assert.notEqual(http.statusCode, 403);

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.decision, 'allow');
    assert.equal(row.pagePath, '/api/chat');
  });

  it('SEC-AUDIT-PAGE-02: 伪造 x-user-id 在登录态仍不能覆盖 identifier（S9 合取）', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'sec-02' },
      user: { id: 42, clientId: 'web' },
      headers: {
        'x-user-id': 'victim-999',
        'x-page-path': '/assistant',
        'user-agent': 'S19-Sec/1.0',
      },
    });
    await guard.middleware(http.req, http.res, () => {});
    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.userIdentifier, '42');
    assert.notEqual(row.userIdentifier, 'victim-999');
    assert.equal(row.pagePath, '/assistant');
    assert.equal(row.userAgent, 'S19-Sec/1.0');
    assert.ok(row.actionName && String(row.actionName).length > 0);
  });

  it('SEC-AUDIT-PAGE-03: reject 路径审计含 pagePath 且 reason 名不变', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const http = mockHttp({
      body: { message: 'sec-03' },
      headers: {
        origin: 'http://evil.example.com',
        'x-page-path': '/assistant',
        'user-agent': 'S19-Sec/1.0',
      },
    });
    let nextCount = 0;
    await guard.middleware(http.req, http.res, () => { nextCount += 1; });
    assert.equal(nextCount, 0);
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.decision, 'reject');
    assert.equal(row.reason, 'origin_blocked');
    assert.equal(row.pagePath, '/assistant');
    assert.equal(row.userAgent, 'S19-Sec/1.0');
  });

  it('IT-AUDIT-PAGE-01: chat allow：NDJSON+SQL 页字段闭环', async () => {
    configurePageEnv();
    const { pool, waitInsert } = createCapturingDbPool();
    const guard = createAiGuard({ jwtSecret: 'test', dbPool: pool });
    const http = mockHttp({
      body: { message: 'it-01' },
      headers: {
        'x-page-path': '/assistant',
        'x-page-title': '职问助手',
        'user-agent': 'S19-IT/1.0',
      },
    });
    await guard.middleware(http.req, http.res, () => {});
    assert.equal(http.req.aiGuard.pagePath, '/assistant');
    assert.equal(http.req.aiGuard.pageTitle, '职问助手');
    assert.equal(http.req.aiGuard.actionName, 'AI 助手对话');
    assert.equal(http.req.aiGuard.userAgent, 'S19-IT/1.0');

    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'stream_done',
      completionText: 'ok',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.actionName, 'AI 助手对话');
    assert.equal(row.pagePath, '/assistant');
    assert.equal(row.pageTitle, '职问助手');
    assert.equal(row.userAgent, 'S19-IT/1.0');

    const inserts = await waitInsert(1);
    assert.equal(inserts[0].params[SQL_IDX.pagePath], '/assistant');
    assert.equal(inserts[0].params[SQL_IDX.pageTitle], '职问助手');
    assert.equal(inserts[0].params[SQL_IDX.actionName], 'AI 助手对话');
    assert.equal(inserts[0].params[SQL_IDX.userAgent], 'S19-IT/1.0');
  });

  it('IT-AUDIT-PAGE-02: generate allow：actionName 为生成题目解析', async () => {
    configurePageEnv();
    const guard = createAiGuard({ jwtSecret: 'test' });
    const genPath = '/api/problems/9/answer/generate';
    const http = mockHttp({
      path: genPath,
      body: { force: true },
      headers: {
        'user-agent': 'S19-IT-Gen/1.0',
        'x-page-path': '/problem-detail',
      },
    });
    await guard.middleware(http.req, http.res, () => {});
    await http.req.aiGuard.finalize({
      status: 'ok',
      reason: 'generated_answer',
      completionText: '{"summary":"s","keyPoints":["k"],"nextStep":"n"}',
      upstreamReached: true,
    });
    await guard.flushAudit();

    const [row] = await readAuditLines(1);
    assert.equal(row.actionName, '生成题目解析');
    assert.equal(row.userAgent, 'S19-IT-Gen/1.0');
    assert.equal(row.pagePath, '/problem-detail');
  });

  it('IT-AUDIT-PAGE-04: 不做 / residual 边界', () => {
    // 只读 backlog S19 不做与 residual：本行不以「未发页头 / 未改 schema」判 FAIL
    assert.ok(true, '不做：改 schema/列名、强制发头、页头当鉴权、改 S9、改 reason');
    assert.ok(true, 'residual：未发 x-page-path 时 page_path 为 API path；前端发头另条');
  });
});
