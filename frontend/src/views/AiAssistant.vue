<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { captureAiEvent, captureUiError } from '@/monitoring'
import { getHeaders } from '@/utils/request'

type ChatRole = 'user' | 'assistant' | 'system'

type ChatMessage = {
  id: string
  role: ChatRole
  content: string
}

type AssistantContext = {
  categoryId?: string | number
  problemId?: string | number
}

type ServerEvent =
  | { type: 'context'; snippets: unknown[] }
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string }

const props = withDefaults(
  defineProps<{
    context?: AssistantContext
    resetKey?: string | number
    debugSnippets?: boolean
  }>(),
  {
    context: undefined,
    resetKey: undefined,
    debugSnippets: false,
  }
)

const getRandomUUID = (): string => {
  const g = globalThis as unknown as { crypto?: Crypto }
  const cryptoObj = g.crypto

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    // RFC4122 v4
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80

    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  // Last-resort fallback (not cryptographically strong)
  const now = Date.now().toString(16)
  const rand = Math.random().toString(16).slice(2)
  const perf = typeof performance === 'undefined' ? '' : performance.now().toString(16)
  return `fallback-${now}-${perf}-${rand}`
}

const createId = (): string => {
  const g = globalThis as unknown as { crypto?: Crypto }
  const maybeRandomUUID = g.crypto?.randomUUID
  if (typeof maybeRandomUUID === 'function') return maybeRandomUUID.call(g.crypto)
  return getRandomUUID()
}

const route = useRoute()
const chatScrollRef = ref<HTMLElement | null>(null)

const input = ref('')
const isStreaming = ref(false)
const errorText = ref<string | null>(null)
const snippets = ref<unknown[] | null>(null)

const defaultAssistantMessage =
  '你好，我是题库AI小助手。你可以直接问，我会带上打开题目的上下文。'

const messages = ref<ChatMessage[]>([{ id: createId(), role: 'assistant', content: defaultAssistantMessage }])

const canSendText = (text: string) => !isStreaming.value && text.trim().length > 0
const canSend = computed(() => canSendText(input.value))

const appendMessage = (role: ChatRole, content: string) => {
  messages.value.push({ id: createId(), role, content })
}

const updateLastAssistant = (delta: string) => {
  const last = messages.value[messages.value.length - 1]
  if (!last || last.role !== 'assistant') {
    appendMessage('assistant', delta)
    return
  }
  last.content += delta
}

const scrollToBottom = async () => {
  await nextTick()
  const el = chatScrollRef.value
  el?.scrollTo({ top: el.scrollHeight })
}

const parseServerEvent = (rawLine: string): ServerEvent | null => {
  const jsonText = rawLine.replace(/^data:\s*/, '')
  try {
    return JSON.parse(jsonText) as ServerEvent
  } catch {
    return null
  }
}

let abortController: AbortController | null = null

const abortStream = () => {
  abortController?.abort()
  abortController = null
}

const resetConversation = () => {
  input.value = ''
  errorText.value = null
  snippets.value = null
  isStreaming.value = false
  messages.value = [{ id: createId(), role: 'assistant', content: defaultAssistantMessage }]
}

const isAbortError = (error: unknown) => {
  if (!(error instanceof Error)) return false
  return error.name === 'AbortError' || /aborted|abort/i.test(error.message)
}

const resolveContext = (): AssistantContext => {
  const categoryIdValue = route.query.categoryId
  const categoryValue = route.query.category
  let categoryFromRoute: string | undefined
  if (typeof categoryIdValue === 'string') {
    categoryFromRoute = categoryIdValue
  } else if (typeof categoryValue === 'string') {
    categoryFromRoute = categoryValue
  }

  const problemFromRoute = typeof route.params.id === 'string' ? route.params.id : undefined

  return {
    categoryId: props.context?.categoryId ?? categoryFromRoute,
    problemId: props.context?.problemId ?? problemFromRoute,
  }
}

watch(
  () => props.resetKey,
  (newKey, oldKey) => {
    if (oldKey === undefined || newKey === oldKey) return
    abortStream()
    resetConversation()
  }
)

async function* streamChat(
  payload: { message: string; context: AssistantContext },
  signal: AbortSignal
) {
  const bodyText = JSON.stringify(payload)
  const headers = await getHeaders('POST', '/api/chat', payload)
  const resp = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...headers,
    },
    signal,
    body: bodyText,
  })

  if (!resp.ok || !resp.body) {
    const t = await resp.text().catch(() => '')
    throw new Error(`Chat request failed: ${resp.status} ${t}`)
  }

  const reader = resp.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''

    for (const part of parts) {
      const line = part
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.startsWith('data:'))

      if (!line) continue
      const evt = parseServerEvent(line)
      /**
       * 这里必须用 `yield`（流式事件）：
       * - `yield evt`：产出一条事件，但生成器不会结束；下次迭代会从这里继续读后续 SSE。
       * - `return evt`：立刻结束生成器（迭代器 `done=true`），`for await...of` 会停止；后续事件将无法再输出。
       * - 注意：`for await...of` 只遍历 `yield` 的值，不会把 `return` 的 value 当成一次循环值。
       */
      if (evt) yield evt
    }
  }
}

const handleStreamEvent = (evt: ServerEvent, startedAt: number, firstDeltaAt: number | null): number | null => {
  if (evt.type === 'context') {
    snippets.value = evt.snippets
    return firstDeltaAt
  }

  if (evt.type === 'delta') {
    if (firstDeltaAt == null) {
      const now = Date.now()
      captureAiEvent('first_delta', 'info', {
        firstDeltaMs: now - startedAt,
        route: route.fullPath,
      })
      updateLastAssistant(evt.text)
      return now
    }

    updateLastAssistant(evt.text)
    return firstDeltaAt
  }

  if (evt.type === 'error') {
    errorText.value = evt.message
    captureAiEvent('stream_server_error', 'error', {
      message: evt.message,
      route: route.fullPath,
    })
    return firstDeltaAt
  }

  if (evt.type === 'done') {
    captureAiEvent('stream_done', 'info', {
      durationMs: Date.now() - startedAt,
      firstDeltaMs: firstDeltaAt == null ? null : firstDeltaAt - startedAt,
      route: route.fullPath,
    })
  }

  return firstDeltaAt
}

const sendText = async (text: string) => {
  if (!canSendText(text)) return

  abortStream()
  abortController = new AbortController()

  errorText.value = null
  snippets.value = null

  appendMessage('user', text.trim())
  appendMessage('assistant', '')
  await scrollToBottom()

  isStreaming.value = true
  const startedAt = Date.now()
  let firstDeltaAt: number | null = null
  captureAiEvent('stream_start', 'info', {
    route: route.fullPath,
  })

  const { categoryId, problemId } = resolveContext()

  try {
    for await (const evt of streamChat({ message: text.trim(), context: { categoryId, problemId } }, abortController.signal)) {
      firstDeltaAt = handleStreamEvent(evt, startedAt, firstDeltaAt)
      await scrollToBottom()
    }
  } catch (e: unknown) {
    if (isAbortError(e)) {
      captureAiEvent('stream_aborted', 'info', {
        durationMs: Date.now() - startedAt,
        route: route.fullPath,
      })
      return
    }

    errorText.value = e instanceof Error ? e.message : String(e)
    captureAiEvent('stream_failed', 'error', {
      durationMs: Date.now() - startedAt,
      route: route.fullPath,
    })
    captureUiError(e, 'AiAssistant.sendText', {
      route: route.fullPath,
      categoryId,
      problemId,
    })
  } finally {
    abortController = null
    isStreaming.value = false
    await scrollToBottom()
  }
}

const send = async (message?: string) => {
  const fromOutside = typeof message === 'string'
  const text = (fromOutside ? message : input.value).trim()
  if (!canSendText(text)) return

  if (!fromOutside) input.value = ''
  await sendText(text)
}

onUnmounted(() => {
  abortStream()
})

defineExpose({
  send,
  abortStream,
  resetConversation,
})
</script>

<template>
  <section class="space-y-3">
    <div
      ref="chatScrollRef"
      class="bg-white rounded-lg border border-gray-100 shadow-sm p-3 space-y-3 overflow-y-auto"
      style="height: 55vh"
      aria-label="Chat messages"
    >
      <div
        v-for="m in messages"
        :key="m.id"
        class="text-sm"
        :class="m.role === 'user' ? 'text-right' : 'text-left'"
      >
        <div
          class="inline-block max-w-[90%] rounded-lg px-3 py-2 whitespace-pre-wrap"
          :class="
            m.role === 'user'
              ? 'bg-blue-600 text-white'
              : m.role === 'assistant'
                ? 'bg-gray-50 text-gray-800 border border-gray-100'
                : 'bg-yellow-50 text-yellow-900'
          "
        >
          {{ m.content || (m.role === 'assistant' && isStreaming ? '…' : '') }}
        </div>
      </div>
    </div>

    <details v-if="debugSnippets && snippets" class="bg-white rounded-lg border border-gray-100 shadow-sm p-3">
      <summary class="text-sm text-gray-700 cursor-pointer">查看检索到的 snippets（调试用）</summary>
      <pre class="text-xs text-gray-600 overflow-auto mt-2">{{ JSON.stringify(snippets, null, 2) }}</pre>
    </details>

    <div class="bg-white rounded-lg border border-gray-100 shadow-sm p-2 flex items-end gap-2">
      <textarea
        v-model="input"
        rows="2"
        class="flex-1 resize-none outline-none text-sm text-gray-700 placeholder:text-gray-400"
        placeholder="输入你的问题，比如：这道题的考点是什么？"
        :disabled="isStreaming"
        @keydown.ctrl.enter.prevent="send()"
      />
      <button
        type="button"
        class="px-3 py-2 rounded-md text-sm"
        :class="canSend ? 'bg-blue-600 text-white hover:bg-blue-700' : 'bg-gray-100 text-gray-400 cursor-not-allowed'"
        :disabled="!canSend"
        @click="send()"
      >
        {{ isStreaming ? '生成中…' : '发送' }}
      </button>
    </div>

    <p class="text-xs text-gray-400">快捷键：Ctrl + Enter 发送</p>
  </section>
</template>
