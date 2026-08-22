import { afterEach, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'bagujing-secret-2026';
const AUDIT_FILE = path.join(os.tmpdir(), `chat-sse-a5-${process.pid}.ndjson`);

const ENV_KEYS = [
  'BAGUJING_SKIP_LISTEN',
  'ENABLE_SQLITE',
  'JWT_SECRET',
  'OPENAI_API_KEY',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_AUDIT_FILE_PATH',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
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

function configureTestEnv() {
  process.env.BAGUJING_SKIP_LISTEN = '1';
  process.env.ENABLE_SQLITE = 'false';
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';
}

function makeAuthToken() {
  return jwt.sign(
    {
      id: 1,
      username: 'tester',
      role: 'admin',
      permissions: ['chat_ai', 'study'],
      clientId: 'web',
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  );
}

/**
 * 构造 POST /api/chat 请求，走 Express 中间件链（含 JSON 解析）。
 */
function createChatRequest({ message, token = makeAuthToken() }) {
  const body = { message };
  const payload = JSON.stringify(body);
  const req = Readable.from([payload]);
  req.method = 'POST';
  req.url = '/api/chat';
  req.path = '/api/chat';
  req.originalUrl = '/api/chat';
  req.headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(payload)),
    'x-request-id': 'test-chat-sse-a5',
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

/**
 * 记录 setHeader / write / end 调用顺序，用于断言 SSE 头先于 error 事件。
 */
function createTrackingResponse() {
  const callOrder = [];
  const headers = {};
  let ended = false;
  const finishListeners = [];

  const res = {
    callOrder,
    get ended() {
      return ended;
    },
    setHeader(name, value) {
      callOrder.push({ op: 'setHeader', name, value });
      headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return headers[String(name).toLowerCase()];
    },
    write(data) {
      callOrder.push({ op: 'write', data: String(data) });
      return true;
    },
    end(data) {
      if (data !== undefined) {
        this.write(data);
      }
      ended = true;
      callOrder.push({ op: 'end' });
      for (const listener of finishListeners) listener();
    },
    status() {
      return this;
    },
    json() {
      return this;
    },
    once(event, listener) {
      if (event === 'finish' || event === 'close') {
        finishListeners.push(listener);
      }
    },
  };

  return res;
}

async function invokeChatRoute(app, { message }) {
  const req = createChatRequest({ message });
  const res = createTrackingResponse();

  await new Promise((resolve, reject) => {
    const baseEnd = res.end.bind(res);
    res.end = function endWithResolve(data) {
      baseEnd(data);
      resolve();
    };

    app.handle(req, res, (err) => {
      if (err) reject(err);
    });
  });

  return res;
}

function parseSsePayload(raw) {
  const match = raw.match(/^data: (.+)\n\n$/);
  assert.ok(match, `invalid SSE frame: ${raw}`);
  return JSON.parse(match[1]);
}

function collectSsePayloads(callOrder) {
  return callOrder
    .filter((entry) => entry.op === 'write')
    .map((entry) => parseSsePayload(entry.data));
}

function findOpIndex(callOrder, op, predicate = () => true) {
  return callOrder.findIndex((entry) => entry.op === op && predicate(entry));
}

/**
 * 锁定 P2-5：SSE 响应头全部写入后，才发送 type:error，最后 end。
 */
function assertSseHeadersBeforeError(callOrder, expectedError) {
  const contentTypeIdx = findOpIndex(
    callOrder,
    'setHeader',
    (entry) => entry.name.toLowerCase() === 'content-type'
      && String(entry.value).includes('text/event-stream'),
  );
  const cacheControlIdx = findOpIndex(
    callOrder,
    'setHeader',
    (entry) => entry.name.toLowerCase() === 'cache-control',
  );
  const connectionIdx = findOpIndex(
    callOrder,
    'setHeader',
    (entry) => entry.name.toLowerCase() === 'connection',
  );
  const firstWriteIdx = findOpIndex(callOrder, 'write');
  const endIdx = findOpIndex(callOrder, 'end');

  assert.ok(contentTypeIdx >= 0, 'must set Content-Type to text/event-stream');
  assert.ok(cacheControlIdx >= 0, 'must set Cache-Control header');
  assert.ok(connectionIdx >= 0, 'must set Connection header');
  assert.ok(firstWriteIdx >= 0, 'must write SSE error event before end');
  assert.ok(endIdx >= 0, 'must end response');

  assert.ok(contentTypeIdx < firstWriteIdx, 'Content-Type must precede first SSE write');
  assert.ok(cacheControlIdx < firstWriteIdx, 'Cache-Control must precede first SSE write');
  assert.ok(connectionIdx < firstWriteIdx, 'Connection must precede first SSE write');
  assert.ok(endIdx > firstWriteIdx, 'end must follow SSE error write');

  const payloads = collectSsePayloads(callOrder);
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0], expectedError);
}

describe('A5/P2-5: /api/chat early exit emits type:error after SSE headers', () => {
  /** @type {import('express').Express} */
  let app;

  saveEnv();

  before(async () => {
    configureTestEnv();
    ({ app } = await import('../server-express.js'));
  });

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('missing OPENAI_API_KEY: SSE headers then type:error then end', async () => {
    const res = await invokeChatRoute(app, { message: 'hello' });

    assert.equal(res.ended, true);
    assertSseHeadersBeforeError(res.callOrder, {
      type: 'error',
      message: 'OPENAI_API_KEY is required',
    });
  });

  it('empty message: SSE headers then type:error then end', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const res = await invokeChatRoute(app, { message: '   ' });

    assert.equal(res.ended, true);
    assertSseHeadersBeforeError(res.callOrder, {
      type: 'error',
      message: 'Empty message',
    });
  });
});
