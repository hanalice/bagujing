import { ChatOpenAI } from "@langchain/openai";

/**
 * 读取并清理模型环境变量，避免空白配置进入上游模型实例。
 */
function getConfiguredModel(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildLlmConfig(guardContext, defaultConfig = {}, role = 'generation') {
  const modelName = role === 'chat'
    ? getConfiguredModel('OPENAI_CHAT_MODEL') || 'gpt-4o-mini'
    : getConfiguredModel('OPENAI_GENERATION_MODEL')
      || getConfiguredModel('OPENAI_MODEL')
      || 'gpt-4o-mini';

  return {
    openAIApiKey: process.env.OPENAI_API_KEY || null,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },
    modelName,
    temperature: 0.2,
    maxTokens: guardContext?.maxCompletionTokens ?? defaultConfig?.maxCompletionTokens,
    timeout: guardContext?.upstreamTimeoutMs ?? defaultConfig?.upstreamTimeoutMs,
  };
}

export function createLlmModel(guardContext, defaultConfig = {}, role = 'generation') {
  const config = buildLlmConfig(guardContext, defaultConfig, role);
  if (!config.openAIApiKey) return null;
  return new ChatOpenAI(config);
}
