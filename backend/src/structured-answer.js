/**
 * C41 / P1-4：解析生成结构化 JSON 三字段校验。
 * 成功形态为 { summary, keyPoints, nextStep }；失败不得入库。
 */

/** 生成路径要求模型输出 JSON 三字段（禁止整篇 HTML 硬指令）。 */
export const GENERATE_ANSWER_SYSTEM_PROMPT =
  '你是资深技术面试官。请只输出一个 JSON 对象（不要输出整篇 HTML），字段必须包含：\n'
  + 'summary（非空字符串：简短结论）、keyPoints（非空字符串数组：分点说明）、nextStep（非空字符串：可操作的下一步建议）。\n'
  + '要求：\n'
  + '1) 先给简短结论，再给分点说明，并给出下一步；\n'
  + '2) 内容准确、可落地，避免空话；\n'
  + '3) 若使用 Markdown 代码围栏，围栏内必须是合法 JSON。';

/**
 * 剥除常见 Markdown 代码围栏（```json ... ``` 或无 lang 标签）。
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownFence(text) {
  const trimmed = String(text).trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```\s*$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * 将模型原始 content 规范为字符串。
 * @param {unknown} raw
 * @returns {string}
 */
function coerceRawText(raw) {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (raw == null) return '';
  return String(raw);
}

/**
 * 校验并归一化为仅含三字段的结构化解析对象。
 * @param {unknown} parsed
 * @returns {{ ok: true, value: { summary: string, keyPoints: string[], nextStep: string } } | { ok: false, reason: string }}
 */
function validateStructuredObject(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }

  const { summary, keyPoints, nextStep } = parsed;

  if (typeof summary !== 'string' || !summary.trim()) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }
  if (typeof nextStep !== 'string' || !nextStep.trim()) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }
  if (!Array.isArray(keyPoints) || keyPoints.length === 0) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }
  if (!keyPoints.every((item) => typeof item === 'string' && item.trim().length > 0)) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }

  return {
    ok: true,
    value: {
      summary: summary.trim(),
      keyPoints: keyPoints.map((item) => item.trim()),
      nextStep: nextStep.trim(),
    },
  };
}

/**
 * 解析模型输出为结构化三字段；失败返回 { ok:false }，不抛未捕获异常。
 * @param {unknown} raw 模型 content（字符串、围栏 JSON 或非法文本）
 * @returns {{ ok: true, value: { summary: string, keyPoints: string[], nextStep: string } } | { ok: false, reason: string }}
 */
export function parseStructuredAnswer(raw) {
  const text = coerceRawText(raw);
  if (!text.trim()) {
    return { ok: false, reason: 'empty_answer' };
  }

  const candidate = stripMarkdownFence(text);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'invalid_structured_answer' };
  }

  return validateStructuredObject(parsed);
}

/**
 * 将三字段规范序列化为可入库的 JSON 字符串。
 * @param {{ summary: string, keyPoints: string[], nextStep: string }} value
 * @returns {string}
 */
export function serializeStructuredAnswer(value) {
  return JSON.stringify({
    summary: value.summary,
    keyPoints: value.keyPoints,
    nextStep: value.nextStep,
  });
}

/**
 * 校验通过才调用 writeAnswer；失败路径绝不写库（供 UT-GEN-JSON-08 与 handler 共用编排）。
 * @param {unknown} raw
 * @param {(serialized: string, value: { summary: string, keyPoints: string[], nextStep: string }) => void} writeAnswer
 * @returns {{ ok: true, value: object, serialized: string } | { ok: false, reason: string }}
 */
export function persistStructuredAnswerIfValid(raw, writeAnswer) {
  const parsed = parseStructuredAnswer(raw);
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason };
  }
  const serialized = serializeStructuredAnswer(parsed.value);
  writeAnswer(serialized, parsed.value);
  return { ok: true, value: parsed.value, serialized };
}
