/**
 * S6 / S20：助教助手气泡 Markdown → HTML → DOMPurify。
 * 每个 SSE delta 应对**完整缓冲区**调用本函数，禁止按 chunk 解析后再拼接 HTML。
 * 消毒白名单与 answer-rich-text（rich-text-allowlist）对齐。
 */
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { ALLOWED_ATTR, ALLOWED_TAGS } from './rich-text-allowlist'

// 同步解析；流式场景下对全文重解析，不启用 marked 异步路径
marked.setOptions({ gfm: true, breaks: false })

/**
 * 将助手已累积全文解析为可安全写入 DOM 的 HTML。
 * 管线：marked.parse → DOMPurify.sanitize（ALLOWED_TAGS/ATTR）；禁止跳过任一步。
 */
export function renderAssistantMarkdown(md: string): string {
  if (!md) return ''
  const rawHtml = marked.parse(md, { async: false }) as string
  return DOMPurify.sanitize(rawHtml, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
  })
}
