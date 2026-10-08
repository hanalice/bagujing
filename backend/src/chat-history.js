/**
 * C31 / P1-1：chat 多轮 messages 窗口归一化。
 * 只保留最近 N=6 条合法 user/assistant，按条截断到 maxInputChars；不做滚动摘要。
 */

/** 对话历史尾窗上限（写死，禁止读环境变量改 N）。 */
export const CHAT_HISTORY_WINDOW = 6;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

const DEFAULT_MAX_INPUT_CHARS = 1200;

// 将 maxInputChars 归一为合法正整数，非法时回退默认。
const resolveMaxInputChars = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_MAX_INPUT_CHARS;
};

/**
 * 过滤非法项、按条截断 content，并只保留时间正序尾窗最近 N 条。
 * @param {unknown} messages 客户端回传的 messages[]（可为缺省/非数组）
 * @param {{ maxInputChars?: number }} [options] 单条 content 上限，对齐 AI_MAX_INPUT_CHARS
 * @returns {{ role: 'user'|'assistant', content: string }[]}
 */
export function normalizeChatHistory(messages, { maxInputChars } = {}) {
  const limit = resolveMaxInputChars(maxInputChars);
  const list = Array.isArray(messages) ? messages : [];
  const filtered = [];

  for (const item of list) {
    if (item === null || typeof item !== 'object') continue;
    const { role, content } = item;
    if (!ALLOWED_ROLES.has(role)) continue;
    if (typeof content !== 'string') continue;
    filtered.push({
      role,
      content: content.replaceAll(String.fromCodePoint(0), '').slice(0, limit),
    });
  }

  return filtered.slice(-CHAT_HISTORY_WINDOW);
}
