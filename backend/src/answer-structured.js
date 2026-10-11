/**
 * C41：解析 / 校验 answer/generate 模型返回的 JSON 三字段。
 * 成功仅暴露 { summary, keyPoints, nextStep }；失败不入库由调用方处理。
 */

/**
 * 去掉 Markdown 代码围栏，便于模型偶发用 ```json 包裹合法 JSON。
 * @param {string} text
 * @returns {string}
 */
function stripMarkdownFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * 解析并校验结构化解析 JSON。
 * @param {unknown} raw 模型 `content` 或已是对象的候选值
 * @returns {{ ok: true, value: { summary: string, keyPoints: string[], nextStep: string } }
 *   | { ok: false, error: string }}
 */
export function parseStructuredAnswer(raw) {
  let candidate = raw;

  if (typeof candidate === 'string') {
    const stripped = stripMarkdownFence(candidate);
    if (!stripped) {
      return { ok: false, error: 'empty_content' };
    }
    try {
      candidate = JSON.parse(stripped);
    } catch {
      return { ok: false, error: 'invalid_json' };
    }
  } else if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { ok: false, error: 'not_object' };
  }

  const { summary, keyPoints, nextStep } = candidate;

  if (typeof summary !== 'string' || !summary.trim()) {
    return { ok: false, error: 'invalid_summary' };
  }
  if (typeof nextStep !== 'string' || !nextStep.trim()) {
    return { ok: false, error: 'invalid_nextStep' };
  }
  if (!Array.isArray(keyPoints)) {
    return { ok: false, error: 'invalid_keyPoints' };
  }

  const normalizedPoints = [];
  for (const item of keyPoints) {
    if (typeof item !== 'string' || !item.trim()) {
      return { ok: false, error: 'invalid_keyPoints' };
    }
    normalizedPoints.push(item.trim());
  }
  if (normalizedPoints.length < 1) {
    return { ok: false, error: 'invalid_keyPoints' };
  }

  return {
    ok: true,
    value: {
      summary: summary.trim(),
      keyPoints: normalizedPoints,
      nextStep: nextStep.trim(),
    },
  };
}

/**
 * 将已校验三字段序列化为入库用的 `details.answer` 正文。
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
