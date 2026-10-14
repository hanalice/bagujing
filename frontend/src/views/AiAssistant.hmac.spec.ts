/**
 * B33 UT-FE-SIG-03：AiAssistant chat fetch 登录态发出 HMAC 六头
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AiAssistant from './AiAssistant.vue'

vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: {},
    query: {},
    fullPath: '/problems/1',
  }),
}))

vi.mock('@/monitoring', () => ({
  captureAiEvent: vi.fn(),
  captureUiError: vi.fn(),
}))

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

const headerFromInit = (init: RequestInit | undefined, name: string): string => {
  const headers = init?.headers
  if (!headers) return ''
  if (headers instanceof Headers) {
    return headers.get(name) || headers.get(name.toLowerCase()) || ''
  }
  if (Array.isArray(headers)) {
    const hit = headers.find(([k]) => k.toLowerCase() === name.toLowerCase())
    return hit?.[1] ?? ''
  }
  const record = headers as Record<string, string>
  for (const [k, v] of Object.entries(record)) {
    if (k.toLowerCase() === name.toLowerCase()) return v
  }
  return ''
}

describe('AiAssistant HMAC chat fetch (B33)', () => {
  let app: App | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    localStorage.clear()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_AI_CLIENT_ID', 'web')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', 'change_me')
    vi.restoreAllMocks()
    // jsdom 未实现 Element.scrollTo，sendText 会调用 scrollToBottom
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  })

  afterEach(() => {
    if (app) {
      app.unmount()
      app = null
    }
    if (host) {
      host.remove()
      host = null
    }
    vi.unstubAllEnvs()
  })

  it('UT-FE-SIG-03: AiAssistant chat fetch：登录态发出六头', async () => {
    localStorage.setItem('token', 'user-jwt-chat')

    const sseBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
        controller.close()
      },
    })

    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(sseBody, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(AiAssistant)
    const vm = app.mount(host) as unknown as { send: (msg?: string) => Promise<void> }

    await vm.send('hello hmac')
    await nextTick()

    expect(fetchMock).toHaveBeenCalled()
    const [url, init] = fetchMock.mock.calls[0]!
    const urlText = String(url)
    expect(urlText === '/api/chat' || new URL(urlText, 'http://localhost').pathname === '/api/chat').toBe(
      true
    )
    expect(String(init?.method || 'GET').toUpperCase()).toBe('POST')

    const auth = headerFromInit(init, 'Authorization')
    expect(auth).toBe('Bearer user-jwt-chat')

    for (const name of [
      'X-Client-Id',
      'X-Client-Token',
      'X-Ts',
      'X-Nonce',
      'X-Body-Sha256',
      'X-Signature',
    ]) {
      expect(headerFromInit(init, name), name).toBeTruthy()
    }

    const body = String(init?.body ?? '')
    expect(body).toBeTruthy()
    expect(headerFromInit(init, 'X-Body-Sha256')).toBe(sha256Hex(body))
  })
})
