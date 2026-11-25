import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { createAiGuard } from '../security/ai-guard.js';

function mockOptionsRequest({ origin = 'http://localhost', requestMethod = 'POST', requestHeaders = 'authorization, content-type' } = {}) {
  const headers = {
    origin,
    'access-control-request-method': requestMethod,
    'access-control-request-headers': requestHeaders,
  };
  const responseHeaders = {};
  const req = {
    method: 'OPTIONS',
    headers,
    header(name) {
      return headers[String(name).toLowerCase()];
    },
    get(name) {
      return headers[String(name).toLowerCase()];
    },
  };
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      responseHeaders[String(name).toLowerCase()] = value;
      return this;
    },
    getHeader(name) {
      return responseHeaders[String(name).toLowerCase()];
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    send() {
      this.ended = true;
      return this;
    },
  };
  return { req, res, responseHeaders };
}

describe('2.11 CORS 跨域预检与允许请求头契约 (B4 / P2-1)', () => {
  it('UT-CORS-01: corsOptions 配置显式包含 Authorization 与 S19 页头', () => {
    const guard = createAiGuard();
    const { allowedHeaders, methods } = guard.corsOptions;

    assert.ok(Array.isArray(allowedHeaders), 'allowedHeaders 必须是数组');
    assert.ok(allowedHeaders.includes('Authorization'), 'allowedHeaders 必须精确包含 "Authorization"');

    const requiredHeaders = [
      'Content-Type',
      'Accept',
      'Authorization',
      'X-Request-Id',
      'X-Client-Id',
      'X-Client-Token',
      'X-Ts',
      'X-Nonce',
      'X-Signature',
      'X-Body-Sha256',
      'X-Maf-Mission-Id',
      'X-Page-Path',
      'X-Page-Title',
      'X-User-Id',
    ];
    for (const h of requiredHeaders) {
      assert.ok(allowedHeaders.includes(h), `allowedHeaders 必须保留必要头: ${h}`);
    }

    assert.ok(Array.isArray(methods), 'methods 必须是数组');
    assert.ok(methods.includes('GET'), 'methods 必须包含 GET');
    assert.ok(methods.includes('POST'), 'methods 必须包含 POST');
    assert.ok(methods.includes('OPTIONS'), 'methods 必须包含 OPTIONS');
  });

  it('UT-CORS-02: 白名单 Origin 预检 Authorization 放行', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
    try {
      const guard = createAiGuard();
      const corsMiddleware = cors(guard.corsOptions);

      const { req, res, responseHeaders } = mockOptionsRequest({
        origin: 'http://localhost',
        requestMethod: 'POST',
        requestHeaders: 'authorization, content-type',
      });

      let nextError = null;
      await new Promise((resolve) => {
        corsMiddleware(req, res, (err) => {
          nextError = err;
          resolve();
        });
        if (res.ended) resolve();
      });

      assert.equal(nextError, null, '不应抛出 CORS 错误');
      assert.ok(res.statusCode === 204 || res.statusCode === 200, `预检状态码应为 204 或 200, 实际为: ${res.statusCode}`);
      assert.equal(responseHeaders['access-control-allow-origin'], 'http://localhost');
      assert.ok(responseHeaders['access-control-allow-headers'], '应包含 Access-Control-Allow-Headers');
      const allowHeadersLower = String(responseHeaders['access-control-allow-headers']).toLowerCase();
      assert.ok(allowHeadersLower.includes('authorization'), 'Access-Control-Allow-Headers 应包含 authorization');
      assert.ok(responseHeaders['access-control-allow-methods'].includes('POST'), 'Access-Control-Allow-Methods 应包含 POST');
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });

  it('UT-CORS-03: 混合签名头与 Authorization 预检联合放行', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
    try {
      const guard = createAiGuard();
      const corsMiddleware = cors(guard.corsOptions);

      const requestedHeaders = 'authorization, x-signature, x-client-id, x-ts, x-nonce, content-type';
      const { req, res, responseHeaders } = mockOptionsRequest({
        origin: 'http://localhost',
        requestMethod: 'POST',
        requestHeaders: requestedHeaders,
      });

      let nextError = null;
      await new Promise((resolve) => {
        corsMiddleware(req, res, (err) => {
          nextError = err;
          resolve();
        });
        if (res.ended) resolve();
      });

      assert.equal(nextError, null, '不应抛出 CORS 错误');
      assert.ok(res.statusCode === 204 || res.statusCode === 200, `状态码应为 204 或 200`);
      const allowHeaders = String(responseHeaders['access-control-allow-headers']).toLowerCase();
      for (const h of ['authorization', 'x-signature', 'x-client-id', 'x-ts', 'x-nonce', 'content-type']) {
        assert.ok(allowHeaders.includes(h), `Access-Control-Allow-Headers 应包含 ${h}`);
      }
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });

  it('UT-CORS-04: 非法 Origin 跨域预检拦截', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost';
    try {
      const guard = createAiGuard();
      const corsMiddleware = cors(guard.corsOptions);

      const { req, res, responseHeaders } = mockOptionsRequest({
        origin: 'http://unauthorized-domain.com',
        requestMethod: 'POST',
        requestHeaders: 'authorization',
      });

      let corsError = null;
      await new Promise((resolve) => {
        corsMiddleware(req, res, (err) => {
          corsError = err;
          resolve();
        });
        if (res.ended) resolve();
      });

      assert.ok(corsError instanceof Error, '应触发 CORS 校验错误');
      assert.equal(corsError.message, 'Not allowed by CORS');
      assert.equal(responseHeaders['access-control-allow-origin'], undefined, '不应设置 Access-Control-Allow-Origin');
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });

  it('UT-CORS-05: S19：页头三件套预检放行', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
    try {
      const guard = createAiGuard();
      const corsMiddleware = cors(guard.corsOptions);

      const { req, res, responseHeaders } = mockOptionsRequest({
        origin: 'http://localhost',
        requestMethod: 'POST',
        requestHeaders: 'x-page-path, x-page-title, x-user-id, content-type',
      });

      let nextError = null;
      await new Promise((resolve) => {
        corsMiddleware(req, res, (err) => {
          nextError = err;
          resolve();
        });
        if (res.ended) resolve();
      });

      assert.equal(nextError, null, '不应抛出 CORS 错误');
      assert.ok(res.statusCode === 204 || res.statusCode === 200, `状态码应为 204 或 200, 实际为: ${res.statusCode}`);
      const allowHeaders = String(responseHeaders['access-control-allow-headers'] || '').toLowerCase();
      for (const h of ['x-page-path', 'x-page-title', 'x-user-id']) {
        assert.ok(allowHeaders.includes(h), `Access-Control-Allow-Headers 应包含 ${h}`);
      }
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });

  it('UT-CORS-06: S19：页头 + Authorization + 签名头联合预检', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost,http://127.0.0.1';
    try {
      const guard = createAiGuard();
      const corsMiddleware = cors(guard.corsOptions);

      const requestedHeaders = 'authorization, x-page-path, x-page-title, x-user-id, x-signature, x-client-id, content-type';
      const { req, res, responseHeaders } = mockOptionsRequest({
        origin: 'http://localhost',
        requestMethod: 'POST',
        requestHeaders: requestedHeaders,
      });

      let nextError = null;
      await new Promise((resolve) => {
        corsMiddleware(req, res, (err) => {
          nextError = err;
          resolve();
        });
        if (res.ended) resolve();
      });

      assert.equal(nextError, null, '不应抛出 CORS 错误');
      assert.ok(res.statusCode === 204 || res.statusCode === 200);
      const allowHeaders = String(responseHeaders['access-control-allow-headers'] || '').toLowerCase();
      for (const h of ['authorization', 'x-page-path', 'x-page-title', 'x-user-id', 'x-signature', 'x-client-id', 'content-type']) {
        assert.ok(allowHeaders.includes(h), `Access-Control-Allow-Headers 应包含 ${h}`);
      }
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });
});

describe('3.4 CORS 跨域直连与反代配置验证 (B4 / P2-1)', () => {
  it('IT-CORS-01: 跨域 OPTIONS 预检后发起携带 Authorization 的 POST 请求', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost';
    try {
      const guard = createAiGuard();
      const app = express();
      app.use(cors(guard.corsOptions));
      app.use(express.json());

      let postHandlerReached = false;
      let receivedAuthHeader = null;
      app.post('/api/chat', (req, res) => {
        postHandlerReached = true;
        receivedAuthHeader = req.headers['authorization'];
        res.status(200).json({ ok: true });
      });

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        // Step 1: OPTIONS /api/chat
        const optRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, content-type',
          },
        });

        assert.ok(optRes.status === 204 || optRes.status === 200, 'Step 1 预检响应码应为 204/200');
        assert.equal(optRes.headers.get('access-control-allow-origin'), 'http://localhost');
        const allowHeaders = optRes.headers.get('access-control-allow-headers') || '';
        assert.ok(allowHeaders.toLowerCase().includes('authorization'), '预检响应头应包含 authorization');

        // Step 2: POST /api/chat
        const postRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            Authorization: 'Bearer mock-jwt-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: 'hello' }),
        });

        assert.equal(postRes.status, 200);
        assert.equal(postRes.headers.get('access-control-allow-origin'), 'http://localhost');
        assert.equal(postHandlerReached, true, 'POST 请求应正常进入下游 handler');
        assert.equal(receivedAuthHeader, 'Bearer mock-jwt-token', '下游应正常接收 Authorization 请求头');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });

  it('IT-CORS-02: Nginx 反代配置签名头与 Authorization 透传合规性', () => {
    const nginxConfPath = path.resolve(import.meta.dirname, '../../../deploy/nginx.conf');
    assert.ok(fs.existsSync(nginxConfPath), 'deploy/nginx.conf 文件应存在');

    const content = fs.readFileSync(nginxConfPath, 'utf8');

    // 1. proxy_pass 正常转发至本地 Node.js 集群
    assert.ok(content.includes('location /api/'), 'Nginx 配置应包含 location /api/');
    assert.ok(content.includes('proxy_pass http://127.0.0.1:3000;'), 'Nginx 配置应包含 proxy_pass http://127.0.0.1:3000;');

    // 2. 不存在显式清空或覆盖 Authorization、X-Signature、X-Client-Id 等关键请求头
    const sensitiveHeaders = [
      'Authorization',
      'X-Signature',
      'X-Client-Id',
      'X-Client-Token',
      'X-Ts',
      'X-Nonce',
      'X-Body-Sha256',
    ];
    for (const header of sensitiveHeaders) {
      const clearDirective = new RegExp(`proxy_set_header\\s+${header}\\s+["']?\\s*["']?;`, 'i');
      assert.equal(clearDirective.test(content), false, `Nginx 配置不得显式清空 ${header} 请求头`);
    }
  });

  it('IT-CORS-03: S19：预检放行页头后 POST 可携带 X-Page-* / X-User-Id', async () => {
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost';
    try {
      const guard = createAiGuard();
      const app = express();
      app.use(cors(guard.corsOptions));
      app.use(express.json());

      let postHandlerReached = false;
      let receivedPagePath = null;
      let postWithoutPageReached = false;
      app.post('/api/chat', (req, res) => {
        if (req.headers['x-page-path']) {
          postHandlerReached = true;
          receivedPagePath = req.headers['x-page-path'];
        } else {
          postWithoutPageReached = true;
        }
        res.status(200).json({ ok: true });
      });

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const optRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'authorization, x-page-path, x-page-title, x-user-id, content-type',
          },
        });
        assert.ok(optRes.status === 204 || optRes.status === 200);
        const allowHeaders = (optRes.headers.get('access-control-allow-headers') || '').toLowerCase();
        for (const h of ['authorization', 'x-page-path', 'x-page-title', 'x-user-id']) {
          assert.ok(allowHeaders.includes(h), `预检 Allow-Headers 应含 ${h}`);
        }

        // 注：undici fetch 要求头值为 ByteString，中文页标题由 mockHttp 单测覆盖
        const postRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            Authorization: 'Bearer mock-jwt-token',
            'Content-Type': 'application/json',
            'X-Page-Path': '/assistant',
            'X-Page-Title': 'DevAsk-Assistant',
            'X-User-Id': 'guest-it',
          },
          body: JSON.stringify({ message: 'hello-page' }),
        });
        assert.equal(postRes.status, 200);
        assert.equal(postRes.headers.get('access-control-allow-origin'), 'http://localhost');
        assert.equal(postHandlerReached, true);
        assert.equal(receivedPagePath, '/assistant');

        // 对照：缺 X-Page-Path 仍可进入下游（页头非鉴权）
        const postNoPage = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            Authorization: 'Bearer mock-jwt-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ message: 'no-page' }),
        });
        assert.equal(postNoPage.status, 200);
        assert.equal(postWithoutPageReached, true);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });

  it('IT-AUDIT-PAGE-03: CORS 预检三页头 + 真实 POST 不拦', async () => {
    // 与 IT-CORS-03 / UT-CORS-05/06 合取：OPTIONS 放行三页头后 POST 不因 CORS 失败
    const prevOrigins = process.env.AI_ALLOWED_ORIGINS;
    process.env.AI_ALLOWED_ORIGINS = 'http://localhost';
    try {
      const guard = createAiGuard();
      const app = express();
      app.use(cors(guard.corsOptions));
      app.use(express.json());
      app.post('/api/chat', (_req, res) => res.status(200).json({ ok: true }));

      const server = http.createServer(app);
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      const baseUrl = `http://127.0.0.1:${port}`;

      try {
        const optRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'OPTIONS',
          headers: {
            Origin: 'http://localhost',
            'Access-Control-Request-Method': 'POST',
            'Access-Control-Request-Headers': 'x-page-path, x-page-title, x-user-id, content-type',
          },
        });
        assert.ok(optRes.status === 204 || optRes.status === 200);
        const allowHeaders = (optRes.headers.get('access-control-allow-headers') || '').toLowerCase();
        for (const h of ['x-page-path', 'x-page-title', 'x-user-id']) {
          assert.ok(allowHeaders.includes(h));
        }

        const postRes = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: {
            Origin: 'http://localhost',
            'Content-Type': 'application/json',
            'X-Page-Path': '/assistant',
            'X-Page-Title': 'DevAsk-Assistant',
            'X-User-Id': 'guest-it',
          },
          body: JSON.stringify({ message: 'it-page-03' }),
        });
        assert.equal(postRes.status, 200);
        assert.equal(postRes.headers.get('access-control-allow-origin'), 'http://localhost');
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    } finally {
      process.env.AI_ALLOWED_ORIGINS = prevOrigins;
    }
  });
});
