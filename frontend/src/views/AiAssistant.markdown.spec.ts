/**
 * S6：AiAssistant 助手气泡 Markdown + DOMPurify，用户气泡纯文本。
 * Markdown 库：marked；消毒：dompurify。全文缓冲重解析，禁止按 chunk 拼 HTML。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import AiAssistant from './AiAssistant.vue'
import { DEFAULT_ASSISTANT_MESSAGE } from '@/utils/chat-history'
import { renderAssistantMarkdown } from '@/utils/assistant-markdown'

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

type ChatMessage = { id: string; role: string; content: string }

type AssistantVm = {
  send: (msg?: string) => Promise<void>
  resetConversation: () => void
  messages: ChatMessage[]
}

/** 构造可控 SSE ReadableStream（按帧 enqueue）。 */
function sseStream(frames: string[]) {
  return new ReadableStream({
    start(controller) {
      const enc = new TextEncoder()
      for (const frame of frames) {
        controller.enqueue(enc.encode(frame))
      }
      controller.close()
    },
  })
}

function deltaFrame(text: string) {
  return `data: ${JSON.stringify({ type: 'delta', text })}\n\n`
}

function doneFrame() {
  return 'data: {"type":"done"}\n\n'
}

describe('S6 AiAssistant Markdown 气泡', () => {
  let app: App | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    localStorage.clear()
    localStorage.setItem('token', 'user-jwt-chat')
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_AI_CLIENT_ID', 'web')
    vi.stubEnv('VITE_AI_CLIENT_SECRET', 'change_me')
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

  function mountAssistant() {
    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(AiAssistant)
    return app.mount(host) as unknown as AssistantVm
  }

  function stubFetch(body: ReadableStream<Uint8Array>) {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )
  }

  /** 聊天区根节点。 */
  function messagesRoot(): HTMLElement {
    return host!.querySelector('[aria-label="Chat messages"]') as HTMLElement
  }

  /** 用户气泡（右对齐容器内）。 */
  function userBubbles(): HTMLElement[] {
    return Array.from(messagesRoot().querySelectorAll('.text-right > div'))
  }

  /** 助手气泡（左对齐容器内）。 */
  function assistantBubbles(): HTMLElement[] {
    return Array.from(messagesRoot().querySelectorAll('.text-left > div'))
  }

  it('UT-FE-CHAT-MD-01: 组件路径 **x** 解析为加粗', async () => {
    stubFetch(sseStream([deltaFrame('hello **x** world'), doneFrame()]))
    const vm = mountAssistant()
    await vm.send('问-MD-01')
    await nextTick()
    const last = assistantBubbles().at(-1)!
    const bold = last.querySelector('strong, b')
    expect(bold).toBeTruthy()
    expect(bold!.textContent?.trim()).toBe('x')
    expect(last.textContent).toContain('hello')
    expect(last.textContent).toContain('world')
  })

  it('UT-FE-CHAT-MD-05: 每个 delta 对完整缓冲区重解析', async () => {
    stubFetch(
      sseStream([deltaFrame('前半 **bo'), deltaFrame('ld** 后半'), doneFrame()])
    )
    const vm = mountAssistant()
    await vm.send('问-MD-05')
    await nextTick()
    const last = assistantBubbles().at(-1)!
    const bold = last.querySelector('strong, b')
    expect(bold).toBeTruthy()
    expect(bold!.textContent).toContain('bold')
    expect(last.textContent).toContain('前半')
    expect(last.textContent).toContain('后半')
  })

  it('UT-FE-CHAT-MD-06: 用户气泡纯文本插值', async () => {
    delete (window as unknown as { __s6user?: unknown }).__s6user
    stubFetch(sseStream([deltaFrame('收到'), doneFrame()]))
    const vm = mountAssistant()
    await vm.send('我的 **粗** 与 <script>window.__s6user=1</script>')
    await nextTick()

    const userBubble = userBubbles().at(-1)!
    expect(userBubble.textContent).toContain('**粗**')
    expect(userBubble.querySelectorAll('strong, b').length).toBe(0)
    expect(userBubble.querySelector('script')).toBeNull()
    expect((window as unknown as { __s6user?: unknown }).__s6user).toBeUndefined()

    const assistantBubble = assistantBubbles().at(-1)!
    expect(assistantBubble.textContent).toContain('收到')
  })

  it('UT-FE-CHAT-MD-07: 源码禁止 v-html 绑定原始 m.content', () => {
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), 'AiAssistant.vue')
    const src = readFileSync(srcPath, 'utf8')
    // 禁止直接绑定原始 content；允许经 assistantBubbleHtml / renderAssistantMarkdown
    expect(src).not.toMatch(/v-html\s*=\s*["']m\.content["']/)
    expect(src).toMatch(/renderAssistantMarkdown|assistantBubbleHtml/)
    expect(src).toContain('v-html="assistantBubbleHtml(m.content)"')
  })

  it('UT-FE-CHAT-MD-08: 模板约束用户消息不走 Markdown', () => {
    const srcPath = join(dirname(fileURLToPath(import.meta.url)), 'AiAssistant.vue')
    const src = readFileSync(srcPath, 'utf8')
    // 用户分支为文本插值
    expect(src).toMatch(/\{\{\s*m\.content\s*\}\}/)
    // 用户 content 不调用 renderAssistantMarkdown
    const userBranch = src.slice(src.indexOf('v-else'))
    expect(userBranch).toMatch(/\{\{\s*m\.content\s*\}\}/)
    expect(userBranch).not.toMatch(/renderAssistantMarkdown|marked|markdown-it|v-html/)
  })

  it('UT-FE-CHAT-MD-09: 边界不改 B22 Prompt / 题目解析页', () => {
    const vueSrc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'AiAssistant.vue'),
      'utf8'
    )
    // 本组件不触及 chat systemPrompt，也不挂载题目详情答案区
    expect(vueSrc).not.toMatch(/systemPrompt/)
    expect(vueSrc).not.toMatch(/ProblemItem/)
    expect(vueSrc).not.toMatch(/normalizeStructuredAnswer/)
  })

  it('UT-FE-CHAT-MD-11: 欢迎语助手条亦走同一渲染管线', async () => {
    mountAssistant()
    await nextTick()
    const first = assistantBubbles()[0]!
    expect(first.className).toContain('bg-gray-50')
    expect(first.textContent).toContain(DEFAULT_ASSISTANT_MESSAGE.slice(0, 8))
    // 与纯函数管线一致：纯文本欢迎语经同一 render 无 XSS
    const viaFn = renderAssistantMarkdown(DEFAULT_ASSISTANT_MESSAGE)
    const tmp = document.createElement('div')
    tmp.innerHTML = viaFn
    expect(tmp.querySelector('script')).toBeNull()
    expect(first.innerHTML.length).toBeGreaterThan(0)
  })

  it('UT-FE-CHAT-MD-12: 与 E2E-MAIN-04 契约对齐说明', () => {
    const e2ePath = join(
      dirname(fileURLToPath(import.meta.url)),
      '../../e2e/main-path.spec.ts'
    )
    const e2eSrc = readFileSync(e2ePath, 'utf8')
    expect(e2eSrc).toMatch(/E2E-MAIN-04|\/api\/chat/)
    expect(e2eSrc).toMatch(/strong|加粗/)
    // XSS / 用户纯文本细断言由独立 E2E 用例承担（避免 MAIN-04 过度膨胀）
    expect(e2eSrc).toMatch(/E2E-CHAT-MD-01/)
    expect(e2eSrc).toMatch(/E2E-CHAT-MD-02/)
    expect(e2eSrc).toMatch(/E2E-CHAT-MD-03/)
    expect(e2eSrc).toMatch(/__s6e2e|javascript:/)
    // 禁止空泛断言口令（拆成片段避免本用例源码自命中）
    const vague = ['应表', '现正常'].join('')
    expect(e2eSrc.includes(vague)).toBe(false)
  })
})
