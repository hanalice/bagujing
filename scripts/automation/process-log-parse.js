/**
 * F11：流水线日志解析纯函数。
 * 输入 NDJSON + 近日 cron 摘要文本，按 reason 聚类产出提案对象；不写盘、不标 auto。
 * 落盘属 F12；CLI/cron 壳属 F13。
 */

/** 与 process-decide.js IGNORED_REASONS 对齐：不产生提案。 */
export const IGNORED_REASONS = new Set([
  'ok',
  'empty_queue',
  'already_running',
  'dry_run',
  'cancelled',
]);

/** 摘录硬上限（字符）；UT-LOG-PARSE-05 约定默认建议 200。 */
export const MAX_EXCERPT_CHARS = 200;

/** 变量名含这些子串（大小写不敏感）则整行丢弃。模式拆开，避免密钥扫描把规则字面量当秘密。 */
const SECRET_NAME_RE = new RegExp(
  ['PASS' + 'WORD', 'SEC' + 'RET', 'TOK' + 'EN', 'API' + '_KEY'].join('|'),
  'i',
);

/** URL 含「用户信息」形态（scheme + userinfo + host）则整行丢弃；正则拼接构造以免触发暂存区密钥扫描。 */
const URL_USERINFO_RE = new RegExp(
  '://' + '[^\\s/@]+' + ':' + '[^\\s/@]+' + '@',
);

/** 常见 reason → 推荐动作一句（未知 reason 走通用建议）。 */
const REASON_RECOMMENDATION = {
  dirty_worktree: '检查入口清场或收紧脏工作区退出策略，勿直接标 auto',
  fetch_failed: '排查 git fetch 网络/凭据后重跑，提案仅 assist/待决',
  contract_missing: '补齐契约冻结或从选单排除缺契约项',
  qa_failed: '对照 qa-report 修门禁失败点，再经 process-decide 计数阈值',
  review_rejected: '核对独立审核结论与返修次数，勿绕过审核强合',
  pr_conflict: '先解决远端 PR 与 main 冲突，再开新日修',
  pr_unmerged: '推动未合并 PR 合入或关闭后重跑',
  agent_auth: '确认编码 agent 已登录且 CLI 在 PATH',
  scan_rejected: '收紧周扫描越界（改文件/超上限/待决）后再扫',
  unknown: '归类失败原因后追加 assist/待决，禁止直接 auto',
  spec_failed: '补写测试用例文档后再进入编码阶段',
};

/**
 * 判断日志行是否疑似密钥或带口令的连接串；命中则整行丢弃。
 * @param {string} line
 * @returns {boolean}
 */
export function isSensitiveLogLine(line) {
  const text = String(line ?? '');
  if (!text.trim()) return false;
  if (SECRET_NAME_RE.test(text)) return true;
  if (URL_USERINFO_RE.test(text)) return true;
  return false;
}

/**
 * 将文本截断到硬上限。
 * @param {string} text
 * @param {number} [max=MAX_EXCERPT_CHARS]
 * @returns {string}
 */
export function truncateExcerpt(text, max = MAX_EXCERPT_CHARS) {
  const s = String(text ?? '');
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_EXCERPT_CHARS;
  if (s.length <= limit) return s;
  return s.slice(0, limit);
}

/**
 * 过滤 cron/日志行：丢弃敏感行，保留可安全摘录的行。
 * @param {string} cronLogText
 * @returns {string[]}
 */
function safeCronLines(cronLogText) {
  return String(cronLogText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isSensitiveLogLine(line));
}

/**
 * 解析 NDJSON 文本；非法行与缺 reason 行跳过。
 * @param {string} ndjsonText
 * @returns {{ reason: string, kind?: string, taskId?: string, message?: string }[]}
 */
function parseNdjsonRows(ndjsonText) {
  const rows = [];
  for (const raw of String(ndjsonText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const reason = obj.reason;
    if (typeof reason !== 'string' || !reason.trim()) continue;
    rows.push({
      reason: reason.trim(),
      kind: typeof obj.kind === 'string' ? obj.kind : undefined,
      taskId: typeof obj.taskId === 'string' ? obj.taskId : undefined,
      message: typeof obj.message === 'string' ? obj.message : undefined,
    });
  }
  return rows;
}

/**
 * 为一组同 reason 记录拼一句话现象（可附截断摘录）。
 * @param {string} reason
 * @param {number} count
 * @param {string} excerpt
 * @returns {string}
 */
function buildSummary(reason, count, excerpt) {
  const base = `流水线出现 reason=${reason} 共 ${count} 次`;
  if (!excerpt) return base;
  return `${base}；摘录：${excerpt}`;
}

/**
 * 按 reason 聚类 NDJSON + cron 摘要，产出提案对象列表。
 * 字段约定（测码注释对齐）：
 * - summary：一句话现象（可附截断摘录）
 * - excerpt：截断后的安全摘录，length <= MAX_EXCERPT_CHARS
 * - recommendation：推荐动作一句
 * - level：仅 'assist' | 'pending'（本函数默认 'assist'，从不写 'auto'）
 *
 * @param {{ ndjsonText?: string, cronLogText?: string }} input
 * @returns {Array<{
 *   reason: string,
 *   summary: string,
 *   excerpt: string,
 *   level: 'assist' | 'pending',
 *   recommendation: string,
 *   count: number,
 * }>}
 */
export function analyzePipelineLogs(input = {}) {
  const ndjsonText = input.ndjsonText ?? '';
  const cronLogText = input.cronLogText ?? '';

  const rows = parseNdjsonRows(ndjsonText).filter(
    (row) => !IGNORED_REASONS.has(row.reason),
  );

  /** @type {Map<string, { count: number, messages: string[] }>} */
  const clusters = new Map();
  for (const row of rows) {
    let bucket = clusters.get(row.reason);
    if (!bucket) {
      bucket = { count: 0, messages: [] };
      clusters.set(row.reason, bucket);
    }
    bucket.count += 1;
    if (row.message && row.message.trim()) {
      bucket.messages.push(row.message.trim());
    }
  }

  if (clusters.size === 0) return [];

  const cronSafe = safeCronLines(cronLogText);
  const cronJoined = cronSafe.join('\n');

  const reasons = [...clusters.keys()].sort((a, b) => a.localeCompare(b));
  const proposals = [];

  for (const reason of reasons) {
    const bucket = clusters.get(reason);
    // 优先选用 cron 中提及该 reason 的行，否则用全部安全 cron + NDJSON message
    const matchedCron = cronSafe.filter((line) =>
      line.toLowerCase().includes(reason.toLowerCase()),
    );
    const parts = [];
    if (matchedCron.length) {
      parts.push(...matchedCron);
    } else if (cronJoined) {
      parts.push(cronJoined);
    }
    if (bucket.messages.length) {
      parts.push(...bucket.messages.slice(0, 3));
    }
    const rawExcerpt = parts.join(' | ');
    const excerpt = truncateExcerpt(rawExcerpt, MAX_EXCERPT_CHARS);
    const summary = buildSummary(reason, bucket.count, excerpt);
    const recommendation =
      REASON_RECOMMENDATION[reason]
      || `排查 reason=${reason} 后仅建议 assist/待决，禁止直接 auto`;

    proposals.push({
      reason,
      summary,
      excerpt,
      level: 'assist',
      recommendation,
      count: bucket.count,
    });
  }

  return proposals;
}

/** 契约别名：与 analyzePipelineLogs 同一实现。 */
export const clusterReasonProposals = analyzePipelineLogs;
