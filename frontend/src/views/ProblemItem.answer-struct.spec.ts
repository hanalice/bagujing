/**
 * C42：解析三字段前端渲染单测（对齐 docs/test_cases.md §4.3）
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp, nextTick, type App } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import DOMPurify from 'dompurify'
import {
  legacyAnswerToPlainText,
  normalizeStructuredAnswer,
} from '@/utils/normalizeStructuredAnswer'
import type { GenerateProblemAnswerResponse, Problem } from '@/api/problemItem'
import ProblemItem from './ProblemItem.vue'

vi.mock('@/api/problemItem', async () => {
  const actual = await vi.importActual<typeof import('@/api/problemItem')>('@/api/problemItem')
  return {
    ...actual,
    getProblemById: vi.fn(),
    generateProblemAnswer: vi.fn(),
  }
})

import { getProblemById, generateProblemAnswer } from '@/api/problemItem'

const vueSourcePath = join(dirname(fileURLToPath(import.meta.url)), 'ProblemItem.vue')

function baseProblem(overrides: Partial<Problem> & Record<string, unknown> = {}): Problem & Record<string, unknown> {
  return {
    time: '2026-01-01',
    url: '',
    id: 42,
    name: '题目标题',
    briefName: '简题',
    options: null,
    type: 1,
    keyPoints: ['标签A'],
    years: null,
    level: 1,
    freq: 0.1,
    categoryId: '1',
    answer: '',
    analysis: '',
    moreAsk: '',
    mindmap: '',
    companies: [],
    ...overrides,
  }
}

describe('C42 normalizeStructuredAnswer / ProblemItem 三字段渲染', () => {
  let app: App | null = null
  let host: HTMLElement | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    delete (window as unknown as { __ut?: number }).__ut
    delete (window as unknown as { __legacy?: number }).__legacy
  })

  afterEach(() => {
    if (app) {
      app.unmount()
      app = null
    }
    if (host) {
      host.remove()
      host = null
    }
  })

  async function mountWithProblem(data: Problem & Record<string, unknown>) {
    vi.mocked(getProblemById).mockResolvedValue(data as Problem)
    vi.mocked(generateProblemAnswer).mockResolvedValue({
      id: Number(data.id),
      answer: data.answer || '',
      cached: true,
    })

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProblemItem, { problemId: Number(data.id) })
    app.use(createPinia())
    app.mount(host)
    await nextTick()
    await nextTick()
    // 等待 watch(immediate) 触发的异步 fetch
    await vi.waitFor(() => {
      expect(host!.querySelector('.problem-detail')).toBeTruthy()
    })
    return host
  }

  it('UT-FE-ANSWER-01: 顶层三字段归一化成功', async () => {
    const answerJson = '{"summary":"结论A","keyPoints":["p1","p2"],"nextStep":"下一步A"}'
    const data = {
      summary: '结论A',
      keyPoints: ['p1', 'p2'],
      nextStep: '下一步A',
      answer: answerJson,
      cached: false,
    }
    const normalized = normalizeStructuredAnswer(data)
    expect(normalized).toEqual({
      kind: 'structured',
      value: { summary: '结论A', keyPoints: ['p1', 'p2'], nextStep: '下一步A' },
    })

    // 模拟 generate/详情顶层暴露冻约三字段（此时 keyPoints 为解析要点）
    await mountWithProblem({
      ...baseProblem({ answer: answerJson }),
      summary: '结论A',
      keyPoints: ['p1', 'p2'],
      nextStep: '下一步A',
    })

    expect(host!.textContent).toContain('结论A')
    expect(host!.textContent).toContain('p1')
    expect(host!.textContent).toContain('p2')
    expect(host!.textContent).toContain('下一步A')
    const lis = host!.querySelectorAll('[data-testid="answer-keypoints"] li')
    expect(lis.length).toBe(2)
    const panel = host!.querySelector('[data-testid="answer-panel"]')
    expect(panel).toBeTruthy()
    expect(panel!.innerHTML).not.toBe(answerJson)
    expect(host!.querySelector('[data-testid="answer-structured"]')).toBeTruthy()
  })

  it('UT-FE-ANSWER-02: 仅有序列化 answer JSON 时仍可三字段渲染', async () => {
    const answerJson = '{"summary":"从answer来","keyPoints":["仅此项"],"nextStep":"继续"}'
    const normalized = normalizeStructuredAnswer({ answer: answerJson })
    expect(normalized.kind).toBe('structured')
    if (normalized.kind === 'structured') {
      expect(normalized.value.keyPoints).toHaveLength(1)
      expect(normalized.value.summary).toBe('从answer来')
    }

    await mountWithProblem(baseProblem({
      answer: answerJson,
      keyPoints: ['标签X'],
    }))

    expect(host!.textContent).toContain('从answer来')
    expect(host!.textContent).toContain('仅此项')
    expect(host!.textContent).toContain('继续')
    expect(host!.innerHTML.includes('{"summary":')).toBe(false)
    expect(host!.querySelectorAll('[data-testid="answer-keypoints"] li').length).toBe(1)
  })

  it('UT-FE-ANSWER-03: 空 keyPoints 仍展示 summary 与 nextStep', async () => {
    const normalized = normalizeStructuredAnswer({
      summary: '只有结论',
      keyPoints: [],
      nextStep: '去练习',
    })
    expect(normalized).toEqual({
      kind: 'structured',
      value: { summary: '只有结论', keyPoints: [], nextStep: '去练习' },
    })

    await mountWithProblem(baseProblem({
      summary: '只有结论',
      keyPoints: [],
      nextStep: '去练习',
      answer: '{"summary":"只有结论","keyPoints":[],"nextStep":"去练习"}',
    }))

    expect(host!.textContent).toContain('只有结论')
    expect(host!.textContent).toContain('去练习')
    expect(host!.querySelectorAll('[data-testid="answer-keypoints"] li').length).toBe(0)
    expect(host!.querySelector('[data-testid="answer-structured"]')).toBeTruthy()
  })

  it('UT-FE-ANSWER-04: 冻约字段名：别名不得当作正式三字段', () => {
    const aliasOnly = normalizeStructuredAnswer({
      points: ['x'],
      conclusion: 'y',
      next: 'z',
      answer: '<p>not-json</p>',
    })
    expect(aliasOnly.kind).not.toBe('structured')
    expect(aliasOnly.kind).toBe('legacy')

    const withExtra = normalizeStructuredAnswer({
      summary: '正式',
      keyPoints: ['k'],
      nextStep: '下一步',
      html: '<p>忽略我</p>',
    })
    expect(withExtra).toEqual({
      kind: 'structured',
      value: { summary: '正式', keyPoints: ['k'], nextStep: '下一步' },
    })
    if (withExtra.kind === 'structured') {
      expect(Object.keys(withExtra.value).sort()).toEqual(['keyPoints', 'nextStep', 'summary'])
    }
  })

  it('UT-FE-ANSWER-05: 字段内 HTML/脚本按文本安全展示', async () => {
    await mountWithProblem(baseProblem({
      summary: '看这里<script>window.__ut=1</script>',
      keyPoints: ['<img src=x onerror=window.__ut=2>'],
      nextStep: '<b>粗</b>',
      answer: JSON.stringify({
        summary: '看这里<script>window.__ut=1</script>',
        keyPoints: ['<img src=x onerror=window.__ut=2>'],
        nextStep: '<b>粗</b>',
      }),
    }))

    expect((window as unknown as { __ut?: number }).__ut).toBeUndefined()
    expect(host!.textContent).toMatch(/粗/)
    expect(host!.querySelector('[data-testid="answer-structured"]')).toBeTruthy()
    expect(host!.querySelector('script')).toBeNull()
  })

  it('UT-FE-ANSWER-06: 旧 HTML answer 降级：脚本不执行', async () => {
    const raw = '<p>旧解析</p><script>window.__legacy=1</script>'
    expect(legacyAnswerToPlainText(raw)).toContain('旧解析')

    await mountWithProblem(baseProblem({
      answer: raw,
      keyPoints: ['标签'],
    }))

    expect((window as unknown as { __legacy?: number }).__legacy).toBeUndefined()
    expect(host!.textContent).toContain('旧解析')
    expect(host!.querySelector('[data-testid="answer-legacy"]')).toBeTruthy()
    expect(host!.querySelector('[data-testid="answer-legacy"] script')).toBeNull()
    expect(host!.querySelector('[data-testid="answer-structured"]')).toBeNull()
  })

  it('UT-FE-ANSWER-07: 其它字段 DOMPurify 保持不动', async () => {
    const sanitizeSpy = vi.spyOn(DOMPurify, 'sanitize')
    await mountWithProblem(baseProblem({
      name: '<b>t</b><script>window.__x=1</script>',
      answer: '{"summary":"结论","keyPoints":["k"],"nextStep":"n"}',
      analysis: '<b>t</b><script>window.__x=1</script>',
      moreAsk: '<i>ask</i><script>bad()</script>',
    }))

    expect(sanitizeSpy).toHaveBeenCalled()
    const calledWithAnalysisOrMore = sanitizeSpy.mock.calls.some(
      (args) => typeof args[0] === 'string' && (args[0].includes('<b>t</b>') || args[0].includes('<i>ask</i>')),
    )
    expect(calledWithAnalysisOrMore).toBe(true)
    expect(host!.querySelector('[data-testid="answer-structured"]')).toBeTruthy()
    sanitizeSpy.mockRestore()
  })

  it('UT-FE-ANSWER-08: generate 响应消费三字段而非仅 answer 字符串', async () => {
    const generateRes: GenerateProblemAnswerResponse = {
      id: 42,
      cached: false,
      summary: '生成结论',
      keyPoints: ['g1'],
      nextStep: '生成下一步',
      answer: '{"summary":"生成结论","keyPoints":["g1"],"nextStep":"生成下一步"}',
    }

    vi.mocked(getProblemById).mockResolvedValue(baseProblem({
      id: 42,
      answer: '',
      keyPoints: ['标签'],
    }) as Problem)
    vi.mocked(generateProblemAnswer).mockResolvedValue(generateRes)

    host = document.createElement('div')
    document.body.appendChild(host)
    app = createApp(ProblemItem, { problemId: 42 })
    app.use(createPinia())
    app.mount(host)

    await vi.waitFor(() => {
      expect(host!.textContent).toContain('生成结论')
    })

    expect(host!.textContent).toContain('g1')
    expect(host!.textContent).toContain('生成下一步')
    expect(host!.querySelector('[data-testid="answer-structured"]')).toBeTruthy()
    expect(host!.innerHTML).not.toContain('v-html')
    // 类型可表达三字段（编译期由 FE-STATIC-01 覆盖；运行时读取）
    expect(generateRes.summary).toBe('生成结论')
    expect(generateRes.keyPoints).toEqual(['g1'])
    expect(generateRes.nextStep).toBe('生成下一步')
  })

  it('UT-FE-ANSWER-09: 模板静态约束：答案区禁止整篇 v-html', () => {
    const source = readFileSync(vueSourcePath, 'utf8')
    expect(source).not.toMatch(/v-html\s*=\s*"problem\?\.answer"/)
    expect(source).not.toMatch(/v-html\s*=\s*"problem\.answer"/)
    expect(source).not.toMatch(/v-html\s*=\s*"answerSource/)
    // 非答案字段仍可保留 v-html
    expect(source).toMatch(/v-html="problem\?\.analysis"/)
    expect(source).toMatch(/v-html="problem\?\.moreAsk"/)
    expect(source).toMatch(/v-html="problem\?\.name/)
  })
})
