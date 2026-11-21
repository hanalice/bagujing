/**
 * F12：将 F11 分析提案写入 docs/process-backlog.md。
 * 只追加 assist+todo 或待决；已有同 reason 的 todo 则跳过且不降优先级。
 * 禁止标 auto；不读 NDJSON 计次、不调用 process-decide。
 * CLI/--dry-run 属 F13。
 */

/**
 * 取队列表中 todo 行的最小优先级数字。
 * @param {string} markdown
 * @returns {number | null}
 */
export function minTodoPriority(markdown) {
  const lines = markdown.split('\n');
  let inQueue = false;
  let min = null;
  for (const line of lines) {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*[A-Z][0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    // 1 ID, 2 类型, 3 来源, 4 分级, 5 状态, 6 优先级, 7 任务
    if (cells[5] !== 'todo') continue;
    if (/^[0-9]+$/.test(cells[6])) {
      const n = Number(cells[6]);
      if (min === null || n < min) min = n;
    }
  }
  return min;
}

/**
 * 生成下一个流程 ID（P1, P2, …）。
 * @param {string} markdown
 * @returns {string}
 */
function nextProcessId(markdown) {
  let max = 0;
  for (const match of markdown.matchAll(/\|\s*P([0-9]+)\s*\|/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return `P${max + 1}`;
}

/**
 * 在队列表中查找同来源且状态为 todo 的行。
 * @param {string} markdown
 * @param {string} reason
 * @returns {{ id: string, level: string, priority: string } | null}
 */
function findTodoBySource(markdown, reason) {
  const lines = markdown.split('\n');
  let inQueue = false;
  for (const line of lines) {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*[A-Z][0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells[3] === reason && cells[5] === 'todo') {
      return { id: cells[1], level: cells[4], priority: cells[6] };
    }
  }
  return null;
}

/**
 * 待决节是否已有含该 reason 的数据行。
 * @param {string} markdown
 * @param {string} reason
 * @returns {boolean}
 */
function hasPending(markdown, reason) {
  let inPending = false;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inPending = /^##\s*待决/.test(line);
    if (inPending && line.includes(reason) && /^\|\s*P[0-9]+\s*\|/.test(line)) {
      return true;
    }
  }
  return false;
}

/**
 * 在队列表末尾追加一行。
 * @param {string} markdown
 * @param {string} row
 * @returns {string}
 */
function appendQueueRow(markdown, row) {
  const lines = markdown.split('\n');
  let inQueue = false;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      if (inQueue) break;
      inQueue = /^##\s*队列表/.test(lines[i]);
    } else if (inQueue && /^\|\s*[A-Z][0-9]+\s*\|/.test(lines[i])) {
      last = i;
    }
  }
  if (last === -1) {
    inQueue = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^##\s/.test(lines[i])) {
        if (inQueue) break;
        inQueue = /^##\s*队列表/.test(lines[i]);
      } else if (inQueue && /^\|\s*---/.test(lines[i])) {
        last = i;
      }
    }
  }
  if (last === -1) throw new Error('流程队列表缺少表头，拒绝写入');
  lines.splice(last + 1, 0, row);
  return lines.join('\n');
}

/**
 * 在待决表追加一行。
 * @param {string} markdown
 * @param {{ id: string, date: string, reason: string, summary: string, recommendation: string }} row
 * @returns {string}
 */
function appendPending(markdown, row) {
  const problem = row.summary
    ? `${row.reason}：${row.summary}`
    : `原因 ${row.reason}（日志分析）`;
  const hint = row.recommendation || '人确认后决定是否拆条或改分级，禁止直接 auto';
  const line = `| ${row.id} | ${row.date} | 日志分析 | ${problem} | ${hint} |`;
  const lines = markdown.split('\n');
  let inPending = false;
  let insertAt = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      if (inPending) break;
      inPending = /^##\s*待决/.test(lines[i]);
    } else if (inPending && /^\|\s*---/.test(lines[i])) {
      insertAt = i + 1;
    }
  }
  if (insertAt === -1) throw new Error('流程待决表缺少表头');
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

/**
 * 在修订记录追加一行。关键词约定：「日志分析」（UT-LOG-WRITE-05 锁死）。
 * @param {string} markdown
 * @param {string} date
 * @param {string} note
 * @returns {string}
 */
function appendRevision(markdown, date, note) {
  const line = `| ${date} | ${note} |`;
  const lines = markdown.split('\n');
  let inRev = false;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      if (inRev) break;
      inRev = /^##\s*修订记录/.test(lines[i]);
    } else if (inRev && /^\|\s*20/.test(lines[i])) {
      last = i;
    }
  }
  if (last === -1) throw new Error('流程修订记录缺少表头');
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/**
 * 规范化提案字段：兼容 F11 的 summary/recommendation，以及 phenomenon/hint 别名。
 * @param {object} raw
 * @returns {{ reason: string, level: 'assist'|'pending', summary: string, recommendation: string } | null}
 */
function normalizeProposal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!reason) return null;
  const levelRaw = typeof raw.level === 'string' ? raw.level.trim() : '';
  if (levelRaw !== 'assist' && levelRaw !== 'pending') return null;
  const summary = String(
    raw.summary ?? raw.phenomenon ?? raw.message ?? '',
  ).trim();
  const recommendation = String(
    raw.recommendation ?? raw.hint ?? raw.action ?? '',
  ).trim();
  return { reason, level: levelRaw, summary, recommendation };
}

/**
 * 消费 F11 提案，只改 process-backlog markdown 字符串。
 * 返回字段：
 * - markdown：写后全文
 * - action：'assist' | 'pending' | 'skip' | 'none'
 *   （有任一 assist 落盘优先返回 assist；否则有 pending 返回 pending；
 *    全部因已存在而跳过返回 skip；空提案返回 none）
 * - applied：实际写入条数摘要（测码可选读）
 *
 * @param {{
 *   proposals?: Array<object>,
 *   processBacklogMarkdown?: string,
 *   today?: string,
 * }} input
 * @returns {{ markdown: string, action: 'assist'|'pending'|'skip'|'none', applied: { assist: number, pending: number, skipped: number } }}
 */
export function applyLogProposals(input = {}) {
  const proposals = Array.isArray(input.proposals) ? input.proposals : [];
  const today = input.today || new Date().toISOString().slice(0, 10);
  let markdown = input.processBacklogMarkdown ?? '';
  const applied = { assist: 0, pending: 0, skipped: 0 };

  if (proposals.length === 0) {
    return { markdown, action: 'none', applied };
  }

  let wroteRevision = false;

  for (const raw of proposals) {
    const p = normalizeProposal(raw);
    if (!p) {
      applied.skipped += 1;
      continue;
    }

    if (p.level === 'assist') {
      const existing = findTodoBySource(markdown, p.reason);
      if (existing) {
        // 已有同 reason 的 todo：跳过追加，绝不降低优先级
        applied.skipped += 1;
        continue;
      }
      const id = nextProcessId(markdown);
      const currentMin = minTodoPriority(markdown);
      const priority = currentMin === null ? 10 : Math.max(1, currentMin - 10);
      const taskParts = [p.summary, p.recommendation].filter(Boolean);
      const task = taskParts.length
        ? taskParts.join('；')
        : `日志分析提案：${p.reason}`;
      markdown = appendQueueRow(
        markdown,
        `| ${id} | fix | ${p.reason} | assist | todo | ${priority} | ${task} |`,
      );
      applied.assist += 1;
      if (!wroteRevision) {
        markdown = appendRevision(
          markdown,
          today,
          `日志分析追加 assist（来源 pipeline / F11 提案）`,
        );
        wroteRevision = true;
      }
      continue;
    }

    // level === 'pending'：仅写待决；同 reason 已在待决则跳过
    if (hasPending(markdown, p.reason)) {
      applied.skipped += 1;
      continue;
    }
    const id = nextProcessId(markdown);
    markdown = appendPending(markdown, {
      id,
      date: today,
      reason: p.reason,
      summary: p.summary,
      recommendation: p.recommendation,
    });
    applied.pending += 1;
    if (!wroteRevision) {
      markdown = appendRevision(
        markdown,
        today,
        `日志分析写入待决（来源 pipeline / F11 提案）`,
      );
      wroteRevision = true;
    }
  }

  let action = 'none';
  if (applied.assist > 0) action = 'assist';
  else if (applied.pending > 0) action = 'pending';
  else if (proposals.length > 0) action = 'skip';

  return { markdown, action, applied };
}

/** 契约别名：与 applyLogProposals 同一实现。 */
export const writeProposalsToProcessBacklog = applyLogProposals;
