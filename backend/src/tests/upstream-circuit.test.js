/**
 * D12 / P1-5：进程内连续失败熔断（单元）。
 * 用例 ID 对齐 docs/test_cases.md §2.28。
 * 状态字段：state / consecutiveFailures / openedAt / openUntil（见 getSnapshot）。
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createCircuitBreaker,
  createCircuitOpenError,
  getUpstreamCircuit,
  isCircuitOpenError,
  resetUpstreamCircuitForTests,
} from '../upstream-circuit.js';
import {
  invokeWithRetry,
  resetUpstreamRetryForTests,
  setUpstreamRetryForTests,
} from '../upstream-retry.js';

/** 构造带 HTTP 状态的上游错误。 */
function makeUpstreamError(status, message = `upstream ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

afterEach(() => {
  resetUpstreamCircuitForTests();
  resetUpstreamRetryForTests();
});

describe('D12 / P1-5: 进程内连续失败熔断', () => {
  it('UT-CIRCUIT-01: 连续失败达阈值后进入 open', () => {
    let now = 1_000_000;
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      openDurationMs: 60_000,
      now: () => now,
    });

    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.getState(), 'closed');
    breaker.recordFailure();

    const snap = breaker.getSnapshot();
    assert.equal(snap.state, 'open');
    assert.equal(breaker.isOpen(), true);
    assert.equal(snap.consecutiveFailures, 3);
    assert.equal(snap.openUntil, now + 60_000);
    assert.equal(snap.openedAt, now);
  });

  it('UT-CIRCUIT-02: open 窗口内短路：零次上游调用', async () => {
    let now = 2_000_000;
    const breaker = createCircuitBreaker({
      failureThreshold: 3,
      openDurationMs: 60_000,
      now: () => now,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), true);
    const openUntilBefore = breaker.getSnapshot().openUntil;

    let invokeCalls = 0;
    await assert.rejects(
      () => breaker.run(async () => {
        invokeCalls += 1;
        return 'should-not-run';
      }),
      (err) => isCircuitOpenError(err) && err.reason === 'circuit_open',
    );
    assert.equal(invokeCalls, 0);
    assert.equal(breaker.getState(), 'open');
    assert.equal(breaker.getSnapshot().openUntil, openUntilBefore);
  });

  it('UT-CIRCUIT-03: 打开窗口结束后恢复可调用', async () => {
    let now = 3_000_000;
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      openDurationMs: 1000,
      now: () => now,
    });
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.isOpen(), true);
    const openedAt = breaker.getSnapshot().openedAt;

    now = openedAt + 1000;
    let invokeCalls = 0;
    const result = await breaker.run(async () => {
      invokeCalls += 1;
      return 'ok';
    });
    assert.equal(invokeCalls, 1);
    assert.equal(result, 'ok');
    assert.equal(breaker.getState(), 'closed');
    assert.equal(breaker.getSnapshot().consecutiveFailures, 0);
  });

  it('UT-CIRCUIT-04: 成功清零连续失败计数', async () => {
    const breaker = createCircuitBreaker({ failureThreshold: 3, openDurationMs: 60_000 });
    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.getState(), 'closed');
    assert.equal(breaker.getSnapshot().consecutiveFailures, 2);

    await breaker.run(async () => 'ok');
    assert.equal(breaker.getSnapshot().consecutiveFailures, 0);

    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.getState(), 'closed');
    assert.equal(breaker.getSnapshot().consecutiveFailures, 2);
  });

  it('UT-CIRCUIT-05: 阈值与窗口可注入：单测可驱动', () => {
    let nowA = 10_000;
    const a = createCircuitBreaker({
      failureThreshold: 2,
      openDurationMs: 500,
      now: () => nowA,
    });
    a.recordFailure();
    a.recordFailure();
    assert.equal(a.getState(), 'open');
    const snapA = a.getSnapshot();
    assert.equal(snapA.openUntil - snapA.openedAt, 500);

    let nowB = 20_000;
    const b = createCircuitBreaker({
      failureThreshold: 5,
      openDurationMs: 10_000,
      now: () => nowB,
    });
    for (let i = 0; i < 4; i += 1) b.recordFailure();
    assert.equal(b.getState(), 'closed');
    b.recordFailure();
    assert.equal(b.getState(), 'open');
    const snapB = b.getSnapshot();
    assert.equal(snapB.openUntil - snapB.openedAt, 10_000);
  });

  it('UT-CIRCUIT-06: 不依赖 Redis：无客户端亦生效', async () => {
    const prevRedis = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const breaker = createCircuitBreaker({ failureThreshold: 2, openDurationMs: 60_000 });
      let invokeCalls = 0;
      await assert.rejects(() => breaker.run(async () => {
        invokeCalls += 1;
        throw new Error('fail');
      }));
      await assert.rejects(() => breaker.run(async () => {
        invokeCalls += 1;
        throw new Error('fail');
      }));
      assert.equal(breaker.getState(), 'open');
      const before = invokeCalls;
      await assert.rejects(
        () => breaker.run(async () => {
          invokeCalls += 1;
          return 'nope';
        }),
        (err) => isCircuitOpenError(err),
      );
      assert.equal(invokeCalls, before);
    } finally {
      if (prevRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = prevRedis;
    }
  });

  it('UT-CIRCUIT-07: 不做：两独立实例不共享状态', async () => {
    const a = createCircuitBreaker({ failureThreshold: 2, openDurationMs: 60_000 });
    const b = createCircuitBreaker({ failureThreshold: 2, openDurationMs: 60_000 });
    a.recordFailure();
    a.recordFailure();
    assert.equal(a.getState(), 'open');
    assert.equal(b.getState(), 'closed');

    let invokeCalls = 0;
    const result = await b.run(async () => {
      invokeCalls += 1;
      return 'ok-b';
    });
    assert.equal(invokeCalls, 1);
    assert.equal(result, 'ok-b');
  });

  it('UT-CIRCUIT-08: residual：cluster 每进程一份（文档/契约锁）', () => {
    const modPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../upstream-circuit.js',
    );
    const source = fs.readFileSync(modPath, 'utf8');
    assert.match(source, /每进程一份|不跨进程聚合/);
    assert.match(source, /不读写 Redis|不依赖 Redis|不.*Redis/);

    const circuit = getUpstreamCircuit();
    circuit.recordFailure();
    assert.ok(circuit.getSnapshot().consecutiveFailures >= 1);
    resetUpstreamCircuitForTests();
    assert.equal(getUpstreamCircuit().getState(), 'closed');
    assert.equal(getUpstreamCircuit().getSnapshot().consecutiveFailures, 0);
  });

  it('UT-CIRCUIT-09: 与 D11 解耦：整轮重试耗尽只计 1 次失败', async () => {
    setUpstreamRetryForTests({ jitterMs: [0, 0], sleep: async () => {} });
    let now = 5_000_000;
    const breaker = createCircuitBreaker({
      failureThreshold: 2,
      openDurationMs: 60_000,
      now: () => now,
    });

    let invokeCalls = 0;
    const failingInvoke = async () => {
      invokeCalls += 1;
      throw makeUpstreamError(503);
    };

    // 第一轮：3 次 invoke，计数 1，仍 closed
    await assert.rejects(() => breaker.run(() => invokeWithRetry(failingInvoke)));
    assert.equal(invokeCalls, 3);
    assert.equal(breaker.getSnapshot().consecutiveFailures, 1);
    assert.equal(breaker.getState(), 'closed');

    // 第二轮：再 3 次后 open
    await assert.rejects(() => breaker.run(() => invokeWithRetry(failingInvoke)));
    assert.equal(invokeCalls, 6);
    assert.equal(breaker.getSnapshot().consecutiveFailures, 2);
    assert.equal(breaker.getState(), 'open');

    // 第三轮：短路，零次 invoke
    const before = invokeCalls;
    await assert.rejects(
      () => breaker.run(() => invokeWithRetry(failingInvoke)),
      (err) => isCircuitOpenError(err),
    );
    assert.equal(invokeCalls, before);
  });

  it('UT-CIRCUIT-10: 未达阈值时行为与无熔断一致', async () => {
    setUpstreamRetryForTests({ jitterMs: [0, 0], sleep: async () => {} });
    const breaker = createCircuitBreaker({ failureThreshold: 5, openDurationMs: 60_000 });

    let okCalls = 0;
    await breaker.run(async () => {
      okCalls += 1;
      return 'ok';
    });
    assert.equal(okCalls, 1);
    assert.equal(breaker.getState(), 'closed');
    assert.equal(breaker.getSnapshot().consecutiveFailures, 0);

    let badCalls = 0;
    await assert.rejects(
      () => breaker.run(() => invokeWithRetry(async () => {
        badCalls += 1;
        throw makeUpstreamError(400);
      })),
      (err) => err.status === 400 && !isCircuitOpenError(err),
    );
    assert.equal(badCalls, 1);
    assert.equal(breaker.getState(), 'closed');
    assert.equal(breaker.getSnapshot().consecutiveFailures, 1);
  });

  it('辅助：createCircuitOpenError 可识别', () => {
    const err = createCircuitOpenError();
    assert.equal(isCircuitOpenError(err), true);
    assert.equal(err.code, 'circuit_open');
  });
});
