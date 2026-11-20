/**
 * F11 流水线日志解析：NDJSON + cron → reason 聚类提案（不写盘；禁 auto）。
 * 字段约定：summary=现象句；excerpt=截断摘录（<= MAX_EXCERPT_CHARS，默认 200）；
 * recommendation=推荐动作；level 仅 assist|pending。
 * 主导出 analyzePipelineLogs（别名 clusterReasonProposals）。
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  analyzePipelineLogs,
  clusterReasonProposals,
  IGNORED_REASONS,
  MAX_EXCERPT_CHARS,
} from '../../../scripts/automation/process-log-parse.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const PROCESS_DECIDE = path.join(ROOT, 'scripts/automation/process-decide.js');
const DAILY_FIX = path.join(ROOT, 'scripts/automation/daily-fix.sh');
const PROCESS_BACKLOG = path.join(ROOT, 'docs/process-backlog.md');
const PARSE_SRC = path.join(ROOT, 'scripts/automation/process-log-parse.js');

/** 构造一行 automation-runs NDJSON。 */
function runLine(reason, extra = {}) {
  return JSON.stringify({
    ts: '2026-11-20T00:00:00.000Z',
    kind: 'daily-fix',
    taskId: 'F11',
    stage: 'qa',
    reason,
    exitCode: reason === 'ok' ? 0 : 1,
    prOpened: false,
    qaPassed: reason !== 'qa_failed',
    ...extra,
  });
}

/** 按 reason 排序后比较，消除实现内部 Map 遍历顺序差异。 */
function sortedByReason(proposals) {
  return [...proposals].sort((a, b) => a.reason.localeCompare(b.reason));
}

function allTextFields(proposal) {
  return [proposal.summary, proposal.excerpt, proposal.recommendation]
    .filter((v) => typeof v === 'string')
    .join('\n');
}

describe('process-log-parse (F11)', () => {
  it('UT-LOG-PARSE-01: 纯函数可对内存 NDJSON+cron 文本产出提案数组', () => {
    const writeFileSyncOrig = fs.writeFileSync;
    const appendFileSyncOrig = fs.appendFileSync;
    let writeCalls = 0;
    let appendCalls = 0;
    fs.writeFileSync = (...args) => {
      writeCalls += 1;
      return writeFileSyncOrig(...args);
    };
    fs.appendFileSync = (...args) => {
      appendCalls += 1;
      return appendFileSyncOrig(...args);
    };
    try {
      const ndjsonText = [runLine('qa_failed'), runLine('qa_failed', { taskId: 'S14' })].join('\n');
      const cronLogText = 'daily-fix: qa_failed at gate\n';
      const proposals = analyzePipelineLogs({ ndjsonText, cronLogText });
      assert.ok(Array.isArray(proposals));
      assert.ok(proposals.length >= 1);
      const hit = proposals.find((p) => p.reason === 'qa_failed');
      assert.ok(hit);
      assert.equal(hit.reason, 'qa_failed');
      assert.ok(typeof hit.summary === 'string' && hit.summary.length > 0);
      assert.ok(typeof hit.recommendation === 'string' && hit.recommendation.length > 0);
      assert.ok(hit.level === 'assist' || hit.level === 'pending');
      assert.equal(writeCalls, 0);
      assert.equal(appendCalls, 0);
    } finally {
      fs.writeFileSync = writeFileSyncOrig;
      fs.appendFileSync = appendFileSyncOrig;
    }
  });

  it('UT-LOG-PARSE-02: 夹具下提案 level 从不含 auto', () => {
    const ndjsonText = [
      runLine('qa_failed'),
      runLine('dirty_worktree'),
      runLine('agent_auth'),
    ].join('\n');
    const cronLogText = 'noise from automation cron\n';
    const proposals = analyzePipelineLogs({ ndjsonText, cronLogText });
    assert.ok(proposals.length >= 3);
    for (const p of proposals) {
      assert.ok(p.level === 'assist' || p.level === 'pending', `非法 level=${p.level}`);
      assert.notEqual(p.level, 'auto');
      for (const [key, val] of Object.entries(p)) {
        if (key === 'level') continue;
        if (typeof val === 'string') {
          assert.notEqual(val.trim(), 'auto');
          assert.doesNotMatch(val, /\|\s*auto\s*\|/);
        }
      }
    }
  });

  it('UT-LOG-PARSE-03: 同 reason 聚类稳定（多行合并为一条）', () => {
    const ndjsonText = [
      runLine('qa_failed', { taskId: 'A' }),
      runLine('qa_failed', { taskId: 'B', ts: '2026-11-20T01:00:00.000Z' }),
      runLine('qa_failed', { taskId: 'C' }),
      runLine('qa_failed', { taskId: 'D' }),
      runLine('fetch_failed'),
    ].join('\n');
    const a = analyzePipelineLogs({ ndjsonText, cronLogText: '' });
    const b = analyzePipelineLogs({ ndjsonText, cronLogText: '' });
    assert.equal(a.filter((p) => p.reason === 'qa_failed').length, 1);
    assert.equal(a.filter((p) => p.reason === 'fetch_failed').length, 1);
    assert.equal(a.length, 2);
    assert.deepEqual(sortedByReason(a), sortedByReason(b));
  });

  it('UT-LOG-PARSE-04: 忽略 ok / empty_queue / already_running / dry_run / cancelled', () => {
    const ignored = ['ok', 'empty_queue', 'already_running', 'dry_run', 'cancelled'];
    assert.equal(IGNORED_REASONS.size, 5);
    for (const r of ignored) assert.ok(IGNORED_REASONS.has(r));
    const ndjsonText = [...ignored.map((r) => runLine(r)), runLine('qa_failed')].join('\n');
    const proposals = analyzePipelineLogs({ ndjsonText, cronLogText: '' });
    for (const r of ignored) {
      assert.equal(proposals.filter((p) => p.reason === r).length, 0);
    }
    assert.equal(proposals.filter((p) => p.reason === 'qa_failed').length, 1);
  });

  it('UT-LOG-PARSE-05: 超长日志摘录被硬上限截断', () => {
    // MAX_EXCERPT_CHARS 默认建议 200；测码可读导出常量
    assert.ok(Number.isFinite(MAX_EXCERPT_CHARS) && MAX_EXCERPT_CHARS > 0);
    const MAX = MAX_EXCERPT_CHARS;
    const sentinel = 'TAIL_SENTINEL_XYZ';
    const longLine = `${'x'.repeat(MAX + 100)}${sentinel}`;
    const ndjsonText = runLine('scan_rejected');
    const proposals = analyzePipelineLogs({ ndjsonText, cronLogText: longLine });
    const hit = proposals.find((p) => p.reason === 'scan_rejected');
    assert.ok(hit);
    assert.ok(hit.excerpt.length <= MAX);
    assert.ok(!hit.excerpt.includes(sentinel));
    assert.ok(!allTextFields(hit).includes(sentinel));
  });

  it('UT-LOG-PARSE-06: 含伪密钥行时摘录不含该行（PASSWORD/SECRET/TOKEN/API_KEY）', () => {
    const cronLogText = [
      'daily-fix: qa_failed at gate',
      'export OPENAI_API_KEY=sk_live_fake_probe_001',
      'retry scheduled',
    ].join('\n');
    const proposals = analyzePipelineLogs({
      ndjsonText: runLine('qa_failed'),
      cronLogText,
    });
    for (const p of proposals) {
      const blob = allTextFields(p);
      assert.ok(!blob.includes('sk_live_fake_probe_001'));
      assert.ok(!blob.includes('export OPENAI_API_KEY=sk_live_fake_probe_001'));
    }
    const hit = proposals.find((p) => p.reason === 'qa_failed');
    assert.ok(hit);
    assert.match(allTextFields(hit), /qa_failed at gate|retry scheduled/);
  });

  it('UT-LOG-PARSE-07: URL 用户口令形态整行丢弃', () => {
    const cronLogText = [
      'postgres://appuser:s3cretPW@db.internal:5432/app',
      'https://example.com/status',
    ].join('\n');
    const proposals = analyzePipelineLogs({
      ndjsonText: runLine('fetch_failed'),
      cronLogText,
    });
    for (const p of proposals) {
      const blob = allTextFields(p);
      assert.ok(!blob.includes('s3cretPW'));
      assert.ok(!blob.includes('appuser:s3cretPW@'));
      assert.ok(blob.includes('example.com') || blob.includes('fetch_failed'));
    }
  });

  it('UT-LOG-PARSE-08: 空输入 → 空提案列表', () => {
    assert.doesNotThrow(() => {
      const a = analyzePipelineLogs({ ndjsonText: '', cronLogText: '' });
      assert.equal(a.length, 0);
      const b = analyzePipelineLogs({ ndjsonText: '  \n', cronLogText: '\n\n' });
      assert.equal(b.length, 0);
    });
  });

  it('UT-LOG-PARSE-09: 残缺/非法 NDJSON 行可跳过', () => {
    const ndjsonText = [
      runLine('qa_failed'),
      'not-json',
      JSON.stringify({ kind: 'daily-fix' }),
    ].join('\n');
    let proposals;
    assert.doesNotThrow(() => {
      proposals = analyzePipelineLogs({ ndjsonText, cronLogText: '' });
    });
    assert.equal(proposals.filter((p) => p.reason === 'qa_failed').length, 1);
    for (const p of proposals) {
      assert.equal(typeof p.reason, 'string');
      assert.ok(p.reason.length > 0);
      assert.notEqual(p.reason, 'undefined');
    }
  });

  it('UT-LOG-PARSE-10: 近日 cron 摘要可参与现象/摘录（与 NDJSON 联合）', () => {
    const ndjsonText = runLine('agent_auth');
    const cronLogText = 'agent not logged in\nCLI not in PATH\n';
    const proposals = analyzePipelineLogs({ ndjsonText, cronLogText });
    const hit = proposals.find((p) => p.reason === 'agent_auth');
    assert.ok(hit);
    const blob = allTextFields(hit);
    assert.ok(
      blob.includes('not logged in') || blob.includes('PATH'),
      `现象/摘录未含 cron 摘要: ${blob}`,
    );
  });

  it('UT-LOG-PARSE-11: 不做：调用后不写任何 markdown', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f11-md-'));
    const processMd = path.join(tmp, 'process-backlog.md');
    const backlogMd = path.join(tmp, 'backlog.md');
    const processBody = '# process\n| P1 | fix | x | assist | todo | 10 | t |\n';
    const backlogBody = '# backlog\n| F11 | feat |\n';
    fs.writeFileSync(processMd, processBody);
    fs.writeFileSync(backlogMd, backlogBody);
    const h1 = crypto.createHash('sha256').update(processBody).digest('hex');
    const h2 = crypto.createHash('sha256').update(backlogBody).digest('hex');
    analyzePipelineLogs({
      ndjsonText: runLine('qa_failed'),
      cronLogText: 'qa failed',
    });
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(processMd)).digest('hex'),
      h1,
    );
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(backlogMd)).digest('hex'),
      h2,
    );
    const mdFiles = fs.readdirSync(tmp).filter((n) => n.endsWith('.md'));
    assert.deepEqual(mdFiles.sort(), ['backlog.md', 'process-backlog.md']);
    const src = fs.readFileSync(PARSE_SRC, 'utf8');
    assert.doesNotMatch(src, /writeFileSync|appendFileSync|writeFile\(|appendFile\(/);
  });

  it('UT-LOG-PARSE-12: 不做：不改 process-decide 阈值或状态文件', () => {
    const before = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(before, /IGNORED_REASONS/);
    assert.match(before, /threshold/);
    assert.match(before, /\b20\b/);
    assert.match(before, /\b3\b/);
    analyzePipelineLogs({
      ndjsonText: runLine('qa_failed'),
      cronLogText: '',
    });
    const after = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.equal(after, before);
  });

  it('UT-LOG-PARSE-13: 不做：不读 ai_audit_logs（属 F2）', () => {
    const src = fs.readFileSync(PARSE_SRC, 'utf8');
    assert.doesNotMatch(src, /ai_audit_logs/);
    assert.doesNotMatch(src, /sqlite|dbPool|better-sqlite/i);
    analyzePipelineLogs({
      ndjsonText: runLine('qa_failed'),
      cronLogText: '',
    });
  });

  it('UT-LOG-PARSE-14: 不做：不发邮件；不改 daily-fix.sh 选单', () => {
    const dailyBefore = fs.readFileSync(DAILY_FIX, 'utf8');
    const hashBefore = crypto.createHash('sha256').update(dailyBefore).digest('hex');
    const sendMail = mock.fn();
    const automationNotifyHuman = mock.fn();
    analyzePipelineLogs({
      ndjsonText: [runLine('qa_failed'), runLine('agent_auth')].join('\n'),
      cronLogText: 'ok',
    });
    assert.equal(sendMail.mock.callCount(), 0);
    assert.equal(automationNotifyHuman.mock.callCount(), 0);
    const hashAfter = crypto
      .createHash('sha256')
      .update(fs.readFileSync(DAILY_FIX))
      .digest('hex');
    assert.equal(hashAfter, hashBefore);
    const src = fs.readFileSync(PARSE_SRC, 'utf8');
    assert.doesNotMatch(src, /sendMail|SMTP|automation_notify_human|nodemailer/);
  });

  it('UT-LOG-PARSE-15: residual：本表不要求 F12 落盘 / F13 CLI / F14 cron 挂载', () => {
    // PASS 不要求 F12 落盘 / F13 CLI / F14 crontab；只锁纯函数可产出提案
    assert.equal(typeof analyzePipelineLogs, 'function');
    assert.equal(typeof clusterReasonProposals, 'function');
    assert.equal(clusterReasonProposals, analyzePipelineLogs);
    const proposals = analyzePipelineLogs({
      ndjsonText: runLine('qa_failed'),
      cronLogText: '',
    });
    assert.ok(proposals.length >= 1);
    assert.ok(proposals.every((p) => p.level === 'assist' || p.level === 'pending'));
  });

  it('UT-LOG-PARSE-16: 与 UT-PROCESS 分界：不计 decide 的「满 3 次」门槛', () => {
    const backlogBefore = fs.existsSync(PROCESS_BACKLOG)
      ? fs.readFileSync(PROCESS_BACKLOG, 'utf8')
      : '';
    const ndjsonText = runLine('qa_failed');
    const proposals = analyzePipelineLogs({ ndjsonText, cronLogText: 'short' });
    const hits = proposals.filter((p) => p.reason === 'qa_failed');
    assert.equal(hits.length, 1);
    assert.ok(hits[0].level === 'assist' || hits[0].level === 'pending');
    if (fs.existsSync(PROCESS_BACKLOG)) {
      assert.equal(fs.readFileSync(PROCESS_BACKLOG, 'utf8'), backlogBefore);
    }
  });
});
