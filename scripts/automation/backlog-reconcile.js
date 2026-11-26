/**
 * 队列表收回：同一 ID 只留一行；done/split 胜出 todo；
 * 修订记录里出现「ID 完成」时，把仍为 todo 的行改成 done。
 * 并发日修 PR 合并冲突时，用 union 合并两边的队列表和修订记录，不改其它章节。
 */
import fs from 'node:fs';

const STATUS_RANK = { todo: 1, done: 2, split: 3 };

/**
 * 把 markdown 按二级标题切开。队列表、修订记录与其它章节分开处理。
 * @param {string} text
 * @returns {{ heading: string | null, lines: string[] }[]}
 */
export function splitSections(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  /** @type {{ heading: string | null, lines: string[] }[]} */
  const sections = [];
  let current = { heading: null, lines: [] };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      sections.push(current);
      current = { heading: line, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  sections.push(current);
  return sections;
}

/**
 * @param {{ heading: string | null, lines: string[] }[]} sections
 * @returns {string}
 */
export function joinSections(sections) {
  const out = [];
  sections.forEach((section, index) => {
    if (index > 0) out.push(section.heading);
    out.push(...section.lines);
  });
  return out.join('\n');
}

/**
 * @param {string | null} heading
 * @returns {'queue' | 'rev' | 'other'}
 */
function sectionKind(heading) {
  if (!heading) return 'other';
  if (heading.includes('队列表')) return 'queue';
  if (heading.includes('修订记录')) return 'rev';
  return 'other';
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isQueueDataRow(line) {
  return /^\|\s*[A-Z][0-9]+\s*\|/.test(line);
}

/**
 * @param {string} line
 * @returns {{ id: string, status: string, line: string } | null}
 */
function parseQueueRow(line) {
  if (!isQueueDataRow(line)) return null;
  const parts = line.split('|');
  if (parts.length < 7) return null;
  return {
    id: parts[1].trim(),
    status: parts[5].trim(),
    line,
  };
}

/**
 * @param {string} line
 * @param {string} status
 * @returns {string}
 */
function withStatus(line, status) {
  const parts = line.split('|');
  parts[5] = ` ${status} `;
  return parts.join('|');
}

/**
 * 从修订记录抽出已经写了「ID 完成」的编号。
 * @param {string[]} lines
 * @returns {Set<string>}
 */
export function completionIds(lines) {
  const ids = new Set();
  for (const line of lines) {
    const matched = line.match(/\|\s*20[0-9]{2}-[0-9]{2}-[0-9]{2}\s*\|\s*([A-Z][0-9]+)\s+完成/);
    if (matched) ids.add(matched[1]);
  }
  return ids;
}

/**
 * 同一 ID 合并为一行。done/split 保留原行；仅 todo 且修订记录已完成时改成 done。
 * @param {string[]} lines
 * @param {Set<string>} completed
 * @returns {string[]}
 */
export function collapseQueueLines(lines, completed) {
  /** @type {Map<string, { status: string, line: string }>} */
  const winners = new Map();
  /** @type {string[]} */
  const order = [];
  for (const line of lines) {
    const row = parseQueueRow(line);
    if (!row) continue;
    if (!winners.has(row.id)) {
      order.push(row.id);
      winners.set(row.id, { status: row.status, line: row.line });
      continue;
    }
    const prev = winners.get(row.id);
    const nextRank = STATUS_RANK[row.status] || 0;
    const prevRank = STATUS_RANK[prev.status] || 0;
    if (nextRank > prevRank) winners.set(row.id, { status: row.status, line: row.line });
  }
  for (const id of order) {
    const row = winners.get(id);
    if (completed.has(id) && row.status === 'todo') {
      winners.set(id, { status: 'done', line: withStatus(row.line, 'done') });
    }
  }
  const emitted = new Set();
  const out = [];
  for (const line of lines) {
    const row = parseQueueRow(line);
    if (!row) {
      out.push(line);
      continue;
    }
    if (emitted.has(row.id)) continue;
    emitted.add(row.id);
    out.push(winners.get(row.id).line);
  }
  return out;
}

/**
 * 修订记录按整行去重，先保留 ours 的顺序，再追加 theirs 里没有的行。
 * @param {string[]} ours
 * @param {string[]} theirs
 * @returns {string[]}
 */
export function unionRevisionLines(ours, theirs) {
  const seen = new Set();
  const out = [];
  for (const line of ours) {
    const key = line.trim();
    if (key.startsWith('|') && seen.has(key)) continue;
    if (key.startsWith('|')) seen.add(key);
    out.push(line);
  }
  for (const line of theirs) {
    const key = line.trim();
    if (!key.startsWith('|') || key.includes('---')) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

/**
 * 收回一份 backlog 文本。其它章节原样保留。
 * @param {string} text
 * @returns {{ text: string, changed: boolean }}
 */
export function reconcileText(text) {
  const sections = splitSections(text);
  let changed = false;
  for (const section of sections) {
    if (sectionKind(section.heading) !== 'queue') continue;
    const rev = sections.find((item) => sectionKind(item.heading) === 'rev');
    const completed = completionIds(rev ? rev.lines : []);
    const next = collapseQueueLines(section.lines, completed);
    if (next.join('\n') !== section.lines.join('\n')) {
      section.lines = next;
      changed = true;
    }
  }
  return { text: joinSections(sections), changed };
}

/**
 * 合并两份 backlog。队列表和修订记录按完成状态取并集。
 * 其它章节字节不一致时拒绝，避免把契约正文一起自动盖掉。
 * @param {string} ours
 * @param {string} theirs
 * @returns {{ ok: true, text: string } | { ok: false, reason: string }}
 */
export function unionTexts(ours, theirs) {
  const left = splitSections(ours);
  const right = splitSections(theirs);
  if (left.length !== right.length) {
    return { ok: false, reason: '章节数量不一致，不能只收回队列表' };
  }
  /** @type {{ heading: string | null, lines: string[] }[]} */
  const merged = [];
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if ((a.heading || '') !== (b.heading || '')) {
      return { ok: false, reason: '章节标题不一致，不能只收回队列表' };
    }
    const kind = sectionKind(a.heading);
    if (kind === 'other') {
      if (a.lines.join('\n') !== b.lines.join('\n')) {
        return { ok: false, reason: '队列表和修订记录之外有分歧，留给人工' };
      }
      merged.push({ heading: a.heading, lines: a.lines });
      continue;
    }
    if (kind === 'rev') {
      merged.push({ heading: a.heading, lines: unionRevisionLines(a.lines, b.lines) });
      continue;
    }
    const header = a.lines.filter((line) => !isQueueDataRow(line));
    const data = [];
    const dataSeen = new Set();
    for (const line of [...a.lines, ...b.lines]) {
      const row = parseQueueRow(line);
      if (!row || dataSeen.has(row.id)) continue;
      dataSeen.add(row.id);
      data.push(line);
    }
    const queueLines = [];
    let inserted = false;
    for (const line of header) {
      queueLines.push(line);
      if (!inserted && /^\|\s*---/.test(line)) {
        queueLines.push(...data);
        inserted = true;
      }
    }
    if (!inserted) queueLines.push(...data);
    merged.push({ heading: a.heading, lines: queueLines });
  }
  return { ok: true, text: reconcileText(joinSections(merged)).text };
}

/**
 * 命令行：reconcile <file> 就地收回；union <ours> <theirs> <dest> 写出合并结果。
 * @param {string[]} argv
 * @returns {void}
 */
export function main(argv) {
  const [cmd, first, second, third] = argv.slice(2);
  if (cmd === 'reconcile' && first) {
    const before = fs.readFileSync(first, 'utf8');
    const result = reconcileText(before);
    if (result.changed && result.text !== before) fs.writeFileSync(first, result.text);
    return;
  }
  if (cmd === 'union' && first && second && third) {
    const result = unionTexts(fs.readFileSync(first, 'utf8'), fs.readFileSync(second, 'utf8'));
    if (!result.ok) {
      console.error(result.reason);
      process.exitCode = 2;
      return;
    }
    fs.writeFileSync(third, result.text);
    return;
  }
  console.error('用法: backlog-reconcile.js reconcile <file> | union <ours> <theirs> <dest>');
  process.exitCode = 2;
}

const entry = process.argv[1] || '';
if (entry.endsWith('backlog-reconcile.js')) main(process.argv);
