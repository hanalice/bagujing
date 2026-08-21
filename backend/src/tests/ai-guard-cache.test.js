import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAiGuard } from '../security/ai-guard.js';

const AUDIT_FILE = path.join(os.tmpdir(), `ai-audit-a3-${process.pid}.ndjson`);

function mockHttp({ method, path: reqPath, body }) {
  const jsonCalls = [];
  const req = {
    method,
    path: reqPath,
    body,
    headers: {},
    user: { clientId: 'web' },
    header(name) {
      const key = String(name).toLowerCase();
      if (key === 'x-request-id') return 'test-req';
      return '';
    },
  };
  const res = {
    json(payload) {
      jsonCalls.push(payload);
      return this;
    },
    status() {
      return this;
    },
    setHeader() {},
    getHeader(name) {
      return name === 'X-Request-Id' ? 'test-req' : undefined;
    },
    once() {},
  };
  return { req, res, jsonCalls };
}

describe('A3: Guard must not JSON-short-circuit AI routes', () => {
  afterEach(() => {
    try { fs.unlinkSync(AUDIT_FILE); } catch { /* ignore */ }
  });

  it('chat: identical bodies still call next; middleware never res.json', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    const guard = createAiGuard({ jwtSecret: 'test' });
    const body = { message: 'hello cache' };

    const first = mockHttp({ method: 'POST', path: '/api/chat', body });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    assert.equal(first.jsonCalls.length, 0);
    first.req.aiGuard.finalize({ status: 'ok', reason: 'stream_done', completionText: '<p>hi</p>' });

    const second = mockHttp({ method: 'POST', path: '/api/chat', body });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1);
    assert.equal(second.jsonCalls.length, 0);
  });

  it('answer_generate: Guard never res.json; handler owns SQLite cached_answer', async () => {
    process.env.AI_AUDIT_FILE_PATH = AUDIT_FILE;
    process.env.AI_REQUIRE_SIGNED_HEADERS = 'false';
    const guard = createAiGuard({ jwtSecret: 'test' });
    const body = { force: false };
    const reqPath = '/api/problems/42/answer/generate';

    const first = mockHttp({ method: 'POST', path: reqPath, body });
    let firstNext = 0;
    await guard.middleware(first.req, first.res, () => { firstNext += 1; });
    assert.equal(firstNext, 1);
    assert.equal(first.jsonCalls.length, 0);
    first.req.aiGuard.finalize({
      status: 'ok',
      reason: 'generated_answer',
      completionText: '<p>answer</p>',
      upstreamStatus: 200,
    });

    const second = mockHttp({ method: 'POST', path: reqPath, body });
    let secondNext = 0;
    await guard.middleware(second.req, second.res, () => { secondNext += 1; });
    assert.equal(secondNext, 1);
    assert.equal(second.jsonCalls.length, 0);
  });
});
