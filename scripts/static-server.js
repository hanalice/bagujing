#!/usr/bin/env node

/*
  Static HTTP server with configurable caching.

  Env vars (defaults match pm2 serve env names):
  - PM2_SERVE_PATH: directory to serve (default: ./dist)
  - PM2_SERVE_PORT: port to listen on (default: 8080)
  - PM2_SERVE_SPA: "true" to enable SPA fallback to /index.html
  - PM2_SERVE_HOST: host to listen on (default: 0.0.0.0)

  Extra options:
  - STATIC_CACHE_HTML: Cache-Control for HTML (default: no-cache)
  - STATIC_CACHE_ASSETS: Cache-Control for hashed assets (default: public, max-age=31536000, immutable)
  - STATIC_CACHE_DEFAULT: Cache-Control for other files (default: public, max-age=3600)
  - STATIC_PRECOMPRESSED: "true" to serve .br/.gz when available (default: true)
  - STATIC_DOTFILES: "deny" | "allow" (default: deny)
  - STATIC_SECURITY_HEADERS: "true" to add basic security headers (default: true)
  - STATIC_CSP: override full CSP string (set to "off" to disable)
  - STATIC_CSP_CONNECT_SRC: extra connect-src origins (space or comma separated)
  - STATIC_CSP_REPORT_ONLY: "true" to emit Content-Security-Policy-Report-Only

  API proxy options:
  - STATIC_API_PROXY_ENABLED: "true" to enable reverse proxy for prefix (default: false)
  - STATIC_API_PROXY_PREFIX: path prefix to proxy (default: /api)
  - STATIC_API_PROXY_TARGET: backend base URL (required when enabled)

  API proxy timeouts:
  - STATIC_API_PROXY_TOTAL_TIMEOUT_MS: total timeout for normal API (default: 30000)
  - STATIC_API_PROXY_TTFB_TIMEOUT_MS: time-to-first-byte timeout (default: 15000)
  - STATIC_API_PROXY_IDLE_TIMEOUT_MS: idle timeout for SSE streams (default: 65000)

  SSL options:
  - STATIC_SSL_CERT: path to SSL certificate (optional)
  - STATIC_SSL_KEY: path to SSL private key (optional, can be same as cert if PEM contains both)
*/

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { URL } = require('node:url');

const PROCESS_NAME = process.env.STATIC_PROCESS_NAME || 'proxy';
const LOG_LEVEL = String(process.env.STATIC_LOG_LEVEL || 'info').toLowerCase();
const LOG_FILE_PATH = path.join(__dirname, process.env.STATIC_LOG_FILE || 'static-server.log');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function shouldLog(level) {
  const current = LEVELS[LOG_LEVEL] ?? LEVELS.info;
  const incoming = LEVELS[level] ?? LEVELS.info;
  return incoming >= current;
}

const logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: 'a' });
logStream.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('[static][logger] failed to write log file:', err && err.stack ? err.stack : err);
});

function formatError(err) {
  if (!err) return undefined;
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: String(err) };
}

function logEvent(level, message, meta) {
  if (!shouldLog(level)) return;

  const entry = {
    time: new Date().toISOString(),
    process: PROCESS_NAME,
    pid: process.pid,
    level,
    message,
    ...(meta ? { meta } : null),
  };

  const line = `${JSON.stringify(entry)}\n`;
  try {
    logStream.write(line);
  } catch {
    // ignore
  }

  if (level !== 'debug') {
    // eslint-disable-next-line no-console
    console.log(`[static][${level}]`, message);
  }
}

process.on('uncaughtException', (err) => {
  logEvent('error', 'uncaughtException', { error: formatError(err) });
});
process.on('unhandledRejection', (reason) => {
  logEvent('error', 'unhandledRejection', { error: formatError(reason) });
});

let REQUEST_SEQ = 0;
function nextRequestId() {
  REQUEST_SEQ += 1;
  return REQUEST_SEQ;
}

const ROOT = path.resolve(process.env.PM2_SERVE_PATH || './dist');
const PORT = Number.parseInt(process.env.PM2_SERVE_PORT || '8080', 10);
const HOST = process.env.PM2_SERVE_HOST || '0.0.0.0';
const SPA = String(process.env.PM2_SERVE_SPA || '').toLowerCase() === 'true';

const CACHE_HTML = process.env.STATIC_CACHE_HTML || 'no-cache';
const CACHE_ASSETS = process.env.STATIC_CACHE_ASSETS || 'public, max-age=31536000, immutable';
const CACHE_DEFAULT = process.env.STATIC_CACHE_DEFAULT || 'public, max-age=3600';

const PRECOMPRESSED = (process.env.STATIC_PRECOMPRESSED || 'true').toLowerCase() === 'true';
const DOTFILES = (process.env.STATIC_DOTFILES || 'deny').toLowerCase();
const SECURITY_HEADERS = (process.env.STATIC_SECURITY_HEADERS || 'true').toLowerCase() === 'true';

const CSP_OVERRIDE = process.env.STATIC_CSP;
const CSP_CONNECT_EXTRA = process.env.STATIC_CSP_CONNECT_SRC;
const CSP_REPORT_ONLY = (process.env.STATIC_CSP_REPORT_ONLY || 'false').toLowerCase() === 'true';

const API_PROXY_ENABLED = (process.env.STATIC_API_PROXY_ENABLED || 'false').toLowerCase() === 'true';
const API_PROXY_PREFIX_RAW = process.env.STATIC_API_PROXY_PREFIX || '/api';
const API_PROXY_TARGET_RAW = process.env.STATIC_API_PROXY_TARGET;

const API_PROXY_TOTAL_TIMEOUT_MS = Number.parseInt(process.env.STATIC_API_PROXY_TOTAL_TIMEOUT_MS || '30000', 10);
const API_PROXY_TTFB_TIMEOUT_MS = Number.parseInt(process.env.STATIC_API_PROXY_TTFB_TIMEOUT_MS || '15000', 10);
const API_PROXY_IDLE_TIMEOUT_MS = Number.parseInt(process.env.STATIC_API_PROXY_IDLE_TIMEOUT_MS || '65000', 10);

function normalizePrefix(prefix) {
  let p = String(prefix || '').trim();
  if (!p) p = '/api';
  if (!p.startsWith('/')) p = `/${p}`;
  if (p.length > 1 && p.endsWith('/')) p = p.replace(/\/+$/, '');
  return p;
}

const API_PROXY_PREFIX = normalizePrefix(API_PROXY_PREFIX_RAW);
const API_PROXY_TARGET = API_PROXY_ENABLED && API_PROXY_TARGET_RAW ? new URL(API_PROXY_TARGET_RAW) : null;

function isApiPath(pathname) {
  if (!API_PROXY_ENABLED || !API_PROXY_PREFIX) return false;
  if (pathname === API_PROXY_PREFIX) return true;
  return pathname.startsWith(`${API_PROXY_PREFIX}/`);
}

function shouldDropHeader(name) {
  const n = String(name || '').toLowerCase();
  return (
    n === 'connection' ||
    n === 'keep-alive' ||
    n === 'proxy-authenticate' ||
    n === 'proxy-authorization' ||
    n === 'te' ||
    n === 'trailer' ||
    n === 'transfer-encoding' ||
    n === 'upgrade'
  );
}

function buildUpstreamRequestHeaders(req, upstreamUrl) {
  const headers = { ...req.headers };

  // Drop hop-by-hop headers
  const connectionHeader = headers.connection;
  Object.keys(headers).forEach((k) => {
    if (shouldDropHeader(k)) delete headers[k];
  });
  if (connectionHeader) {
    String(connectionHeader)
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
      .forEach((h) => {
        delete headers[h];
      });
  }

  // Host strategy: use upstream host, preserve original in X-Forwarded-Host
  const originalHost = headers.host;
  headers.host = upstreamUrl.host;

  const remote = req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '';
  const xff = headers['x-forwarded-for'];
  headers['x-forwarded-for'] = xff ? `${xff}, ${remote}` : remote;

  const xfProto = headers['x-forwarded-proto'] || 'http';
  headers['x-forwarded-proto'] = xfProto;
  if (originalHost) headers['x-forwarded-host'] = String(originalHost);

  return headers;
}

function buildProxyResponseHeaders(upstreamHeaders) {
  const headers = { ...upstreamHeaders };
  Object.keys(headers).forEach((k) => {
    if (shouldDropHeader(k)) delete headers[k];
  });

  // Ensure /api responses are never cached
  delete headers.etag;
  delete headers['last-modified'];
  delete headers.expires;
  headers['cache-control'] = 'no-store';
  headers.pragma = 'no-cache';
  headers.expires = '0';

  return headers;
}

function sendApiError(res, statusCode, message) {
  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    Expires: '0',
  };
  send(res, statusCode, headers, message);
}

function isSseContentType(contentType) {
  return String(contentType || '').toLowerCase().includes('text/event-stream');
}

async function proxyRequest(req, res) {
  if (!API_PROXY_TARGET) {
    logEvent('error', 'proxy.missing_target', { target: API_PROXY_TARGET_RAW || null });
    sendApiError(res, 502, 'Bad Gateway');
    return;
  }

  const requestId = nextRequestId();
  const startedAt = Date.now();

  let upstreamUrl;
  try {
    upstreamUrl = new URL(req.url || '/', API_PROXY_TARGET);
  } catch {
    logEvent('warn', 'proxy.bad_request_url', { requestId, url: req.url || null });
    sendApiError(res, 400, 'Bad Request');
    return;
  }

  logEvent('info', 'proxy.start', {
    requestId,
    method: req.method,
    url: req.url,
    target: API_PROXY_TARGET.origin,
  });

  const transport = upstreamUrl.protocol === 'https:' ? https : http;

  let finished = false;
  const finish = () => {
    finished = true;
  };

  let ttfbTimer;
  let totalTimer;
  let idleTimer;

  const clearTimers = () => {
    if (ttfbTimer) clearTimeout(ttfbTimer);
    if (totalTimer) clearTimeout(totalTimer);
    if (idleTimer) clearTimeout(idleTimer);
    ttfbTimer = undefined;
    totalTimer = undefined;
    idleTimer = undefined;
  };

  const abortWith = (statusCode, msg, upstreamReq) => {
    if (finished) return;
    clearTimers();
    try {
      if (upstreamReq) upstreamReq.destroy();
    } catch {
      // ignore
    }
    logEvent(statusCode >= 500 ? 'warn' : 'info', 'proxy.abort', {
      requestId,
      statusCode,
      reason: msg,
      durationMs: Date.now() - startedAt,
    });

    if (!res.headersSent) sendApiError(res, statusCode, msg);
    else res.destroy();
    finish();
  };

  const upstreamReq = transport.request(
    {
      protocol: upstreamUrl.protocol,
      hostname: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: req.method,
      path: `${upstreamUrl.pathname}${upstreamUrl.search}`,
      headers: buildUpstreamRequestHeaders(req, upstreamUrl),
    },
    (upstreamRes) => {
      if (finished) {
        upstreamRes.resume();
        return;
      }

      if (ttfbTimer) {
        clearTimeout(ttfbTimer);
        ttfbTimer = undefined;
      }

      const isSse = isSseContentType(upstreamRes.headers['content-type']);

      logEvent('info', 'proxy.upstream_response', {
        requestId,
        statusCode: upstreamRes.statusCode || 0,
        contentType: upstreamRes.headers['content-type'] || null,
        isSse,
      });

      if (isSse) {
        if (totalTimer) {
          clearTimeout(totalTimer);
          totalTimer = undefined;
        }

        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          if (Number.isFinite(API_PROXY_IDLE_TIMEOUT_MS) && API_PROXY_IDLE_TIMEOUT_MS > 0) {
            idleTimer = setTimeout(() => {
              logEvent('warn', 'proxy.sse_idle_timeout', { requestId, idleTimeoutMs: API_PROXY_IDLE_TIMEOUT_MS });
              abortWith(504, 'Gateway Timeout', upstreamReq);
            }, API_PROXY_IDLE_TIMEOUT_MS);
          }
        };

        resetIdle();
        upstreamRes.on('data', () => resetIdle());
        upstreamRes.on('end', () => clearTimers());
      }

      const headers = buildProxyResponseHeaders(upstreamRes.headers);
      res.writeHead(upstreamRes.statusCode || 502, headers);

      if (req.method === 'HEAD') {
        res.end();
        finish();
        clearTimers();
        upstreamRes.resume();
        logEvent('info', 'proxy.finish', { requestId, durationMs: Date.now() - startedAt, headOnly: true });
        return;
      }

      upstreamRes.pipe(res);
      upstreamRes.on('error', () => {
        logEvent('error', 'proxy.upstream_response_error', { requestId });
        abortWith(502, 'Bad Gateway', upstreamReq);
      });
      res.on('finish', () => {
        finish();
        clearTimers();
        logEvent('info', 'proxy.finish', { requestId, durationMs: Date.now() - startedAt });
      });
      res.on('close', () => {
        finish();
        clearTimers();
        logEvent('debug', 'proxy.res_close', { requestId });
      });
    }
  );

  // Client disconnect should abort upstream
  req.on('aborted', () => {
    clearTimers();
    logEvent('info', 'proxy.client_aborted', { requestId });
    try {
      upstreamReq.destroy();
    } catch {
      // ignore
    }
  });
  res.on('close', () => {
    clearTimers();
    logEvent('debug', 'proxy.client_close', { requestId });
    try {
      upstreamReq.destroy();
    } catch {
      // ignore
    }
  });

  upstreamReq.on('error', () => {
    logEvent('error', 'proxy.upstream_request_error', { requestId });
    abortWith(502, 'Bad Gateway', upstreamReq);
  });

  // TTFB timeout: must receive response headers within this window
  if (Number.isFinite(API_PROXY_TTFB_TIMEOUT_MS) && API_PROXY_TTFB_TIMEOUT_MS > 0) {
    ttfbTimer = setTimeout(() => {
      logEvent('warn', 'proxy.ttfb_timeout', { requestId, ttfbTimeoutMs: API_PROXY_TTFB_TIMEOUT_MS });
      abortWith(504, 'Gateway Timeout', upstreamReq);
    }, API_PROXY_TTFB_TIMEOUT_MS);
  }

  // Total timeout (normal API). If response turns out to be SSE, we cancel it when headers arrive.
  if (Number.isFinite(API_PROXY_TOTAL_TIMEOUT_MS) && API_PROXY_TOTAL_TIMEOUT_MS > 0) {
    totalTimer = setTimeout(() => {
      logEvent('warn', 'proxy.total_timeout', { requestId, totalTimeoutMs: API_PROXY_TOTAL_TIMEOUT_MS });
      abortWith(504, 'Gateway Timeout', upstreamReq);
    }, API_PROXY_TOTAL_TIMEOUT_MS);
  }

  // Stream request body
  if (req.method === 'GET' || req.method === 'HEAD') {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
}

function log(...args) {
  logEvent(
    'info',
    args
      .map((a) => {
        if (a instanceof Error) return a.stack || a.message;
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
  );
}

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  if (body && res.req && res.req.method !== 'HEAD') res.end(body);
  else res.end();
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.map':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.gif':
      return 'image/gif';
    case '.ico':
      return 'image/x-icon';
    case '.txt':
      return 'text/plain; charset=utf-8';
    case '.xml':
      return 'application/xml; charset=utf-8';
    case '.woff':
      return 'font/woff';
    case '.woff2':
      return 'font/woff2';
    case '.ttf':
      return 'font/ttf';
    case '.otf':
      return 'font/otf';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}

function isDotfile(relPath) {
  return relPath.split('/').some((seg) => seg.startsWith('.') && seg !== '.' && seg !== '..');
}

function cacheControlFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return CACHE_HTML;

  const base = path.basename(filePath);
  // Hashed asset names (supports Vite-style base64url-ish hashes):
  // - app.8d9f3c2a.js
  // - index-BB6N4ja_.css
  // - request-g3UMwPjg.js
  const looksHashed = /[.-][a-z0-9_-]{7,}(?=\.|$)/i.test(base);
  if (looksHashed) return CACHE_ASSETS;

  return CACHE_DEFAULT;
}

function addSecurityHeaders(headers) {
  if (!SECURITY_HEADERS) return headers;

  let csp;
  if (CSP_OVERRIDE && ['off', 'false', '0'].includes(String(CSP_OVERRIDE).trim().toLowerCase())) {
    csp = undefined;
  } else if (CSP_OVERRIDE && String(CSP_OVERRIDE).trim().length > 0) {
    csp = String(CSP_OVERRIDE).trim();
  } else {
    const extraConnect = String(CSP_CONNECT_EXTRA || '')
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    const connectSrc = [`'self'`, ...extraConnect].join(' ');
    csp = `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src ${connectSrc}; font-src 'self' data:; base-uri 'self'; frame-ancestors 'none'`;
  }

  const cspHeaderName = CSP_REPORT_ONLY ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';

  return {
    ...headers,
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    ...(csp ? { [cspHeaderName]: csp } : null),
  };
}

function weakEtag(stat) {
  // Weak ETag based on size+mtime; stable enough for static server.
  return `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
}

async function fileExists(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return st.isFile();
  } catch {
    return false;
  }
}

function pickPrecompressed(acceptEncoding, filePath) {
  if (!PRECOMPRESSED) return null;
  const ae = String(acceptEncoding || '');

  // Prefer br over gzip
  if (ae.includes('br')) return { path: `${filePath}.br`, encoding: 'br' };
  if (ae.includes('gzip')) return { path: `${filePath}.gz`, encoding: 'gzip' };
  return null;
}

async function serveFile(req, res, absPath) {
  let stat;
  try {
    stat = await fsp.stat(absPath);
  } catch {
    return false;
  }

  if (!stat.isFile()) return false;

  const etag = weakEtag(stat);
  const ifNoneMatch = req.headers['if-none-match'];
  const ifModifiedSince = req.headers['if-modified-since'];

  const lastModified = stat.mtime.toUTCString();

  // Cache validation
  if ((ifNoneMatch && ifNoneMatch === etag) || (ifModifiedSince && new Date(ifModifiedSince).getTime() >= stat.mtime.getTime())) {
    const headers = addSecurityHeaders({
      ETag: etag,
      'Last-Modified': lastModified,
      'Cache-Control': cacheControlFor(absPath),
      Vary: PRECOMPRESSED ? 'Accept-Encoding' : undefined,
    });

    // Remove undefined
    Object.keys(headers).forEach((k) => headers[k] === undefined && delete headers[k]);
    send(res, 304, headers);
    return true;
  }

  let fileToSend = absPath;
  let contentEncoding;

  const pre = pickPrecompressed(req.headers['accept-encoding'], absPath);
  if (pre && (await fileExists(pre.path))) {
    fileToSend = pre.path;
    contentEncoding = pre.encoding;
  }

  const headers = addSecurityHeaders({
    'Content-Type': contentTypeFor(absPath),
    'Content-Length': (await fsp.stat(fileToSend)).size,
    'Cache-Control': cacheControlFor(absPath),
    ETag: etag,
    'Last-Modified': lastModified,
    ...(contentEncoding ? { 'Content-Encoding': contentEncoding } : null),
    ...(PRECOMPRESSED ? { Vary: 'Accept-Encoding' } : null),
  });

  if (req.method === 'HEAD') {
    send(res, 200, headers);
    return true;
  }

  res.writeHead(200, headers);
  const stream = fs.createReadStream(fileToSend);
  stream.on('error', () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
  });
  stream.pipe(res);
  return true;
}

function safeJoin(root, urlPath) {
  const decoded = decodeURIComponent(urlPath);
  const clean = decoded.replaceAll('\0', '');

  // Normalize to POSIX separators first
  const rel = clean.replaceAll('\\', '/');
  const relNoLeading = rel.replace(/^\/+/, '');

  const abs = path.resolve(root, relNoLeading);
  if (!abs.startsWith(root + path.sep) && abs !== root) return null;
  return { abs, rel: relNoLeading };
}

async function handler(req, res) {
  if (!req.url) {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
    return;
  }

  // /api proxy (allow all methods, no caching)
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (isApiPath(requestUrl.pathname)) {
    logEvent('debug', 'proxy.route_match', { method: req.method, url: req.url, prefix: API_PROXY_PREFIX });
    await proxyRequest(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' }, 'Method Not Allowed');
    return;
  }

  let pathname = requestUrl.pathname;

  // Default document
  if (pathname.endsWith('/')) pathname += 'index.html';

  const joined = safeJoin(ROOT, pathname);
  if (!joined) {
    send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Bad Request');
    return;
  }

  if (DOTFILES !== 'allow' && isDotfile(joined.rel)) {
    send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
    return;
  }

  // Try exact file
  if (await serveFile(req, res, joined.abs)) return;

  // If path without extension, try directory index
  if (!path.extname(joined.abs)) {
    const asDirIndex = path.join(joined.abs, 'index.html');
    if (await serveFile(req, res, asDirIndex)) return;
  }

  // SPA fallback
  if (SPA) {
    const indexPath = path.join(ROOT, 'index.html');
    if (await serveFile(req, res, indexPath)) return;
  }

  send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Not Found');
}

async function main() {
  // Ensure root exists
  try {
    const st = await fsp.stat(ROOT);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    logEvent('error', 'root.invalid', { root: ROOT });
    process.exitCode = 1;
    return;
  }

  let server;
  let sslConfig = null;

  const sslCertPath = process.env.STATIC_SSL_CERT;
  const sslKeyPath = process.env.STATIC_SSL_KEY;

  if (sslCertPath) {
    try {
      const cert = fs.readFileSync(sslCertPath);
      const key = sslKeyPath ? fs.readFileSync(sslKeyPath) : cert;
      sslConfig = { cert, key };
    } catch (err) {
      logEvent('error', 'ssl.load.failed', { error: formatError(err), cert: sslCertPath, key: sslKeyPath });
    }
  }

  const requestHandler = (req, res) => {
    handler(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[static] Unhandled error:', err && err.stack ? err.stack : err);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(res, 500, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Internal Server Error');
    });
  };

  if (sslConfig) {
    server = https.createServer(sslConfig, requestHandler);
  } else {
    server = http.createServer(requestHandler);
  }

  server.listen(PORT, HOST, () => {
    logEvent('info', 'server.listen', {
      root: ROOT,
      host: HOST,
      port: PORT,
      protocol: sslConfig ? 'https' : 'http',
      spa: SPA,
      precompressed: PRECOMPRESSED,
      apiProxyEnabled: API_PROXY_ENABLED,
      apiProxyPrefix: API_PROXY_PREFIX,
      apiProxyTarget: API_PROXY_TARGET ? API_PROXY_TARGET.origin : null,
      logFile: LOG_FILE_PATH,
    });
  });

  const shutdown = (signal) => {
    logEvent('info', 'server.shutdown', { signal });
    server.close(() => {
      process.exit(0);
    });
    // Force exit if stuck
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
