/**
 * F22 审计提案写入业务 backlog：调优先级或追加 assist（禁 auto）。
 * 主导出 applyAuditProposals（别名 writeProposalsToBusinessBacklog）。
 * 提案字段约定：reason、level==='assist'、summary=现象、recommendation=推荐。
 * 关联规则：来源列 === reason 或 任务列含 reason；仅 todo。
 * 调优先级：推荐含「优先级」/priority → 下调最多 MAX_PRIORITY_STEP=10。
 * 追加草案语义（推荐不含优先级关键词）且已存在 → skip。
 * 新增行来源列锁死为 audit；修订关键词锁死为「业务审计排行」。
 * 新 ID 规则：A + 递增（如 A1）。
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  applyAuditProposals,
  writeProposalsToBusinessBacklog,
  MAX_PRIORITY_STEP,
  NEW_ROW_SOURCE,
  REVISION_KEYWORD,
} from '../../../scripts/automation/audit-reason-write.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PROCESS_DECIDE = path.join(ROOT, 'scripts/automation/process-decide.js');
const DAILY_FIX = path.join(ROOT, 'scripts/automation/daily-fix.sh');
const WEEKLY_SCAN = path.join(ROOT, 'scripts/automation/weekly-scan.sh');
const WRITE_SRC = path.join(ROOT, 'scripts/automation/audit-reason-write.js');

/** 最小业务 backlog 模板：含队列表与修订记录。 */
const TEMPLATE = `# 工程待办队列

## 队列表

| ID  | 类型 | 来源  | 分级   | 状态  | 优先级 | 任务 |
| --- | -- | --- | ---- | --- | --- | -- |
| Z1 | fix | other | assist | todo | 90 | 无关占位 |

## 修订记录

| 日期         | 说明 |
| ---------- | -- |
| 2026-01-01 | 初始夹具 |
`;

/** 构造 F21 形态提案对象。 */
function proposal(reason, summary, recommendation, level = 'assist') {
  return { reason, level, summary, recommendation };
}

/** 统计队列表中可关联某 reason 且 todo 的数据行数。 */
function countRelatedTodo(markdown, reason) {
  let inQueue = false;
  let n = 0;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*[A-Z][0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[5] !== 'todo') continue;
    if (cells[3] === reason || (cells[7] || '').includes(reason)) n += 1;
  }
  return n;
}

/** 取可关联 todo 行全文。 */
function relatedTodoLine(markdown, reason) {
  let inQueue = false;
  for (const line of markdown.split('\n')) {
    if (/^##\s/.test(line)) inQueue = /^##\s*队列表/.test(line);
    if (!inQueue || !/^\|\s*[A-Z][0-9]+\s*\|/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells[5] !== 'todo') continue;
    if (cells[3] === reason || (cells[7] || '').includes(reason)) return line;
  }
  return null;
}

/** 取可关联 todo 优先级。 */
function relatedTodoPriority(markdown, reason) {
  const line = relatedTodoLine(markdown, reason);
  if (!line) return null;
  const cells = line.split('|').map((c) => c.trim());
  return cells[6];
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

describe('audit-reason-write (F22)', () => {
  it('UT-AUDIT-WRITE-01: 无关联项 → 队列表追加 assist+todo 草案行', () => {
    // 新 ID 规则：A + 递增；来源列锁死为 audit
    assert.equal(NEW_ROW_SOURCE, 'audit');
    const result = applyAuditProposals({
      proposals: [
        proposal(
          'sse_idle_timeout',
          '空闲超时占比上升',
          '开 assist 草案排查 SSE',
        ),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    assert.equal(result.action, 'assist');
    assert.equal(countRelatedTodo(result.markdown, 'sse_idle_timeout'), 1);
    assert.match(
      result.markdown,
      /\|\s*A\d+\s*\|\s*\w+\s*\|\s*(?:audit|sse_idle_timeout)\s*\|\s*assist\s*\|\s*todo\s*\|\s*\d+\s*\|/,
    );
    const hit = relatedTodoLine(result.markdown, 'sse_idle_timeout');
    assert.ok(hit);
    assert.ok(hit.includes('空闲超时占比上升'));
    assert.ok(hit.includes('开 assist 草案排查 SSE'));
    assert.match(hit, /\|\s*audit\s*\|/);
  });

  it('UT-AUDIT-WRITE-02: 已有可关联 todo → 仅调优先级且步长不超过硬上限', () => {
    assert.equal(MAX_PRIORITY_STEP, 10);
    const before = withQueueRow(
      TEMPLATE,
      '| S99 | fix | audit | assist | todo | 80 | 排查 sse_idle_timeout 空闲超时 |',
    );
    const result = applyAuditProposals({
      proposals: [
        proposal(
          'sse_idle_timeout',
          '空闲超时占比上升',
          '建议调整业务 backlog 优先级',
        ),
      ],
      backlogMarkdown: before,
      today: '2026-11-23',
    });
    assert.equal(result.action, 'priority');
    assert.equal(countRelatedTodo(result.markdown, 'sse_idle_timeout'), 1);
    const row = relatedTodoLine(result.markdown, 'sse_idle_timeout');
    assert.ok(row);
    assert.match(row, /\|\s*assist\s*\|\s*todo\s*\|/);
    assert.ok(row.includes('排查 sse_idle_timeout 空闲超时'));
    const p = Number(relatedTodoPriority(result.markdown, 'sse_idle_timeout'));
    assert.ok(Number.isInteger(p) && p >= 1);
    assert.ok(Math.abs(80 - p) <= MAX_PRIORITY_STEP);
    assert.notEqual(p, 10); // 禁止一次从 80 跨到 10
    assert.equal(p, 70);
  });

  it('UT-AUDIT-WRITE-03: 已有同 reason/同主题 todo → 跳过追加且不改成 auto', () => {
    // 选定语义：追加草案（推荐不含「优先级」）且已存在 → skip，优先级与分级均不变
    const before = withQueueRow(
      TEMPLATE,
      '| F90 | feat | sse_idle_timeout | assist | todo | 60 | 既有审计相关任务 |',
    );
    const result = applyAuditProposals({
      proposals: [
        proposal(
          'sse_idle_timeout',
          '空闲超时占比上升',
          '开 assist 草案排查 SSE',
        ),
      ],
      backlogMarkdown: before,
      today: '2026-11-23',
    });
    assert.ok(result.action === 'skip' || result.action === 'none');
    assert.equal(countRelatedTodo(result.markdown, 'sse_idle_timeout'), 1);
    const row = relatedTodoLine(result.markdown, 'sse_idle_timeout');
    assert.ok(row);
    assert.match(row, /\|\s*assist\s*\|\s*todo\s*\|/);
    assert.doesNotMatch(row, /\|\s*auto\s*\|/);
    assert.equal(relatedTodoPriority(result.markdown, 'sse_idle_timeout'), '60');
  });

  it('UT-AUDIT-WRITE-04: 无提案数组 → 业务 backlog 原文不变', () => {
    const before = withQueueRow(
      TEMPLATE,
      '| S1 | fix | audit | assist | todo | 40 | 占位 |',
    );
    const result = applyAuditProposals({
      proposals: [],
      backlogMarkdown: before,
      today: '2026-11-23',
    });
    assert.equal(result.markdown, before);
    assert.equal(result.action, 'none');
  });

  it('UT-AUDIT-WRITE-05: 单次写入后新增行不得出现 | auto |', () => {
    const result = applyAuditProposals({
      proposals: [
        proposal('upstream_http', '上游失败占比上升', '开 assist 草案排查上游'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    assert.equal(result.action, 'assist');
    const added = addedLines(TEMPLATE, result.markdown);
    for (const line of added) {
      if (/^\|\s*[A-Z]\d+\s*\|/.test(line) && line.includes('todo')) {
        assert.doesNotMatch(line, /\|\s*auto\s*\|/);
        assert.match(line, /\|\s*assist\s*\|\s*todo\s*\|/);
      }
    }
  });

  it('UT-AUDIT-WRITE-06: 差分可审：调优先级或追加行可定位', () => {
    // A) 调优先级
    const beforeA = withQueueRow(
      TEMPLATE,
      '| S99 | fix | audit | assist | todo | 80 | 排查 sse_idle_timeout |',
    );
    const resultA = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '现象', '建议调整优先级'),
      ],
      backlogMarkdown: beforeA,
      today: '2026-11-23',
    });
    assert.notEqual(resultA.markdown, beforeA);
    assert.equal(resultA.action, 'priority');
    const changedA = beforeA
      .split('\n')
      .filter((line, i) => resultA.markdown.split('\n')[i] !== line
        || !resultA.markdown.split('\n').includes(line));
    void changedA;
    const oldRow = beforeA.split('\n').find((l) => l.includes('S99'));
    const newRow = resultA.markdown.split('\n').find((l) => l.includes('S99'));
    assert.ok(oldRow && newRow);
    assert.notEqual(oldRow, newRow);
    assert.ok(oldRow.includes('| 80 |'));
    assert.ok(newRow.includes('| 70 |'));

    // B) 追加 assist
    const resultB = applyAuditProposals({
      proposals: [
        proposal('circuit_open', '熔断占比上升', '开 assist 草案'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    assert.notEqual(resultB.markdown, TEMPLATE);
    const added = addedLines(TEMPLATE, resultB.markdown);
    const queueAdded = added.filter(
      (l) => /^\|\s*[A-Z]\d+\s*\|/.test(l)
        && l.includes('assist')
        && l.includes('todo')
        && (l.includes('circuit_open') || l.includes('audit')),
    );
    assert.ok(queueAdded.length >= 1);
  });

  it('UT-AUDIT-WRITE-07: 可写修订记录一行：来源为业务审计排行', () => {
    assert.equal(REVISION_KEYWORD, '业务审计排行');
    const revBefore = countRevisionRows(TEMPLATE);
    const result = applyAuditProposals({
      proposals: [
        proposal('upstream_http', '上游失败', '开 assist 草案'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    const revAfter = countRevisionRows(result.markdown);
    assert.equal(revAfter, revBefore + 1);
    const revLines = result.markdown
      .split('\n')
      .filter((l) => /^\|\s*2026-11-23\s*\|/.test(l));
    assert.ok(revLines.length >= 1);
    assert.ok(revLines.some((l) => l.includes(REVISION_KEYWORD)));
    // 无关占位 Z1 优先级不变
    assert.match(result.markdown, /\|\s*Z1\s*\|.*\|\s*90\s*\|/);
  });

  it('UT-AUDIT-WRITE-08: 不做：绝不改 docs/process-backlog.md', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f22-proc-'));
    const docs = path.join(tmp, 'docs');
    fs.mkdirSync(docs);
    const backlogPath = path.join(docs, 'backlog.md');
    const processPath = path.join(docs, 'process-backlog.md');
    fs.writeFileSync(backlogPath, TEMPLATE);
    const processBody = '# process\nPROCESS_BACKLOG_SENTINEL_F22\n';
    fs.writeFileSync(processPath, processBody);
    const processHash = crypto.createHash('sha256').update(processBody).digest('hex');
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '空闲超时', '开 assist 草案'),
      ],
      backlogMarkdown: fs.readFileSync(backlogPath, 'utf8'),
      today: '2026-11-23',
    });
    assert.equal(result.action, 'assist');
    fs.writeFileSync(backlogPath, result.markdown);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex'),
      processHash,
    );
    assert.notEqual(fs.readFileSync(backlogPath, 'utf8'), TEMPLATE);
    assert.ok(fs.readFileSync(processPath, 'utf8').includes('PROCESS_BACKLOG_SENTINEL_F22'));
  });

  it('UT-AUDIT-WRITE-09: 不做：不替代/绕过 process-decide；不读流水线日志当主源', () => {
    const decideBefore = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(decideBefore, /threshold/);
    let decideCalls = 0;
    const decideStub = mock.fn(() => {
      decideCalls += 1;
    });
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '现象', '开 assist 草案'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    assert.equal(result.action, 'assist');
    assert.equal(fs.readFileSync(PROCESS_DECIDE, 'utf8'), decideBefore);
    assert.equal(decideStub.mock.callCount(), 0);
    assert.equal(decideCalls, 0);
    const src = fs.readFileSync(WRITE_SRC, 'utf8');
    assert.doesNotMatch(src, /automation-runs\.ndjson/);
    assert.doesNotMatch(src, /decideFromRuns|from ['"].*process-decide/);
    assert.doesNotMatch(src, /\*cron\*\.log|cron\.log/);
  });

  it('UT-AUDIT-WRITE-10: 不做：不改 daily-fix.sh / weekly-scan.sh；本函数内不 git commit/push', () => {
    const dailyHash = crypto
      .createHash('sha256')
      .update(fs.readFileSync(DAILY_FIX))
      .digest('hex');
    const weeklyExists = fs.existsSync(WEEKLY_SCAN);
    const weeklyHash = weeklyExists
      ? crypto.createHash('sha256').update(fs.readFileSync(WEEKLY_SCAN)).digest('hex')
      : null;
    applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '现象', '开 assist 草案'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
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
    // 纯 markdown 变换：无 child_process / 无实际 git 写操作 API
    assert.doesNotMatch(src, /child_process|execFile|spawn\(|execSync/);
    assert.doesNotMatch(src, /from ['"]node:child_process['"]|require\(['"]child_process['"]\)/);
  });

  it('UT-AUDIT-WRITE-11: 不做：不改 done/split 行；不把未冻项标成 auto', () => {
    const before = withQueueRow(
      withQueueRow(
        TEMPLATE,
        '| S80 | fix | sse_idle_timeout | auto | done |  | 已完成文案 |',
      ),
      '| F2 | feat | flywheel | assist | split |  | 已拆子项 |',
    );
    const s80Before = before.split('\n').find((l) => l.includes('| S80 |'));
    const f2Before = before.split('\n').find((l) => l.includes('| F2 |'));
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '空闲超时', '开 assist 草案排查 SSE'),
      ],
      backlogMarkdown: before,
      today: '2026-11-23',
    });
    const s80After = result.markdown.split('\n').find((l) => l.includes('| S80 |'));
    const f2After = result.markdown.split('\n').find((l) => l.includes('| F2 |'));
    assert.equal(s80After, s80Before);
    assert.equal(f2After, f2Before);
    assert.equal(result.action, 'assist');
    const added = addedLines(before, result.markdown);
    for (const line of added) {
      if (/^\|\s*[A-Z]\d+\s*\|/.test(line) && line.includes('todo')) {
        assert.match(line, /\|\s*assist\s*\|/);
        assert.doesNotMatch(line, /\|\s*auto\s*\|/);
      }
    }
  });

  it('UT-AUDIT-WRITE-12: 不做：不改审计 schema / reason 名', () => {
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '空闲超时占比上升', '开 assist 草案排查 SSE'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    assert.equal(result.action, 'assist');
    const hit = relatedTodoLine(result.markdown, 'sse_idle_timeout');
    assert.ok(hit);
    // 来源为 audit，任务列保留原 reason 子串
    assert.match(hit, /\|\s*audit\s*\|/);
    assert.ok(hit.includes('sse_idle_timeout'));
    const src = fs.readFileSync(WRITE_SRC, 'utf8');
    assert.doesNotMatch(src, /ALTER\s+TABLE/i);
  });

  it('UT-AUDIT-WRITE-13: 多提案：仅缺失项追加，已关联项只调优先级或跳过', () => {
    const before = withQueueRow(
      TEMPLATE,
      '| S70 | fix | audit | assist | todo | 70 | 排查 sse_idle_timeout |',
    );
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '空闲超时', '建议调整优先级'),
        proposal('circuit_open', '熔断上升', '开 assist 草案'),
      ],
      backlogMarkdown: before,
      today: '2026-11-23',
    });
    assert.equal(countRelatedTodo(result.markdown, 'circuit_open'), 1);
    assert.equal(countRelatedTodo(result.markdown, 'sse_idle_timeout'), 1);
    const sseRow = relatedTodoLine(result.markdown, 'sse_idle_timeout');
    assert.ok(sseRow);
    assert.doesNotMatch(sseRow, /\|\s*auto\s*\|/);
    const p = Number(relatedTodoPriority(result.markdown, 'sse_idle_timeout'));
    // 调优先级路径：70 → 60；或若实现 skip 则保持 70
    assert.ok(p === 60 || p === 70);
    assert.ok(Math.abs(70 - p) <= MAX_PRIORITY_STEP);
    const circuit = relatedTodoLine(result.markdown, 'circuit_open');
    assert.ok(circuit);
    assert.match(circuit, /\|\s*assist\s*\|\s*todo\s*\|/);
    assert.doesNotMatch(circuit, /\|\s*auto\s*\|/);
  });

  it('UT-AUDIT-WRITE-14: residual：本表不要求标 auto / 不要求 F23 CLI / 不要求本函数 git commit', () => {
    // PASS 不要求标 auto / F23 CLI / git commit；只锁 assist 可落盘
    assert.equal(typeof applyAuditProposals, 'function');
    assert.equal(typeof writeProposalsToBusinessBacklog, 'function');
    assert.equal(writeProposalsToBusinessBacklog, applyAuditProposals);
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '现象', '开 assist 草案'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
    });
    assert.equal(result.action, 'assist');
    assert.match(
      result.markdown,
      /\|\s*A\d+\s*\|\s*\w+\s*\|\s*audit\s*\|\s*assist\s*\|\s*todo\s*\|/,
    );
    const cronShell = path.join(ROOT, 'scripts/automation/audit-reason-rank-cron.sh');
    // 不因「无 CLI」判 FAIL——此处仅记录存在性
    void fs.existsSync(cronShell);
  });

  it('UT-AUDIT-WRITE-15: 与 UT-AUDIT-RANK / UT-LOG-WRITE 分界：只落盘业务 backlog、不排行、不碰 process', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f22-bound-'));
    const processPath = path.join(tmp, 'process-backlog.md');
    const processBody = 'PROCESS_SENTINEL_F22_BOUND\n';
    fs.writeFileSync(processPath, processBody);
    const processHash = crypto.createHash('sha256').update(processBody).digest('hex');
    let rankCalls = 0;
    const rankStub = mock.fn(() => {
      rankCalls += 1;
      return [];
    });
    const result = applyAuditProposals({
      proposals: [
        proposal('sse_idle_timeout', '单次提案即可落盘', '开 assist 草案'),
      ],
      backlogMarkdown: TEMPLATE,
      today: '2026-11-23',
      // 若误传审计行集亦应被忽略（签名不消费）
      auditRows: [{ reason: 'should_be_ignored' }],
    });
    assert.equal(result.action, 'assist');
    assert.equal(countRelatedTodo(result.markdown, 'sse_idle_timeout'), 1);
    assert.equal(rankStub.mock.callCount(), 0);
    assert.equal(rankCalls, 0);
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex'),
      processHash,
    );
    const src = fs.readFileSync(WRITE_SRC, 'utf8');
    assert.doesNotMatch(src, /rankAuditReasons|clusterAuditReasonProposals/);
    assert.doesNotMatch(src, /from ['"].*audit-reason-rank/);
    assert.doesNotMatch(src, /from ['"].*process-log-write|writeProposalsToProcessBacklog|applyLogProposals/);
    assert.doesNotMatch(src, /fs\.(writeFileSync|appendFileSync|renameSync)/);
  });
});
