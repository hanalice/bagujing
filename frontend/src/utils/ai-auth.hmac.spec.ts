/**
 * B33：登录态 chat / generate HMAC 六头（对齐 docs/test_cases.md §4.5）
 */
import { createHash, createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildAiAuthHeaders,
  fetchAiSessionToken,
  normalizeAiPath,
  resetAiSessionTokenForTests,
} from '@/utils/ai-auth'
import { getHeaders } from '@/utils/request'

const SECRET = 'change_me'

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const hmacHex = (secret: string, payload: string) =>
  createHmac('sha256', secret).update(payload, 'utf8').digest('hex')

const headerGet = (headers: Record<string, string>, name: string): string => {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v
  }
  return ''
}

const assertSixHeadersPresent = (headers: Record<string, string>) => {
  for (const name of [
    'X-Client-Id',
    'X-Client-Token',
    'X-Ts',
    'X-Nonce',
    'X-Body-Sha256',
    'X-Signature',
  ]) {
    expect(headerGet(headers, name), name).toBeTruthy()
  }
}

const assertHmacMatches = (
  headers: Record<string, string>,
  method: string,
  path: string,
  secret = SECRET
) => {
  const ts = headerGet(headers, 'X-Ts')
  const nonce = headerGet(headers, 'X-Nonce')
  const bodyHash = headerGet(headers, 'X-Body-Sha256')
  const sig = headerGet(headers, 'X-Signature')
  const expected = hmacHex(secret, `${ts}.${nonce}.${method.toUpperCase()}.${path}.${bodyHash}`)
  expect(sig).toBe(expected)
}

describe('B33 HMAC 签名头 (ai-auth / getHeaders)', () => {
  beforeEach(() => {
    localStorage.clear()
    resetAiSessionTokenForTests()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_AI_CLIENT_ID', 'web')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', SECRET)
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    resetAiSessionTokenForTests()
  })

  it('UT-FE-SIG-01: 已登录 chat：getHeaders 带齐六头且保留用户 Bearer', async () => {
    localStorage.setItem('token', 'user-jwt-login')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}'))

    const headers = await getHeaders('POST', '/api/chat', { message: 'hello', context: {} })

    expect(headers.Authorization).toBe('Bearer user-jwt-login')
    expect(headerGet(headers, 'X-Client-Id')).toBe('web')
    expect(headerGet(headers, 'X-Client-Token')).toBe(SECRET)
    assertSixHeadersPresent(headers)

    const tokenCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/auth/token')
    )
    expect(tokenCalls).toHaveLength(0)
  })

  it('UT-FE-SIG-02: 已登录 generate：六头注入且 path 含 /api', async () => {
    localStorage.setItem('token', 'user-jwt-login')
    const body = { force: false }
    const axiosRelative = '/problems/42/answer/generate'

    expect(normalizeAiPath(axiosRelative)).toBe('/api/problems/42/answer/generate')
    expect(normalizeAiPath(axiosRelative)).not.toBe('/problems/42/answer/generate')

    const headers = await getHeaders('POST', axiosRelative, body)

    expect(headers.Authorization).toBe('Bearer user-jwt-login')
    expect(headerGet(headers, 'X-Client-Id')).toBe('web')
    expect(headerGet(headers, 'X-Client-Token')).toBe(SECRET)
    assertSixHeadersPresent(headers)
    assertHmacMatches(headers, 'POST', '/api/problems/42/answer/generate')
  })

  it('UT-FE-SIG-04: 同一密钥按基串重算 HMAC 必须对上', async () => {
    localStorage.setItem('token', 'user-jwt-login')

    const chatHeaders = await getHeaders('POST', '/api/chat', { message: 'sig-chat', context: {} })
    assertHmacMatches(chatHeaders, 'POST', '/api/chat')

    const genHeaders = await getHeaders('POST', '/problems/7/answer/generate', { force: false })
    assertHmacMatches(genHeaders, 'POST', '/api/problems/7/answer/generate')
  })

  it('UT-FE-SIG-05: Body 哈希锁定实际发出的 JSON 字符串', async () => {
    localStorage.setItem('token', 'user-jwt-login')
    const payload = { message: 'a', context: { problemId: 1 } }
    const bodyText = JSON.stringify(payload)

    const headers = await getHeaders('POST', '/api/chat', payload)
    const bodyHash = headerGet(headers, 'X-Body-Sha256')

    expect(bodyHash).toBe(sha256Hex(bodyText))

    const otherText = JSON.stringify({ context: { problemId: 1 }, message: 'a' })
    expect(otherText).not.toBe(bodyText)
    expect(sha256Hex(otherText)).not.toBe(bodyHash)

    assertHmacMatches(headers, 'POST', '/api/chat')
  })

  it('UT-FE-SIG-06: 无登录 Bearer 时受保护路径仍注入六头（对照）', async () => {
    localStorage.removeItem('token')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { token: 'ai-session-anon', expiresIn: 3600 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    const headers = await getHeaders('POST', '/api/chat', { message: 'anon' })

    assertSixHeadersPresent(headers)
    expect(headerGet(headers, 'X-Client-Token')).toBe(SECRET)
    expect(headers.Authorization).toMatch(/^Bearer /)
  })

  it('UT-FE-SIG-07: 已登录时不得用换票结果覆盖用户 Bearer', async () => {
    localStorage.setItem('token', 'user-jwt-keep')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const headers = await getHeaders('POST', '/api/chat', { message: 'keep' })

    expect(headers.Authorization).toBe('Bearer user-jwt-keep')
    const tokenFetchCalls = fetchSpy.mock.calls.filter(([url]) =>
      String(url).includes('/auth/token')
    )
    expect(tokenFetchCalls).toHaveLength(0)
    assertSixHeadersPresent(headers)
  })

  it('UT-FE-SIG-08: 密钥缺失：明确失败且不发空签名', async () => {
    localStorage.setItem('token', 'user-jwt')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', '')

    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(getHeaders('POST', '/api/chat', { message: 'nosecret' })).rejects.toThrow(
      /VITE_AI_CLIENT_SECRET/
    )

    await expect(
      buildAiAuthHeaders('POST', '/api/chat', JSON.stringify({ message: 'nosecret' }))
    ).rejects.toThrow(/VITE_AI_CLIENT_SECRET/)

    const aiPathFetches = fetchSpy.mock.calls.filter(([url]) => String(url).includes('/api/chat'))
    expect(aiPathFetches).toHaveLength(0)
  })

  it('UT-FE-SIG-09: VITE_AI_CLIENT_ID 显式值写入 X-Client-Id', async () => {
    localStorage.setItem('token', 'user-jwt-login')
    vi.stubEnv('VITE_AI_CLIENT_ID', 'web-custom')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', SECRET)

    const headers = await getHeaders('POST', '/api/chat', { message: 'id' })

    expect(headerGet(headers, 'X-Client-Id')).toBe('web-custom')
    expect(headerGet(headers, 'X-Client-Token')).toBe(SECRET)
    assertSixHeadersPresent(headers)
    assertHmacMatches(headers, 'POST', '/api/chat')
  })

  it('UT-FE-SIG-10: B33 边界：不要求改后端默认开关 / 换票协议', () => {
    // 本用例仅锁文档边界：PASS 判据不包含「代码默认 AI_REQUIRE_SIGNED_HEADERS=true」
    // 也不要求修改 /api/auth/token 的 body/claims（属 B32 / S1）。
    expect(typeof fetchAiSessionToken).toBe('function')
    expect(normalizeAiPath('/chat')).toBe('/api/chat')
    // 证明本文件断言对象是前端六头，而非后端默认开关
    expect(true).toBe(true)
  })
})
