/**
 * S7：换票 fetch URL 与签名 path 对齐为 `/api/auth/token`（docs/test_cases.md §4.8）
 */
import { createHash, createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAiAuthHeaders,
  ensureAiSessionToken,
  fetchAiSessionToken,
  resetAiSessionTokenForTests,
} from '@/utils/ai-auth'

const SECRET = 'change_me'
const TOKEN = 'ai-session-jwt-s7'
const SIGN_PATH = '/api/auth/token'

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const hmacHex = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex')

/** 将 fetch 第 1 参解析为 pathname（相对或绝对 URL）。 */
const urlPathname = (url: unknown): string => {
  const raw = String(url)
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    return new URL(raw).pathname
  }
  return new URL(raw, 'http://localhost').pathname
}

const stubTokenFetch = () =>
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 0,
        message: 'success',
        data: { token: TOKEN, expiresIn: 3600 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  )

/** 从首次换票 fetch 调用解析 body 与 URL pathname。 */
const parseTokenCall = (fetchSpy: ReturnType<typeof stubTokenFetch>) => {
  expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1)
  const [url, init] = fetchSpy.mock.calls[0]
  const pathname = urlPathname(url)
  const method = String((init as RequestInit | undefined)?.method || '').toUpperCase()
  const headers = (init as RequestInit | undefined)?.headers as Record<string, string> | undefined
  const body = JSON.parse(String((init as RequestInit | undefined)?.body || '{}')) as {
    clientId: string
    ts: string
    nonce: string
    signature: string
    bodyHash: string
  }
  return { url: String(url), pathname, method, headers, body }
}

describe('S7 换票 URL / 签名 path 对齐 (ai-auth)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetAiSessionTokenForTests()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_AI_CLIENT_ID', 'web')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', SECRET)
    // 默认未设 VITE_API_BASE_URL（与 axios 同语义回退 /api）
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetAiSessionTokenForTests()
  })

  it('UT-FE-TOKEN-URL-01: 默认 env：fetch URL pathname 为 /api/auth/token', async () => {
    const fetchSpy = stubTokenFetch()
    await fetchAiSessionToken('web', SECRET)

    const { pathname, method } = parseTokenCall(fetchSpy)
    expect(pathname).toBe(SIGN_PATH)
    expect(pathname).not.toBe('/auth/token')
    expect(pathname).not.toBe('/api/api/auth/token')
    expect(method).toBe('POST')
  })

  it('UT-FE-TOKEN-URL-02: 默认 env：签名基串 path 为 /api/auth/token', async () => {
    const fetchSpy = stubTokenFetch()
    await fetchAiSessionToken('web', SECRET)

    const { body } = parseTokenCall(fetchSpy)
    const { clientId, ts, nonce, bodyHash, signature } = body
    expect(bodyHash).toBe(sha256Hex(JSON.stringify({ clientId, ts, nonce })))

    const expectedSig = hmacHex(SECRET, `${ts}.${nonce}.POST.${SIGN_PATH}.${bodyHash}`)
    expect(signature).toBe(expectedSig)

    const wrongPathSig = hmacHex(SECRET, `${ts}.${nonce}.POST./auth/token.${bodyHash}`)
    expect(signature).not.toBe(wrongPathSig)
  })

  it('UT-FE-TOKEN-URL-03: 同一请求：URL pathname 与签名 path 全等对齐', async () => {
    const fetchSpy = stubTokenFetch()
    await fetchAiSessionToken('web', SECRET)

    const { pathname, body } = parseTokenCall(fetchSpy)
    const { clientId, ts, nonce, bodyHash, signature } = body
    expect(pathname).toBe(SIGN_PATH)

    const expectedSig = hmacHex(SECRET, `${ts}.${nonce}.POST.${SIGN_PATH}.${bodyHash}`)
    expect(signature).toBe(expectedSig)
    expect(bodyHash).toBe(sha256Hex(JSON.stringify({ clientId, ts, nonce })))
    // 合取：URL pathname 与签名基串 path 字面量全等，禁止半修复
    expect(pathname).toBe(SIGN_PATH)
  })

  it('UT-FE-TOKEN-URL-04: getApiBase 未设时回退 /api（对齐 axios）', async () => {
    // 对照 request.ts：baseURL: import.meta.env.VITE_API_BASE_URL || '/api'
    const fetchSpy = stubTokenFetch()
    await fetchAiSessionToken('web', SECRET)

    const { url, pathname } = parseTokenCall(fetchSpy)
    expect(pathname).toBe(SIGN_PATH)
    expect(pathname.endsWith('/api/auth/token')).toBe(true)
    expect(url).not.toBe('/auth/token')
    expect(pathname).not.toBe('/auth/token')
  })

  it("UT-FE-TOKEN-URL-05: VITE_API_BASE_URL='/api'：无双重 /api/api", async () => {
    vi.stubEnv('VITE_API_BASE_URL', '/api')
    const fetchSpy = stubTokenFetch()
    await fetchAiSessionToken('web', SECRET)

    const { pathname, body } = parseTokenCall(fetchSpy)
    expect(pathname).toBe(SIGN_PATH)
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('/api/api/auth/token')

    const { ts, nonce, bodyHash, signature } = body
    expect(signature).toBe(hmacHex(SECRET, `${ts}.${nonce}.POST.${SIGN_PATH}.${bodyHash}`))
    expect(pathname).toBe(SIGN_PATH)
  })

  it('UT-FE-TOKEN-URL-06: 绝对 baseURL：pathname 仍为 /api/auth/token', async () => {
    vi.stubEnv('VITE_API_BASE_URL', 'http://127.0.0.1:9/api')
    const fetchSpy = stubTokenFetch()
    await fetchAiSessionToken('web', SECRET)

    const { url, pathname, body } = parseTokenCall(fetchSpy)
    expect(pathname).toBe(SIGN_PATH)
    const absolute = new URL(url)
    expect(absolute.origin).toBe('http://127.0.0.1:9')
    expect(absolute.pathname).toBe(SIGN_PATH)

    const { ts, nonce, bodyHash, signature } = body
    expect(signature).toBe(hmacHex(SECRET, `${ts}.${nonce}.POST.${SIGN_PATH}.${bodyHash}`))
  })

  it('UT-FE-TOKEN-URL-07: 换票 body 字段齐全且 Content-Type 正确', async () => {
    const fetchSpy = stubTokenFetch()
    const token = await fetchAiSessionToken('web', SECRET)

    const { body, headers, method } = parseTokenCall(fetchSpy)
    expect(method).toBe('POST')
    for (const key of ['clientId', 'ts', 'nonce', 'signature', 'bodyHash'] as const) {
      expect(typeof body[key]).toBe('string')
      expect(body[key].length).toBeGreaterThan(0)
    }
    const contentType =
      headers?.['Content-Type'] || headers?.['content-type'] || ''
    expect(contentType).toContain('application/json')
    expect(token).toBe(TOKEN)
  })

  it('UT-FE-TOKEN-URL-08: ensureAiSessionToken 无缓存时走同一对齐 path', async () => {
    const fetchSpy = stubTokenFetch()
    await ensureAiSessionToken()

    const { pathname, body } = parseTokenCall(fetchSpy)
    expect(pathname).toBe(SIGN_PATH)
    const { ts, nonce, bodyHash, signature, clientId } = body
    expect(bodyHash).toBe(sha256Hex(JSON.stringify({ clientId, ts, nonce })))
    expect(signature).toBe(hmacHex(SECRET, `${ts}.${nonce}.POST.${SIGN_PATH}.${bodyHash}`))

    const callsAfterFirst = fetchSpy.mock.calls.length
    await ensureAiSessionToken()
    expect(fetchSpy.mock.calls.length).toBe(callsAfterFirst)
  })

  it('UT-FE-TOKEN-URL-09: 不做：不改换票 JWT claims / 权限面（S1 分界）', async () => {
    // 本表仅锁前端 URL/签名 path；不要求 jwt.decode 断言 op/role/permissions
    const fetchSpy = stubTokenFetch()
    const token = await fetchAiSessionToken('web', SECRET)
    expect(token).toBe(TOKEN)
    expect(typeof token).toBe('string')
    expect(urlPathname(fetchSpy.mock.calls[0][0])).toBe(SIGN_PATH)
  })

  it('UT-FE-TOKEN-URL-10: 不做：不改 AI 路由六头注入（B33 分界）', async () => {
    // 本表不以 chat/generate 六头为 PASS/FAIL；可选确认 buildAiAuthHeaders 仍可用
    const headers = await buildAiAuthHeaders('POST', '/api/chat', '{}')
    expect(typeof headers).toBe('object')
    expect(true).toBe(true)
  })

  it('UT-FE-TOKEN-URL-11: 不做：不改后端验签算法或挂载点', () => {
    // 本文件不 import backend exchangeToken；前端签名 path 对齐现网 req.path 即可
    expect(SIGN_PATH).toBe('/api/auth/token')
    expect(true).toBe(true)
  })

  it('UT-FE-TOKEN-URL-12: residual：权限隔离与六头另条', () => {
    // residual：S1 requireAdmin / B33 登录态六头另条，不以本表未覆盖判 FAIL
    expect(true).toBe(true)
  })
})
