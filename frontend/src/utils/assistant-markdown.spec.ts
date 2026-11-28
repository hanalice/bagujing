/**
 * S6 / S20：renderAssistantMarkdown 纯函数（marked → DOMPurify 白名单）。
 * 库：marked + dompurify；白名单与 answer-rich-text 共用 rich-text-allowlist。
 */
import { describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import { renderAssistantMarkdown } from './assistant-markdown'
import { ALLOWED_ATTR, ALLOWED_TAGS } from './rich-text-allowlist'
import { legacyAnswerToSafeHtml } from './answer-rich-text'

/** 把消毒后的 HTML 挂到临时节点，便于查询 DOM。 */
function mountHtml(html: string): HTMLElement {
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

/** 无序集合全等。 */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((x) => setA.has(x))
}

describe('S6/S20 renderAssistantMarkdown 纯函数', () => {
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
      const config = sanitizeSpy.mock.calls[0]?.[1] as
        | { ALLOWED_TAGS?: string[]; ALLOWED_ATTR?: string[] }
        | undefined
      expect(config?.ALLOWED_TAGS).toBeTruthy()
      expect(config?.ALLOWED_ATTR).toBeTruthy()
      expect(sameSet(config!.ALLOWED_TAGS!, [...ALLOWED_TAGS])).toBe(true)
      expect(sameSet(config!.ALLOWED_ATTR!, [...ALLOWED_ATTR])).toBe(true)
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

  it('UT-FE-CHAT-MD-07: 禁止模型原文未消毒直接 v-html（运行时；S20 无 img）', () => {
    delete (window as unknown as { __s6raw?: unknown }).__s6raw
    const html = renderAssistantMarkdown('<img src=x onerror=window.__s6raw=1>')
    const el = mountHtml(html)
    try {
      expect((window as unknown as { __s6raw?: unknown }).__s6raw).toBeUndefined()
      expect(el.querySelectorAll('img').length).toBe(0)
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

  it('UT-FE-CHAT-MD-13: S20 sanitize 白名单与 answer-rich-text 对齐', () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize')
    try {
      renderAssistantMarkdown('**x**')
      expect(sanitizeSpy).toHaveBeenCalled()
      const config = sanitizeSpy.mock.calls[0]?.[1] as
        | { ALLOWED_TAGS?: string[]; ALLOWED_ATTR?: string[] }
        | undefined
      expect(config).toBeTruthy()
      expect(sameSet(config!.ALLOWED_TAGS!, [...ALLOWED_TAGS])).toBe(true)
      expect(sameSet(config!.ALLOWED_ATTR!, [...ALLOWED_ATTR])).toBe(true)
      // 不得多出危险标签；ATTR 精确全等
      for (const forbidden of ['img', 'iframe', 'script', 'object', 'style']) {
        expect(config!.ALLOWED_TAGS!).not.toContain(forbidden)
      }
      expect(sameSet(config!.ALLOWED_ATTR!, ['class', 'title', 'href', 'target', 'rel'])).toBe(true)
      // 两边共用同一导出（rich-text-allowlist）
      expect(ALLOWED_TAGS).toBeTruthy()
      expect(ALLOWED_ATTR).toBeTruthy()
    } finally {
      sanitizeSpy.mockRestore()
    }
  })

  it('UT-FE-CHAT-MD-14: S20 img 标签不保留', () => {
    delete (window as unknown as { __s20img?: unknown }).__s20img
    const html = renderAssistantMarkdown(
      '安全正文<img src="https://evil.example/x.png" onerror="window.__s20img=1">\n\n![](https://evil.example/y.png)'
    )
    const el = mountHtml(html)
    try {
      expect(el.querySelectorAll('img').length).toBe(0)
      expect((window as unknown as { __s20img?: unknown }).__s20img).toBeUndefined()
      expect(el.textContent).toContain('安全正文')
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-15: S20 iframe 标签不保留', () => {
    const html = renderAssistantMarkdown('可见<iframe src="https://evil.example/frame"></iframe>文本')
    const el = mountHtml(html)
    try {
      expect(el.querySelector('iframe')).toBeNull()
      expect(el.textContent).toContain('可见')
      expect(el.textContent).toContain('文本')
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-16: S20 白名单内排版标签仍可保留', () => {
    const md =
      '<p>段</p><strong>粗</strong><em>斜</em>\n\n```js\nconst z=1\n```\n\n[文档](https://example.com)'
    const html = renderAssistantMarkdown(md)
    const el = mountHtml(html)
    try {
      expect(el.querySelector('p')).toBeTruthy()
      expect(el.querySelector('strong, b')?.textContent).toContain('粗')
      expect(el.textContent).toContain('段')
      expect(el.querySelector('pre')).toBeTruthy()
      expect(el.querySelector('code')?.textContent).toContain('const z=1')
      const a = el.querySelector('a')
      if (a) {
        const href = (a.getAttribute('href') || '').toLowerCase()
        expect(href.startsWith('javascript:')).toBe(false)
        expect(href === 'https://example.com' || href.startsWith('#') || href === '').toBe(true)
      }
      expect(el.querySelector('img')).toBeNull()
      expect(el.querySelector('iframe')).toBeNull()
      expect(el.querySelector('script')).toBeNull()
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-17: S20 白名单收紧后加粗与围栏回归仍过', () => {
    const boldHtml = renderAssistantMarkdown('hello **x** world')
    const boldEl = mountHtml(boldHtml)
    try {
      const bold = boldEl.querySelector('strong, b')
      expect(bold).toBeTruthy()
      expect(bold!.textContent?.trim()).toBe('x')
    } finally {
      boldEl.remove()
    }

    const fenceHtml = renderAssistantMarkdown('```js\nconst a = 1\n```')
    const fenceEl = mountHtml(fenceHtml)
    try {
      expect(fenceEl.querySelector('pre')).toBeTruthy()
      expect(fenceEl.querySelector('code')?.textContent).toContain('const a = 1')
    } finally {
      fenceEl.remove()
    }
  })

  it('UT-FE-CHAT-MD-18: S20 边界不改 answer-rich-text 调用方语义', () => {
    const html = legacyAnswerToSafeHtml('<p>ok</p><script>1</script>')
    const el = mountHtml(html)
    try {
      expect(el.querySelector('script')).toBeNull()
      expect(el.querySelector('p')?.textContent).toContain('ok')
    } finally {
      el.remove()
    }
  })

  it('UT-FE-CHAT-MD-19: S20 residual 收紧标签面；事件属性默认剥离', () => {
    delete (window as unknown as { __s20clk?: unknown }).__s20clk
    delete (window as unknown as { __s20err?: unknown }).__s20err
    const html = renderAssistantMarkdown(
      '<p onclick="window.__s20clk=1" onmouseover="evil()">文</p><img src=x onerror=window.__s20err=1>'
    )
    const el = mountHtml(html)
    try {
      expect(el.querySelectorAll('img').length).toBe(0)
      const p = el.querySelector('p')
      if (p) {
        expect(p.getAttribute('onclick')).toBeNull()
        expect(p.getAttribute('onmouseover')).toBeNull()
      }
      expect((window as unknown as { __s20clk?: unknown }).__s20clk).toBeUndefined()
      expect((window as unknown as { __s20err?: unknown }).__s20err).toBeUndefined()
      expect(el.textContent).toContain('文')
    } finally {
      el.remove()
    }
  })
})
