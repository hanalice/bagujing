/**
 * S3：助教 POST /api/chat 回传最近 6 轮 messages。
 */
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AiAssistant from './AiAssistant.vue'
import {
  buildChatHistoryPayload,
  CHAT_HISTORY_WINDOW,
  CHAT_INPUT_MAX_CHARS,
  DEFAULT_ASSISTANT_MESSAGE,
} from '@/utils/chat-history'

vi.mock('vue-router', () => ({
  useRoute: () => ({
    params: {},
    query: {},
    fullPath: '/assistant',
  }),
}))

vi.mock('@/monitoring', () => ({
  captureAiEvent: vi.fn(),
  captureUiError: vi.fn(),
}))

const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

type ChatMessage = { id: string; role: string; content: string }

type AssistantVm = {
  send: (msg?: string) => Promise<void>
  resetConversation: () => void
  messages: ChatMessage[]
}

const emptySse = () =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
      controller.close()
    },
  })

const headerFromInit = (init: RequestInit | undefined, name: string): string => {
  const headers = init?.headers
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return ''
  const record = headers as Record<string, string>
  for (const [key, value] of Object.entries(record)) {
    if (key.toLowerCase() === name.toLowerCase()) return value
  }
  return ''
}

describe('S3 助教回传最近 6 轮 messages', () => {
  let app: App | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('token', 'user-jwt-chat')
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_AI_CLIENT_ID', 'web')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', 'change_me')
    vi.stubEnv('VITE_CHAT_HISTORY_WINDOW', '2')
    Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
  })

  afterEach(() => {
    app?.unmount()
    app = null
    host?.remove()
    host = null
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  /** 挂载助教并返回可调用 send / 改历史的实例。 */
  function mountAssistant(props?: Record<string, unknown>) {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(AiAssistant, props)
    return app.mount(host) as unknown as AssistantVm
  }

  function stubFetch(body?: ReadableStream<Uint8Array>) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body ?? emptySse(), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
  }

  async function readBody(fetchMock: ReturnType<typeof stubFetch>, callIndex = 0) {
    const [url, init] = fetchMock.mock.calls[callIndex]!
    const urlText = String(url)
    const pathname = urlText.startsWith('/') ? urlText : new URL(urlText, 'http://localhost').pathname
    const raw = String(init?.body ?? '')
    return {
      pathname,
      method: String(init?.method || 'GET').toUpperCase(),
      raw,
      json: JSON.parse(raw) as {
        message: string
        context: { problemId?: number | string; categoryId?: string }
        messages: { role: string; content: string }[]
      },
      init,
    }
  }

  it('UT-FE-CHAT-HIST-01: 首次发送 body 含 message/context/messages', async () => {
    const fetchMock = stubFetch()
    const vm = mountAssistant()
    await vm.send('首问-S3')
    await nextTick()
    const body = await readBody(fetchMock)
    expect(body.pathname).toBe('/api/chat')
    expect(body.method).toBe('POST')
    expect(body.json.message).toBe('首问-S3')
    expect(body.json.context).toEqual(expect.any(Object))
    expect(Array.isArray(body.json.messages)).toBe(true)
    expect(body.json.messages.length).toBeLessThanOrEqual(6)
  })

  it('UT-FE-CHAT-HIST-02: 多轮后回传先旧后新的历史窗', async () => {
    const fetchMock = stubFetch()
    const vm = mountAssistant()
    vm.messages.splice(
      0,
      vm.messages.length,
      { id: '1', role: 'user', content: 'U1' },
      { id: '2', role: 'assistant', content: 'A1' },
      { id: '3', role: 'user', content: 'U2' },
      { id: '4', role: 'assistant', content: 'A2' }
    )
    await vm.send('U3-追问')
    const body = await readBody(fetchMock)
    expect(body.json.message).toBe('U3-追问')
    expect(body.json.messages.map((item) => item.content)).toEqual(['U1', 'A1', 'U2', 'A2'])
    expect(body.json.messages.some((item) => item.content === '')).toBe(false)
  })

  it('UT-FE-CHAT-HIST-03: 超过 6 条时前端只回传尾窗 6 条', async () => {
    expect(CHAT_HISTORY_WINDOW).toBe(6)
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `H${index + 1}`,
    }))
    const payload = buildChatHistoryPayload(history, '追问', {})
    expect(payload.messages).toHaveLength(6)
    expect(payload.messages.map((item) => item.content)).toEqual(['H3', 'H4', 'H5', 'H6', 'H7', 'H8'])
    expect(import.meta.env.VITE_CHAT_HISTORY_WINDOW).toBe('2')
    expect(buildChatHistoryPayload(history, '追问', {}).messages).toHaveLength(CHAT_HISTORY_WINDOW)
  })

  it('UT-FE-CHAT-HIST-04: 每条 content 按前端输入上限截断', () => {
    const long = `${'a'.repeat(80)}FE-TAIL`
    const payload = buildChatHistoryPayload(
      [{ role: 'assistant', content: long }],
      '短问',
      {},
      { maxChars: 32 }
    )
    expect(payload.messages[0]?.content.length).toBeLessThanOrEqual(32)
    expect(payload.messages[0]?.content.includes('FE-TAIL')).toBe(false)
    expect(payload.message).toBe('短问')
    expect(payload.messages).toHaveLength(1)
  })

  it('UT-FE-CHAT-HIST-05: 仍发送 context.problemId / categoryId', async () => {
    const fetchMock = stubFetch()
    const vm = mountAssistant({ context: { problemId: 42, categoryId: 'cat-9' } })
    vm.messages.push({ id: 'u', role: 'user', content: '已有' })
    await vm.send('继续')
    const body = await readBody(fetchMock)
    expect(Number(body.json.context.problemId)).toBe(42)
    expect(body.json.context.categoryId).toBe('cat-9')
    expect(body.json.messages.length).toBeGreaterThan(0)
    expect(body.json).toHaveProperty('context')
  })

  it('UT-FE-CHAT-HIST-06: role 仅 user/assistant，不回传 system', () => {
    const payload = buildChatHistoryPayload(
      [
        { role: 'system', content: '不要回传' },
        { role: 'user', content: '问' },
        { role: 'tool', content: '工具' },
        { role: 'assistant', content: '答' },
      ],
      '再问',
      {}
    )
    expect(payload.messages.every((item) => item.role === 'user' || item.role === 'assistant')).toBe(true)
    expect(payload.messages.some((item) => item.role === 'system' || item.role === 'tool')).toBe(false)
    expect(payload.messages.every((item) => typeof item.content === 'string')).toBe(true)
  })

  it('UT-FE-CHAT-HIST-07: 不做滚动摘要，messages 保持尾窗条数', () => {
    const history = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `M${index + 1}`,
    }))
    const payload = buildChatHistoryPayload(history, '新消息', {})
    expect(payload.messages).toHaveLength(6)
    expect(payload.messages.some((item) => item.role === 'summary' || item.content.startsWith('对话摘要'))).toBe(false)
    for (const mark of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6']) {
      expect(payload.messages.find((item) => item.content === mark)).toBeTruthy()
    }
  })

  it('UT-FE-CHAT-HIST-08: 不断言气泡 Markdown，只锁请求体', async () => {
    const sse = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('data: {"type":"delta","text":"**粗**<script>x</script>"}\n\n')
        )
        controller.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n'))
        controller.close()
      },
    })
    const fetchMock = stubFetch(sse)
    const vm = mountAssistant()
    await vm.send('看请求')
    const body = await readBody(fetchMock)
    expect(body.json.message).toBe('看请求')
    expect(body.json).toHaveProperty('messages')
    expect(body.json).toHaveProperty('context')
  })

  it('UT-FE-CHAT-HIST-09: 空历史时仍发送 message 与 context', async () => {
    const fetchMock = stubFetch()
    const vm = mountAssistant()
    vm.resetConversation()
    await vm.send('单轮')
    const body = await readBody(fetchMock)
    expect(body.json.message).toBe('单轮')
    expect(body.json.context).toEqual(expect.any(Object))
    expect(body.json.messages.length).toBeLessThanOrEqual(1)
    if (body.json.messages.length === 1) {
      expect(body.json.messages[0]?.content).toBe(DEFAULT_ASSISTANT_MESSAGE)
    }
  })

  it('UT-FE-CHAT-HIST-10: 带 messages 时 Body 哈希仍对发出串', async () => {
    const fetchMock = stubFetch()
    const vm = mountAssistant()
    vm.messages.push({ id: 'u', role: 'user', content: '上一问' })
    await vm.send('这一问')
    const body = await readBody(fetchMock)
    expect(body.json.messages.length).toBeGreaterThanOrEqual(1)
    expect(headerFromInit(body.init, 'X-Body-Sha256')).toBe(sha256Hex(body.raw))
    const without = { ...body.json, messages: undefined }
    expect(sha256Hex(JSON.stringify(without))).not.toBe(headerFromInit(body.init, 'X-Body-Sha256'))
  })

  it('UT-FE-CHAT-HIST-11: 窗口常量写死且默认上限与 Guard 对齐', () => {
    expect(CHAT_HISTORY_WINDOW).toBe(6)
    expect(CHAT_INPUT_MAX_CHARS).toBe(1200)
    const payload = buildChatHistoryPayload(
      [{ role: 'user', content: '只有这一条' }],
      '当前',
      {}
    )
    expect(payload.messages).toEqual([{ role: 'user', content: '只有这一条' }])
    expect(payload).not.toHaveProperty('summary')
  })
})
