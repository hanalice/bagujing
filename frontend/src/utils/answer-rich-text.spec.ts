/**
 * 答案富文本：旧 HTML 只消毒；三字段 Markdown → DOMPurify。
 */
import { describe, expect, it } from 'vitest'
import { legacyAnswerToSafeHtml, structuredFieldToSafeHtml } from './answer-rich-text'

function mountHtml(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('答案富文本消毒', () => {
  it('旧 HTML 保留段落和代码块，剥掉 script', () => {
    const html = legacyAnswerToSafeHtml(
      '<p>核心在于 <strong>缓存</strong></p><pre><code>const a = 1</code></pre><script>window.__legacyRich=1</script>',
    )
    const el = mountHtml(html)
    try {
      expect(el.querySelector('strong')?.textContent).toBe('缓存')
      expect(el.querySelector('pre code')?.textContent).toContain('const a = 1')
      expect(el.querySelector('script')).toBeNull()
      expect((window as unknown as { __legacyRich?: number }).__legacyRich).toBeUndefined()
    } finally {
      el.remove()
    }
  })

  it('旧 HTML 去掉 javascript: 链接', () => {
    const html = legacyAnswerToSafeHtml('<a href="javascript:alert(1)">点</a>')
    const el = mountHtml(html)
    try {
      const href = (el.querySelector('a')?.getAttribute('href') || '').toLowerCase()
      expect(href.startsWith('javascript:')).toBe(false)
    } finally {
      el.remove()
    }
  })

  it('三字段 Markdown 加粗与代码块可渲染，script 不进 DOM', () => {
    delete (window as unknown as { __fieldRich?: number }).__fieldRich
    const html = structuredFieldToSafeHtml('结论 **要点**\n\n```js\nconst a = 1\n```\n\n<script>window.__fieldRich=1</script>')
    const el = mountHtml(html)
    try {
      expect(el.querySelector('strong')?.textContent).toBe('要点')
      expect(el.querySelector('pre code')?.textContent).toContain('const a = 1')
      expect(el.querySelector('script')).toBeNull()
      expect((window as unknown as { __fieldRich?: number }).__fieldRich).toBeUndefined()
    } finally {
      el.remove()
    }
  })
})
