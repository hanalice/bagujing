/**
 * S6：renderAssistantMarkdown 纯函数（marked → DOMPurify）。
 * 库：marked + dompurify。
 */
import { describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import { renderAssistantMarkdown } from './assistant-markdown'

/** 把消毒后的 HTML 挂到临时节点，便于查询 DOM。 */
function mountHtml(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

describe('S6 renderAssistantMarkdown 纯函数', () => {
  it('UT-FE-CHAT-MD-01: **x** 解析为加粗', () => {
    const html = renderAssistantMarkdown('hello **x** world')
    const el = mountHtml(html)
    try {
      const bold = el.querySelector('strong, b')
      expect(bold).toBeTruthy()
      expect(bold!.textContent?.trim()).toBe('x')
      expect(el.textContent).toContain('hello')
      expect(el.textContent).toContain('world')
      expect(el.textContent?.includes('**x**') && !bold).toBe(false)
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-02: 围栏代码块出 pre/code', () => {
    const md = '```js\nconst a = 1\n```'
    const html = renderAssistantMarkdown(md)
    const el = mountHtml(html)
    try {
      const pre = el.querySelector('pre')
      expect(pre).toBeTruthy()
      const code = pre!.querySelector('code') ?? el.querySelector('code')
      expect(code).toBeTruthy()
      expect(code!.textContent).toContain('const a = 1')
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-03: 含 <script> 消毒后不进 DOM', () => {
    delete (window as unknown as { __s6ut?: unknown }).__s6ut
    const html = renderAssistantMarkdown('安全<p>ok</p><script>window.__s6ut=1</script>')
    const el = mountHtml(html)
    try {
      expect((window as unknown as { __s6ut?: unknown }).__s6ut).toBeUndefined()
      expect(el.querySelector('script')).toBeNull()
      expect(el.textContent).toContain('ok')
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-04: 含 javascript: 消毒后不进危险 URL', () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize')
    const html = renderAssistantMarkdown(
      '[点我](javascript:alert(1))\n\n<a href="javascript:alert(1)">x</a>'
    )
    const el = mountHtml(html)
    try {
      expect(sanitizeSpy).toHaveBeenCalled()
      const anchors = el.querySelectorAll('a')
      for (const a of anchors) {
        const href = (a.getAttribute('href') || '').toLowerCase()
        expect(href.startsWith('javascript:')).toBe(false)
      }
    } finally {
      sanitizeSpy.mockRestore()
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-07: 禁止模型原文未消毒直接 v-html（运行时）', () => {
    delete (window as unknown as { __s6raw?: unknown }).__s6raw
    const html = renderAssistantMarkdown('<img src=x onerror=window.__s6raw=1>')
    const el = mountHtml(html)
    try {
      expect((window as unknown as { __s6raw?: unknown }).__s6raw).toBeUndefined()
      const img = el.querySelector('img')
      if (img) {
        expect(img.getAttribute('onerror')).toBeNull()
      }
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-10: residual 不要求 LaTeX / mermaid', () => {
    const html = renderAssistantMarkdown('$E=mc^2$\n\n```mermaid\ngraph TD;A-->B\n```')
    const el = mountHtml(html)
    try {
      // 允许降级：公式按文本、mermaid 按代码块；不得以 KaTeX/SVG 缺失为 FAIL
      expect(el.textContent).toContain('E=mc^2')
      const hasMathml = !!el.querySelector('math')
      const hasSvgFlow = !!el.querySelector('svg')
      expect(hasMathml || hasSvgFlow || el.textContent?.includes('E=mc^2')).toBe(true)
      const pre = el.querySelector('pre')
      if (pre) {
        expect(pre.textContent).toMatch(/graph TD|A-->B/)
      }
    } finally {
      el.remove()
    }
  })
})
