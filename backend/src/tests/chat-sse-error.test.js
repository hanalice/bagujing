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
 * omitMessage=true 时 body 不含 message 字段（覆盖 sanitize 得 ''）。
 */
function createChatRequest({ message, omitMessage = false, token = makeAuthToken() }) {
  const body = omitMessage ? {} : { message };
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
 * 记录 setHeader / write / end / status / json，用于断言 SSE 协议与禁止 JSON 错误体。
 */
function createTrackingResponse() {
  const callOrder = [];
  const headers = {};
  let ended = false;
  const finishListeners = [];

  const res = {
    callOrder,
    statusCode: 200,
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
    status(code) {
      callOrder.push({ op: 'status', code });
      this.statusCode = code;
      return this;
    },
    json(payload) {
      callOrder.push({ op: 'json', payload });
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

async function invokeChatRoute(app, { message, omitMessage = false }) {
  const req = createChatRequest({ message, omitMessage });
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

function findOpIndex(callOrder, op, predicate = () => true) {
  return callOrder.findIndex((entry) => entry.op === op && predicate(entry));
}

function collectWriteFrames(callOrder) {
  return callOrder.filter((entry) => entry.op === 'write').map((entry) => entry.data);
}

/**
 * 锁定 P2-5 / docs UT-CHAT-SSE-*：SSE 三头 → 唯一 type:error 线格式 → end；禁止 JSON 错误体。
 */
function assertSseErrorProtocol(callOrder, expectedWireFrame) {
  assert.equal(
    callOrder.filter((e) => e.op === 'status').length,
    0,
    'must not use res.status(...) for chat early-exit errors',
  );
  assert.equal(
    callOrder.filter((e) => e.op === 'json').length,
    0,
    'must not use res.json(...) for chat early-exit errors',
  );

  const contentTypeIdx = findOpIndex(
    callOrder,
    'setHeader',
    (entry) => entry.name.toLowerCase() === 'content-type'
      && entry.value === 'text/event-stream; charset=utf-8',
  );
  const cacheControlIdx = findOpIndex(
    callOrder,
    'setHeader',
    (entry) => entry.name.toLowerCase() === 'cache-control'
      && entry.value === 'no-cache, no-transform',
  );
  const connectionIdx = findOpIndex(
    callOrder,
    'setHeader',
    (entry) => entry.name.toLowerCase() === 'connection'
      && entry.value === 'keep-alive',
  );
  const firstWriteIdx = findOpIndex(callOrder, 'write');
  const endIdx = findOpIndex(callOrder, 'end');
  const writes = collectWriteFrames(callOrder);

  assert.ok(contentTypeIdx >= 0, 'must set Content-Type: text/event-stream; charset=utf-8');
  assert.ok(cacheControlIdx >= 0, 'must set Cache-Control: no-cache, no-transform');
  assert.ok(connectionIdx >= 0, 'must set Connection: keep-alive');
  assert.ok(firstWriteIdx >= 0, 'must write SSE error event before end');
  assert.ok(endIdx >= 0, 'must end response');

  assert.ok(contentTypeIdx < firstWriteIdx, 'Content-Type must precede first SSE write');
  assert.ok(cacheControlIdx < firstWriteIdx, 'Cache-Control must precede first SSE write');
  assert.ok(connectionIdx < firstWriteIdx, 'Connection must precede first SSE write');
  assert.ok(endIdx > firstWriteIdx, 'end must follow SSE error write');

  assert.equal(writes.length, 1, 'exactly one SSE write frame');
  assert.equal(writes[0], expectedWireFrame);

  for (const forbidden of ['"type":"context"', '"type":"delta"', '"type":"done"']) {
    assert.equal(
      writes.some((frame) => frame.includes(forbidden)),
      false,
      `must not emit ${forbidden} frames`,
    );
  }
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

  it('UT-CHAT-SSE-01: 缺 Key：SSE 头后发 type:error 再 end', async () => {
    const res = await invokeChatRoute(app, { message: 'hello' });

    assert.equal(res.ended, true);
    assertSseErrorProtocol(
      res.callOrder,
      'data: {"type":"error","message":"OPENAI_API_KEY is required"}\n\n',
    );
  });

  it('UT-CHAT-SSE-02: 空白消息：SSE 头后发 type:error 再 end', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const res = await invokeChatRoute(app, { message: '   ' });

    assert.equal(res.ended, true);
    assertSseErrorProtocol(
      res.callOrder,
      'data: {"type":"error","message":"Empty message"}\n\n',
    );
  });

  it('UT-CHAT-SSE-03: 空串或缺 message：同 Empty message 协议', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';

    const emptyRes = await invokeChatRoute(app, { message: '' });
    assert.equal(emptyRes.ended, true);
    assertSseErrorProtocol(
      emptyRes.callOrder,
      'data: {"type":"error","message":"Empty message"}\n\n',
    );

    const omittedRes = await invokeChatRoute(app, { omitMessage: true });
    assert.equal(omittedRes.ended, true);
    assertSseErrorProtocol(
      omittedRes.callOrder,
      'data: {"type":"error","message":"Empty message"}\n\n',
    );
  });
});
