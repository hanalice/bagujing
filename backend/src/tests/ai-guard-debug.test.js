import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-a6-${process.pid}.ndjson`);

const ENV_KEYS = [
  'NODE_ENV',
  'AI_GUARD_DEBUG',
  'AI_AUDIT_FILE_PATH',
  'AI_REQUIRE_SIGNED_HEADERS',
  'AI_RATE_LIMIT_CLIENT_PER_MINUTE',
  'AI_RATE_LIMIT_CLIENT_PER_HOUR',
  'AI_RATE_LIMIT_IP_PER_MINUTE',
  'AI_MAX_CONCURRENCY_PER_CLIENT',
  'AI_DAILY_REQUEST_LIMIT_PER_CLIENT',
  'AI_DAILY_TOKEN_LIMIT_PER_CLIENT',
  'AI_GLOBAL_DAILY_REQUEST_LIMIT',
  'AI_GLOBAL_DAILY_TOKEN_LIMIT',
];

/** 保存/恢复本用例触碰的环境变量，避免污染其它套件 */
function withEnv(overrides, fn) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
}

function applyLooseLimits() {
  process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
  process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
  process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE = '1000';
  process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR = '10000';
  process.env.AI_RATE_LIMIT_IP_PER_MINUTE = '1000';
  process.env.AI_MAX_CONCURRENCY_PER_CLIENT = '100';
  process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT = '10000';
  process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT = '1000000';
  process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT = '100000';
  process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT = '10000000';
}

/**
 * 构造可走通 Guard middleware → next() 的假 HTTP 对象。
 * @param {{ headers?: Record<string, string> }} [opts]
 */
function mockHttp({ headers = {} } = {}) {
  const req = {
    method: 'POST',
    path: '/api/chat',
    body: { message: 'debug-probe' },
    headers: {},
    user: { clientId: 'web' },
    header(name) {
      const key = String(name).toLowerCase();
      if (Object.prototype.hasOwnProperty.call(headers, key)) return headers[key];
      if (Object.prototype.hasOwnProperty.call(headers, name)) return headers[name];
      if (key === 'x-request-id') return 'test-req';
      return '';
    },
  };
  const res = {
    json() {
      return this;
    },
    status() {
      return this;
    },
    setHeader() {},
    getHeader(name) {
      return name === 'X-Request-Id' ? (headers['x-request-id'] || 'test-req') : undefined;
    },
    once() {},
  };
  return { req, res };
}

/** stub console.log/debug/info，收集全部参数拼接串 */
function stubConsole() {
  const calls = { log: [], debug: [], info: [] };
  const original = {
    log: console.log,
    debug: console.debug,
    info: console.info,
  };
  console.log = (...args) => {
    calls.log.push(args.map(String).join(' '));
  };
  console.debug = (...args) => {
    calls.debug.push(args.map(String).join(' '));
  };
  console.info = (...args) => {
    calls.info.push(args.map(String).join(' '));
  };
  return {
    calls,
    restore() {
      console.log = original.log;
      console.debug = original.debug;
      console.info = original.info;
    },
    allJoined() {
      return [...calls.log, ...calls.debug, ...calls.info].join('\n');
    },
    debugJoined() {
      return [...calls.log, ...calls.debug].join('\n');
    },
  };
}

describe('A6/P2-3: ai-guard-debug 生产默认不输出', () => {
  afterEach(() => {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('UT-GUARD-DEBUG-01: 生产默认无 [ai-guard-debug] 输出', async () => {
    await withEnv({
      NODE_ENV: 'production',
      AI_GUARD_DEBUG: undefined,
    }, async () => {
      applyLooseLimits();
      delete process.env.AI_GUARD_DEBUG;

      const stub = stubConsole();
      try {
        const guard = createAiGuard({ jwtSecret: 'test' });
        const { req, res } = mockHttp();
        let nextCount = 0;
        await guard.middleware(req, res, () => { nextCount += 1; });

        assert.equal(nextCount, 1);
        assert.equal(
          stub.allJoined().includes('[ai-guard-debug]'),
          false,
          '生产默认不得输出 [ai-guard-debug]',
        );
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-DEBUG-02: 显式开启调试允许一条 [ai-guard-debug]', async () => {
    await withEnv({
      NODE_ENV: 'production',
      AI_GUARD_DEBUG: 'true',
    }, async () => {
      applyLooseLimits();

      const stub = stubConsole();
      try {
        const guard = createAiGuard({ jwtSecret: 'test' });
        const { req, res } = mockHttp({ headers: { 'x-request-id': 'req-debug-1' } });
        let nextCount = 0;
        await guard.middleware(req, res, () => { nextCount += 1; });

        assert.equal(nextCount, 1);
        const debugChannel = stub.calls.debug.join('\n');
        const logChannel = stub.calls.log.join('\n');
        // 须走 console.debug（或至少 debug/log 之一），禁止仅靠 info 刷屏
        const hit =
          debugChannel.includes('[ai-guard-debug]') || logChannel.includes('[ai-guard-debug]');
        assert.equal(hit, true, '开启 AI_GUARD_DEBUG 后应有 [ai-guard-debug]');
        assert.equal(
          stub.calls.info.some((s) => s.includes('[ai-guard-debug]')),
          false,
          '不得用 console.info 输出 [ai-guard-debug]',
        );
        const joined = stub.debugJoined();
        assert.match(joined, /\[ai-guard-debug\]/);
        assert.match(joined, /route=/);
        assert.ok(
          joined.includes('chat') || joined.includes('/api/chat'),
          '须含 chat 路由标识',
        );
        assert.ok(
          joined.includes('req-debug-1') || joined.includes('requestId'),
          '须含 requestId / req-debug-1',
        );
      } finally {
        stub.restore();
      }
    });
  });

  it('UT-GUARD-DEBUG-03: 调试开启时正文不含签名/Token 原文', async () => {
    await withEnv({
      NODE_ENV: 'production',
      AI_GUARD_DEBUG: 'true',
    }, async () => {
      applyLooseLimits();

      const stub = stubConsole();
      try {
        const guard = createAiGuard({ jwtSecret: 'test' });
        const { req, res } = mockHttp({
          headers: {
            'x-request-id': 'req-debug-1',
            'x-client-token': 'secret-token-value',
            'x-signature': 'sig-leak-probe',
            authorization: 'Bearer leak-jwt',
          },
        });
        let nextCount = 0;
        await guard.middleware(req, res, () => { nextCount += 1; });
        assert.equal(nextCount, 1);

        const debugLines = [...stub.calls.log, ...stub.calls.debug, ...stub.calls.info]
          .filter((s) => s.includes('[ai-guard-debug]'));
        assert.ok(debugLines.length >= 1, '应至少一条 [ai-guard-debug]');
        const joined = debugLines.join('\n');
        assert.equal(joined.includes('secret-token-value'), false);
        assert.equal(joined.includes('sig-leak-probe'), false);
        assert.equal(joined.includes('leak-jwt'), false);
        assert.equal(joined.includes('Bearer leak-jwt'), false);
      } finally {
        stub.restore();
      }
    });
  });
});
