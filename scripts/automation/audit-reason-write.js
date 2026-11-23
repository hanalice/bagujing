/**
 * F22：将 F21 审计提案写入业务 docs/backlog.md。
 * 有关联 todo → 仅调优先级（步长 ≤ MAX_PRIORITY_STEP）；无关联 → 追加 assist+todo。
 * 已有同 reason 且推荐为「追加草案」语义 → 跳过；禁 auto；不改 done/split。
 * 只改业务 backlog 字符串；不读流水线日志；不做版本库写操作。CLI/--dry-run 属 F23。
 */

/** 优先级调整绝对值步长硬上限；对齐队列表惯例步长 10。UT-AUDIT-WRITE-02 锁死。 */
export const MAX_PRIORITY_STEP = 10;

/** 新增行来源列约定：固定写 `audit`；任务列保留 reason 子串。UT-AUDIT-WRITE-01/12 锁死。 */
export const NEW_ROW_SOURCE = 'audit';

/** 修订记录说明关键词约定。UT-AUDIT-WRITE-07 锁死。 */
export const REVISION_KEYWORD = '业务审计排行';

/** 新增行 ID 前缀：A + 递增数字（如 A91）。UT-AUDIT-WRITE-01 锁死生成规则。 */
const NEW_ID_PREFIX = 'A';

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
 * 生成下一个业务 ID（A1, A2, …；取现有 A 前缀最大号 +1）。
 * @param {string} markdown
 * @returns {string}
 */
function nextBusinessId(markdown) {
  let max = 0;
  const re = new RegExp(`\\|\\s*${NEW_ID_PREFIX}([0-9]+)\\s*\\|`, 'g');
  for (const match of markdown.matchAll(re)) {
    max = Math.max(max, Number(match[1]));
  }
  return `${NEW_ID_PREFIX}${max + 1}`;
}

/**
 * 在队列表中查找可关联且状态为 todo 的行。
 * 关联规则（测码注释锁死）：
 * - 来源列精确等于提案 reason，或
 * - 任务列包含提案 reason 子串
 * 仅匹配 status === 'todo'；done/split 永不命中。
 *
 * @param {string} markdown
 * @param {string} reason
 * @returns {{ lineIndex: number, id: string, level: string, priority: number, task: string, raw: string } | null}
 */
function findRelatedTodo(markdown, reason) {
  const lines = markdown.split('\n');
  let inQueue = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*[A-Z][0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells[5] !== 'todo') continue;
    const source = cells[3] || '';
    const task = cells[7] || '';
    const matched = source === reason || task.includes(reason);
    if (!matched) continue;
    const priorityRaw = cells[6];
    const priority = /^[0-9]+$/.test(priorityRaw) ? Number(priorityRaw) : null;
    if (priority === null) continue;
    return {
      lineIndex: i,
      id: cells[1],
      level: cells[4],
      priority,
      task,
      raw: line,
    };
  }
  return null;
}

/**
 * 推荐是否走「调优先级」路径（含 优先级 / priority 关键词）。
 * 否则视为「追加草案」语义：已存在则跳过。
 * @param {string} recommendation
 * @returns {boolean}
 */
function wantsPriorityAdjust(recommendation) {
  return /优先级|priority/i.test(recommendation || '');
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
  if (last === -1) throw new Error('业务队列表缺少表头，拒绝写入');
  lines.splice(last + 1, 0, row);
  return lines.join('\n');
}

/**
 * 将队列表某行的优先级单元格替换为新正整数；其余单元格保持原文切片结构。
 * @param {string} line
 * @param {number} newPriority
 * @returns {string}
 */
function replacePriorityCell(line, newPriority) {
  const parts = line.split('|');
  // parts[0] 为空（行首 |），1=ID … 6=优先级
  if (parts.length < 8) return line;
  parts[6] = ` ${newPriority} `;
  return parts.join('|');
}

/**
 * 在修订记录追加一行。关键词约定：REVISION_KEYWORD（「业务审计排行」）。
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
    } else if (inRev && last === -1 && /^\|\s*---/.test(lines[i])) {
      last = i;
    }
  }
  if (last === -1) throw new Error('业务修订记录缺少表头');
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/**
 * 规范化 F21 提案字段。
 * @param {object} raw
 * @returns {{ reason: string, level: 'assist', summary: string, recommendation: string } | null}
 */
function normalizeProposal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (!reason) return null;
  const levelRaw = typeof raw.level === 'string' ? raw.level.trim() : '';
  // F21 仅产出 assist；其它 level 忽略
  if (levelRaw !== 'assist') return null;
  const summary = String(
    raw.summary ?? raw.phenomenon ?? raw.message ?? '',
  ).trim();
  const recommendation = String(
    raw.recommendation ?? raw.hint ?? raw.action ?? '',
  ).trim();
  return { reason, level: 'assist', summary, recommendation };
}

/**
 * 按步长硬上限下调优先级（数字越小越先做）；不得跨多档。
 * @param {number} oldPriority
 * @returns {number}
 */
function nextPriorityDown(oldPriority) {
  const stepped = oldPriority - MAX_PRIORITY_STEP;
  return Math.max(1, stepped);
}

/**
 * 消费 F21 提案，只改业务 backlog markdown 字符串。
 * 返回字段：
 * - markdown：写后全文
 * - action：'priority' | 'assist' | 'skip' | 'none'
 *   （有任一 assist 追加优先返回 assist；否则有调优先级返回 priority；
 *    全部跳过返回 skip；空提案返回 none）
 * - applied：实际写入条数摘要
 *
 * @param {{
 *   proposals?: Array<object>,
 *   backlogMarkdown?: string,
 *   today?: string,
 * }} input
 * @returns {{
 *   markdown: string,
 *   action: 'priority'|'assist'|'skip'|'none',
 *   applied: { priority: number, assist: number, skipped: number },
 * }}
 */
export function applyAuditProposals(input = {}) {
  const proposals = Array.isArray(input.proposals) ? input.proposals : [];
  const today = input.today || new Date().toISOString().slice(0, 10);
  let markdown = input.backlogMarkdown ?? '';
  const applied = { priority: 0, assist: 0, skipped: 0 };

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

    const existing = findRelatedTodo(markdown, p.reason);

    if (existing) {
      if (wantsPriorityAdjust(p.recommendation)) {
        const newPriority = nextPriorityDown(existing.priority);
        if (newPriority === existing.priority) {
          // 已到下限 1，无法再调 → 视为跳过，不追加第二行
          applied.skipped += 1;
          continue;
        }
        const delta = Math.abs(existing.priority - newPriority);
        if (delta > MAX_PRIORITY_STEP) {
          // 防御：硬上限再夹一次（理论上 nextPriorityDown 已保证）
          applied.skipped += 1;
          continue;
        }
        const lines = markdown.split('\n');
        lines[existing.lineIndex] = replacePriorityCell(
          lines[existing.lineIndex],
          newPriority,
        );
        markdown = lines.join('\n');
        applied.priority += 1;
        if (!wroteRevision) {
          markdown = appendRevision(
            markdown,
            today,
            `${REVISION_KEYWORD}：调优先级（来源 audit / F21 提案）`,
          );
          wroteRevision = true;
        }
        continue;
      }
      // 追加草案语义且已有同 reason/主题 todo → 跳过追加，不改分级/优先级
      applied.skipped += 1;
      continue;
    }

    // 无关联项 → 追加 assist+todo 草案
    const id = nextBusinessId(markdown);
    const currentMin = minTodoPriority(markdown);
    const priority = currentMin === null ? 50 : Math.max(1, currentMin - MAX_PRIORITY_STEP);
    const taskParts = [
      p.reason,
      p.summary,
      p.recommendation,
    ].filter(Boolean);
    const task = taskParts.length
      ? taskParts.join('；')
      : `业务审计提案：${p.reason}`;
    markdown = appendQueueRow(
      markdown,
      `| ${id} | fix | ${NEW_ROW_SOURCE} | assist | todo | ${priority} | ${task} |`,
    );
    applied.assist += 1;
    if (!wroteRevision) {
      markdown = appendRevision(
        markdown,
        today,
        `${REVISION_KEYWORD}：追加 assist（来源 audit / F21 提案）`,
      );
      wroteRevision = true;
    }
  }

  let action = 'none';
  if (applied.assist > 0) action = 'assist';
  else if (applied.priority > 0) action = 'priority';
  else if (proposals.length > 0) action = 'skip';

  return { markdown, action, applied };
}

/** 契约别名：与 applyAuditProposals 同一实现。 */
export const writeProposalsToBusinessBacklog = applyAuditProposals;
