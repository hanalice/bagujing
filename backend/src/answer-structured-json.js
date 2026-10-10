/**
 * C41：解析并校验题目解析生成路径的结构化 JSON 输出。
 * 冻约字段：summary / keyPoints / nextStep；校验失败不得入库。
 */

/** generate 路由 systemPrompt：要求 JSON 三字段，禁止整篇 HTML 输出指令。 */
export const GENERATE_ANSWER_SYSTEM_PROMPT =
  '你是资深技术面试官。请只输出一个 JSON 对象（不要在 JSON 外附加说明文字），字段必须精确为：\n'
  + 'summary（非空字符串：简短结论）、keyPoints（字符串数组：分点说明）、nextStep（非空字符串：下一步建议）。\n'
  + '要求：\n'
  + '1) 内容准确、可落地，避免空话；\n'
  + '2) keyPoints 每一项均为字符串；无要点时可为空数组；\n'
  + '3) 不要输出整篇 HTML 文档。';

/**
 * 剥离常见 markdown 代码围栏后返回待解析文本。
 * @param {string} raw
 * @returns {string}
 */
function stripMarkdownFence(raw) {
  const trimmed = String(raw ?? '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

/**
 * 将模型原文解析为冻约三字段；失败返回可区分 reason。
 * @param {unknown} raw
 * @returns {{ ok: true, value: { summary: string, keyPoints: string[], nextStep: string } }
 *   | { ok: false, reason: 'invalid_json' | 'schema_mismatch' }}
 */
export function parseGeneratedAnswerJson(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'invalid_json' };
  }

  const text = stripMarkdownFence(raw);
  if (!text) {
    return { ok: false, reason: 'invalid_json' };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'schema_mismatch' };
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, 'summary')
    || !Object.prototype.hasOwnProperty.call(parsed, 'keyPoints')
    || !Object.prototype.hasOwnProperty.call(parsed, 'nextStep')) {
    return { ok: false, reason: 'schema_mismatch' };
  }

  const { summary, keyPoints, nextStep } = parsed;

  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return { ok: false, reason: 'schema_mismatch' };
  }
  if (typeof nextStep !== 'string' || nextStep.trim().length === 0) {
    return { ok: false, reason: 'schema_mismatch' };
  }
  if (!Array.isArray(keyPoints) || !keyPoints.every((item) => typeof item === 'string')) {
    return { ok: false, reason: 'schema_mismatch' };
  }

  return {
    ok: true,
    value: {
      summary: summary.trim(),
      keyPoints,
      nextStep: nextStep.trim(),
    },
  };
}

/**
 * 将校验通过的三字段规范序列化为入库用 JSON 文本。
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
