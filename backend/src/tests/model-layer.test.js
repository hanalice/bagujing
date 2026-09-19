import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatOpenAI } from '@langchain/openai';
import { buildLlmConfig, createLlmModel } from '../llm.js';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_CHAT_MODEL',
  'OPENAI_GENERATION_MODEL',
];

let savedEnv;

// 保存模型分层测试涉及的环境变量，避免测试之间相互污染。
function saveEnv() {
  return Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
}

// 恢复模型分层测试涉及的环境变量。
function restoreEnv(env) {
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
}

// 读取 LangChain 模型实例实际使用的模型标识。
function getModelIdentifier(model) {
  return model.modelName ?? model.model;
}

describe('C6 / C61 模型分层与环境配置', () => {
  beforeEach(() => {
    savedEnv = saveEnv();
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.OPENAI_API_KEY = 'sk-model-layer-test';
    process.env.OPENAI_BASE_URL = 'http://model-layer.invalid/v1';
  });

  afterEach(() => restoreEnv(savedEnv));

  it('UT-MODEL-LAYER-01: 默认 chat 使用 mini、解析使用生成默认回退', () => {
    const chatConfig = buildLlmConfig({ maxCompletionTokens: 512 }, {}, 'chat');
    const generationConfig = buildLlmConfig({ maxCompletionTokens: 512 }, {}, 'generation');

    assert.equal(chatConfig.modelName, 'gpt-4o-mini');
    assert.equal(generationConfig.modelName, 'gpt-4o-mini');
    assert.equal(chatConfig.openAIApiKey, 'sk-model-layer-test');
    assert.equal(generationConfig.openAIApiKey, 'sk-model-layer-test');
    assert.equal(chatConfig.configuration.baseURL, 'http://model-layer.invalid/v1');
    assert.equal(generationConfig.configuration.baseURL, 'http://model-layer.invalid/v1');
    assert.equal(chatConfig.temperature, 0.2);
    assert.equal(generationConfig.temperature, 0.2);
    assert.equal(chatConfig.maxTokens, 512);
    assert.equal(generationConfig.maxTokens, 512);
  });

  it('UT-MODEL-LAYER-02: 显式路由专用模型优先于 OPENAI_MODEL（C61 residual）', () => {
    process.env.OPENAI_CHAT_MODEL = 'chat-mini-test';
    process.env.OPENAI_GENERATION_MODEL = 'generation-large-test';
    process.env.OPENAI_MODEL = 'legacy-test';

    const chat = createLlmModel({ maxCompletionTokens: 512 }, {}, 'chat');
    const generation = createLlmModel({ maxCompletionTokens: 512 }, {}, 'generation');

    assert.ok(chat instanceof ChatOpenAI);
    assert.ok(generation instanceof ChatOpenAI);
    assert.equal(getModelIdentifier(chat), 'chat-mini-test');
    assert.equal(getModelIdentifier(generation), 'generation-large-test');
    assert.notEqual(getModelIdentifier(chat), 'legacy-test');
    assert.notEqual(getModelIdentifier(generation), 'legacy-test');
    assert.equal(chat.maxTokens, 512);
    assert.equal(generation.maxTokens, 512);
  });

  it('UT-MODEL-LAYER-03: 未配置专用变量时 OPENAI_MODEL 同时回退 chat 与 generation（C61）', () => {
    process.env.OPENAI_MODEL = 'legacy-shared-test';

    assert.equal(buildLlmConfig({}, {}, 'chat').modelName, 'legacy-shared-test');
    assert.equal(buildLlmConfig({}, {}, 'generation').modelName, 'legacy-shared-test');

    delete process.env.OPENAI_MODEL;
    assert.equal(buildLlmConfig({}, {}, 'chat').modelName, 'gpt-4o-mini');
    assert.equal(buildLlmConfig({}, {}, 'generation').modelName, 'gpt-4o-mini');
  });

  it('UT-MODEL-LAYER-04: 空白专用变量按 OPENAI_MODEL→mini 回退且不得注入空白 model', () => {
    for (const chatModel of ['', '   ']) {
      process.env.OPENAI_CHAT_MODEL = chatModel;
      process.env.OPENAI_MODEL = 'legacy-chat-fallback';

      const chatConfig = buildLlmConfig({}, {}, 'chat');
      const chat = createLlmModel({}, {}, 'chat');

      assert.equal(chatConfig.modelName, 'legacy-chat-fallback');
      assert.equal(getModelIdentifier(chat), 'legacy-chat-fallback');
      assert.ok(chatConfig.modelName.trim());
    }

    for (const chatModel of ['', '   ']) {
      process.env.OPENAI_CHAT_MODEL = chatModel;
      delete process.env.OPENAI_MODEL;

      const chatConfig = buildLlmConfig({}, {}, 'chat');
      const chat = createLlmModel({}, {}, 'chat');

      assert.equal(chatConfig.modelName, 'gpt-4o-mini');
      assert.equal(getModelIdentifier(chat), 'gpt-4o-mini');
      assert.ok(chatConfig.modelName.trim());
    }

    for (const generationModel of ['', '   ']) {
      process.env.OPENAI_GENERATION_MODEL = generationModel;
      process.env.OPENAI_MODEL = 'legacy-generation-test';

      const generationConfig = buildLlmConfig({}, {}, 'generation');
      const generation = createLlmModel({}, {}, 'generation');

      assert.equal(generationConfig.modelName, 'legacy-generation-test');
      assert.equal(getModelIdentifier(generation), 'legacy-generation-test');
      assert.ok(generationConfig.modelName.trim());
    }

    delete process.env.OPENAI_MODEL;
    for (const generationModel of ['', '   ']) {
      process.env.OPENAI_GENERATION_MODEL = generationModel;

      const generationConfig = buildLlmConfig({}, {}, 'generation');
      const generation = createLlmModel({}, {}, 'generation');

      assert.equal(generationConfig.modelName, 'gpt-4o-mini');
      assert.equal(getModelIdentifier(generation), 'gpt-4o-mini');
      assert.ok(generationConfig.modelName.trim());
    }
  });

  it('UT-MODEL-LAYER-05: 角色选模不改变 Guard token 上限', () => {
    process.env.OPENAI_CHAT_MODEL = 'chat-mini-test';
    process.env.OPENAI_GENERATION_MODEL = 'generation-large-test';

    const chat = createLlmModel({ maxCompletionTokens: 512 }, {}, 'chat');
    const generation = createLlmModel({ maxCompletionTokens: 512 }, {}, 'generation');

    assert.equal(getModelIdentifier(chat), 'chat-mini-test');
    assert.equal(getModelIdentifier(generation), 'generation-large-test');
    assert.equal(chat.maxTokens, 512);
    assert.equal(generation.maxTokens, 512);
  });

  it('UT-MODEL-LAYER-06: C61 契约：仅 OPENAI_MODEL 时 chat 选模与 createLlmModel 一致', () => {
    for (const chatModel of [undefined, '', '  ']) {
      if (chatModel === undefined) delete process.env.OPENAI_CHAT_MODEL;
      else process.env.OPENAI_CHAT_MODEL = chatModel;
      delete process.env.OPENAI_GENERATION_MODEL;
      process.env.OPENAI_MODEL = 'c61-chat-fallback';

      const chatConfig = buildLlmConfig({}, {}, 'chat');
      const chat = createLlmModel({}, {}, 'chat');

      assert.equal(chatConfig.modelName, 'c61-chat-fallback');
      assert.ok(chat instanceof ChatOpenAI);
      assert.equal(getModelIdentifier(chat), 'c61-chat-fallback');
      assert.equal(buildLlmConfig({}, {}, 'generation').modelName, 'c61-chat-fallback');
    }
  });
});
