/**
 * S16：配置 AI_METRICS_TOKEN 时 /api/metrics 须校验令牌，未配置保持可匿名。
 * 用例 ID 对齐 docs/test_cases.md §2.47 / §3.25。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import {
  TEST_JWT_SECRET,
  configureRouteTestEnv,
  createRouteResponse,
  makeTestToken,
  removeTestFiles,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const METRICS_SECRET = 'metrics-secret-s16';
const ENV_KEY = 'AI_METRICS_TOKEN';

const savedEnv = saveTestEnv();
let savedMetricsToken;
let app;

/**
 * 扩展 createRouteResponse：补齐 Express res.set / res.send，便于 GET /api/metrics。
 * @param {(res: object) => void} resolve
 */
function createMetricsResponse(resolve) {
  const res = createRouteResponse(resolve);
  res.set = function set(name, value) {
    if (name && typeof name === 'object') {
      for (const [k, v] of Object.entries(name)) this.setHeader(k, v);
      return this;
    }
    this.setHeader(name, value);
    return this;
  };
  res.send = function send(body) {
    const text = body === undefined || body === null ? '' : String(body);
    this.callOrder.push({ op: 'send', body: text });
    return this.end(text);
  };
  return res;
}

/**
 * 经 app.handle 打真实 GET /api/metrics。
 * @param {{ authorization?: string, omitAuth?: boolean }} [options]
 */
function invokeMetrics(options = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/api/metrics';
    req.path = '/api/metrics';
    req.originalUrl = '/api/metrics';
    req.headers = {
      'x-request-id': `s16-metrics-${process.pid}`,
      'x-forwarded-for': '127.0.0.1',
    };
    if (options.authorization) {
      req.headers.authorization = options.authorization;
    }
    req.socket = { remoteAddress: '127.0.0.1' };
    req.ip = '127.0.0.1';
    req.query = {};
    req.header = function header(name) {
      return this.headers[String(name).toLowerCase()];
    };
    req.get = req.header;
    req.on = function on(event, listener) {
      if (event === 'close') return this;
      return Readable.prototype.on.call(this, event, listener);
    };
    req.once = function once(event, listener) {
      if (event === 'close') return this;
      return Readable.prototype.once.call(this, event, listener);
    };
    const res = createMetricsResponse(resolve);
    app.handle(req, res, (error) => {
      if (error) reject(error);
      else if (!res.ended) resolve(res);
    });
  });
}

/** 汇总响应正文（send / write / json）。 */
function responseBody(res) {
  const parts = [];
  for (const entry of res.callOrder) {
    if (entry.op === 'send' || entry.op === 'write') parts.push(String(entry.body ?? entry.data ?? ''));
    if (entry.op === 'json') parts.push(JSON.stringify(entry.payload ?? {}));
  }
  return parts.join('');
}

function contentType(res) {
  const raw = res.getHeader('content-type') ?? res.headers['content-type'] ?? '';
  return String(raw);
}

describe('S16: AI_METRICS_TOKEN 可选保护 /api/metrics', () => {
  before(async () => {
    savedMetricsToken = process.env[ENV_KEY];
    configureRouteTestEnv();
    delete process.env[ENV_KEY];
    await seedPromptBudgetDatabase();
    ({ app } = await import('../server-express.js'));
  });

  after(() => {
    restoreTestEnv(savedEnv);
    if (savedMetricsToken === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedMetricsToken;
    removeTestFiles();
  });

  beforeEach(() => {
    delete process.env[ENV_KEY];
  });

  it('UT-METRICS-01: 未配置：匿名 GET 200 且含 ai_guard_requests_total', async () => {
    delete process.env[ENV_KEY];
    const res = await invokeMetrics({ omitAuth: true });
    const body = responseBody(res);
    assert.equal(res.statusCode, 200);
    assert.ok(body.includes('ai_guard_requests_total'), '正文须含 ai_guard_requests_total');
    assert.notEqual(res.statusCode, 401);
  });

  it('UT-METRICS-02: 空字符串：与未配置同，可匿名', async () => {
    process.env[ENV_KEY] = '';
    const res = await invokeMetrics({ omitAuth: true });
    const body = responseBody(res);
    assert.equal(res.statusCode, 200);
    assert.ok(body.includes('ai_guard_requests_total'));
  });

  it('UT-METRICS-03: 已配置缺令牌：401 且无指标正文', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ omitAuth: true });
    const body = responseBody(res);
    assert.equal(res.statusCode, 401);
    assert.equal(body.includes('ai_guard_requests_total'), false);
  });

  it('UT-METRICS-04: 已配置错误 Bearer：401 且无指标正文', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ authorization: 'Bearer wrong-token' });
    const body = responseBody(res);
    assert.equal(res.statusCode, 401);
    assert.equal(body.includes('ai_guard_requests_total'), false);
  });

  it('UT-METRICS-05: 已配置正确 Bearer：200 且含 ai_guard_requests_total', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ authorization: `Bearer ${METRICS_SECRET}` });
    const body = responseBody(res);
    assert.equal(res.statusCode, 200);
    assert.match(contentType(res), /text\/plain/i);
    assert.ok(body.includes('ai_guard_requests_total'));
  });

  it('UT-METRICS-06: 登录 JWT 不得替代 metrics 令牌', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const loginJwt = makeTestToken(['chat_ai', 'study']);
    // 确认 JWT 本身可被当前 JWT_SECRET 验过，但字面 ≠ AI_METRICS_TOKEN
    assert.doesNotThrow(() => jwt.verify(loginJwt, TEST_JWT_SECRET));
    assert.notEqual(loginJwt, METRICS_SECRET);

    const res = await invokeMetrics({ authorization: `Bearer ${loginJwt}` });
    const body = responseBody(res);
    assert.equal(res.statusCode, 401);
    assert.equal(body.includes('ai_guard_requests_total'), false);
  });

  it('UT-METRICS-07: 不做：未配置不得强制鉴权；字段名不变', async () => {
    delete process.env[ENV_KEY];
    const res = await invokeMetrics({ omitAuth: true });
    const body = responseBody(res);
    assert.equal(res.statusCode, 200);
    assert.ok(body.includes('ai_guard_requests_total'), '匿名仍须导出现网计数器名');
    assert.match(body, /ai_guard_tokens_total|ai_guard_errors_total|ai_guard_rejections_total/);
    // 不要求生产必须设变量、不连真 Prometheus
  });

  it('UT-METRICS-08: 可同步：env 名进入 example / 部署 §3（E17 方向）', () => {
    const example = fs.readFileSync(path.join(REPO_ROOT, 'backend/.env.example'), 'utf8');
    const deploy = fs.readFileSync(path.join(REPO_ROOT, 'docs/deployment-and-operations.md'), 'utf8');
    const serverSrc = fs.readFileSync(path.join(REPO_ROOT, 'backend/src/server-express.js'), 'utf8');

    assert.match(example, /^AI_METRICS_TOKEN=/m);
    assert.ok(
      /\| `AI_METRICS_TOKEN` \|/.test(deploy) || /\| AI_METRICS_TOKEN \|/.test(deploy),
      '部署文档 §3 表第一列须含 AI_METRICS_TOKEN',
    );
    assert.ok(
      serverSrc.includes('process.env.AI_METRICS_TOKEN'),
      '源码须读取 process.env.AI_METRICS_TOKEN',
    );
  });

  it('UT-METRICS-09: residual：公开文档可不写利用步骤；默认仍开放', () => {
    const guardDoc = fs.readFileSync(path.join(REPO_ROOT, 'docs/security-ai-guard.md'), 'utf8');
    if (guardDoc.includes('AI_METRICS_TOKEN')) {
      const idx = guardDoc.indexOf('AI_METRICS_TOKEN');
      const window = guardDoc.slice(Math.max(0, idx - 120), idx + 200);
      assert.ok(/可选|未设|空串|可匿名/.test(window), '提及 AI_METRICS_TOKEN 时须写明可选/未设可匿名');
      assert.equal(/生产必须配置|强制配置 AI_METRICS_TOKEN/.test(window), false);
    }
    // 公开文档不写绕过令牌步骤；默认开放属 residual
    assert.equal(/绕过.*AI_METRICS_TOKEN|伪造 metrics 令牌步骤/.test(guardDoc), false);
  });

  it('MON-01: 未配置令牌：匿名导出含 ai_guard_requests_total', async () => {
    delete process.env[ENV_KEY];
    const res = await invokeMetrics({ omitAuth: true });
    assert.equal(res.statusCode, 200);
    assert.ok(responseBody(res).includes('ai_guard_requests_total'));
  });

  it('SEC-METRICS-01: 已配置：无 Authorization → 401 无指标泄露', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ omitAuth: true });
    const body = responseBody(res);
    assert.equal(res.statusCode, 401);
    assert.equal(body.includes('ai_guard_requests_total'), false);
    assert.equal(/ai_guard_\w+_total\s+\d+/.test(body), false);
  });

  it('SEC-METRICS-02: 已配置：错误 Bearer → 401 无指标泄露', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ authorization: 'Bearer not-the-metrics-token' });
    assert.equal(res.statusCode, 401);
    assert.equal(responseBody(res).includes('ai_guard_requests_total'), false);
  });

  it('SEC-METRICS-03: 已配置：正确 Bearer → 200 含计数器', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ authorization: `Bearer ${METRICS_SECRET}` });
    assert.equal(res.statusCode, 200);
    assert.match(contentType(res), /text\/plain/i);
    assert.ok(responseBody(res).includes('ai_guard_requests_total'));
  });

  it('IT-METRICS-01: 登录 JWT 不能充当 metrics 令牌', async () => {
    process.env[ENV_KEY] = METRICS_SECRET;
    const res = await invokeMetrics({ authorization: `Bearer ${makeTestToken()}` });
    assert.equal(res.statusCode, 401);
    assert.equal(responseBody(res).includes('ai_guard_requests_total'), false);
  });

  it('IT-METRICS-02: 不做 / residual 边界', () => {
    // PASS 不要求未配置强制鉴权、改字段名、生产强制设变量、真 Prometheus；
    // 生产设令牌与网络隔离属运维；公开用例不写绕过步骤。
    assert.ok(true);
  });
});
