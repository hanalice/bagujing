/**
 * 题目解析结构化 JSON（C41 / P1-4）。
 *
 * 职责：将模型 generation 输出解析并校验为冻名字段
 * `{ summary, keyPoints, nextStep }`；失败时不产生可入库结果。
 */

/** generate 路径 system 指令：要求 JSON 三字段，不再要求整篇 HTML */
export const ANSWER_GENERATE_SYSTEM_PROMPT =
  '你是资深技术面试官。请只输出一个 JSON 对象（不要其它说明文字），字段为：'
  + 'summary（字符串，简短结论）、keyPoints（字符串数组，分点说明）、nextStep（字符串，可操作的下一步建议）。\n'
  + '要求：\n'
  + '1) summary / nextStep 必须为非空字符串；keyPoints 必须是字符串数组（可以为空数组）；\n'
  + '2) 内容准确、可落地，避免空话；\n'
  + '3) 不要输出 HTML 片段，不要用 markdown 代码块包裹以外的散文。';

/**
 * 将模型 content 归一为待解析文本。
 * @param {unknown} content
 * @returns {string}
 */
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  return String(content);
}

/**
 * 若整段文本恰好是一层 markdown 代码围栏，则剥离围栏；否则原样返回。
 * @param {string} text
 * @returns {string}
 */
function stripOneMarkdownFence(text) {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/i);
  if (match) return match[1].trim();
  return trimmed;
}

/**
 * 校验已解析对象是否符合三字段 schema。
 * @param {unknown} parsed
 * @returns {{ ok: true, value: { summary: string, keyPoints: string[], nextStep: string } } | { ok: false, reason: string }}
 */
function validateStructuredObject(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }

  const { summary, keyPoints, nextStep } = parsed;

  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }
  if (typeof nextStep !== 'string' || nextStep.trim().length === 0) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }
  if (!Array.isArray(keyPoints)) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }
  if (!keyPoints.every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'invalid_structured_answer' };
  }

  return {
    ok: true,
    value: {
      summary,
      keyPoints: [...keyPoints],
      nextStep,
    },
  };
}

/**
 * 解析并校验模型输出的结构化解析 JSON。
 * 约定：支持剥离一层 markdown fence；`keyPoints: []` 合法；多余顶层字段忽略。
 *
 * @param {unknown} content - 模型返回的 content
 * @returns {{ ok: true, value: { summary: string, keyPoints: string[], nextStep: string } } | { ok: false, reason: string }}
 */
export function parseStructuredAnswer(content) {
  const rawText = contentToText(content);
  if (!rawText.trim()) {
    return { ok: false, reason: 'empty_answer' };
  }

  const candidate = stripOneMarkdownFence(rawText);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'invalid_structured_answer' };
  }

  return validateStructuredObject(parsed);
}

/**
 * 将通过校验的三字段序列化为可写入 details.answer 的派生字符串。
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
