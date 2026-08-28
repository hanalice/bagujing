import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { initCategorySchema, upsertCategory } from '../db/category-repo.js';
import { initProblemSchema, upsertProblem } from '../db/problem-repo.js';
import { initProblemDetailSchema, upsertProblemDetail } from '../db/problem-detail-repo.js';

export const TEST_JWT_SECRET = 'prompt-budget-test-secret';
export const TEST_DB_PATH = path.join(os.tmpdir(), `prompt-budget-${process.pid}.sqlite3`);
export const TEST_AUDIT_PATH = path.join(os.tmpdir(), `prompt-budget-${process.pid}.ndjson`);

const TEST_ENV_KEYS = [
  'BAGUJING_SKIP_LISTEN',
  'ENABLE_SQLITE',
  'SQLITE_DB',
  'JWT_SECRET',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_AUDIT_FILE_PATH',
  'AI_PROMPT_MAX_DESC_CHARS',
  'AI_PROMPT_MAX_CHARS',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
];

// 保存路由集成测试会修改的环境变量，避免污染同一测试进程。
export function saveTestEnv() {
  return Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
}

// 恢复路由集成测试修改过的环境变量。
export function restoreTestEnv(savedEnv) {
  for (const key of TEST_ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

// 删除临时 SQLite 及审计文件，清理测试产生的持久化状态。
export function removeTestFiles() {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
  }
  try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
}

// 写入包含普通或超大 RAG 字段的隔离 SQLite fixture。
export async function seedPromptBudgetDatabase({ huge = false } = {}) {
  removeTestFiles();
  const pool = createSqlitePool({ filename: TEST_DB_PATH, max: 1 });
  await initCategorySchema(pool);
  await initProblemSchema(pool);
  await initProblemDetailSchema(pool);
  await pool.withConnection((db) => db.exec(`
    CREATE TABLE IF NOT EXISTS ai_clients (
      client_id TEXT PRIMARY KEY,
      client_name TEXT,
      daily_token_limit INTEGER,
      daily_request_limit INTEGER
    );
    INSERT OR REPLACE INTO ai_clients (
      client_id, client_name, daily_token_limit, daily_request_limit
    ) VALUES ('web', 'Prompt budget test client', 1000000, 10000);
  `));

  const groupDesc = huge
    ? `${'数据库污染描述🙂\n"}]'.repeat(1024 * 1024 / 12)}尾部_GROUP_SENTINEL`
    : `面试缓存分类描述${'很长'.repeat(3000)}尾部_GROUP_SENTINEL`;
  const keyPoints = huge
    ? Array.from({ length: 3000 }, (_, index) => `超大要点${index}🙂\n"}]`)
    : Array.from({ length: 120 }, (_, index) => `缓存要点${index}`);

  await upsertCategory(pool, {
    id: 1,
    name: '后端开发',
    groupName: '服务端',
    groupDesc,
    count: 42,
  });
  await upsertProblem(pool, {
    id: 42,
    groupId: 1,
    type: 1,
    brief_name: '缓存一致性设计',
    keyPoints,
    companies: ['测试公司'],
  });
  await upsertProblemDetail(pool, {
    id: 42,
    group_id: 1,
    name: '缓存一致性设计',
  });
  await pool.closeAll();
}

// 配置完整路由测试环境，确保认证、SQLite 和模型调用均可离线运行。
export function configureRouteTestEnv() {
  process.env.BAGUJING_SKIP_LISTEN = '1';
  process.env.ENABLE_SQLITE = 'true';
  process.env.SQLITE_DB = TEST_DB_PATH;
  process.env.JWT_SECRET = TEST_JWT_SECRET;
  process.env.OPENAI_API_KEY = 'sk-prompt-budget-test';
  process.env.OPENAI_BASE_URL = 'http://prompt-budget.invalid/v1';
  process.env.OPENAI_MODEL = 'gpt-4o-mini';
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_AUDIT_FILE_PATH = TEST_AUDIT_PATH;
  process.env.AI_PROMPT_MAX_DESC_CHARS = '240';
  process.env.AI_PROMPT_MAX_CHARS = '8000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';
}

// 生成带有 chat_ai 与 study 权限的离线测试登录令牌。
export function makeTestToken() {
  return jwt.sign({
    id: 1,
    username: 'prompt-budget-tester',
    role: 'admin',
    permissions: ['chat_ai', 'study'],
    clientId: 'web',
  }, TEST_JWT_SECRET, { expiresIn: '1h' });
}

// 构造可被 Express app.handle 消费的 JSON POST 请求。
export function createRouteRequest(route, body) {
  const payload = JSON.stringify(body);
  const req = Readable.from([payload]);
  req.method = 'POST';
  req.url = route;
  req.path = route;
  req.originalUrl = route;
  req.headers = {
    authorization: `Bearer ${makeTestToken()}`,
    'content-type': 'application/json',
    'content-length': String(payload.length),
    'x-request-id': `prompt-budget-${process.pid}`,
    'x-forwarded-for': '127.0.0.1',
  };
  req.socket = { remoteAddress: '127.0.0.1' };
  req.ip = '127.0.0.1';
  req.header = function header(name) {
    return this.headers[String(name).toLowerCase()];
  };
  req.on = function on(event, listener) {
    if (event === 'close') return this;
    return Readable.prototype.on.call(this, event, listener);
  };
  req.once = function once(event, listener) {
    if (event === 'close') return this;
    return Readable.prototype.once.call(this, event, listener);
  };
  return req;
}

// 创建记录响应头、SSE 帧和 JSON 结果的 Express 测试响应对象。
export function createRouteResponse(resolve) {
  const callOrder = [];
  const headers = {};
  const listeners = new Map();
  let ended = false;
  const res = {
    callOrder,
    statusCode: 200,
    get headers() { return headers; },
    get ended() { return ended; },
    get writableEnded() { return ended; },
    get headersSent() { return callOrder.some((entry) => entry.op === 'write') || ended; },
    setHeader(name, value) {
      headers[String(name).toLowerCase()] = value;
      callOrder.push({ op: 'setHeader', name, value });
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    write(data) {
      callOrder.push({ op: 'write', data: String(data) });
      return true;
    },
    end(data) {
      if (data !== undefined) this.write(data);
      if (ended) return this;
      ended = true;
      callOrder.push({ op: 'end' });
      for (const listener of listeners.get('finish') || []) listener();
      for (const listener of listeners.get('close') || []) listener();
      resolve(this);
      return this;
    },
    status(code) {
      this.statusCode = code;
      callOrder.push({ op: 'status', code });
      return this;
    },
    json(payload) {
      callOrder.push({ op: 'json', payload });
      return this.end();
    },
    once(event, listener) {
      const callbacks = listeners.get(event) || [];
      callbacks.push(listener);
      listeners.set(event, callbacks);
      return this;
    },
  };
  return res;
}

// 通过 app.handle 执行真实 Express 路由链并等待响应结束。
export function invokeRoute(app, route, body) {
  return new Promise((resolve, reject) => {
    const res = createRouteResponse(resolve);
    app.handle(createRouteRequest(route, body), res, (error) => {
      if (error) reject(error);
      else if (!res.ended) resolve(res);
    });
  });
}

// 安装只返回固定 OpenAI 兼容响应的 fetch stub，阻断所有外部网络访问。
export function installMockModelFetch(calls) {
  const originalFetch = globalThis.fetch;
  const encoder = new TextEncoder();
  globalThis.fetch = async (_url, init = {}) => {
    const request = JSON.parse(String(init.body));
    calls.push(request);
    if (request.stream) {
      const events = [
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: { role: 'assistant', content: '<p>mock answer</p>' }, finish_reason: null }],
        })}\n\n`,
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        })}\n\n`,
        'data: [DONE]\n\n',
      ];
      const body = new ReadableStream({
        start(controller) {
          for (const event of events) controller.enqueue(encoder.encode(event));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }

    return new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: '<p>mock answer</p>' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

// 等待异步审计队列落盘并读取指定数量的 NDJSON 记录。
export async function readAuditLines(expectedCount, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = fs.existsSync(TEST_AUDIT_PATH) ? fs.readFileSync(TEST_AUDIT_PATH, 'utf8').trim() : '';
    const lines = raw ? raw.split('\n') : [];
    if (lines.length >= expectedCount) return lines.map((line) => JSON.parse(line));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`审计日志在 ${timeoutMs}ms 内未写满 ${expectedCount} 条`);
}
