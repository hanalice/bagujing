import { isCircuitOpenError } from './upstream-circuit.js';
import { getUpstreamHttpStatus } from './upstream-retry.js';

/**
 * 把 chat 流式失败收成可排行的 reason，并带上上游 HTTP 状态码。
 * 客户端中断优先于空闲超时：连接已断时不再记成超时。
 * @param {unknown} error
 * @param {{ aborted?: boolean }} [options]
 * @returns {{ reason: string, upstreamStatus: number|null }}
 */
export function classifyChatStreamFailure(error, { aborted = false } = {}) {
  if (isCircuitOpenError(error)) {
    return { reason: 'circuit_open', upstreamStatus: null };
  }
  if (aborted) {
    return { reason: 'client_abort', upstreamStatus: null };
  }
  if (error && typeof error === 'object' && /** @type {{ message?: unknown }} */ (error).message === 'SSE idle timeout') {
    return { reason: 'sse_idle_timeout', upstreamStatus: null };
  }
  const status = getUpstreamHttpStatus(error);
  if (typeof status === 'number') {
    return { reason: 'upstream_http', upstreamStatus: status };
  }
  return { reason: 'server_error', upstreamStatus: null };
}
