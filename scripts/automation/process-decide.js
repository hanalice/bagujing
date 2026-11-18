/**
 * 读自动化运行记录，只改流程队列 docs/process-backlog.md。
 * 同一原因达到次数才调优先级或追加 assist；次数没下降则不再顶同一项，改写待决。
 * 不改 daily-fix.sh / weekly-scan.sh。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 不拿来改队列的结局。 */
const IGNORED_REASONS = new Set(['ok', 'empty_queue', 'already_running', 'dry_run', 'cancelled']);

/** 计入的运行种类。 */
const COUNTED_KINDS = new Set(['daily-fix', 'weekly-scan', 'daily-fix-cron', 'weekly-scan-cron']);

const REASON_TASK = {
  dirty_worktree: '无人值守因工作区不干净退出，收紧入口或清理步骤',
  fetch_failed: 'git fetch 失败导致当日自动化没跑成',
  contract_missing: '任务缺少契约冻结仍被选中或扫描写入',
  qa_failed: '质量门禁连续不过，日修停在门禁',
  review_rejected: '独立审核连续不通过，日修拒绝提交',
  pr_conflict: '远端 PR 与 main 冲突，当日不开新任务',
  pr_unmerged: '远端 PR 未合并，当日不开新任务',
  agent_auth: '编码 agent 未登录或 CLI 不在 PATH',
  scan_rejected: '周扫描结果越界（改了别的文件、超上限或待决未落盘）',
  unknown: '自动化以未归类原因失败',
  spec_failed: '规格阶段没有写上测试用例文档',
};

/**
 * 从 NDJSON 文本取出最近 limit 条可计数记录，并按 reason 计数。
 * @param {string} text
 * @param {number} limit
 * @returns {Map<string, number>}
 */
export function countRecentReasons(text, limit) {
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => COUNTED_KINDS.has(row.kind));
  const recent = rows.slice(-limit);
  const counts = new Map();
  for (const row of recent) {
    if (!row.reason || IGNORED_REASONS.has(row.reason)) continue;
    counts.set(row.reason, (counts.get(row.reason) || 0) + 1);
  }
  return counts;
}

/**
 * 取次数最高的原因。同次数按原因名字排序，保证重复运行结果稳定。
 * @param {Map<string, number>} counts
 * @param {number} threshold
 * @returns {{ reason: string, count: number } | null}
 */
export function pickTopReason(counts, threshold) {
  const hits = [...counts.entries()]
    .filter(([, count]) => count >= threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (!hits.length) return null;
  return { reason: hits[0][0], count: hits[0][1] };
}

/**
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

function nextProcessId(markdown) {
  let max = 0;
  for (const match of markdown.matchAll(/\|\s*P([0-9]+)\s*\|/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return `P${max + 1}`;
}

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

function setPriority(markdown, id, priority) {
  const lines = markdown.split('\n');
  let inQueue = false;
  let changed = false;
  const next = lines.map((line) => {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !new RegExp(`^\\|\\s*${id}\\s*\\|`).test(line)) return line;
    const cells = line.split('|');
    // 下标 0 与末尾是空串，优先级在 cells[6]。
    if (cells[6].trim() === String(priority)) return line;
    cells[6] = ` ${priority} `;
    changed = true;
    return cells.join('|');
  });
  return { markdown: next.join('\n'), changed };
}

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

function hasPending(markdown, reason) {
  let inPending = false;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inPending = /^##\s*待决/.test(line);
    if (inPending && line.includes(reason) && /^\|\s*P[0-9]+\s*\|/.test(line)) return true;
  }
  return false;
}

function appendPending(markdown, { id, date, reason }) {
  const line = `| ${id} | ${date} | 流程 | 原因 ${reason} 反复出现且次数没有下降 | 人看是否改调度脚本，不自动标 auto |`;
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
 * 决定是否改流程队列。
 * @param {{
 *   runsText: string,
 *   backlog: string,
 *   state: { reasons?: Record<string, { itemId: string, countAtAction: number }> },
 *   threshold: number,
 *   limit: number,
 *   today: string,
 * }} input
 * @returns {{ backlog: string, state: object, action: string }}
 */
export function decide(input) {
  const threshold = input.threshold;
  const state = { reasons: { ...(input.state?.reasons || {}) } };
  const counts = countRecentReasons(input.runsText, input.limit);
  const top = pickTopReason(counts, threshold);
  if (!top) {
    for (const reason of Object.keys(state.reasons)) {
      const count = counts.get(reason) || 0;
      if (count < (state.reasons[reason].countAtAction ?? threshold)) {
        delete state.reasons[reason];
      }
    }
    return { backlog: input.backlog, state, action: 'none' };
  }

  const latch = state.reasons[top.reason];
  if (latch && top.count >= latch.countAtAction) {
    let backlog = input.backlog;
    let action = 'held';
    if (!hasPending(backlog, top.reason)) {
      const id = nextProcessId(backlog);
      backlog = appendPending(backlog, { id, date: input.today, reason: top.reason });
      backlog = appendRevision(backlog, input.today, `${top.reason} 次数未下降，待决 ${id}，不再降低 ${latch.itemId} 优先级`);
      action = 'pending';
    }
    return { backlog, state, action };
  }

  const existing = findTodoBySource(input.backlog, top.reason);
  const currentMin = minTodoPriority(input.backlog);
  const priority = currentMin === null ? 10 : Math.max(1, currentMin - 10);
  let backlog = input.backlog;
  let itemId = existing?.id;
  if (!existing) {
    itemId = nextProcessId(backlog);
    const task = REASON_TASK[top.reason] || REASON_TASK.unknown;
    backlog = appendQueueRow(
      backlog,
      `| ${itemId} | fix | ${top.reason} | assist | todo | ${priority} | ${task} |`,
    );
    backlog = appendRevision(backlog, input.today, `追加 assist ${itemId}（${top.reason} 达 ${top.count} 次）`);
  } else if (String(existing.priority) !== String(priority)) {
    const updated = setPriority(backlog, existing.id, priority);
    backlog = updated.markdown;
    if (updated.changed) {
      backlog = appendRevision(backlog, input.today, `${existing.id} 优先级改为 ${priority}（${top.reason} 达 ${top.count} 次）`);
    }
  }
  state.reasons[top.reason] = { itemId, countAtAction: top.count };
  return { backlog, state, action: existing ? 'priority' : 'assist' };
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main() {
  const args = process.argv.slice(2);
  const opt = {};
  for (let i = 0; i < args.length; i += 2) opt[args[i]] = args[i + 1];
  const runsFile = opt['--runs'];
  const backlogFile = opt['--backlog'];
  const stateFile = opt['--state'];
  if (!runsFile || !backlogFile || !stateFile) {
    throw new Error('需要 --runs --backlog --state');
  }
  const threshold = Number(opt['--threshold'] || 3);
  const limit = Number(opt['--limit'] || 20);
  const today = opt['--today'] || new Date().toISOString().slice(0, 10);
  const runsText = fs.existsSync(runsFile) ? fs.readFileSync(runsFile, 'utf8') : '';
  const result = decide({
    runsText,
    backlog: fs.readFileSync(backlogFile, 'utf8'),
    state: readJson(stateFile, { reasons: {} }),
    threshold,
    limit,
    today,
  });
  if (result.backlog !== fs.readFileSync(backlogFile, 'utf8')) {
    fs.writeFileSync(backlogFile, result.backlog);
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(result.state, null, 2)}\n`);
  process.stdout.write(`${result.action}\n`);
}

if (process.argv[1] && process.argv[1].endsWith('process-decide.js')) {
  main();
}
