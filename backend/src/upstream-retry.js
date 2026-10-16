/**
 * D11 / P1-5：同步 generate 路径对上游 429/5xx 的有限重试。
 * 仅供 `answer/generate` 的 `model.invoke` 使用；chat SSE 不得套用。
 */

/** 两次重试前的固定等待（ms）；可被测试注入覆盖。 */
export const DEFAULT_RETRY_JITTER_MS = Object.freeze([50, 100]);

/** 失败后最多再试次数（合计至多 1 + 2 = 3 次 invoke）。 */
export const MAX_UPSTREAM_RETRIES = 2;

/** @type {readonly number[]} */
let activeJitterMs = DEFAULT_RETRY_JITTER_MS;

/** @type {(ms: number) => Promise<void>} */
let activeSleep = defaultSleep;

/**
 * 默认 sleep：真实等待指定毫秒。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 测试注入 jitter / sleep；生产路径勿调用。
 * @param {{ jitterMs?: number[], sleep?: (ms: number) => Promise<void> }} [opts]
 */
export function setUpstreamRetryForTests(opts = {}) {
  if (Array.isArray(opts.jitterMs)) {
    activeJitterMs = opts.jitterMs.map((n) => Number(n));
  }
  if (typeof opts.sleep === 'function') {
    activeSleep = opts.sleep;
  }
}

/**
 * 恢复默认 jitter 与 sleep。
 */
export function resetUpstreamRetryForTests() {
  activeJitterMs = DEFAULT_RETRY_JITTER_MS;
  activeSleep = defaultSleep;
}

/**
 * 从 Error（或 LangChain / OpenAI 包装）读取上游 HTTP 状态。
 * 择优顺序：`status` → `statusCode` → `response.status`（与 UT-RETRY 测码注释一致）。
 * @param {unknown} error
 * @returns {number|null}
 */
export function getUpstreamHttpStatus(error) {
  if (!error || typeof error !== 'object') return null;
  const err = /** @type {Record<string, unknown>} */ (error);
  if (typeof err.status === 'number') return err.status;
  if (typeof err.statusCode === 'number') return err.statusCode;
  const response = err.response;
  if (response && typeof response === 'object' && typeof /** @type {{ status?: unknown }} */ (response).status === 'number') {
    return /** @type {{ status: number }} */ (response).status;
  }
  return null;
}

/**
 * 仅 429 与 5xx 可重试；其它 4xx 立即失败。
 * @param {number|null} status
 * @returns {boolean}
 */
export function isRetryableUpstreamStatus(status) {
  if (status === null || !Number.isFinite(status)) return false;
  if (status === 429) return true;
  return status >= 500 && status <= 599;
}

/**
 * 对同步 `invoke` 做有限重试：429/5xx 最多再试 MAX_UPSTREAM_RETRIES 次。
 * @template T
 * @param {() => Promise<T>} invokeFn 单次上游调用（通常为 `() => model.invoke(messages)`）
 * @param {{ jitterMs?: number[], sleep?: (ms: number) => Promise<void>, maxRetries?: number }} [options]
 * @returns {Promise<T>}
 */
export async function invokeWithRetry(invokeFn, options = {}) {
  const jitterMs = options.jitterMs ?? activeJitterMs;
  const sleep = options.sleep ?? activeSleep;
  const maxRetries = options.maxRetries ?? MAX_UPSTREAM_RETRIES;
  const maxAttempts = 1 + maxRetries;

  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await invokeFn();
    } catch (error) {
      lastError = error;
      const status = getUpstreamHttpStatus(error);
      const hasMoreAttempts = attempt < maxAttempts - 1;
      if (!hasMoreAttempts || !isRetryableUpstreamStatus(status)) {
        throw error;
      }
      const delay = jitterMs[attempt] ?? jitterMs[jitterMs.length - 1] ?? 0;
      await sleep(delay);
    }
  }
  throw lastError;
}
