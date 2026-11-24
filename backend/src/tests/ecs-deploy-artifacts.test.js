/**
 * 阿里云 ECS 零编译部署资产与健康检查接口单元测试。
 * 覆盖：GET /api/health、PM2 500M 单实例配置、Nginx 多子域名与安全头基线、手动触发工作流约束。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRouteResponse,
  restoreTestEnv,
  saveTestEnv,
} from './prompt-budget-route-helpers.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');

const savedEnv = saveTestEnv();
let app;

/**
 * 经 Express app.handle 直接调用 GET /api/health（离线，不绑定端口）。
 */
function invokeHealth() {
  return new Promise((resolve, reject) => {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = '/api/health';
    req.path = '/api/health';
    req.originalUrl = '/api/health';
    req.headers = {
      'x-request-id': `health-test-${process.pid}`,
    };
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

    const res = createRouteResponse(resolve);
    app.handle(req, res, (error) => {
      if (error) reject(error);
      else if (!res.ended) resolve(res);
    });
  });
}

describe('阿里云 ECS 部署资产与健康检查基线', () => {
  before(async () => {
    process.env.BAGUJING_SKIP_LISTEN = '1';
    process.env.ENABLE_SQLITE = 'false';
    const mod = await import('../server-express.js');
    app = mod.app;
  });

  after(() => {
    restoreTestEnv(savedEnv);
  });

  it('GET /api/health 免鉴权返回 200 且对外使用 devask-api 标识', async () => {
    const res = await invokeHealth();
    assert.equal(res.statusCode, 200);
    assert.equal(res.getHeader('cache-control'), 'no-store');
    const jsonEntry = res.callOrder.find((entry) => entry.op === 'json');
    assert.ok(jsonEntry, '应通过 res.json 返回健康检查结果');
    assert.deepEqual(jsonEntry.payload, { ok: true, service: 'devask-api' });
    assert.doesNotMatch(JSON.stringify(jsonEntry.payload), /bagujing/i);
  });

  it('deploy/ecosystem.ecs.cjs 符合 2C2G 单实例 500M 上限与 B32 强制验签', () => {
    const eco = require(path.join(REPO_ROOT, 'deploy/ecosystem.ecs.cjs'));
    const entry = eco.apps.find((item) => item.name === 'bagujing-be-prod');
    assert.ok(entry, '缺少 bagujing-be-prod 应用定义');
    assert.equal(entry.instances, 1);
    assert.equal(entry.exec_mode, 'fork');
    assert.equal(entry.max_memory_restart, '500M');
    assert.equal(entry.env.AI_REQUIRE_SIGNED_HEADERS, 'true');
    assert.equal(entry.env_production.AI_REQUIRE_SIGNED_HEADERS, 'true');
    assert.equal(entry.env_production.DOTENV_CONFIG_PATH, '/var/lib/bagujing/.env.production');
  });

  it('deploy/nginx-ecs.conf 落实多子域名隔离、证书分离与安全加固基线', () => {
    const rawConf = fs.readFileSync(path.join(REPO_ROOT, 'deploy/nginx-ecs.conf'), 'utf8');
    const activeConf = rawConf
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.match(activeConf, /server_name\s+devask\.hanalice\.net;/);
    assert.doesNotMatch(activeConf, /default_server/);
    assert.match(activeConf, /server_tokens\s+off;/);
    assert.match(activeConf, /ssl_certificate\s+\/etc\/nginx\/ssl\/devask\.hanalice\.net\/fullchain\.pem;/);
    assert.match(activeConf, /ssl_certificate_key\s+\/etc\/nginx\/ssl\/devask\.hanalice\.net\/privkey\.key;/);
    assert.match(activeConf, /root\s+\/opt\/bagujing\/current\/frontend;/);
    assert.match(activeConf, /proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/);
    assert.match(activeConf, /location\s*=\s*\/api\/metrics[\s\S]*?allow\s+127\.0\.0\.1;[\s\S]*?deny\s+all;/);
    assert.match(activeConf, /proxy_buffering\s+off;/);
  });

  it('.github/workflows/deploy.yml 仅允许手动触发且在 Runner 完成打包', () => {
    const wf = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
    assert.match(wf, /workflow_dispatch:/);
    assert.doesNotMatch(wf, /\n\s+push:\s*\n/);
    assert.match(wf, /npm run build/);
    assert.match(wf, /prebuild-install -r napi --platform=linux --arch=x64/);
    assert.match(wf, /deploy-ecs\.sh/);
  });
});
