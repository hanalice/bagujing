const DEFAULT_MAX_DESC_CHARS = 240;
const DEFAULT_MAX_CHARS = 8000;

/** 预留段（system + 题面 + 固定标签）已超过 maxChars，属于非法配置，不得截断题面去凑上限。 */
export const PROMPT_BUDGET_ERROR_RESERVED = 'reserved_exceeds_max_chars';

// 解析正整数配置，避免非法环境变量破坏 Prompt 预算计算。
const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// 按项目现有的每四字符一 Token 估算规则统计最终模型消息。
const estimatePromptTokens = (text) => Math.max(1, Math.ceil(String(text ?? '').length / 4));

// 统一提供模型 Prompt 的字段预算和总字符预算，避免路由各自维护阈值。
export const promptBudget = Object.freeze({
  get maxDescChars() {
    return parsePositiveInt(process.env.AI_PROMPT_MAX_DESC_CHARS, DEFAULT_MAX_DESC_CHARS);
  },
  get maxChars() {
    return parsePositiveInt(process.env.AI_PROMPT_MAX_CHARS, DEFAULT_MAX_CHARS);
  },
});

// 清理空字符、非法代理项和换行，保证 snippet 作为单行文本进入 bullet。
const normalizePromptText = (value) => {
  const text = String(value ?? '').replaceAll(String.fromCodePoint(0), '');
  let normalized = '';

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) {
        normalized += text[index] + text[index + 1];
        index += 1;
      } else {
        normalized += '\uFFFD';
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      normalized += '\uFFFD';
    } else {
      normalized += text[index];
    }
  }

  return normalized.replace(/\r?\n|\r/g, ' ').replace(/\s+/g, ' ').trim();
};

// 按 JavaScript String.length 截断文本，并避免在代理项中间切断 Unicode 字符。
const truncatePromptText = (value, maxChars) => {
  const text = normalizePromptText(value);
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return maxChars === 1 ? '…' : '';

  let prefix = text.slice(0, maxChars - 1);
  const lastCode = prefix.charCodeAt(prefix.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
    prefix = prefix.slice(0, -1);
  }
  return `${prefix}…`;
};

// 将注入的预算值归一化，确保极小预算也能参与硬上限计算。
const getBudgetChars = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
};

// 将 snippet 归类，用于保持问题、分类及其他背景的稳定优先级。
const getSnippetType = (snippet) => snippet?.type === 'problem' ? 'problem' : snippet?.type === 'category' ? 'category' : 'other';

// 把单个结构化 snippet 转成不含 JSON 字段名的可读 bullet。
const getSnippetBullet = (snippet, maxDescChars) => {
  const type = getSnippetType(snippet);
  if (type === 'category') {
    const name = normalizePromptText(snippet.name);
    const groupName = normalizePromptText(snippet.groupName ?? snippet.group_name);
    const description = truncatePromptText(snippet.groupDesc ?? snippet.group_desc, maxDescChars);
    const count = Number.isFinite(Number(snippet.count)) ? `题数：${Number(snippet.count)}` : '';
    const parts = [
      `分类 #${normalizePromptText(snippet.id)}`,
      name ? `名称：${name}` : '',
      groupName ? `分组：${groupName}` : '',
      description ? `描述：${description}` : '',
      count,
    ].filter(Boolean);
    return `- ${parts.join('；')}`;
  }

  if (type === 'problem') {
    const title = normalizePromptText(snippet.brief_name ?? snippet.briefName ?? snippet.name);
    const rawPoints = Array.isArray(snippet.keyPoints)
      ? snippet.keyPoints.map(normalizePromptText).filter(Boolean).join('、')
      : normalizePromptText(snippet.keyPoints);
    const points = truncatePromptText(rawPoints, maxDescChars);
    const parts = [
      `题目 #${normalizePromptText(snippet.id)}`,
      title ? `名称：${title}` : '',
      points ? `要点：${points}` : '',
    ].filter(Boolean);
    return `- ${parts.join('；')}`;
  }

  return `- 相关片段：${normalizePromptText(snippet)}`;
};

// 以问题背景优先、原始顺序次之的规则排序 snippets。
const prioritizeSnippets = (snippets) => snippets
  .map((snippet, index) => ({ snippet, index }))
  .sort((left, right) => {
    const priority = { problem: 0, category: 1, other: 2 };
    return priority[getSnippetType(left.snippet)] - priority[getSnippetType(right.snippet)]
      || left.index - right.index;
  })
  .map(({ snippet }) => snippet);

// 按优先级从高到低装入 context；超预算时从队尾丢掉整条低优先级 bullet，禁止截断当前高优先级条。
const packContextText = (snippets, contextMaxChars, maxDescChars) => {
  const bullets = prioritizeSnippets(Array.isArray(snippets) ? snippets : [])
    .map((snippet) => getSnippetBullet(snippet, maxDescChars));
  while (bullets.length > 0) {
    const packed = bullets.join('\n');
    if (packed.length <= contextMaxChars) return packed;
    bullets.pop();
  }
  return '';
};

// 将题面、系统指令和紧凑 context 组装为受总字符预算保护的模型消息。
export function buildPromptMessages({
  systemPrompt,
  questionLabel,
  question,
  contextLabel,
  instruction = '',
  snippets = [],
  budget = promptBudget,
}) {
  const systemText = normalizePromptText(systemPrompt);
  const questionText = String(question ?? '');
  const questionPart = `${questionLabel}${questionText}\n\n`;
  const contextPart = `${contextLabel}\n`;
  const instructionPart = instruction ? `\n${instruction}` : '';
  const maxChars = getBudgetChars(budget?.maxChars, promptBudget.maxChars);
  const maxDescChars = getBudgetChars(budget?.maxDescChars, promptBudget.maxDescChars);
  const fixedLength = systemText.length + questionPart.length + contextPart.length + instructionPart.length;
  const contextMaxChars = Math.max(0, maxChars - fixedLength);
  const humanWithoutContext = `${questionPart}${contextPart}${instructionPart}`;

  // 非法配置：预留段已超过上限。保留 system 与题面原文，调用方不得再发模型。
  if (fixedLength > maxChars) {
    return {
      system: systemText,
      human: humanWithoutContext,
      promptTokens: estimatePromptTokens(`${systemText}${humanWithoutContext}`),
      budgetError: PROMPT_BUDGET_ERROR_RESERVED,
    };
  }

  const contextText = packContextText(snippets, contextMaxChars, maxDescChars);
  const humanText = `${questionPart}${contextPart}${contextText}${instructionPart}`;
  return {
    system: systemText,
    human: humanText,
    promptTokens: estimatePromptTokens(`${systemText}${humanText}`),
  };
}

