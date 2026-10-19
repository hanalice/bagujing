/**
 * D21 / P1-5：主备 Base URL failover。
 *
 * 契约：若配置了 `OPENAI_BASE_URL_FALLBACK`，主 URL 在向客户端发出首字节
 *（chat：尚未写出任何 SSE `delta`；generate：尚未拿到成功 content）前失败时，
 * 改用备用 Base URL 再发起一次上游。已推 `delta` 后不得切换。
 *
 * 不做：跨请求会话级 failover（每次请求仍从主 URL 起调）；已中断流伪装续传。
 * 与 D11 正交：failover 换的是 Base URL；同 URL 的 429/5xx 重试仍由 invokeWithRetry 负责。
 * 与 D12：熔断已 open 时本模块不应被调用（上游含备用均为 0）。
 */

import { resolveUpstreamBaseUrls } from './llm.js';

/**
 * 同步 generate：主 baseURL 整轮失败且已配置备用时，再用备用跑一轮。
 * 无会话记忆——每次调用都从主 URL 开始。
 *
 * @template T
 * @param {(baseURL: string) => Promise<T>} runOnBaseUrl 按给定 baseURL 执行上游（通常内含 create + invokeWithRetry）
 * @param {{ urls?: { primary: string, fallback: string|null } }} [options]
 * @returns {Promise<T>}
 */
export async function invokeWithBaseUrlFailover(runOnBaseUrl, options = {}) {
  const { primary, fallback } = options.urls ?? resolveUpstreamBaseUrls();
  try {
    return await runOnBaseUrl(primary);
  } catch (error) {
    if (!fallback) throw error;
    return await runOnBaseUrl(fallback);
  }
}

/**
 * 流式 chat：仅在尚未向客户端写出任何 `delta` 时允许切备用。
 * `runAttempt` 内部在写出首条 delta 后须使 `getHasSentDelta()` 为 true。
 *
 * @template T
 * @param {(baseURL: string) => Promise<T>} runAttempt
 * @param {{
 *   urls?: { primary: string, fallback: string|null },
 *   getHasSentDelta?: () => boolean,
 * }} [options]
 * @returns {Promise<T>}
 */
export async function streamWithBaseUrlFailover(runAttempt, options = {}) {
  const { primary, fallback } = options.urls ?? resolveUpstreamBaseUrls();
  const getHasSentDelta = typeof options.getHasSentDelta === 'function'
    ? options.getHasSentDelta
    : () => false;

  try {
    return await runAttempt(primary);
  } catch (error) {
    if (!fallback || getHasSentDelta()) throw error;
    return await runAttempt(fallback);
  }
}

/** 与 withBaseUrlFailover 测码注释中的别名对齐（generate 侧）。 */
export const withBaseUrlFailover = invokeWithBaseUrlFailover;
