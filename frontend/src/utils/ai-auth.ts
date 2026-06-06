const aiClientId = import.meta.env.VITE_AI_CLIENT_ID ?? 'web';
const aiClientSecret = import.meta.env.VITE_AI_CLIENT_SECRET ?? '';

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

const normalizePath = (apiPath: string): string => {
  const path = String(apiPath || '').trim();
  if (!path.startsWith('/')) return `/api/${path}`;
  if (path.startsWith('/api/')) return path;
  if (path === '/api') return '/api';
  return `/api${path}`;
};

export const isAiProtectedPath = (apiPath: string): boolean => {
  const normalized = normalizePath(apiPath);
  if (normalized === '/api/chat') return true;
  return /^\/api\/problems\/[^/]+\/answer\/generate$/.test(normalized);
};

let currentSessionToken: string | null = null;
let sessionExpiresAt: number = 0;

const getApiBase = () => {
  // In Vite, usually /api is proxied. Adjust if necessary.
  return import.meta.env.VITE_API_BASE_URL ?? '';
};

export const fetchAiSessionToken = async (id: string, secret: string): Promise<string> => {
  const ts = String(Date.now());
  const nonce = safeRandomUUID();
  const apiPath = '/auth/token';
  const normalizedPath = normalizePath(apiPath);
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

export const buildAiAuthHeaders = async (
  method: string,
  apiPath: string,
  bodyText: string
): Promise<Record<string, string>> => {
  const now = Date.now();
  if (!currentSessionToken || now >= sessionExpiresAt) {
    if (!aiClientSecret) throw new Error('Missing VITE_AI_CLIENT_SECRET');
    await fetchAiSessionToken(aiClientId, aiClientSecret);
  }

  return {
    token: currentSessionToken || '',
  };
};
