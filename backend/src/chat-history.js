/**
 * C31：chat 多轮 messages 窗口规范化。
 * 只接受 user/assistant，窗口写死 N=6，每条按 maxChars 截断；不做滚动摘要。
 */

/** 发往上游的历史窗口上限（写死，客户端不可改） */
export const CHAT_HISTORY_MAX_MESSAGES = 6;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

/**
 * 与 server-express sanitizeUserText 同源：去 NUL 后按 maxChars 截断。
 * @param {unknown} value
 * @param {number} maxChars
 * @returns {string}
 */
function sanitizeHistoryContent(value, maxChars) {
  const text = typeof value === 'string' ? value : '';
  return text.replaceAll(String.fromCodePoint(0), '').slice(0, maxChars);
}

/**
 * 规范化客户端回传的 messages[]：校验角色、截断 content、只保留最近 6 条。
 * 故意忽略 options.maxCount / body.N 等客户端窗口参数。
 *
 * @param {unknown} raw 原始 body.messages
 * @param {{ maxChars?: number, maxCount?: number }} [options]
 * @returns {{ role: 'user'|'assistant', content: string }[]}
 */
export function normalizeChatHistoryMessages(raw, options = {}) {
  const maxChars = Number.isFinite(options.maxChars) && options.maxChars > 0
    ? Math.floor(options.maxChars)
    : 1200;

  if (!Array.isArray(raw)) return [];

  const accepted = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const role = item.role;
    if (!ALLOWED_ROLES.has(role)) continue;
    if (typeof item.content !== 'string') continue;
    accepted.push({
      role,
      content: sanitizeHistoryContent(item.content, maxChars),
    });
  }

  // 窗口写死为 CHAT_HISTORY_MAX_MESSAGES；忽略 options.maxCount
  return accepted.slice(-CHAT_HISTORY_MAX_MESSAGES);
}
