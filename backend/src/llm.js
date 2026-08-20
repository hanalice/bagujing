import { ChatOpenAI } from "@langchain/openai";

export function buildLlmConfig(guardContext, defaultConfig = {}) {
  return {
    openAIApiKey: process.env.OPENAI_API_KEY || null,
    configuration: {
      baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    },
    modelName: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.2,
    maxTokens: guardContext?.maxCompletionTokens ?? defaultConfig?.maxCompletionTokens,
    timeout: guardContext?.upstreamTimeoutMs ?? defaultConfig?.upstreamTimeoutMs,
  };
}

export function createLlmModel(guardContext, defaultConfig = {}) {
  const config = buildLlmConfig(guardContext, defaultConfig);
  if (!config.openAIApiKey) return null;
  return new ChatOpenAI(config);
}
