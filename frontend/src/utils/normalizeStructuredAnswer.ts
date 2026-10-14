/**
 * C42：将题目详情 / generate 响应归一化为冻约三字段，或标记为旧 HTML 降级。
 * 优先级：顶层 summary/keyPoints/nextStep → 解析 answer JSON → legacy。
 */

import DOMPurify from 'dompurify'

export interface StructuredAnswer {
  summary: string
  keyPoints: string[]
  nextStep: string
}

export type NormalizedAnswer =
  | { kind: 'structured'; value: StructuredAnswer }
  | { kind: 'legacy'; raw: string }
  | { kind: 'empty' }

/**
 * 校验对象是否为冻约三字段（键名精确，大小写敏感；忽略额外未知键）。
 */
function tryStructuredFromObject(input: unknown): StructuredAnswer | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null
  }
  const obj = input as Record<string, unknown>
  if (
    !Object.prototype.hasOwnProperty.call(obj, 'summary')
    || !Object.prototype.hasOwnProperty.call(obj, 'keyPoints')
    || !Object.prototype.hasOwnProperty.call(obj, 'nextStep')
  ) {
    return null
  }
  const { summary, keyPoints, nextStep } = obj
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return null
  }
  if (typeof nextStep !== 'string' || nextStep.trim().length === 0) {
    return null
  }
  if (!Array.isArray(keyPoints) || !keyPoints.every((item) => typeof item === 'string')) {
    return null
  }
  return {
    summary: summary.trim(),
    keyPoints,
    nextStep: nextStep.trim(),
  }
}

/**
 * 尝试将 answer 字符串解析为同构三字段 JSON。
 */
function tryParseAnswerJson(answer: unknown): StructuredAnswer | null {
  if (typeof answer !== 'string') {
    return null
  }
  const trimmed = answer.trim()
  if (!trimmed || trimmed[0] !== '{') {
    return null
  }
  try {
    return tryStructuredFromObject(JSON.parse(trimmed))
  } catch {
    return null
  }
}

/**
 * 从 generate/详情 data 归一化解析答案展示形态。
 */
export function normalizeStructuredAnswer(data: Record<string, unknown> | null | undefined): NormalizedAnswer {
  if (!data || typeof data !== 'object') {
    return { kind: 'empty' }
  }

  const fromTop = tryStructuredFromObject(data)
  if (fromTop) {
    return { kind: 'structured', value: fromTop }
  }

  const fromAnswer = tryParseAnswerJson(data.answer)
  if (fromAnswer) {
    return { kind: 'structured', value: fromAnswer }
  }

  if (typeof data.answer === 'string' && data.answer.trim()) {
    return { kind: 'legacy', raw: data.answer }
  }

  return { kind: 'empty' }
}

/**
 * 将旧 HTML 降级为纯文本（去标签，脚本不可执行）。
 */
export function legacyAnswerToPlainText(raw: string): string {
  return DOMPurify.sanitize(raw, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })
    .replace(/\s+/g, ' ')
    .trim()
}
