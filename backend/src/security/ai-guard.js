import fs from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import Redis from 'ioredis';
import { updateMissionTokens } from '../db/maf-repo.js';

console.log('AI_GUARD_MODULE_LOADED_VERSION_001');

const JWT_EXPIRES_IN = '1h';

const parseIntSafe = (value, fallback) => {
  // ... existing parseIntSafe ...
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseCsvSet = (value) => {
  return new Set(
    String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );
};

const safeParseUrl = (value) => {
  try {
    return new URL(String(value));
  } catch {
    return null;
  }
};

const defaultPortByProtocol = (protocol) => {
  if (protocol === 'http:') return '80';
  if (protocol === 'https:') return '443';
  return '';
};

const normalizePort = (protocol, port) => {
  if (port) return String(port);
  return defaultPortByProtocol(protocol);
};

const parseOriginRule = (ruleRaw) => {
  const rule = String(ruleRaw ?? '').trim();
  if (!rule) return null;
  if (rule === '*') return { type: 'any' };

  const wildcardPort = rule.endsWith(':*');
  const rawForParse = wildcardPort ? rule.slice(0, -2) : rule;
  const parsed = safeParseUrl(rawForParse);
  if (!parsed) return null;

  return {
    type: 'origin',
    protocol: parsed.protocol,
    hostname: parsed.hostname.toLowerCase(),
    port: wildcardPort ? '*' : (parsed.port || ''),
  };
};

const isOriginAllowed = (origin, rules) => {
  if (!origin) return true;
  if (!Array.isArray(rules) || rules.length === 0) return true;

  const target = safeParseUrl(origin);
  if (!target) return false;

  const targetProtocol = target.protocol;
  const targetHostname = target.hostname.toLowerCase();
  const targetPort = normalizePort(targetProtocol, target.port);

  for (const rule of rules) {
    if (!rule) continue;
    if (rule.type === 'any') return true;
    if (rule.type !== 'origin') continue;
    if (rule.protocol !== targetProtocol) continue;
    if (rule.hostname !== targetHostname) continue;

    // Rule without explicit port means allow this host under any port.
    if (!rule.port || rule.port === '*') return true;

    const rulePort = normalizePort(rule.protocol, rule.port);
    if (rulePort === targetPort) return true;
  }

  return false;
};

const parseClientCredentials = (value) => {
  const source = String(value ?? '').trim();
  const result = new Map();

  if (!source) return result;

  for (const pair of source.split(',')) {
    const [clientIdRaw, tokenRaw] = pair.split(':');
    const clientId = String(clientIdRaw ?? '').trim();
    const token = String(tokenRaw ?? '').trim();
    if (!clientId || !token) continue;
    result.set(clientId, token);
  }

  return result;
};

const safeEqualText = (left, right) => {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  const leftBuf = Buffer.from(leftText);
  const rightBuf = Buffer.from(rightText);
  if (leftBuf.length !== rightBuf.length) return false;
  return timingSafeEqual(leftBuf, rightBuf);
};

const sha256Hex = (value) => createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
const hmacHex = (secret, payload) => createHmac('sha256', String(secret ?? '')).update(String(payload ?? ''), 'utf8').digest('hex');

const nowDayKey = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

const estimateTokensByText = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 4));

const estimatePromptTokens = (body) => {
  const fromMessage = typeof body?.message === 'string' ? body.message : '';
  if (fromMessage.trim()) return estimateTokensByText(fromMessage);
  return estimateTokensByText(JSON.stringify(body ?? {}));
};

const getIpFromRequest = (req) => {
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return xff || req.ip || req.socket?.remoteAddress || 'unknown';
};

const matchAiRoute = (req) => {
  if (req.method !== 'POST') return null;
  if (req.path === '/api/chat') return 'chat';
  if (/^\/api\/problems\/[^/]+\/answer\/generate$/.test(req.path)) return 'answer_generate';
  return null;
};

const takeFixedWindow = (store, key, now, windowMs, limit) => {
  const existing = store.get(key);
  if (!existing || now >= existing.resetAt) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: Math.max(0, limit - 1), retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  const nextCount = existing.count + 1;
  if (nextCount > limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count = nextCount;
  return {
    ok: true,
    remaining: Math.max(0, limit - nextCount),
    retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
};

export function createAiGuard({ dbPool = null, redis = null, jwtSecret = null } = {}) {
  const JWT_SECRET = jwtSecret || process.env.AI_JWT_SECRET || 'change_me_jwt_secret';
  const credentials = parseClientCredentials(process.env.AI_CLIENT_CREDENTIALS || 'web:change_me');
  const allowedOriginValues = [...parseCsvSet(process.env.AI_ALLOWED_ORIGINS || 'http://127.0.0.1,http://localhost')];
  const allowedOriginRules = allowedOriginValues.map(parseOriginRule).filter(Boolean);

  // Support dynamic updates for dependencies
  let currentDbPool = dbPool;
  let currentRedis = redis || (process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null);

  const config = {
    enabled: String(process.env.AI_GUARD_ENABLED ?? 'true').toLowerCase() !== 'false',
    requireSignedHeaders: String(process.env.AI_REQUIRE_SIGNED_HEADERS ?? 'false').toLowerCase() === 'true',
    defaultClientId: String(process.env.AI_DEFAULT_CLIENT_ID ?? 'web').trim() || 'web',
    maxClockSkewMs: parseIntSafe(process.env.AI_MAX_CLOCK_SKEW_MS, 5 * 60 * 1000),
    nonceTtlMs: parseIntSafe(process.env.AI_NONCE_TTL_MS, 10 * 60 * 1000),
    maxInputChars: parseIntSafe(process.env.AI_MAX_INPUT_CHARS, 1200),
    maxCompletionTokens: parseIntSafe(process.env.AI_MAX_COMPLETION_TOKENS, 4096),
    upstreamTimeoutMs: parseIntSafe(process.env.AI_UPSTREAM_TIMEOUT_MS, 30 * 1000),
    sseIdleTimeoutMs: parseIntSafe(process.env.AI_SSE_IDLE_TIMEOUT_MS, 20 * 1000),
    minuteLimitPerClient: parseIntSafe(process.env.AI_RATE_LIMIT_CLIENT_PER_MINUTE, 10),
    hourLimitPerClient: parseIntSafe(process.env.AI_RATE_LIMIT_CLIENT_PER_HOUR, 100),
    minuteLimitPerIp: parseIntSafe(process.env.AI_RATE_LIMIT_IP_PER_MINUTE, 30),
    maxConcurrencyPerClient: parseIntSafe(process.env.AI_MAX_CONCURRENCY_PER_CLIENT, 2),
    dailyRequestLimitPerClient: parseIntSafe(process.env.AI_DAILY_REQUEST_LIMIT_PER_CLIENT, 200),
    dailyTokenLimitPerClient: parseIntSafe(process.env.AI_DAILY_TOKEN_LIMIT_PER_CLIENT, 50000),
    globalDailyRequestLimit: parseIntSafe(process.env.AI_GLOBAL_DAILY_REQUEST_LIMIT, 5000),
    globalDailyTokenLimit: parseIntSafe(process.env.AI_GLOBAL_DAILY_TOKEN_LIMIT, 500000),
    auditFilePath: process.env.AI_AUDIT_FILE_PATH
      ? path.resolve(process.cwd(), process.env.AI_AUDIT_FILE_PATH)
      : path.resolve(process.cwd(), 'data/ai-audit.ndjson'),
  };

  const nonces = new Map();
  const routeClientMinute = new Map();
  const routeClientHour = new Map();
  const routeIpMinute = new Map();
  const clientConcurrency = new Map();
  const riskEvents = new Map();
  const semanticCache = new Map(); // Simple in-memory cache for now
  const nonceCache = new Set(); // Fallback for when Redis is missing

  // Prometheus-style metrics
  const metrics = {
    totalRequests: 0,
    totalTokens: 0,
    totalErrors: 0,
    totalRejections: 0,
    rejectedByReason: new Map(),
    latencyBuckets: [0, 0, 0, 0], // <1s, <3s, <10s, >10s
  };

  const usage = {
    dayKey: nowDayKey(),
    globalRequests: 0,
    globalTokens: 0,
    clients: new Map(),
  };

  let auditQueue = Promise.resolve();

  const refreshDailyStateIfNeeded = (now) => {
    const key = nowDayKey(now);
    if (usage.dayKey === key) return;
    usage.dayKey = key;
    usage.globalRequests = 0;
    usage.globalTokens = 0;
    usage.clients.clear();
    nonces.clear();
    riskEvents.clear();
  };

  const getClientUsage = (clientId) => {
    const existing = usage.clients.get(clientId);
    if (existing) return existing;

    const created = { requests: 0, tokens: 0 };
    usage.clients.set(clientId, created);
    return created;
  };

  const appendAudit = async (payload) => {
    // 1. NDJSON Fallback (Legacy)
    const row = `${JSON.stringify(payload)}\n`;
    auditQueue = auditQueue
      .then(() => fs.appendFile(config.auditFilePath, row, 'utf8'))
      .catch((error) => {
        console.error('[ai-guard] append audit failed', error?.message || error);
      });

    // 2. SQL Audit (New) - Asynchronous but non-blocking
    if (currentDbPool) {
      currentDbPool.withConnection(async (db) => {
        try {
          const cid = (payload.clientId && payload.clientId.trim()) ? payload.clientId : null;
          await db.run(`
            INSERT INTO ai_audit_logs (
              request_id, client_id, user_identifier, action_type, action_name,
              page_path, page_title, payload_preview, prompt_tokens,
              completion_tokens, total_tokens, status_code, decision,
              reason, duration_ms, client_ip_hash, user_agent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            payload.requestId ?? null,
            cid,
            payload.userIdentifier ?? null,
            payload.actionType || payload.route || null,
            payload.actionName ?? null,
            payload.path ?? null,
            payload.pageTitle ?? null,
            payload.payloadPreview ?? null,
            payload.promptTokens ?? 0,
            payload.completionTokens ?? 0,
            payload.totalTokens ?? 0,
            payload.status ?? 200,
            payload.decision ?? 'unknown',
            payload.reason ?? 'unknown',
            payload.durationMs ?? 0,
            payload.ipHash ?? null,
            payload.userAgent ?? null
          ]);
          // console.log('[ai-guard] SQL audit recorded:', payload.requestId);
          console.log('[ai-guard] SQL audit success for requestId:', payload.requestId);
        } catch (err) {
          console.error('[ai-guard] SQL audit failed:', err.message);
        }
      }).catch(() => { });
    }

    return auditQueue;
  };

  const exchangeToken = async (req, res) => {
    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, allowedOriginRules)) {
      return res.status(403).json({ code: 403, message: 'Origin not allowed' });
    }

    const { clientId, ts, nonce, signature, bodyHash } = req.body;
    if (!clientId || !ts || !nonce || !signature || !bodyHash) {
      return res.status(400).json({ code: 400, message: 'Missing exchange parameters' });
    }

    const secret = credentials.get(clientId);
    if (!secret) return res.status(401).json({ code: 401, message: 'Invalid client' });

    // 1. Verify Clock Skew
    const now = Date.now();
    if (Math.abs(now - Number(ts)) > config.maxClockSkewMs) {
      return res.status(401).json({ code: 401, message: 'Stale request' });
    }

    // 2. Verify Nonce
    const nonceKey = `nonce:${clientId}:${nonce}`;
    if (currentRedis) {
      const seen = await currentRedis.set(nonceKey, '1', 'PX', config.nonceTtlMs, 'NX');
      if (!seen) return res.status(401).json({ code: 401, message: 'Replay blocked' });
    } else {
      if (nonceCache.has(nonceKey)) return res.status(401).json({ code: 401, message: 'Replay blocked' });
      nonceCache.add(nonceKey);
      setTimeout(() => nonceCache.delete(nonceKey), config.nonceTtlMs);
    }

    // 3. Verify Signature
    // Construction must match frontend: JSON.stringify({ clientId, ts, nonce })
    const bodyForHash = JSON.stringify({ clientId, ts, nonce });
    const actualBodyHash = sha256Hex(bodyForHash);

    if (!safeEqualText(actualBodyHash, bodyHash)) {
      console.log('[ai-guard] Body hash mismatch:', {
        actual: actualBodyHash,
        provided: bodyHash,
        constructedBody: bodyForHash
      });
      return res.status(401).json({ code: 401, message: 'Body hash mismatch' });
    }

    const signatureBase = `${ts}.${nonce}.POST.${req.path}.${bodyHash}`;
    const expectedSignature = hmacHex(secret, signatureBase);

    if (!safeEqualText(expectedSignature, signature)) {
      console.log('[ai-guard] Invalid signature. Expected base:', signatureBase);
      return res.status(401).json({ code: 401, message: 'Invalid signature' });
    }

    // 4. Issue JWT
    const token = jwt.sign({ clientId, op: 'ai_access', role: 'admin', permissions: ['chat_ai', 'study'] }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    return res.json({ code: 0, data: { token, expiresIn: 3600 }, message: 'success' });
  };

  const reject = ({ req, res, status, message, reason, clientId = null, routeKey = null }) => {
    metrics.totalRejections += 1;
    const reasonCount = metrics.rejectedByReason.get(reason) || 0;
    metrics.rejectedByReason.set(reason, reasonCount + 1);

    const requestId = res.getHeader('X-Request-Id') || req.header('x-request-id') || '-';
    appendAudit({
      ts: new Date().toISOString(),
      requestId,
      decision: 'reject',
      status,
      reason,
      route: routeKey,
      clientId,
      ipHash: sha256Hex(getIpFromRequest(req)),
      userAgent: req.header('user-agent'),
      method: req.method,
      path: req.path,
    });

    return res.status(status).json({ code: status, message });
  };

  const checkAndConsumeQuota = async ({ clientId, projectedTokens, now }) => {
    refreshDailyStateIfNeeded(now);

    // 1. Memory checks (Global)
    const nextGlobalRequests = usage.globalRequests + 1;
    if (nextGlobalRequests > config.globalDailyRequestLimit) {
      return { ok: false, reason: 'global_daily_request_limit' };
    }

    const nextGlobalTokens = usage.globalTokens + projectedTokens;
    if (nextGlobalTokens > config.globalDailyTokenLimit) {
      return { ok: false, reason: 'global_daily_token_limit' };
    }

    // 2. SQL Persistent checks (Client-specific)
    if (currentDbPool) {
      const quota = await currentDbPool.withConnection(async (db) => {
        // Get today's usage from audit logs
        const today = nowDayKey(now);
        const row = await db.get(`
          SELECT 
            COUNT(*) as request_count, 
            SUM(total_tokens) as token_sum 
          FROM ai_audit_logs 
          WHERE client_id = ? AND date(created_at) = date(?)
        `, [clientId, today]);

        const client = await db.get(`SELECT daily_token_limit, daily_request_limit FROM ai_clients WHERE client_id = ?`, [clientId]);
        const reqLimit = client?.daily_request_limit ?? config.dailyRequestLimitPerClient;
        const tokenLimit = client?.daily_token_limit ?? config.dailyTokenLimitPerClient;

        return {
          requests: row.request_count || 0,
          tokens: row.token_sum || 0,
          reqLimit,
          tokenLimit
        };
      });

      if (quota.requests + 1 > quota.reqLimit) return { ok: false, reason: 'client_daily_request_limit' };
      if (quota.tokens + projectedTokens > quota.tokenLimit) return { ok: false, reason: 'client_daily_token_limit' };
    }

    // 3. Fallback/Sync Memory State
    const clientUsage = getClientUsage(clientId);
    usage.globalRequests = nextGlobalRequests;
    usage.globalTokens = nextGlobalTokens;
    clientUsage.requests += 1;
    clientUsage.tokens += projectedTokens;

    return { ok: true };
  };

  const trackRisk = ({ clientId, signature }) => {
    const key = `${clientId}:${signature}`;
    const prev = riskEvents.get(key) || 0;
    const next = prev + 1;
    riskEvents.set(key, next);
    return next;
  };

  const releaseConcurrency = (clientId) => {
    const value = clientConcurrency.get(clientId) || 0;
    if (value <= 1) {
      clientConcurrency.delete(clientId);
      return;
    }
    clientConcurrency.set(clientId, value - 1);
  };

  const createRateLimitKey = ({ routeKey, clientId, ip }) => `${routeKey}:${clientId}:${ip}`;

  const middleware = async (req, res, next) => {
    if (!config.enabled) return next();

    const routeKey = matchAiRoute(req);
    if (!routeKey) return next();

    const origin = req.headers.origin;
    if (!isOriginAllowed(origin, allowedOriginRules)) {
      return reject({ req, res, status: 403, message: 'Origin not allowed', reason: 'origin_blocked', routeKey });
    }

    const authHeader = req.header('authorization');
    let session = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      try {
        session = jwt.verify(token, JWT_SECRET);
      } catch (err) {
        return reject({ req, res, status: 401, message: 'Invalid or expired session', reason: 'invalid_jwt', routeKey });
      }
    }

    // Unified clientId extraction
    let clientId = session?.clientId || String(req.header('x-client-id') || '').trim();
    
    // Fallback for legacy tokens or missing clientId
    if (!clientId && (session || !config.requireSignedHeaders)) {
      clientId = config.defaultClientId || 'web';
    }

    const forceSignatureCheck = !session && !clientId && config.requireSignedHeaders;

    console.log(`[ai-guard-debug] requestId="${req.header('x-request-id')}" route="${routeKey}" clientId="${clientId}" session=${!!session} forceSig=${forceSignatureCheck}`);

    if (!clientId) {
      return reject({ req, res, status: 401, message: 'Missing client id', reason: 'missing_client_id', clientId, routeKey });
    }

    const secret = credentials.get(clientId);
    if (!secret) {
      return reject({ req, res, status: 401, message: 'Invalid client id', reason: 'invalid_client_id', clientId, routeKey });
    }

    const now = Date.now();
    if (forceSignatureCheck) {
      const clientToken = String(req.header('x-client-token') || '').trim();
      const tsRaw = String(req.header('x-ts') || '').trim();
      const nonce = String(req.header('x-nonce') || '').trim();
      const signature = String(req.header('x-signature') || '').trim();
      const bodyHashHeader = String(req.header('x-body-sha256') || '').trim();

      if (!clientToken || !tsRaw || !nonce || !signature || !bodyHashHeader) {
        return reject({ req, res, status: 401, message: 'Missing AI auth headers', reason: 'missing_headers', clientId, routeKey });
      }

      if (!safeEqualText(clientToken, secret)) {
        const attempts = trackRisk({ clientId, signature });
        if (attempts >= 6) {
          return reject({ req, res, status: 403, message: 'Client temporarily blocked', reason: 'client_token_bruteforce', clientId, routeKey });
        }
        return reject({ req, res, status: 401, message: 'Invalid client token', reason: 'invalid_client_token', clientId, routeKey });
      }

      const ts = Number(tsRaw);
      if (!Number.isFinite(ts) || Math.abs(now - ts) > config.maxClockSkewMs) {
        return reject({ req, res, status: 401, message: 'Stale or invalid timestamp', reason: 'invalid_timestamp', clientId, routeKey });
      }

      if (currentRedis) {
        const nonceKey = `nonce:${clientId}:${nonce}`;
        const seen = await currentRedis.set(nonceKey, '1', 'PX', config.nonceTtlMs, 'NX');
        if (!seen) return reject({ req, res, status: 401, message: 'Replay request blocked', reason: 'replay_blocked', clientId, routeKey });
      } else {
        const seenAt = nonces.get(nonce);
        if (seenAt && now - seenAt < config.nonceTtlMs) {
          return reject({ req, res, status: 401, message: 'Replay request blocked', reason: 'replay_blocked', clientId, routeKey });
        }
        nonces.set(nonce, now);
      }

      const bodyText = JSON.stringify(req.body ?? {});
      const bodyHash = sha256Hex(bodyText);
      if (!safeEqualText(bodyHash, bodyHashHeader)) {
        return reject({ req, res, status: 401, message: 'Body hash mismatch', reason: 'body_hash_mismatch', clientId, routeKey });
      }

      const signatureBase = `${tsRaw}.${nonce}.${req.method.toUpperCase()}.${req.path}.${bodyHash}`;
      const expectedSignature = hmacHex(secret, signatureBase);
      if (!safeEqualText(expectedSignature, signature)) {
        return reject({ req, res, status: 401, message: 'Invalid signature', reason: 'invalid_signature', clientId, routeKey });
      }
    }

    if (typeof req.body?.message === 'string' && req.body.message.length > config.maxInputChars) {
      return reject({ req, res, status: 400, message: `message is too long (>${config.maxInputChars})`, reason: 'message_too_long', clientId, routeKey });
    }

    const ip = getIpFromRequest(req);
    const limitKey = createRateLimitKey({ routeKey, clientId, ip });

    const minuteClient = takeFixedWindow(routeClientMinute, limitKey, now, 60 * 1000, config.minuteLimitPerClient);
    if (!minuteClient.ok) {
      res.setHeader('Retry-After', String(minuteClient.retryAfterSec));
      return reject({ req, res, status: 429, message: 'Too many requests (client per minute)', reason: 'rate_client_minute', clientId, routeKey });
    }

    const hourClient = takeFixedWindow(routeClientHour, limitKey, now, 60 * 60 * 1000, config.hourLimitPerClient);
    if (!hourClient.ok) {
      res.setHeader('Retry-After', String(hourClient.retryAfterSec));
      return reject({ req, res, status: 429, message: 'Too many requests (client per hour)', reason: 'rate_client_hour', clientId, routeKey });
    }

    const ipMinute = takeFixedWindow(routeIpMinute, `${routeKey}:${ip}`, now, 60 * 1000, config.minuteLimitPerIp);
    if (!ipMinute.ok) {
      res.setHeader('Retry-After', String(ipMinute.retryAfterSec));
      return reject({ req, res, status: 429, message: 'Too many requests (ip per minute)', reason: 'rate_ip_minute', clientId, routeKey });
    }

    const inFlight = clientConcurrency.get(clientId) || 0;
    if (inFlight >= config.maxConcurrencyPerClient) {
      return reject({ req, res, status: 429, message: 'Too many concurrent requests', reason: 'concurrency_limit', clientId, routeKey });
    }

    const promptTokens = estimatePromptTokens(req.body);
    const projectedTokens = promptTokens + config.maxCompletionTokens;
    const quotaResult = await checkAndConsumeQuota({ clientId, projectedTokens, now });
    if (!quotaResult.ok) {
      return reject({ req, res, status: 429, message: 'Quota exceeded', reason: quotaResult.reason, clientId, routeKey });
    }

    clientConcurrency.set(clientId, inFlight + 1);

    const requestId = res.getHeader('X-Request-Id') || 'unknown';
    const startedAt = Date.now();

    let finished = false;
    const releaseOnce = () => {
      if (finished) return;
      finished = true;
      releaseConcurrency(clientId);
    };

    res.once('close', releaseOnce);
    res.once('finish', releaseOnce);

    // 0. Check Semantic Cache
    const bodyTextForCache = JSON.stringify(req.body ?? {});
    const cacheKey = sha256Hex(`${req.method}:${req.path}:${bodyTextForCache}`);
    const cached = semanticCache.get(cacheKey);
    if (cached && (now - cached.ts < 24 * 60 * 60 * 1000)) { // 24h cache
      releaseOnce();
      appendAudit({
        ts: new Date().toISOString(), requestId, decision: 'allow', status: 'ok',
        reason: 'semantic_cache_hit', route: routeKey, clientId, ipHash: sha256Hex(ip),
        method: req.method, path: req.path, totalTokens: 0, durationMs: 0
      });
      res.setHeader('X-Cache', 'HIT');
      // For answer_generate, we need to return the ID as well to match frontend expectations
      let data = { answer: cached.text, cached: true };
      if (routeKey === 'answer_generate') {
        const parts = req.path.split('/');
        const id = parts[parts.length - 3]; // URL: /api/problems/:id/answer/generate
        data.id = Number(id);
      }
      return res.json({ code: 0, data, message: 'success' });
    }

    const missionId = req.header('x-maf-mission-id');

    req.aiGuard = {
      clientId,
      routeKey,
      missionId,
      promptTokens,
      userIdentifier: req.header('x-user-id') || sha256Hex(ip).slice(0, 16),
      pagePath: req.header('x-page-path') || req.path,
      pageTitle: req.header('x-page-title') || '',
      actionName: routeKey === 'chat' ? 'AI 助手对话' : '生成题目解析',
      userAgent: req.header('user-agent'),
      maxCompletionTokens: config.maxCompletionTokens,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      sseIdleTimeoutMs: config.sseIdleTimeoutMs,
      finalize: ({ completionText = '', status = 'ok', reason = 'completed', upstreamStatus = null } = {}) => {
        metrics.totalRequests += 1;
        const duration = Date.now() - startedAt;
        if (duration < 1000) metrics.latencyBuckets[0]++;
        else if (duration < 3000) metrics.latencyBuckets[1]++;
        else if (duration < 10000) metrics.latencyBuckets[2]++;
        else metrics.latencyBuckets[3]++;

        const completionTokens = estimateTokensByText(completionText);
        metrics.totalTokens += promptTokens + completionTokens;

        if (status === 'error') metrics.totalErrors++;

        // Cache successful non-streaming responses if applicable
        if (status === 'ok' && completionText && (routeKey === 'answer_generate' || routeKey === 'chat')) {
          // Use the same strong cache key logic
          const bodyTextForCache = JSON.stringify(req.body ?? {});
          const cacheKey = sha256Hex(`${req.method}:${req.path}:${bodyTextForCache}`);
          semanticCache.set(cacheKey, { text: completionText, ts: Date.now() });
        }

        const totalTokens = promptTokens + completionTokens;

        if (missionId && currentDbPool) {
          updateMissionTokens(currentDbPool, missionId, totalTokens).catch(err => {
            console.error('[ai-guard] Failed to update mission tokens:', err.message);
          });
        }

        appendAudit({
          ts: new Date().toISOString(),
          requestId,
          decision: 'allow',
          status,
          reason,
          route: routeKey,
          clientId,
          ipHash: sha256Hex(ip),
          method: req.method,
          path: req.path,
          promptTokens,
          completionTokens,
          totalTokens,
          upstreamStatus,
          durationMs: Date.now() - startedAt,
        });
      },
    };

    return next();
  };

  const corsOptions = {
    origin(origin, callback) {
      if (isOriginAllowed(origin, allowedOriginRules)) {
        callback(null, true);
        return;
      }
      callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      'X-Request-Id',
      'X-Client-Id',
      'X-Client-Token',
      'X-Ts',
      'X-Nonce',
      'X-Signature',
      'X-Body-Sha256',
      'X-Maf-Mission-Id',
    ],
  };

  const getMetrics = () => {
    let prometheus = '';
    prometheus += `# HELP ai_guard_requests_total Total number of AI requests\n`;
    prometheus += `# TYPE ai_guard_requests_total counter\n`;
    prometheus += `ai_guard_requests_total ${metrics.totalRequests}\n`;
    prometheus += `ai_guard_tokens_total ${metrics.totalTokens}\n`;
    prometheus += `ai_guard_errors_total ${metrics.totalErrors}\n`;
    prometheus += `ai_guard_rejections_total ${metrics.totalRejections}\n`;
    for (const [reason, count] of metrics.rejectedByReason) {
      prometheus += `ai_guard_rejections_by_reason{reason="${reason}"} ${count}\n`;
    }
    return prometheus;
  };

  return {
    config,
    middleware,
    corsOptions,
    exchangeToken,
    getMetrics,
    set dbPool(val) { currentDbPool = val; },
    set redis(val) { currentRedis = val; }
  };
}

export async function readStreamChunkWithTimeout(reader, timeoutMs) {
  let timer = null;
  try {
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('SSE idle timeout')), timeoutMs);
    });
    const readPromise = reader.read();
    const result = await Promise.race([readPromise, timeoutPromise]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
