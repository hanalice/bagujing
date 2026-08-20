import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ChatOpenAI } from '@langchain/openai';
import { buildLlmConfig, createLlmModel } from '../llm.js';
import { readStreamChunkWithTimeout } from '../security/ai-guard.js';

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

describe('readStreamChunkWithTimeout (A2 timeout helper)', () => {
  it('resolves chunk value before timeout occurs with reader.read()', async () => {
    const mockReader = {
      read: async () => ({ done: false, value: { content: 'chunk data' } }),
    };
    const result = await readStreamChunkWithTimeout(mockReader, 100);
    assert.equal(result.done, false);
    assert.equal(result.value.content, 'chunk data');
  });

  it('resolves chunk value before timeout occurs with iterator.next()', async () => {
    const mockIterator = {
      next: async () => ({ done: false, value: { content: 'iterator data' } }),
    };
    const result = await readStreamChunkWithTimeout(mockIterator, 100);
    assert.equal(result.done, false);
    assert.equal(result.value.content, 'iterator data');
  });

  it('resolves done=true when stream finishes normally', async () => {
    const mockReader = {
      read: async () => ({ done: true, value: undefined }),
    };
    const result = await readStreamChunkWithTimeout(mockReader, 100);
    assert.equal(result.done, true);
  });

  it('rejects with "SSE idle timeout" error when chunk is not received in time', async () => {
    const hungReader = {
      read: () => new Promise((resolve) => setTimeout(resolve, 500)),
    };
    await assert.rejects(
      async () => {
        await readStreamChunkWithTimeout(hungReader, 30);
      },
      (err) => {
        assert.equal(err.message, 'SSE idle timeout');
        return true;
      }
    );
  });

  it('rejects with error when reader is invalid', async () => {
    await assert.rejects(
      async () => {
        await readStreamChunkWithTimeout(null, 50);
      },
      (err) => {
        assert.equal(err.message, 'Invalid stream reader');
        return true;
      }
    );
  });
});

describe('Chat stream consumption loop (idle timeout & resource cleanup)', () => {
  it('hung stream terminates on idle timeout, invokes finalize(aborted_or_timeout), and sends SSE error', async () => {
    // 模拟挂起的 stream：发送首个 chunk 之后后续挂起超过 sseIdleTimeoutMs
    let chunkCount = 0;
    const hungReader = {
      read: async () => {
        chunkCount++;
        if (chunkCount === 1) {
          return { done: false, value: { content: '<p>Initial chunk</p>' } };
        }
        // 第二个 chunk 挂起
        return new Promise((resolve) => setTimeout(resolve, 500));
      },
      releaseLock: () => {
        mockLockReleased = true;
      },
    };

    let mockLockReleased = false;
    let finalizePayload = null;
    const guardContext = {
      sseIdleTimeoutMs: 30, // 30ms 快速超时用于测试
      finalize: (payload) => {
        finalizePayload = payload;
      },
    };

    const sseEvents = [];
    let responseEnded = false;
    const mockRes = {
      writableEnded: false,
      write: (data) => sseEvents.push(data),
      end: () => {
        mockRes.writableEnded = true;
        responseEnded = true;
      },
    };

    const abortController = new AbortController();
    let completionText = '';

    // 运行在 /api/chat 中的 stream 消费核心逻辑
    try {
      const sseIdleTimeoutMs = guardContext?.sseIdleTimeoutMs || 20000;
      const reader = typeof hungReader?.getReader === 'function'
        ? hungReader.getReader()
        : (hungReader?.[Symbol.asyncIterator] ? hungReader[Symbol.asyncIterator]() : hungReader);

      try {
        while (true) {
          const { done, value } = await readStreamChunkWithTimeout(reader, sseIdleTimeoutMs);
          if (done) break;
          const chunk = value;
          const delta = chunk?.content;
          if (delta) {
            completionText += delta;
            mockRes.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
          }
        }
      } finally {
        if (typeof reader?.releaseLock === 'function') {
          try { reader.releaseLock(); } catch (_) {}
        }
      }

      guardContext.finalize({
        status: 'ok',
        reason: 'stream_done',
        completionText,
      });
      mockRes.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      mockRes.end();
    } catch (error) {
      const isTimeout = error?.message === 'SSE idle timeout';
      const isAborted = abortController.signal.aborted;
      guardContext.finalize({
        status: 'error',
        reason: (isAborted || isTimeout) ? 'aborted_or_timeout' : 'server_error',
      });
      const errorMsg = isTimeout ? 'Stream idle timeout' : (error?.message || String(error));
      if (!mockRes.writableEnded) {
        mockRes.write(`data: ${JSON.stringify({ type: 'error', message: errorMsg })}\n\n`);
        mockRes.end();
      }
    }

    // 门禁断言 1: 超时必定断开并结束响应
    assert.equal(responseEnded, true, 'response must be ended upon timeout');
    // 门禁断言 2: finalize 状态为 error 且 reason 为 aborted_or_timeout
    assert.deepEqual(finalizePayload, {
      status: 'error',
      reason: 'aborted_or_timeout',
    });
    // 门禁断言 3: SSE 包含首个 chunk 的 delta 与超时 error 事件
    const hasDelta = sseEvents.some((e) => e.includes('Initial chunk'));
    const hasError = sseEvents.some((e) => e.includes('Stream idle timeout'));
    assert.equal(hasDelta, true, 'SSE events should contain initial chunk delta');
    assert.equal(hasError, true, 'SSE events should contain timeout error event');
    // 门禁断言 4: reader lock 正确释放
    assert.equal(mockLockReleased, true, 'reader lock must be released');
  });

  it('concurrency is released when request ends or client aborts', () => {
    let activeConcurrency = 1;
    let finished = false;
    const releaseOnce = () => {
      if (finished) return;
      finished = true;
      activeConcurrency = Math.max(0, activeConcurrency - 1);
    };

    // 模拟 res 触发 close/finish
    releaseOnce();
    assert.equal(activeConcurrency, 0, 'concurrency must decrease to 0 after release');
    // 幂等调用不重复释放
    releaseOnce();
    assert.equal(activeConcurrency, 0, 'concurrency release must be idempotent');
  });
});

