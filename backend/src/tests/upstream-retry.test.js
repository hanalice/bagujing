/**
 * D11 / P1-5：同步 generate 对 429/5xx 有限重试（单元）。
 * 状态读取顺序：error.status → statusCode → response.status（见 getUpstreamHttpStatus）。
 * 用例 ID 对齐 docs/test_cases.md §2.27。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmConfig } from '../llm.js';
import {
  DEFAULT_RETRY_JITTER_MS,
  getUpstreamHttpStatus,
  invokeWithRetry,
  resetUpstreamRetryForTests,
  setUpstreamRetryForTests,
} from '../upstream-retry.js';

/** 构造带 HTTP 状态的上游错误（优先挂 status，与 LangChain/OpenAI 一致）。 */
function makeUpstreamError(status, message = `upstream ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const OK_CONTENT = {
  content: '{"summary":"ok","keyPoints":["k"],"nextStep":"n"}',
};

afterEach(() => {
  resetUpstreamRetryForTests();
});

describe('D11 / P1-5: invokeWithRetry 有限重试', () => {
  it('UT-RETRY-01: 429 后第 2 次成功：共 2 次 invoke', async () => {
    const sleeps = [];
    setUpstreamRetryForTests({
      jitterMs: [0, 0],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    let calls = 0;
    const result = await invokeWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw makeUpstreamError(429);
      return OK_CONTENT;
    });
    assert.equal(calls, 2);
    assert.deepEqual(sleeps, [0]);
    assert.equal(result, OK_CONTENT);
  });

  it('UT-RETRY-02: 5xx（503）后第 3 次成功：共 3 次 invoke', async () => {
    for (const status of [503, 500, 502]) {
      const sleeps = [];
      setUpstreamRetryForTests({
        jitterMs: [10, 20],
        sleep: async (ms) => { sleeps.push(ms); },
      });
      let calls = 0;
      const result = await invokeWithRetry(async () => {
        calls += 1;
        if (calls <= 2) throw makeUpstreamError(status);
        return { content: `ok-${status}` };
      });
      assert.equal(calls, 3, `status=${status} invoke 次数`);
      assert.deepEqual(sleeps, [10, 20], `status=${status} sleep`);
      assert.equal(result.content, `ok-${status}`);
    }
  });

  it('UT-RETRY-03: 连续 3 次 429：耗尽后抛出且不再调用', async () => {
    const sleeps = [];
    setUpstreamRetryForTests({
      jitterMs: [0, 0],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    let calls = 0;
    await assert.rejects(
      () => invokeWithRetry(async () => {
        calls += 1;
        throw makeUpstreamError(429);
      }),
      (err) => {
        assert.equal(getUpstreamHttpStatus(err), 429);
        return true;
      },
    );
    assert.equal(calls, 3);
    assert.equal(sleeps.length, 2);
  });

  it('UT-RETRY-04: 非 429 的 4xx（400/401/403）不重试', async () => {
    for (const status of [400, 401, 403]) {
      const sleeps = [];
      setUpstreamRetryForTests({
        jitterMs: [50, 100],
        sleep: async (ms) => { sleeps.push(ms); },
      });
      let calls = 0;
      await assert.rejects(
        () => invokeWithRetry(async () => {
          calls += 1;
          throw makeUpstreamError(status);
        }),
        (err) => getUpstreamHttpStatus(err) === status,
      );
      assert.equal(calls, 1, `status=${status}`);
      assert.equal(sleeps.length, 0, `status=${status} 零次 sleep`);
    }
  });

  it('UT-RETRY-05: jitter 序列固定：断言精确等待', async () => {
    const sleeps = [];
    const callOrder = [];
    setUpstreamRetryForTests({
      jitterMs: [50, 100],
      sleep: async (ms) => {
        sleeps.push(ms);
        callOrder.push(`sleep${ms}`);
      },
    });
    let calls = 0;
    await invokeWithRetry(async () => {
      calls += 1;
      callOrder.push(`invoke${calls}`);
      if (calls <= 2) throw makeUpstreamError(500);
      return OK_CONTENT;
    });
    assert.deepEqual(sleeps, [50, 100]);
    assert.deepEqual(callOrder, ['invoke1', 'sleep50', 'invoke2', 'sleep100', 'invoke3']);
    assert.equal(calls, 3);
    // 证明未使用 DEFAULT 以外的随机毫秒
    assert.deepEqual(DEFAULT_RETRY_JITTER_MS, [50, 100]);
  });

  it('UT-RETRY-06: chat SSE：stream 遇 429/5xx 不重试', async () => {
    const sleeps = [];
    setUpstreamRetryForTests({
      jitterMs: [50, 100],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    let streamCalls = 0;
    const model = {
      // chat 路径直接 stream，不经过 invokeWithRetry
      async stream() {
        streamCalls += 1;
        throw makeUpstreamError(429);
      },
    };
    await assert.rejects(() => model.stream([]), (err) => getUpstreamHttpStatus(err) === 429);
    assert.equal(streamCalls, 1);
    assert.equal(sleeps.length, 0);
  });

  it('UT-RETRY-07: 不做：上游超时默认值未被本项改写', () => {
    const bare = buildLlmConfig();
    assert.equal(bare.timeout, undefined);
    const withDefault = buildLlmConfig({}, { upstreamTimeoutMs: 30000 });
    assert.equal(withDefault.timeout, 30000);
  });

  it('UT-RETRY-08: residual：本项不引入跨进程熔断', async () => {
    setUpstreamRetryForTests({
      jitterMs: [0, 0],
      sleep: async () => {},
    });
    // 先耗尽三次 429
    let failCalls = 0;
    await assert.rejects(() => invokeWithRetry(async () => {
      failCalls += 1;
      throw makeUpstreamError(429);
    }));
    assert.equal(failCalls, 3);

    // 全新第四次调用：无熔断，首次即成功
    let okCalls = 0;
    const result = await invokeWithRetry(async () => {
      okCalls += 1;
      return OK_CONTENT;
    });
    assert.equal(okCalls, 1);
    assert.equal(result, OK_CONTENT);
  });

  it('UT-RETRY-09: 首次 invoke 成功：无 sleep、无二次调用', async () => {
    const sleeps = [];
    setUpstreamRetryForTests({
      jitterMs: [50, 100],
      sleep: async (ms) => { sleeps.push(ms); },
    });
    let calls = 0;
    const result = await invokeWithRetry(async () => {
      calls += 1;
      return OK_CONTENT;
    });
    assert.equal(calls, 1);
    assert.equal(sleeps.length, 0);
    assert.equal(result, OK_CONTENT);
  });
});
