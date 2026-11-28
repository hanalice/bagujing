/**
 * 答案区与助教 Markdown 共用的 DOMPurify 白名单。
 * 与服务端 html-sanitizer 排版标签面对齐；不含 img/iframe/script。
 */

/** 允许保留的排版标签（无序集合语义）。 */
export const ALLOWED_TAGS = [
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li',
  'strong', 'b', 'em', 'i', 'u', 's', 'del',
  'code', 'pre', 'blockquote',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  'span', 'div', 'a',
] as const

/** 允许保留的属性（不含 src / on*）。 */
export const ALLOWED_ATTR = ['class', 'title', 'href', 'target', 'rel'] as const
