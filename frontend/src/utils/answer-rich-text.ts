/**
 * 答案区富文本：旧 HTML 只消毒；三字段先按 Markdown 解析再消毒。
 * 调用方只能把返回值交给 v-html，禁止绑定原始 answer。
 */
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { ALLOWED_ATTR, ALLOWED_TAGS } from './rich-text-allowlist'

/**
 * 按答案白名单消毒 HTML，去掉脚本、事件属性和 javascript: 链接。
 */
function sanitizeAnswerHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTR],
  })
}

/**
 * 旧库 HTML 答案：保留排版标签，不经过 Markdown 解析。
 */
export function legacyAnswerToSafeHtml(raw: string): string {
  if (!raw.trim()) return ''
  return sanitizeAnswerHtml(raw)
}

/**
 * 三字段中的单个字符串：Markdown 解析后再消毒。
 */
export function structuredFieldToSafeHtml(raw: string): string {
  if (!raw.trim()) return ''
  const html = marked.parse(raw, { async: false, gfm: true, breaks: false }) as string
  return sanitizeAnswerHtml(html)
}
