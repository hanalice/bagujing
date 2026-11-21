/**
 * F12 分析提案写入 process-backlog：assist / 待决落盘（禁 auto；不降优先级）。
 * 主导出 applyLogProposals（别名 writeProposalsToProcessBacklog）。
 * 提案字段约定：reason、level∈{assist,pending}、summary=现象、recommendation=推荐。
 * 修订记录关键词锁死为「日志分析」。
 * 待决重复语义：同 reason 已在待决则跳过、行数不变（UT-LOG-WRITE-12）。
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  applyLogProposals,
  writeProposalsToProcessBacklog,
} from '../../../scripts/automation/process-log-write.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TEMPLATE = fs.readFileSync(
  path.join(ROOT, 'docs/process-backlog.md'),
  'utf8',
);
const PROCESS_DECIDE = path.join(ROOT, 'scripts/automation/process-decide.js');
const DAILY_FIX = path.join(ROOT, 'scripts/automation/daily-fix.sh');
const WEEKLY_SCAN = path.join(ROOT, 'scripts/automation/weekly-scan.sh');
const WRITE_SRC = path.join(ROOT, 'scripts/automation/process-log-write.js');

/** 构造 F11 形态提案对象。 */
function proposal(reason, level, summary, recommendation) {
  return { reason, level, summary, recommendation };
}

/** 统计队列表中某来源且 todo 的数据行数。 */
function countTodoBySource(markdown, reason) {
  let inQueue = false;
  let n = 0;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*P[0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[3] === reason && cells[5] === 'todo') n += 1;
  }
  return n;
}

/** 取队列表中某来源 todo 行的优先级。 */
function todoPriority(markdown, reason) {
  let inQueue = false;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*P[0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[3] === reason && cells[5] === 'todo') return cells[6];
  }
  return null;
}

/** 统计待决中含 reason 的数据行。 */
function countPendingWithReason(markdown, reason) {
  let inPending = false;
  let n = 0;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inPending = /^##\s*待决/.test(line);
    if (inPending && /^\|\s*P[0-9]+\s*\|/.test(line) && line.includes(reason)) {
      n += 1;
    }
  }
  return n;
}

/** 修订记录数据行数（日期以 20 开头）。 */
function countRevisionRows(markdown) {
  let inRev = false;
  let n = 0;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inRev = /^##\s*修订记录/.test(line);
    if (inRev && /^\|\s*20/.test(line)) n += 1;
  }
  return n;
}

/** 行级差：仅在 after 中出现的行。 */
function addedLines(before, after) {
  const set = new Set(before.split('\n'));
  return after.split('\n').filter((line) => !set.has(line));
}

/** 在模板队列表分隔行后插入一行。 */
function withQueueRow(markdown, row) {
  const lines = markdown.split('\n');
  let inQueue = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      if (inQueue) break;
      inQueue = /^##\s*队列表/.test(lines[i]);
    } else if (inQueue && /^\|\s*---/.test(lines[i])) {
      lines.splice(i + 1, 0, row);
      return lines.join('\n');
    }
  }
  throw new Error('模板缺队列表');
}

/** 在待决分隔行后插入一行。 */
function withPendingRow(markdown, row) {
  const lines = markdown.split('\n');
  let inPending = false;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      if (inPending) break;
      inPending = /^##\s*待决/.test(lines[i]);
    } else if (inPending && /^\|\s*---/.test(lines[i])) {
      lines.splice(i + 1, 0, row);
      return lines.join('\n');
    }
  }
  throw new Error('模板缺待决表');
}

describe('process-log-write (F12)', () => {
  it('UT-LOG-WRITE-01: assist 提案 → 队列表追加 assist+todo 行', () => {
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '闸门失败于 UT-X', '检查 qa-report 日志'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(result.action, 'assist');
    assert.equal(countTodoBySource(result.markdown, 'qa_failed'), 1);
    assert.match(
      result.markdown,
      /\|\s*P\d+\s*\|\s*\w+\s*\|\s*qa_failed\s*\|\s*assist\s*\|\s*todo\s*\|\s*\d+\s*\|/,
    );
    const hit = result.markdown
      .split('\n')
      .find((l) => /^\|\s*P\d+\s*\|/.test(l) && l.includes('qa_failed') && l.includes('assist'));
    assert.ok(hit);
    assert.ok(hit.includes('闸门失败于 UT-X'));
    assert.ok(hit.includes('检查 qa-report 日志'));
  });

  it('UT-LOG-WRITE-02: 已有同 reason 的 todo → 跳过追加且不降优先级', () => {
    const before = withQueueRow(
      TEMPLATE,
      '| P3 | fix | dirty_worktree | assist | todo | 20 | 既有任务文案 |',
    );
    const result = applyLogProposals({
      proposals: [
        proposal('dirty_worktree', 'assist', 'NEW_PHENOMENON', 'NEW_HINT'),
      ],
      processBacklogMarkdown: before,
      today: '2026-11-21',
    });
    assert.ok(result.action === 'skip' || result.action === 'none');
    assert.equal(countTodoBySource(result.markdown, 'dirty_worktree'), 1);
    assert.equal(todoPriority(result.markdown, 'dirty_worktree'), '20');
    const row = result.markdown
      .split('\n')
      .find((l) => l.includes('dirty_worktree') && l.includes('todo'));
    assert.ok(row);
    assert.ok(!row.includes('NEW_PHENOMENON'));
  });

  it('UT-LOG-WRITE-03: pending 提案 → 只写入待决节', () => {
    const result = applyLogProposals({
      proposals: [
        proposal('agent_auth', 'pending', 'CLI 未登录', '人确认 agent 登录态'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(result.action, 'pending');
    assert.equal(countPendingWithReason(result.markdown, 'agent_auth'), 1);
    const pendingBlob = result.markdown;
    assert.ok(
      pendingBlob.includes('agent_auth')
        || pendingBlob.includes('CLI 未登录')
        || pendingBlob.includes('人确认 agent 登录态'),
    );
    assert.equal(countTodoBySource(result.markdown, 'agent_auth'), 0);
    const added = addedLines(TEMPLATE, result.markdown);
    for (const line of added) {
      if (/^\|\s*P\d+\s*\|/.test(line)) {
        assert.doesNotMatch(line, /\|\s*auto\s*\|/);
      }
    }
  });

  it('UT-LOG-WRITE-04: 单次写入后新增行不得出现 | auto |', () => {
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '闸门失败', '查 qa-report'),
        proposal('fetch_failed', 'pending', 'fetch 失败', '查网络'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(result.action, 'assist');
    assert.equal(countTodoBySource(result.markdown, 'qa_failed'), 1);
    assert.match(
      result.markdown,
      /\|\s*P\d+\s*\|\s*\w+\s*\|\s*qa_failed\s*\|\s*assist\s*\|\s*todo\s*\|/,
    );
    assert.equal(countPendingWithReason(result.markdown, 'fetch_failed'), 1);
    assert.equal(countTodoBySource(result.markdown, 'fetch_failed'), 0);
    const added = addedLines(TEMPLATE, result.markdown);
    for (const line of added) {
      // 队列表新增数据行不得含 | auto |；修订记录里 automation 词不构成 FAIL
      if (/^\|\s*P\d+\s*\|/.test(line) && line.includes('| assist |')) {
        assert.doesNotMatch(line, /\|\s*auto\s*\|/);
      }
      if (/^\|\s*P\d+\s*\|/.test(line) && line.includes('todo')) {
        assert.doesNotMatch(line, /\|\s*auto\s*\|/);
      }
    }
  });

  it('UT-LOG-WRITE-05: 可写修订记录一行：来源为日志分析', () => {
    const revBefore = countRevisionRows(TEMPLATE);
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '闸门失败于 UT-X', '检查 qa-report 日志'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    const revAfter = countRevisionRows(result.markdown);
    assert.ok(revAfter >= revBefore + 1);
    assert.ok(revAfter === revBefore + 1);
    const revLines = result.markdown
      .split('\n')
      .filter((l) => /^\|\s*2026-11-21\s*\|/.test(l));
    assert.ok(revLines.length >= 1);
    assert.ok(revLines.some((l) => l.includes('日志分析')));
  });

  it('UT-LOG-WRITE-06: 差分可审：有写入时可定位新增行', () => {
    const before = TEMPLATE;
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '现象A', '推荐B'),
      ],
      processBacklogMarkdown: before,
      today: '2026-11-21',
    });
    assert.notEqual(result.markdown, before);
    const added = addedLines(before, result.markdown);
    const queueAdded = added.filter(
      (l) => /^\|\s*P\d+\s*\|/.test(l)
        && l.includes('qa_failed')
        && l.includes('assist')
        && l.includes('todo'),
    );
    assert.ok(queueAdded.length >= 1);
  });

  it('UT-LOG-WRITE-07: 空提案数组 → process-backlog 原文不变', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f12-empty-'));
    const docs = path.join(tmp, 'docs');
    fs.mkdirSync(docs);
    const backlogPath = path.join(docs, 'backlog.md');
    const sentinel = 'BUSINESS_BACKLOG_SENTINEL_F12_EMPTY\n';
    fs.writeFileSync(backlogPath, sentinel);
    const result = applyLogProposals({
      proposals: [],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(result.markdown, TEMPLATE);
    assert.equal(result.action, 'none');
    assert.equal(fs.readFileSync(backlogPath, 'utf8'), sentinel);
  });

  it('UT-LOG-WRITE-08: 不做：绝不改业务 docs/backlog.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f12-biz-'));
    const docs = path.join(tmp, 'docs');
    fs.mkdirSync(docs);
    const processPath = path.join(docs, 'process-backlog.md');
    const backlogPath = path.join(docs, 'backlog.md');
    fs.writeFileSync(processPath, TEMPLATE);
    const bizBody = '# biz\nBUSINESS_BACKLOG_SENTINEL_F12\n';
    fs.writeFileSync(backlogPath, bizBody);
    const bizHash = crypto.createHash('sha256').update(bizBody).digest('hex');
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '闸门失败', '查日志'),
      ],
      processBacklogMarkdown: fs.readFileSync(processPath, 'utf8'),
      today: '2026-11-21',
    });
    assert.equal(result.action, 'assist');
    fs.writeFileSync(processPath, result.markdown);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(backlogPath)).digest('hex'),
      bizHash,
    );
    assert.notEqual(fs.readFileSync(processPath, 'utf8'), TEMPLATE);
    assert.ok(fs.readFileSync(backlogPath, 'utf8').includes('BUSINESS_BACKLOG_SENTINEL_F12'));
  });

  it('UT-LOG-WRITE-09: 不做：不替代 process-decide「满 3 次才动」/ 不降优先级', () => {
    const decideBefore = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(decideBefore, /threshold/);
    assert.match(decideBefore, /\b3\b/);
    assert.match(decideBefore, /\b20\b/);
    const before = withQueueRow(
      TEMPLATE,
      '| P1 | fix | qa_failed | assist | todo | 10 | 既有闸门项 |',
    );
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '又一次失败', '再查'),
      ],
      processBacklogMarkdown: before,
      today: '2026-11-21',
    });
    assert.equal(todoPriority(result.markdown, 'qa_failed'), '10');
    assert.equal(countTodoBySource(result.markdown, 'qa_failed'), 1);
    assert.match(result.markdown, /\|\s*P1\s*\|/);
    const decideAfter = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.equal(decideAfter, decideBefore);
    // F12 不读 NDJSON 计次：实现源无 automation-runs / decideFromRuns
    const src = fs.readFileSync(WRITE_SRC, 'utf8');
    assert.doesNotMatch(src, /automation-runs\.ndjson/);
    assert.doesNotMatch(src, /decideFromRuns|from ['"].*process-decide/);
  });

  it('UT-LOG-WRITE-10: 不做：不改 daily-fix.sh / weekly-scan.sh', () => {
    const dailyHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(DAILY_FIX))
      .digest('hex');
    const weeklyExists = fs.existsSync(WEEKLY_SCAN);
    const weeklyHash = weeklyExists
      ? crypto.createHash('sha256').update(fs.readFileSync(WEEKLY_SCAN)).digest('hex')
      : null;
    applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '现象', '推荐'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(DAILY_FIX)).digest('hex'),
      dailyHash,
    );
    if (weeklyExists) {
      assert.equal(
        crypto.createHash('sha256').update(fs.readFileSync(WEEKLY_SCAN)).digest('hex'),
        weeklyHash,
      );
    }
    const src = fs.readFileSync(WRITE_SRC, 'utf8');
    assert.doesNotMatch(src, /daily-fix\.sh|weekly-scan\.sh/);
  });

  it('UT-LOG-WRITE-11: 多提案：仅缺失 reason 落盘，已存在 reason 跳过', () => {
    const before = withQueueRow(
      TEMPLATE,
      '| P2 | fix | qa_failed | assist | todo | 15 | 已有 qa |',
    );
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '旧现象', '旧推荐'),
        proposal('scan_rejected', 'assist', '周扫越界', '收紧扫描'),
      ],
      processBacklogMarkdown: before,
      today: '2026-11-21',
    });
    assert.equal(result.action, 'assist');
    assert.equal(countTodoBySource(result.markdown, 'scan_rejected'), 1);
    assert.equal(countTodoBySource(result.markdown, 'qa_failed'), 1);
    assert.equal(todoPriority(result.markdown, 'qa_failed'), '15');
    const qaRows = result.markdown
      .split('\n')
      .filter((l) => /^\|\s*P\d+\s*\|/.test(l) && l.includes('qa_failed') && l.includes('todo'));
    assert.equal(qaRows.length, 1);
    assert.doesNotMatch(qaRows[0], /\|\s*auto\s*\|/);
  });

  it('UT-LOG-WRITE-12: 待决路径：同 reason 已在待决则可跳过重复', () => {
    // 选定语义：跳过重复，行数不变，不写入队列表
    const before = withPendingRow(
      TEMPLATE,
      '| P5 | 2026-11-20 | 流程 | 原因 agent_auth 待人确认 | 人看登录态 |',
    );
    assert.equal(countPendingWithReason(before, 'agent_auth'), 1);
    const result = applyLogProposals({
      proposals: [
        proposal('agent_auth', 'pending', 'CLI 未登录', '人确认 agent 登录态'),
      ],
      processBacklogMarkdown: before,
      today: '2026-11-21',
    });
    assert.ok(result.action === 'skip' || result.action === 'none');
    assert.equal(countPendingWithReason(result.markdown, 'agent_auth'), 1);
    assert.equal(countTodoBySource(result.markdown, 'agent_auth'), 0);
    const added = addedLines(before, result.markdown);
    for (const line of added) {
      assert.doesNotMatch(line, /\|\s*auto\s*\|/);
    }
  });

  it('UT-LOG-WRITE-13: residual：本表不要求标 auto / 不要求 F13 CLI / 不要求邮件摘要', () => {
    // PASS 不要求标 auto / F13 CLI / 发信；只锁 assist 可落盘
    assert.equal(typeof applyLogProposals, 'function');
    assert.equal(typeof writeProposalsToProcessBacklog, 'function');
    assert.equal(writeProposalsToProcessBacklog, applyLogProposals);
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '现象', '推荐'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(result.action, 'assist');
    assert.match(
      result.markdown,
      /\|\s*P\d+\s*\|\s*\w+\s*\|\s*qa_failed\s*\|\s*assist\s*\|\s*todo\s*\|/,
    );
    assert.doesNotMatch(
      result.markdown.split('\n').find((l) => l.includes('qa_failed') && l.includes('todo')) || '',
      /\|\s*auto\s*\|/,
    );
    const cronShell = path.join(ROOT, 'scripts/automation/process-log-analyze-cron.sh');
    // 不因「无 CLI」判 FAIL——此处仅记录存在性，不 assert 必须存在
    void fs.existsSync(cronShell);
  });

  it('UT-LOG-WRITE-14: 与 UT-LOG-PARSE / UT-PROCESS 分界：只落盘不解析 NDJSON、不计次', () => {
    let decideCalls = 0;
    const decideStub = mock.fn(() => {
      decideCalls += 1;
    });
    // 入参仅为提案 + markdown，不传 NDJSON；仍可直接落盘
    const result = applyLogProposals({
      proposals: [
        proposal('qa_failed', 'assist', '单次失败即可提案', '不经满 3 次'),
      ],
      processBacklogMarkdown: TEMPLATE,
      today: '2026-11-21',
    });
    assert.equal(result.action, 'assist');
    assert.equal(countTodoBySource(result.markdown, 'qa_failed'), 1);
    assert.equal(decideStub.mock.callCount(), 0);
    assert.equal(decideCalls, 0);
    const src = fs.readFileSync(WRITE_SRC, 'utf8');
    assert.doesNotMatch(src, /\bdecide\s*\(/);
    assert.doesNotMatch(src, /decideFromRuns/);
    assert.doesNotMatch(src, /automation-runs\.ndjson/);
    assert.doesNotMatch(src, /from ['"].*process-decide/);
    assert.doesNotMatch(src, /readFileSync.*ndjson|ndjsonText/);
  });
});
