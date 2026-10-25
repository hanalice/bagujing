/**
 * S3：助教回传给 POST /api/chat 的历史窗。
 * N 与 C31 一样写死为 6，不读 Vite 环境变量。
 */

/** 与 C31 相同的尾窗条数。 */
export const CHAT_HISTORY_WINDOW = 6

/** 与 Guard 默认 AI_MAX_INPUT_CHARS 对齐的单条输入上限。 */
export const CHAT_INPUT_MAX_CHARS = 1200

export const DEFAULT_ASSISTANT_MESSAGE =
  '你好，我是题库AI小助手。你可以直接问，我会带上打开题目的上下文。'

export type ChatHistoryRole = 'user' | 'assistant'

export type ChatHistoryItem = {
  role: ChatHistoryRole
  content: string
}

type HistorySource = {
  role: string
  content: string
}

/**
 * 按上限截断单条 content。未超限则原样返回。
 */
export function truncateChatContent(content: string, maxChars: number = CHAT_INPUT_MAX_CHARS): string {
  if (content.length <= maxChars) return content
  return content.slice(0, maxChars)
}

/**
 * 用发送前已完成的气泡组包。不含本次 message，也不含空占位助手气泡。
 * window 固定为 CHAT_HISTORY_WINDOW，调用方传入的窗口大小会被忽略。
 */
export function buildChatHistoryPayload<TContext extends object>(
  history: HistorySource[],
  currentText: string,
  context: TContext,
  options?: { maxChars?: number }
) {
  const maxChars = options?.maxChars ?? CHAT_INPUT_MAX_CHARS
  const completed: ChatHistoryItem[] = []
  for (const item of history) {
    if (item.role !== 'user' && item.role !== 'assistant') continue
    if (typeof item.content !== 'string' || item.content.length === 0) continue
    completed.push({
      role: item.role,
      content: truncateChatContent(item.content, maxChars),
    })
  }
  const messages = completed.slice(-CHAT_HISTORY_WINDOW)
  return {
    message: currentText.trim(),
    context,
    messages,
  }
}
