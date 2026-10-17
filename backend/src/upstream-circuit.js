/**
 * D12 / P1-5：进程内连续失败熔断。
 *
 * residual / 运维说明：PM2 cluster 或多 worker 下，熔断计数与打开窗口为
 * **每进程一份**，不跨进程聚合、不读写 Redis。跨 worker 共享属其它条目。
 *
 * 与 D11 解耦：generate 路径以一次 `invokeWithRetry` 整轮（含重试耗尽）计 1 次
 * 连续失败；不得把内部每次 `invoke` 计成多次。
 */

/** 默认连续失败阈值（达到后 open）。 */
export const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 5;

/** 默认打开窗口（ms）。 */
export const DEFAULT_CIRCUIT_OPEN_DURATION_MS = 60_000;

/**
 * 构造可识别的熔断打开错误。
 * @returns {Error & { code: string, reason: string, circuitOpen: true }}
 */
export function createCircuitOpenError() {
  const err = /** @type {Error & { code: string, reason: string, circuitOpen: true }} */ (
    new Error('Upstream circuit is open')
  );
  err.code = 'circuit_open';
  err.reason = 'circuit_open';
  err.circuitOpen = true;
  return err;
}

/**
 * 判断是否为熔断短路错误。
 * @param {unknown} error
 * @returns {boolean}
 */
export function isCircuitOpenError(error) {
  if (!error || typeof error !== 'object') return false;
  const err = /** @type {Record<string, unknown>} */ (error);
  return err.circuitOpen === true
    || err.code === 'circuit_open'
    || err.reason === 'circuit_open';
}

/**
 * 创建独立熔断器实例（同进程多实例互不共享，用于 UT-CIRCUIT-07）。
 * @param {{
 *   failureThreshold?: number,
 *   openDurationMs?: number,
 *   now?: () => number,
 * }} [options]
 */
export function createCircuitBreaker(options = {}) {
  let failureThreshold = Number.isFinite(options.failureThreshold)
    ? Number(options.failureThreshold)
    : DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
  let openDurationMs = Number.isFinite(options.openDurationMs)
    ? Number(options.openDurationMs)
    : DEFAULT_CIRCUIT_OPEN_DURATION_MS;
  let nowFn = typeof options.now === 'function' ? options.now : () => Date.now();

  /** @type {'closed' | 'open'} */
  let state = 'closed';
  let consecutiveFailures = 0;
  /** @type {number|null} */
  let openedAt = null;
  /** @type {number|null} */
  let openUntil = null;

  /**
   * 若打开窗口已过期则回到 closed 并清零计数。
   */
  function maybeExpireOpen() {
    if (state !== 'open' || openUntil == null) return;
    if (nowFn() >= openUntil) {
      state = 'closed';
      consecutiveFailures = 0;
      openedAt = null;
      openUntil = null;
    }
  }

  /**
   * 读取当前快照（测试与路由断言用）。
   */
  function getSnapshot() {
    maybeExpireOpen();
    return {
      state,
      consecutiveFailures,
      openedAt,
      openUntil,
      failureThreshold,
      openDurationMs,
    };
  }

  /**
   * @returns {'closed'|'open'}
   */
  function getState() {
    return getSnapshot().state;
  }

  /**
   * @returns {boolean}
   */
  function isOpen() {
    return getState() === 'open';
  }

  /**
   * open 时抛 circuit_open；closed（含窗口已过期）允许继续。
   */
  function assertClosed() {
    maybeExpireOpen();
    if (state === 'open') {
      throw createCircuitOpenError();
    }
  }

  /**
   * 记录一次业务侧上游整轮失败；达阈值则 open。
   */
  function recordFailure() {
    maybeExpireOpen();
    if (state === 'open') {
      // 已在打开窗口内：不提前关闭、不刷新窗口
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold) {
      state = 'open';
      openedAt = nowFn();
      openUntil = openedAt + openDurationMs;
    }
  }

  /**
   * 整轮成功：清零连续失败并确保 closed。
   */
  function recordSuccess() {
    consecutiveFailures = 0;
    state = 'closed';
    openedAt = null;
    openUntil = null;
  }

  /**
   * 包装上游调用：先 assertClosed，再按结果 recordSuccess / recordFailure。
   * @template T
   * @param {() => Promise<T>} invokeFn
   * @returns {Promise<T>}
   */
  async function run(invokeFn) {
    assertClosed();
    try {
      const result = await invokeFn();
      recordSuccess();
      return result;
    } catch (error) {
      if (!isCircuitOpenError(error)) {
        recordFailure();
      }
      throw error;
    }
  }

  /**
   * 测试/路由注入：覆盖阈值、窗口与时钟。
   * @param {{
   *   failureThreshold?: number,
   *   openDurationMs?: number,
   *   now?: () => number,
   *   consecutiveFailures?: number,
   * }} [opts]
   */
  function configure(opts = {}) {
    if (Number.isFinite(opts.failureThreshold)) {
      failureThreshold = Number(opts.failureThreshold);
    }
    if (Number.isFinite(opts.openDurationMs)) {
      openDurationMs = Number(opts.openDurationMs);
    }
    if (typeof opts.now === 'function') {
      nowFn = opts.now;
    }
    if (Number.isFinite(opts.consecutiveFailures)) {
      consecutiveFailures = Number(opts.consecutiveFailures);
      state = 'closed';
      openedAt = null;
      openUntil = null;
      if (consecutiveFailures >= failureThreshold) {
        state = 'open';
        openedAt = nowFn();
        openUntil = openedAt + openDurationMs;
      }
    }
  }

  /**
   * 恢复 closed、计数 0，并可选重置时钟为 Date.now。
   */
  function reset() {
    state = 'closed';
    consecutiveFailures = 0;
    openedAt = null;
    openUntil = null;
    failureThreshold = DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    openDurationMs = DEFAULT_CIRCUIT_OPEN_DURATION_MS;
    nowFn = () => Date.now();
  }

  return {
    assertClosed,
    recordFailure,
    recordSuccess,
    run,
    getSnapshot,
    getState,
    isOpen,
    configure,
    reset,
  };
}

/** 进程内默认单例（cluster 下每 worker 各自一份）。 */
const processCircuit = createCircuitBreaker();

/**
 * 取得进程内默认熔断器。
 */
export function getUpstreamCircuit() {
  return processCircuit;
}

/**
 * 测试注入默认单例的阈值 / 窗口 / 时钟。
 * @param {{
 *   failureThreshold?: number,
 *   openDurationMs?: number,
 *   now?: () => number,
 *   consecutiveFailures?: number,
 * }} [opts]
 */
export function setUpstreamCircuitForTests(opts = {}) {
  processCircuit.configure(opts);
}

/**
 * 测试恢复默认单例为 closed、计数 0。
 */
export function resetUpstreamCircuitForTests() {
  processCircuit.reset();
}

/**
 * 经进程内默认熔断器执行上游整轮调用（generate：包一层 invokeWithRetry）。
 * @template T
 * @param {() => Promise<T>} invokeFn
 * @returns {Promise<T>}
 */
export async function runWithUpstreamCircuit(invokeFn) {
  return processCircuit.run(invokeFn);
}
