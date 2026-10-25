const getAiClientId = (): string => String(import.meta.env.VITE_AI_CLIENT_ID ?? 'web');
const getAiClientSecret = (): string => String(import.meta.env.VITE_AI_CLIENT_SECRET ?? '');

const toHex = (bytes: Uint8Array): string => {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const safeRandomUUID = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const ensureCryptoSubtle = () => {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error(
      'Crypto.subtle is not available. This feature requires a secure context (HTTPS or localhost).'
    );
  }
};

const sha256Hex = async (text: string): Promise<string> => {
  ensureCryptoSubtle();
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return toHex(new Uint8Array(digest));
};

const hmacSha256Hex = async (secret: string, text: string): Promise<string> => {
  ensureCryptoSubtle();
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return toHex(new Uint8Array(signature));
};

/**
 * 将 axios 相对路径或完整 API 路径归一化为 Express `req.path`（含 `/api` 前缀）。
 */
export const normalizeAiPath = (apiPath: string): string => {
  const path = String(apiPath || '').trim();
  if (!path.startsWith('/')) return `/api/${path}`;
  if (path.startsWith('/api/')) return path;
  if (path === '/api') return '/api';
  return `/api${path}`;
};

export const isAiProtectedPath = (apiPath: string): boolean => {
  const normalized = normalizeAiPath(apiPath);
  if (normalized === '/api/chat') return true;
  return /^\/api\/problems\/[^/]+\/answer\/generate$/.test(normalized);
};

let currentSessionToken: string | null = null;
let sessionExpiresAt: number = 0;

/**
 * 与 axios `baseURL: VITE_API_BASE_URL || '/api'` 对齐；未设/空串时回退 `/api`，避免换票打到裸 `/auth/token`。
 */
const getApiBase = () => {
  return import.meta.env.VITE_API_BASE_URL || '/api';
};

/**
 * 向 /api/auth/token 换取匿名 AI 会话票（仅无用户 Bearer 时使用）。
 * URL 拼法对齐 axios：base(`/api`) + 相对 `/auth/token` → pathname `/api/auth/token`；
 * HMAC 签名 path 用 normalizeAiPath，与 Express `req.path` 一致，禁止双重 `/api/api`。
 */
export const fetchAiSessionToken = async (id: string, secret: string): Promise<string> => {
  const ts = String(Date.now());
  const nonce = safeRandomUUID();
  // 相对 axios baseURL 的路径；最终 fetch pathname 与签名 path 均为 `/api/auth/token`
  const apiPath = '/auth/token';
  const normalizedPath = normalizeAiPath(apiPath);
  const body = JSON.stringify({ clientId: id, ts, nonce });
  const bodyHash = await sha256Hex(body);
  const signPayload = `${ts}.${nonce}.POST.${normalizedPath}.${bodyHash}`;
  const signature = await hmacSha256Hex(secret, signPayload);

  const res = await fetch(`${getApiBase()}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: id, ts, nonce, signature, bodyHash }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: 'Auth failed' }));
    throw new Error(err.message || 'AI Authentication failed');
  }

  const { data } = await res.json();
  currentSessionToken = data.token;
  sessionExpiresAt = Date.now() + (data.expiresIn || 3600) * 1000 - 60000; // 1 min buffer
  return data.token;
};

/**
 * 无用户登录票时确保有可用的 AI 会话 JWT；已登录路径不得调用此函数覆盖 Bearer。
 */
export const ensureAiSessionToken = async (): Promise<string> => {
  const now = Date.now();
  if (currentSessionToken && now < sessionExpiresAt) {
    return currentSessionToken;
  }
  const secret = getAiClientSecret();
  if (!secret) throw new Error('Missing VITE_AI_CLIENT_SECRET');
  return fetchAiSessionToken(getAiClientId(), secret);
};

/** 测试钩子：清空内存中的 AI 会话票缓存。 */
export const resetAiSessionTokenForTests = () => {
  currentSessionToken = null;
  sessionExpiresAt = 0;
};

/**
 * 构建与 backend `ai-guard.js` 一致的六个 HMAC 签名头。
 * 对传入的 bodyText（实际发出的 JSON 字符串）做 SHA-256；path 归一化为 Express req.path。
 */
export const buildAiAuthHeaders = async (
  method: string,
  apiPath: string,
  bodyText: string
): Promise<Record<string, string>> => {
  const secret = getAiClientSecret();
  if (!secret) throw new Error('Missing VITE_AI_CLIENT_SECRET');

  const clientId = getAiClientId();
  const ts = String(Date.now());
  const nonce = safeRandomUUID();
  const path = normalizeAiPath(apiPath);
  const bodyHash = await sha256Hex(bodyText);
  const methodUpper = String(method || 'GET').toUpperCase();
  const signPayload = `${ts}.${nonce}.${methodUpper}.${path}.${bodyHash}`;
  const signature = await hmacSha256Hex(secret, signPayload);

  return {
    'X-Client-Id': clientId,
    'X-Client-Token': secret,
    'X-Ts': ts,
    'X-Nonce': nonce,
    'X-Body-Sha256': bodyHash,
    'X-Signature': signature,
  };
};
