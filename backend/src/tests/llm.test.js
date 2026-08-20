import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatOpenAI } from '@langchain/openai';
import { buildLlmConfig, createLlmModel } from '../llm.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL'];

function saveAndClearEnv() {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnv(saved) {
  for (const k of ENV_KEYS) {
    if (saved[k] !== undefined) process.env[k] = saved[k];
    else delete process.env[k];
  }
}

describe('buildLlmConfig', () => {
  let savedEnv;

  beforeEach(() => { savedEnv = saveAndClearEnv(); });
  afterEach(() => restoreEnv(savedEnv));

  it('sets openAIApiKey from OPENAI_API_KEY env', () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    assert.equal(buildLlmConfig({}).openAIApiKey, 'sk-test');
  });

  it('sets openAIApiKey to null when OPENAI_API_KEY is absent', () => {
    assert.equal(buildLlmConfig({}).openAIApiKey, null);
  });

  it('defaults baseURL to api.openai.com/v1', () => {
    assert.equal(buildLlmConfig({}).configuration.baseURL, 'https://api.openai.com/v1');
  });

  it('uses OPENAI_BASE_URL from env', () => {
    process.env.OPENAI_BASE_URL = 'https://custom.api.com/v1';
    assert.equal(buildLlmConfig({}).configuration.baseURL, 'https://custom.api.com/v1');
  });

  it('defaults modelName to gpt-4o-mini', () => {
    assert.equal(buildLlmConfig({}).modelName, 'gpt-4o-mini');
  });

  it('uses OPENAI_MODEL from env', () => {
    process.env.OPENAI_MODEL = 'gpt-4-turbo';
    assert.equal(buildLlmConfig({}).modelName, 'gpt-4-turbo');
  });

  it('sets temperature to 0.2', () => {
    assert.equal(buildLlmConfig({}).temperature, 0.2);
  });

  it('prefers guardContext.maxCompletionTokens over defaultConfig', () => {
    const cfg = buildLlmConfig({ maxCompletionTokens: 1024 }, { maxCompletionTokens: 512 });
    assert.equal(cfg.maxTokens, 1024);
  });

  it('falls back to defaultConfig.maxCompletionTokens when guardContext is empty', () => {
    const cfg = buildLlmConfig({}, { maxCompletionTokens: 512 });
    assert.equal(cfg.maxTokens, 512);
  });

  it('prefers guardContext.upstreamTimeoutMs over defaultConfig', () => {
    const cfg = buildLlmConfig({ upstreamTimeoutMs: 5000 }, { upstreamTimeoutMs: 30000 });
    assert.equal(cfg.timeout, 5000);
  });

  it('falls back to defaultConfig.upstreamTimeoutMs when guardContext is empty', () => {
    const cfg = buildLlmConfig({}, { upstreamTimeoutMs: 30000 });
    assert.equal(cfg.timeout, 30000);
  });

  it('returns undefined maxTokens and timeout when neither source provides them', () => {
    const cfg = buildLlmConfig({}, {});
    assert.equal(cfg.maxTokens, undefined);
    assert.equal(cfg.timeout, undefined);
  });

  it('handles undefined/null arguments safely', () => {
    assert.doesNotThrow(() => buildLlmConfig());
    assert.doesNotThrow(() => buildLlmConfig(null, null));
  });
});

describe('createLlmModel', () => {
  let savedEnv;

  beforeEach(() => { savedEnv = saveAndClearEnv(); });
  afterEach(() => restoreEnv(savedEnv));

  it('returns null when OPENAI_API_KEY is not set', () => {
    assert.equal(createLlmModel({}, {}), null);
  });

  it('returns ChatOpenAI instance with correct configuration when OPENAI_API_KEY is present', () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    const model = createLlmModel({ maxCompletionTokens: 1024 }, { upstreamTimeoutMs: 5000 });
    assert.ok(model instanceof ChatOpenAI, 'model must be an instance of ChatOpenAI');
    assert.equal(model.temperature, 0.2);
    assert.equal(model.maxTokens, 1024);
    assert.equal(model.timeout, 5000);
  });
});

describe('LangChain model invoke contract', () => {
  it('invoke returns object with string content', async () => {
    const mockModel = {
      invoke: async (_messages) => ({ content: 'Answer text' }),
    };
    const response = await mockModel.invoke([]);
    assert.equal(typeof response.content, 'string');
    assert.ok(response.content.length > 0);
  });

  it('empty content string is handled without throwing', async () => {
    const mockModel = {
      invoke: async (_messages) => ({ content: '' }),
    };
    const response = await mockModel.invoke([]);
    assert.equal(response.content, '');
  });
});

describe('LangChain model stream contract', () => {
  async function* makeStream(contents) {
    for (const content of contents) yield { content };
  }

  it('stream yields chunks each with a content property', async () => {
    const chunks = [];
    for await (const chunk of makeStream(['Hello', ' world', ''])) {
      chunks.push(chunk);
    }
    assert.equal(chunks.length, 3);
    for (const chunk of chunks) {
      assert.ok('content' in chunk, 'each chunk must have content property');
    }
  });

  it('concatenating non-empty chunk.content produces full text', async () => {
    let completionText = '';
    for await (const chunk of makeStream(['Part1', ' Part2', ''])) {
      if (chunk.content) completionText += chunk.content;
    }
    assert.equal(completionText, 'Part1 Part2');
  });

  it('stream with single empty chunk produces empty completion text', async () => {
    let completionText = '';
    for await (const chunk of makeStream([''])) {
      if (chunk.content) completionText += chunk.content;
    }
    assert.equal(completionText, '');
  });

  it('aborted stream stops yielding chunks', async () => {
    const controller = new AbortController();
    async function* abortableStream(signal) {
      for (const content of ['A', 'B', 'C']) {
        if (signal.aborted) return;
        yield { content };
      }
    }

    controller.abort();
    const chunks = [];
    for await (const chunk of abortableStream(controller.signal)) {
      chunks.push(chunk);
    }
    assert.equal(chunks.length, 0);
  });
});
