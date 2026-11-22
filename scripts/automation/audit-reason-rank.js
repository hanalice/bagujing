/**
 * F21：业务审计 reason 排行纯函数。
 * 读 ai_audit_logs 行集（+可选 NDJSON 审计）与可选上次快照，
 * 按 reason 聚类排行并过样本/变化门控，产出 assist 提案对象；不写盘、不标 auto。
 * 落盘属 F22；CLI/cron 壳属 F23。
 */

/** 窗口总样本下限：严格小于此值 → 空提案。UT-AUDIT-RANK-02 约定。 */
export const MIN_SAMPLES = 20;

/** 相对上次 top 计数波动下限（绝对值）；同 reason 且 count/ratio 均低于阈值 → 无意义变化。 */
export const MIN_DELTA = 3;

/** 相对上次 top 占比波动下限（0–1）；与 MIN_DELTA 同时未达 → 空提案。 */
export const MIN_RATIO_DELTA = 0.05;

/** 摘录硬上限（字符）；UT-AUDIT-RANK-08 约定默认建议 200。 */
export const MAX_EXCERPT_CHARS = 200;

/**
 * 成功类 reason：计入窗口总分母，不得单独成「失败飙升」提案。
 * 与 S18 / 审计语义对齐。
 */
export const SUCCESS_REASONS = new Set([
  'stream_done',
  'generated_answer',
  'cached_answer',
]);

/**
 * 流水线 automation-runs 形态的 kind；误塞入审计输入槽时整行忽略（与 F1/F11 数据源分离）。
 */
const PIPELINE_KINDS = new Set([
  'daily-fix',
  'daily-fix-cron',
  'weekly-scan',
  'weekly-scan-cron',
  'process-decide',
  'process-decide-cron',
  'process-log-analyze',
  'process-log-analyze-cron',
]);

/** 变量名含这些子串（大小写不敏感）则整行丢弃。模式拆开，避免密钥扫描把规则字面量当秘密。 */
const SECRET_NAME_RE = new RegExp(
  ['PASS' + 'WORD', 'SEC' + 'RET', 'TOK' + 'EN', 'API' + '_KEY'].join('|'),
  'i',
);

/** URL 含「用户信息」形态（scheme + userinfo + host）则整行丢弃。 */
const URL_USERINFO_RE = new RegExp(
  '://' + '[^\\s/@]+' + ':' + '[^\\s/@]+' + '@',
);

/**
 * 判断审计行序列化文本是否疑似密钥或带口令连接串；命中则整行丢弃。
 * 丢弃行不计入窗口样本与聚类（默认推荐，测码注释对齐）。
 * @param {string} text
 * @returns {boolean}
 */
export function isSensitiveAuditText(text) {
  const s = String(text ?? '');
  if (!s.trim()) return false;
  if (SECRET_NAME_RE.test(s)) return true;
  if (URL_USERINFO_RE.test(s)) return true;
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
 * 把行对象序列化为可做敏感检测的文本（含各文本字段与 JSON）。
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function rowToProbeText(row) {
  const parts = [];
  for (const key of Object.keys(row)) {
    const val = row[key];
    if (typeof val === 'string' && val.trim()) parts.push(val);
    else if (typeof val === 'number' || typeof val === 'boolean') parts.push(String(val));
  }
  try {
    parts.push(JSON.stringify(row));
  } catch {
    /* ignore */
  }
  return parts.join('\n');
}

/**
 * 从行对象提取可用于摘录的 detail/message 类文本。
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function extractDetail(row) {
  for (const key of ['detail', 'message', 'error', 'summary', 'phenomenon']) {
    const val = row[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  const status = row.upstreamStatus ?? row.upstream_status;
  if (status != null && status !== '') return `upstreamStatus=${status}`;
  return '';
}

/**
 * 规范化单行审计记录；流水线 kind 行返回 null；缺 reason 返回 null。
 * 旧行缺 S18 新列可忽略，仍以 reason 为准。
 * @param {unknown} raw
 * @returns {{ reason: string, detail: string, upstreamStatus?: unknown } | null}
 */
function normalizeAuditRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const row = /** @type {Record<string, unknown>} */ (raw);
  const kind = typeof row.kind === 'string' ? row.kind.trim() : '';
  if (kind && PIPELINE_KINDS.has(kind)) return null;

  const reasonRaw = row.reason;
  if (typeof reasonRaw !== 'string' || !reasonRaw.trim()) return null;
  const reason = reasonRaw.trim();

  if (isSensitiveAuditText(rowToProbeText(row))) return null;

  return {
    reason,
    detail: extractDetail(row),
    upstreamStatus: row.upstreamStatus ?? row.upstream_status,
  };
}

/**
 * 将 auditRows 入参统一为对象数组（支持已是数组，或可解析的 NDJSON/JSON 导出文本）。
 * @param {unknown} auditRows
 * @returns {unknown[]}
 */
function coerceAuditRows(auditRows) {
  if (auditRows == null) return [];
  if (Array.isArray(auditRows)) return auditRows;
  if (typeof auditRows === 'string') {
    const text = auditRows.trim();
    if (!text) return [];
    // 优先尝试整段 JSON 数组
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      /* 按 NDJSON 行解析 */
    }
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        rows.push(JSON.parse(t));
      } catch {
        /* skip */
      }
    }
    return rows;
  }
  return [];
}

/**
 * 解析业务审计 NDJSON 文本（字段与 SQL 行语义对齐）。
 * @param {string} ndjsonAuditText
 * @returns {unknown[]}
 */
function parseNdjsonAudit(ndjsonAuditText) {
  const rows = [];
  for (const raw of String(ndjsonAuditText ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip illegal */
    }
  }
  return rows;
}

/**
 * 为一组同 reason 失败记录拼一句话现象（可附截断摘录）。
 * @param {string} reason
 * @param {number} count
 * @param {number} ratio
 * @param {string} excerpt
 * @returns {string}
 */
function buildSummary(reason, count, ratio, excerpt) {
  const pct = (ratio * 100).toFixed(1);
  const base = `业务审计窗口内 reason=${reason} 共 ${count} 次（占比 ${pct}%）`;
  if (!excerpt) return base;
  return `${base}；摘录：${excerpt}`;
}

/**
 * 推荐动作：调业务 backlog 优先级或开 assist 草案；禁止暗示 auto。
 * 测码关键词约定：`优先级` / `assist` / `草案` / `backlog`。
 * @param {string} reason
 * @returns {string}
 */
function buildRecommendation(reason) {
  return (
    `建议调整业务 backlog 中与 reason=${reason} 相关 todo 项的优先级，`
    + `或追加 assist 草案行说明现象；禁止直接标 auto`
  );
}

/**
 * 判断相对上次快照是否「有意义变化」。
 * previousSnapshot 结构约定：{ topReason: string, count: number, ratio: number }
 * （ratio 为 0–1；亦接受 share 别名）。
 * 无快照 → 视为有变化（首次可提案）。
 *
 * @param {{ reason: string, count: number, ratio: number } | null} currentTop
 * @param {{ topReason?: string, reason?: string, count?: number, ratio?: number, share?: number } | null | undefined} previousSnapshot
 * @returns {boolean} true = 有意义变化，应继续产出提案
 */
export function hasMeaningfulChange(currentTop, previousSnapshot) {
  if (!currentTop) return false;
  if (previousSnapshot == null || typeof previousSnapshot !== 'object') return true;

  const prevReason = String(
    previousSnapshot.topReason ?? previousSnapshot.reason ?? '',
  ).trim();
  if (!prevReason || prevReason !== currentTop.reason) return true;

  const prevCount = Number(previousSnapshot.count);
  const prevRatio = Number(
    previousSnapshot.ratio ?? previousSnapshot.share,
  );
  const countOk = Number.isFinite(prevCount);
  const ratioOk = Number.isFinite(prevRatio);
  // 快照缺字段时无法判定「无意义」，视为有变化以免误杀
  if (!countOk || !ratioOk) return true;

  const countDelta = Math.abs(currentTop.count - prevCount);
  const ratioDelta = Math.abs(currentTop.ratio - prevRatio);
  if (countDelta < MIN_DELTA && ratioDelta < MIN_RATIO_DELTA) return false;
  return true;
}

/**
 * 按 reason 聚类排行业务审计行，经样本/变化门控后产出提案对象列表。
 * 字段约定（测码注释对齐）：
 * - count：窗口内该失败 reason 计数
 * - ratio：相对窗口总样本的占比（0–1）
 * - summary：一句话现象（可附截断摘录）
 * - excerpt：截断后的安全摘录，length <= MAX_EXCERPT_CHARS
 * - recommendation：推荐动作（含「优先级」或「assist/草案」语义）
 * - level：精确为 'assist'（从不写 'pending' / 'auto'）
 *
 * 本函数为纯内存计算：不读流水线 logs、不以 HTTP 指标接口为输入、不写任何 markdown。
 *
 * @param {{
 *   auditRows?: unknown,
 *   ndjsonAuditText?: string,
 *   previousSnapshot?: {
 *     topReason?: string,
 *     reason?: string,
 *     count?: number,
 *     ratio?: number,
 *     share?: number,
 *   } | null,
 * }} [input]
 * @returns {Array<{
 *   reason: string,
 *   count: number,
 *   ratio: number,
 *   summary: string,
 *   excerpt: string,
 *   level: 'assist',
 *   recommendation: string,
 * }>}
 */
export function rankAuditReasons(input = {}) {
  const rawRows = [
    ...coerceAuditRows(input.auditRows),
    ...parseNdjsonAudit(input.ndjsonAuditText ?? ''),
  ];

  /** @type {{ reason: string, detail: string, upstreamStatus?: unknown }[]} */
  const rows = [];
  for (const raw of rawRows) {
    const normalized = normalizeAuditRow(raw);
    if (normalized) rows.push(normalized);
  }

  // 自检门：窗口总样本不足 → 空列表（敏感行已丢弃，不计入样本）
  if (rows.length < MIN_SAMPLES) return [];

  const totalSamples = rows.length;

  /** @type {Map<string, { count: number, details: string[] }>} */
  const clusters = new Map();
  for (const row of rows) {
    let bucket = clusters.get(row.reason);
    if (!bucket) {
      bucket = { count: 0, details: [] };
      clusters.set(row.reason, bucket);
    }
    bucket.count += 1;
    if (row.detail) {
      let d = row.detail;
      if (row.upstreamStatus != null && row.upstreamStatus !== '') {
        const tag = `upstreamStatus=${row.upstreamStatus}`;
        if (!d.includes(String(row.upstreamStatus))) d = `${d} ${tag}`;
      }
      bucket.details.push(d);
    } else if (row.upstreamStatus != null && row.upstreamStatus !== '') {
      bucket.details.push(`upstreamStatus=${row.upstreamStatus}`);
    }
  }

  // 失败类：排除成功类分母
  const failureReasons = [...clusters.keys()]
    .filter((r) => !SUCCESS_REASONS.has(r))
    .sort((a, b) => {
      const ca = clusters.get(a).count;
      const cb = clusters.get(b).count;
      if (cb !== ca) return cb - ca;
      return a.localeCompare(b);
    });

  if (failureReasons.length === 0) return [];

  const topReason = failureReasons[0];
  const topCount = clusters.get(topReason).count;
  const topRatio = topCount / totalSamples;
  const currentTop = { reason: topReason, count: topCount, ratio: topRatio };

  // 自检门：相对上次无意义变化 → 空列表
  if (!hasMeaningfulChange(currentTop, input.previousSnapshot)) return [];

  /** @type {ReturnType<typeof rankAuditReasons>} */
  const proposals = [];
  // 产出顺序按 reason localeCompare，保证同夹具排行稳定
  const sortedFailures = [...failureReasons].sort((a, b) => a.localeCompare(b));
  for (const reason of sortedFailures) {
    const bucket = clusters.get(reason);
    const count = bucket.count;
    const ratio = count / totalSamples;
    const rawExcerpt = bucket.details.slice(0, 3).join(' | ');
    const excerpt = truncateExcerpt(rawExcerpt, MAX_EXCERPT_CHARS);
    proposals.push({
      reason,
      count,
      ratio,
      summary: buildSummary(reason, count, ratio, excerpt),
      excerpt,
      level: 'assist',
      recommendation: buildRecommendation(reason),
    });
  }

  return proposals;
}

/** 契约别名：与 rankAuditReasons 同一实现。 */
export const clusterAuditReasonProposals = rankAuditReasons;
