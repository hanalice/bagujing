import { ChatOpenAI } from "@langchain/openai";

/**
 * 读取并清理模型环境变量，避免空白配置进入上游模型实例。
 */
function getConfiguredModel(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * D21：解析主 / 备 Base URL。
 * 主 = `OPENAI_BASE_URL`（缺省 `https://api.openai.com/v1`，与 UT-LLM-03/04 一致）；
 * 备 = `OPENAI_BASE_URL_FALLBACK`（未设、`''`、纯空白均视为未配置 → null）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ primary: string, fallback: string|null }}
 */
export function resolveUpstreamBaseUrls(env = process.env) {
  const primary = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const rawFallback = env.OPENAI_BASE_URL_FALLBACK;
  const fallback = typeof rawFallback === 'string' && rawFallback.trim()
    ? rawFallback.trim()
    : null;
  return { primary, fallback };
}

export function buildLlmConfig(guardContext, defaultConfig = {}, role = 'generation') {
  // chat / generation 均按「路由专用 → OPENAI_MODEL → gpt-4o-mini」解析，避免空白专用变量漏回退。
  const dedicatedEnv = role === 'chat' ? 'OPENAI_CHAT_MODEL' : 'OPENAI_GENERATION_MODEL';
  const modelName = getConfiguredModel(dedicatedEnv)
    || getConfiguredModel('OPENAI_MODEL')
    || 'gpt-4o-mini';

  const { primary, fallback } = resolveUpstreamBaseUrls();
  // defaultConfig.baseURL 供 D21 createLlmModelForBaseUrl 覆盖；未覆盖时仍用主 URL。
  const baseURL = (typeof defaultConfig?.baseURL === 'string' && defaultConfig.baseURL)
    ? defaultConfig.baseURL
    : primary;

  return {
    openAIApiKey: process.env.OPENAI_API_KEY || null,
    configuration: {
      baseURL,
    },
    // 仅供观测 / 单测；不会合并进 configuration.baseURL（UT-LLM-04 / UT-FAILOVER-02）
    fallbackBaseURL: fallback,
    modelName,
    temperature: 0.2,
    // D11：关闭 LangChain/OpenAI 客户端内置重试，由 generate 的 invokeWithRetry 统一控次
    maxRetries: 0,
    maxTokens: guardContext?.maxCompletionTokens ?? defaultConfig?.maxCompletionTokens,
    timeout: guardContext?.upstreamTimeoutMs ?? defaultConfig?.upstreamTimeoutMs,
  };
}

export function createLlmModel(guardContext, defaultConfig = {}, role = 'generation') {
  const config = buildLlmConfig(guardContext, defaultConfig, role);
  if (!config.openAIApiKey) return null;
  // 不把 fallbackBaseURL 传给 ChatOpenAI，避免未知字段干扰客户端
  const chatConfig = { ...config };
  delete chatConfig.fallbackBaseURL;
  return new ChatOpenAI(chatConfig);
}

/**
 * D21：按指定 baseURL 创建模型实例（主失败切备时重建上游客户端）。
 * @param {string} baseURL
 * @param {object} [guardContext]
 * @param {object} [defaultConfig]
 * @param {'chat'|'generation'} [role]
 */
export function createLlmModelForBaseUrl(baseURL, guardContext, defaultConfig = {}, role = 'generation') {
  return createLlmModel(guardContext, { ...defaultConfig, baseURL }, role);
}
