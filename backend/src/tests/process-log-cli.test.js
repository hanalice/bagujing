/**
 * F13 低频分析 CLI/cron 壳：串联 F11+F12、--dry-run、与 process-decide 并存。
 * CLI 路径：scripts/automation/process-log-analyze.js
 * 可选 cron 壳：scripts/automation/process-log-analyze-cron.sh
 * 旗标锁死：--dry-run / --root / --runs / --backlog / --logs-dir / --today / --no-record
 * automation kind 锁死：log-analyze（AUTOMATION_KIND）
 * 近日 cron：CRON_LOOKBACK_DAYS=7，按 mtime 过滤 basename 含 cron 的 .log
 * 退出码约定：无提案仍为 0（dry-run / 非 dry-run 一致）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  AUTOMATION_KIND,
  CRON_LOOKBACK_DAYS,
  main,
  parseArgs,
  runLogAnalyze,
} from '../../../scripts/automation/process-log-analyze.js';
import { analyzePipelineLogs } from '../../../scripts/automation/process-log-parse.js';
import { applyLogProposals } from '../../../scripts/automation/process-log-write.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLI_PATH = path.join(ROOT, 'scripts/automation/process-log-analyze.js');
const CRON_SHELL = path.join(ROOT, 'scripts/automation/process-log-analyze-cron.sh');
const PROCESS_DECIDE = path.join(ROOT, 'scripts/automation/process-decide.js');
const PROCESS_DECIDE_CRON = path.join(ROOT, 'scripts/automation/process-decide-cron.sh');
const DAILY_FIX = path.join(ROOT, 'scripts/automation/daily-fix.sh');
const TEMPLATE = fs.readFileSync(path.join(ROOT, 'docs/process-backlog.md'), 'utf8');
const REAL_BACKLOG = path.join(ROOT, 'docs/backlog.md');
const REAL_PROCESS_BACKLOG = path.join(ROOT, 'docs/process-backlog.md');

/** 构造一行 automation-runs NDJSON。 */
function runLine(reason, extra = {}) {
  return JSON.stringify({
    ts: '2026-11-20T00:00:00.000Z',
    kind: 'daily-fix',
    taskId: 'F13',
    stage: 'qa',
    reason,
    exitCode: reason === 'ok' || reason === 'empty_queue' ? 0 : 1,
    prOpened: false,
    qaPassed: reason !== 'qa_failed',
    ...extra,
  });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

/**
 * 搭临时项目根：logs/ + docs/process-backlog.md + 哨兵 backlog.md。
 * @param {{ ndjson?: string, cronName?: string, cronText?: string, processMd?: string, businessSentinel?: string }} [opts]
 */
function setupTempRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f13-cli-'));
  const logsDir = path.join(root, 'logs');
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });
  const runsFile = path.join(logsDir, 'automation-runs.ndjson');
  fs.writeFileSync(runsFile, opts.ndjson ?? '');
  const cronName = opts.cronName || 'daily-fix-cron-20261120.log';
  fs.writeFileSync(path.join(logsDir, cronName), opts.cronText ?? '');
  const processMd = opts.processMd ?? TEMPLATE;
  const processFile = path.join(docsDir, 'process-backlog.md');
  fs.writeFileSync(processFile, processMd);
  const businessFile = path.join(docsDir, 'backlog.md');
  fs.writeFileSync(
    businessFile,
    opts.businessSentinel || 'BUSINESS_BACKLOG_SENTINEL_F13\n',
  );
  const recordFile = path.join(logsDir, 'f13-record.ndjson');
  return {
    root,
    logsDir,
    runsFile,
    processFile,
    businessFile,
    recordFile,
    cronName,
  };
}

/** 在队列表分隔行后插入一行。 */
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

function captureIo() {
  let out = '';
  let err = '';
  return {
    stdout: { write: (s) => { out += String(s); } },
    stderr: { write: (s) => { err += String(s); } },
    get combined() { return out + err; },
    get out() { return out; },
  };
}

describe('process-log-cli (F13)', () => {
  it('UT-LOG-CLI-01: CLI 入口存在且可被直接执行', () => {
    assert.ok(fs.existsSync(CLI_PATH));
    const tmp = setupTempRoot({ ndjson: '', cronText: '' });
    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        '--dry-run',
        '--root', tmp.root,
        '--runs', tmp.runsFile,
        '--backlog', tmp.processFile,
        '--logs-dir', tmp.logsDir,
        '--no-record',
      ],
      { encoding: 'utf8', env: { ...process.env, AUTOMATION_NOTIFY_DISABLE: '1' } },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    // 源码含 CLI 守卫（非仅库函数）
    const src = fs.readFileSync(CLI_PATH, 'utf8');
    assert.match(src, /endsWith\(['"]process-log-analyze\.js['"]\)/);
  });

  it('UT-LOG-CLI-02: 默认串联顺序：先 F11 解析再（非 dry-run）F12 落盘', () => {
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'gate failed UT-X\n',
    });
    /** @type {string[]} */
    const order = [];
    let analyzeCalls = 0;
    let applyCalls = 0;
    const io = captureIo();
    const result = runLogAnalyze({
      dryRun: false,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: false,
      stdout: io.stdout,
      stderr: io.stderr,
      analyzeFn: (input) => {
        analyzeCalls += 1;
        order.push('analyze');
        return analyzePipelineLogs(input);
      },
      applyFn: (input) => {
        applyCalls += 1;
        order.push('apply');
        return applyLogProposals(input);
      },
    });
    assert.ok(analyzeCalls >= 1);
    assert.ok(applyCalls >= 1);
    assert.deepEqual(order.slice(0, 2), ['analyze', 'apply']);
    assert.ok(result.callOrder.indexOf('analyze') < result.callOrder.indexOf('apply'));
    const md = fs.readFileSync(tmp.processFile, 'utf8');
    assert.match(
      md,
      /\|\s*P\d+\s*\|\s*\w+\s*\|\s*qa_failed\s*\|\s*assist\s*\|\s*todo\s*\|\s*\d+\s*\|/,
    );
  });

  it('UT-LOG-CLI-03: --dry-run 后 process-backlog 原文不变', () => {
    const processMd = `${TEMPLATE}\n<!-- PROCESS_BACKLOG_SENTINEL_F13_DRY -->\n`;
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'qa_failed summary\n',
      processMd,
      businessSentinel: 'BUSINESS_BACKLOG_SENTINEL_F13\n',
    });
    const beforeProcess = fileHash(tmp.processFile);
    const beforeBusiness = fileHash(tmp.businessFile);
    const code = main([
      '--dry-run',
      '--root', tmp.root,
      '--runs', tmp.runsFile,
      '--backlog', tmp.processFile,
      '--logs-dir', tmp.logsDir,
      '--no-record',
    ]);
    assert.equal(code, 0);
    assert.equal(fileHash(tmp.processFile), beforeProcess);
    assert.equal(fileHash(tmp.businessFile), beforeBusiness);
  });

  it('UT-LOG-CLI-04: --dry-run 只打印提案（stdout 可判定）', () => {
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'qa_failed at gate\n',
    });
    const io = captureIo();
    let applyCalls = 0;
    runLogAnalyze({
      dryRun: true,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: false,
      stdout: io.stdout,
      stderr: io.stderr,
      applyFn: (input) => {
        applyCalls += 1;
        return applyLogProposals(input);
      },
    });
    assert.match(io.combined, /qa_failed/);
    assert.match(io.combined, /assist|pending/);
    assert.doesNotMatch(io.combined, /已写入 process-backlog/);
    assert.equal(applyCalls, 0);
  });

  it('UT-LOG-CLI-05: 非 dry-run：临时目录只碰 process-backlog、不碰业务 backlog', () => {
    const realBacklogBefore = fileHash(REAL_BACKLOG);
    const realProcessBefore = fileHash(REAL_PROCESS_BACKLOG);
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'qa failed\n',
      businessSentinel: 'BUSINESS_BACKLOG_SENTINEL_F13\n',
    });
    const beforeBusiness = fileHash(tmp.businessFile);
    const beforeProcess = fileHash(tmp.processFile);
    const code = main([
      '--root', tmp.root,
      '--runs', tmp.runsFile,
      '--backlog', tmp.processFile,
      '--logs-dir', tmp.logsDir,
      '--no-record',
    ]);
    assert.equal(code, 0);
    assert.notEqual(fileHash(tmp.processFile), beforeProcess);
    const md = fs.readFileSync(tmp.processFile, 'utf8');
    assert.match(
      md,
      /\|\s*P\d+\s*\|\s*\w+\s*\|\s*qa_failed\s*\|\s*assist\s*\|\s*todo\s*\|\s*\d+\s*\|/,
    );
    assert.equal(fileHash(tmp.businessFile), beforeBusiness);
    assert.equal(fileHash(REAL_BACKLOG), realBacklogBefore);
    assert.equal(fileHash(REAL_PROCESS_BACKLOG), realProcessBefore);
  });

  it('UT-LOG-CLI-06: 默认读 NDJSON + 近日 *cron*.log（路径契约）', () => {
    // 路径契约：--root + 默认相对 logs/automation-runs.ndjson 与 logs/*cron*.log
    // （测码用 --root 指向临时根，不传 --runs/--logs-dir，验证默认值常量）
    assert.equal(CRON_LOOKBACK_DAYS, 7);
    const tmp = setupTempRoot({
      ndjson: `${runLine('agent_auth')}\n`,
      cronName: 'daily-fix-cron-20261120.log',
      cronText: 'agent not logged in / PATH missing\n',
    });
    // 不传 --runs / --logs-dir / --backlog，仅 --root + --dry-run
    const io = captureIo();
    const result = runLogAnalyze({
      dryRun: true,
      root: tmp.root,
      record: false,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.ok(result.proposals.some((p) => p.reason === 'agent_auth'));
    assert.match(io.combined, /agent_auth/);
    const blob = io.combined + JSON.stringify(result.proposals);
    assert.ok(
      /not logged in|PATH/i.test(blob),
      '现象/打印须含 cron 摘要子串',
    );
  });

  it('UT-LOG-CLI-07: automation_record 独立 kind，不冒充日修/周扫计次', () => {
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'qa\n',
    });
    const decideSrc = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(decideSrc, /COUNTED_KINDS/);
    assert.match(decideSrc, /daily-fix/);
    // F13 kind 不得是 COUNTED_KINDS 成员
    const forbidden = new Set([
      'daily-fix',
      'weekly-scan',
      'daily-fix-cron',
      'weekly-scan-cron',
    ]);
    assert.ok(!forbidden.has(AUTOMATION_KIND));
    assert.equal(AUTOMATION_KIND, 'log-analyze');

    const io = captureIo();
    runLogAnalyze({
      dryRun: false,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: true,
      runFile: tmp.recordFile,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.ok(fs.existsSync(tmp.recordFile));
    const lines = fs.readFileSync(tmp.recordFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.kind, 'log-analyze');
    assert.ok(!forbidden.has(last.kind));
    assert.doesNotMatch(io.combined, /已发送通知邮件/);
  });

  it('UT-LOG-CLI-08: 与 process-decide 并存：不调 decide、不改阈值/状态', () => {
    const decideHashBefore = fileHash(PROCESS_DECIDE);
    const decideSrc = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(decideSrc, /threshold/);
    assert.match(decideSrc, /\b20\b/);
    assert.match(decideSrc, /\b3\b/);
    assert.ok(fs.existsSync(PROCESS_DECIDE_CRON));

    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'x\n',
    });
    const stateFile = path.join(tmp.logsDir, 'process-decide-state.json');
    const stateBody = '{"reasons":{"SENTINEL_F13":true}}\n';
    fs.writeFileSync(stateFile, stateBody);

    const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
    assert.doesNotMatch(cliSrc, /decideFromRuns/);
    assert.doesNotMatch(cliSrc, /from ['"].*process-decide/);

    main([
      '--root', tmp.root,
      '--runs', tmp.runsFile,
      '--backlog', tmp.processFile,
      '--logs-dir', tmp.logsDir,
      '--no-record',
    ]);
    main([
      '--dry-run',
      '--root', tmp.root,
      '--runs', tmp.runsFile,
      '--backlog', tmp.processFile,
      '--logs-dir', tmp.logsDir,
      '--no-record',
    ]);

    assert.equal(fileHash(PROCESS_DECIDE), decideHashBefore);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBody);
    assert.ok(fs.existsSync(PROCESS_DECIDE_CRON));
  });

  it('UT-LOG-CLI-09: 可选 cron 壳：风格对齐 process-decide-cron 且调 CLI', () => {
    // 壳可选：本仓库已提供 process-log-analyze-cron.sh
    if (!fs.existsSync(CRON_SHELL)) {
      // 软 PASS：仍要求 CLI（UT-LOG-CLI-01）已满足可执行入口
      assert.ok(fs.existsSync(CLI_PATH));
      return;
    }
    const shell = fs.readFileSync(CRON_SHELL, 'utf8');
    assert.match(shell, /process-log-analyze\.js/);
    assert.doesNotMatch(shell, /process-decide\.js/);
    assert.match(shell, /process-log-analyze-cron-/);
    // 文档字符串可举例；只禁可执行调用（非注释行）
    const codeLines = shell
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    assert.doesNotMatch(codeLines, /\bcrontab\b|\bschtasks\b|\/etc\/cron/);
    // 对照 decide-cron：cd 项目根、日志重定向、调 node
    assert.match(shell, /PROJECT_ROOT/);
    assert.match(shell, /\bnode\b/);
  });

  it('UT-LOG-CLI-10: 不做：不改 daily-fix.sh 选单 / 不强制插入日修主路径', () => {
    const before = fileHash(DAILY_FIX);
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'x\n',
    });
    main([
      '--root', tmp.root,
      '--runs', tmp.runsFile,
      '--backlog', tmp.processFile,
      '--logs-dir', tmp.logsDir,
      '--no-record',
    ]);
    assert.equal(fileHash(DAILY_FIX), before);
    const daily = fs.readFileSync(DAILY_FIX, 'utf8');
    // 不得变成必跑代码路径（允许注释提及，但不得无条件调用）
    assert.doesNotMatch(
      daily,
      /^[^#\n]*process-log-analyze/m,
    );
  });

  it('UT-LOG-CLI-11: 不做：脚本内不注册系统 crontab / Windows 任务', () => {
    // 契约：文档字符串举例可用，但不得是实际调用——剥注释后再扫
    const stripJsComments = (src) => src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    const stripShComments = (src) => src
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    const cliCode = stripJsComments(fs.readFileSync(CLI_PATH, 'utf8'));
    assert.doesNotMatch(cliCode, /\bcrontab\b/);
    assert.doesNotMatch(cliCode, /\bschtasks\b/);
    assert.doesNotMatch(cliCode, /\/etc\/cron/);
    if (fs.existsSync(CRON_SHELL)) {
      const shellCode = stripShComments(fs.readFileSync(CRON_SHELL, 'utf8'));
      assert.doesNotMatch(shellCode, /\bcrontab\b/);
      assert.doesNotMatch(shellCode, /\bschtasks\b/);
      assert.doesNotMatch(shellCode, /\/etc\/cron/);
    }
  });

  it('UT-LOG-CLI-12: 不做：不读 ai_audit_logs；不发邮件正文', () => {
    const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
    assert.doesNotMatch(cliSrc, /ai_audit_logs/);
    assert.doesNotMatch(cliSrc, /sendMail|automation_notify_human|nodemailer/i);
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`,
      cronText: 'x\n',
    });
    const io = captureIo();
    runLogAnalyze({
      dryRun: true,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: true,
      runFile: tmp.recordFile,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    runLogAnalyze({
      dryRun: false,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: true,
      runFile: tmp.recordFile,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.doesNotMatch(io.combined, /已发送通知邮件/);
    assert.doesNotMatch(io.combined, /ai_audit_logs/);
  });

  it('UT-LOG-CLI-13: 空输入 / 无提案：两类 md 均不变', () => {
    const tmp = setupTempRoot({
      ndjson: `${runLine('ok')}\n${runLine('empty_queue')}\n`,
      cronText: '',
      businessSentinel: 'BUSINESS_BACKLOG_SENTINEL_F13\n',
    });
    const hp = fileHash(tmp.processFile);
    const hb = fileHash(tmp.businessFile);
    const ioDry = captureIo();
    const dry = runLogAnalyze({
      dryRun: true,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: false,
      stdout: ioDry.stdout,
      stderr: ioDry.stderr,
    });
    assert.equal(dry.exitCode, 0);
    assert.equal(fileHash(tmp.processFile), hp);
    assert.equal(fileHash(tmp.businessFile), hb);
    assert.match(ioDry.combined, /无提案|\[\]/);

    const wet = runLogAnalyze({
      dryRun: false,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: false,
      stdout: captureIo().stdout,
      stderr: captureIo().stderr,
    });
    assert.equal(wet.exitCode, 0);
    assert.equal(fileHash(tmp.processFile), hp);
    assert.equal(fileHash(tmp.businessFile), hb);
  });

  it('UT-LOG-CLI-14: residual：不要求 F14 挂载 / 不要求日修默认串联分析', () => {
    // 本行只锁断言范围：不以「未挂载 crontab / 日修未串联」为 FAIL
    assert.ok(fs.existsSync(CLI_PATH));
    assert.equal(typeof parseArgs, 'function');
    assert.equal(typeof main, 'function');
    // 明确不检查系统 crontab、不要求改 daily-fix 默认串联
    assert.ok(true, '挂载属 F14；日修默认串联不在本表范围');
  });

  it('UT-LOG-CLI-15: 与 UT-PROCESS / UT-LOG-WRITE 分界：不实施满 3 次门槛、不降优先级', () => {
    const processMd = withQueueRow(
      TEMPLATE,
      '| P9 | fix | qa_failed | assist | todo | 15 | 旧文案 |',
    );
    const tmp = setupTempRoot({
      ndjson: `${runLine('qa_failed')}\n`, // 仅 1 条 < decide 阈值 3
      cronText: 'qa\n',
      processMd,
    });
    const beforePri = '15';
    runLogAnalyze({
      dryRun: false,
      root: tmp.root,
      runsFile: tmp.runsFile,
      backlogFile: tmp.processFile,
      logsDir: tmp.logsDir,
      record: false,
      stdout: captureIo().stdout,
      stderr: captureIo().stderr,
    });
    const md = fs.readFileSync(tmp.processFile, 'utf8');
    const row = md.split('\n').find((l) => /^\|\s*P9\s*\|/.test(l));
    assert.ok(row);
    const cells = row.split('|').map((c) => c.trim());
    assert.equal(cells[6], beforePri);
    // 同 reason 已存在 → F12 skip，不因 <3 次拒绝调用
    assert.equal(cells[3], 'qa_failed');
  });
});
