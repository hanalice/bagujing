/**
 * B32：生产 PM2 打开签名开关，代码默认仍为 false。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('B32 生产签名开关', () => {
  it('UT-B32-01: PM2 生产环境强制 AI_REQUIRE_SIGNED_HEADERS=true', () => {
    const eco = require(path.join(root, 'ecosystem.config.example.cjs'));
    const app = eco.apps.find((item) => item.name === 'bagujing-be-prod');
    assert.ok(app, '缺少 bagujing-be-prod');
    assert.equal(app.env.AI_REQUIRE_SIGNED_HEADERS, 'true');
    assert.equal(app.env_production.AI_REQUIRE_SIGNED_HEADERS, 'true');
  });

  it('UT-B32-02: ai-guard 未设置环境变量时仍回退 false', () => {
    const src = fs.readFileSync(path.join(root, 'backend/src/security/ai-guard.js'), 'utf8');
    assert.match(src, /AI_REQUIRE_SIGNED_HEADERS\s*\?\?\s*'false'/);
  });
});
