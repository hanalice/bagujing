/**
 * F23 低频审计排行 CLI/cron 壳：串联 F21+F22、--dry-run、与 F13/process-decide 并存。
 *
 * CLI 路径（测码锁死）：scripts/automation/audit-reason-cli.js
 * （契约建议名 audit-reason-rank.js 已由 F21 纯函数占用；本路径为等价可执行入口）
 * 可选 cron 壳：scripts/automation/audit-reason-rank-cron.sh
 *
 * 旗标锁死：--dry-run / --root / --audit-export / --audit-db / --audit-ndjson
 *           / --backlog / --snapshot / --today / --no-record
 * automation kind 锁死：audit-rank（AUTOMATION_KIND）
 * 默认路径常量：DEFAULT_AUDIT_EXPORT_REL / DEFAULT_AUDIT_DB_REL /
 *               DEFAULT_AUDIT_NDJSON_REL / DEFAULT_SNAPSHOT_REL / DEFAULT_BACKLOG_REL
 * （均非流水线 automation-runs.ndjson / *cron*.log）
 * 退出码约定：无提案仍为 0（dry-run / 非 dry-run 一致）
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  AUTOMATION_KIND,
  DEFAULT_AUDIT_DB_REL,
  DEFAULT_AUDIT_EXPORT_REL,
  DEFAULT_AUDIT_NDJSON_REL,
  DEFAULT_BACKLOG_REL,
  DEFAULT_SNAPSHOT_REL,
  main,
  parseArgs,
  runAuditRank,
} from '../../../scripts/automation/audit-reason-cli.js';
import {
  MIN_SAMPLES,
  rankAuditReasons,
} from '../../../scripts/automation/audit-reason-rank.js';
import { applyAuditProposals } from '../../../scripts/automation/audit-reason-write.js';
import { AUTOMATION_KIND as F13_KIND } from '../../../scripts/automation/process-log-analyze.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '../../..');
const CLI_PATH = path.join(ROOT, 'scripts/automation/audit-reason-cli.js');
const CRON_SHELL = path.join(ROOT, 'scripts/automation/audit-reason-rank-cron.sh');
const PROCESS_DECIDE = path.join(ROOT, 'scripts/automation/process-decide.js');
const PROCESS_DECIDE_CRON = path.join(ROOT, 'scripts/automation/process-decide-cron.sh');
const F13_CLI = path.join(ROOT, 'scripts/automation/process-log-analyze.js');
const F13_CRON = path.join(ROOT, 'scripts/automation/process-log-analyze-cron.sh');
const DAILY_FIX = path.join(ROOT, 'scripts/automation/daily-fix.sh');
const REAL_BACKLOG = path.join(ROOT, 'docs/backlog.md');
const REAL_PROCESS_BACKLOG = path.join(ROOT, 'docs/process-backlog.md');

/** 最小业务 backlog 模板：含队列表与修订记录。 */
const BUSINESS_TEMPLATE = `# 工程待办队列

## 队列表

| ID  | 类型 | 来源  | 分级   | 状态  | 优先级 | 任务 |
| --- | -- | --- | ---- | --- | --- | -- |
| Z1 | fix | other | assist | todo | 90 | 无关占位 |

## 修订记录

| 日期         | 说明 |
| ---------- | -- |
| 2026-01-01 | 初始夹具 |
`;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function fileHash(file) {
  return sha256(fs.readFileSync(file));
}

/** 构造审计导出行。 */
function auditRow(reason, extra = {}) {
  return { reason, detail: extra.detail || `${reason} detail`, ...extra };
}

/**
 * 构造窗口样本 ≥ MIN_SAMPLES：成功分母 + 失败行。
 * @param {{ failReason?: string, failCount?: number, successCount?: number }} [opts]
 */
function buildExportRows(opts = {}) {
  const failReason = opts.failReason || 'sse_idle_timeout';
  const failCount = opts.failCount ?? 8;
  const successCount = opts.successCount ?? Math.max(MIN_SAMPLES - failCount, 12);
  const rows = [];
  for (let i = 0; i < successCount; i += 1) {
    rows.push(auditRow('stream_done', { detail: `ok-${i}` }));
  }
  for (let i = 0; i < failCount; i += 1) {
    rows.push(auditRow(failReason, { detail: `fail-${i}` }));
  }
  return rows;
}

/**
 * 搭临时项目根：业务 backlog + process 哨兵 + 审计导出 + 可选快照/NDJSON。
 * @param {{
 *   businessMd?: string,
 *   processSentinel?: string,
 *   exportRows?: object[] | null,
 *   ndjsonText?: string,
 *   snapshot?: object | null,
 *   omitExport?: boolean,
 * }} [opts]
 */
function setupTempRoot(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'f23-cli-'));
  const logsDir = path.join(root, 'logs');
  const docsDir = path.join(root, 'docs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(docsDir, { recursive: true });

  const businessFile = path.join(docsDir, 'backlog.md');
  fs.writeFileSync(businessFile, opts.businessMd ?? BUSINESS_TEMPLATE);

  const processFile = path.join(docsDir, 'process-backlog.md');
  fs.writeFileSync(
    processFile,
    opts.processSentinel || 'PROCESS_BACKLOG_SENTINEL_F23\n',
  );

  const exportFile = path.join(logsDir, 'ai-audit-export.json');
  if (!opts.omitExport) {
    const rows = opts.exportRows === null
      ? []
      : (opts.exportRows ?? buildExportRows());
    fs.writeFileSync(exportFile, JSON.stringify(rows, null, 2));
  }

  const ndjsonFile = path.join(logsDir, 'ai-audit.ndjson');
  fs.writeFileSync(ndjsonFile, opts.ndjsonText ?? '');

  const snapshotFile = path.join(logsDir, 'audit-reason-rank-snapshot.json');
  if (opts.snapshot !== null) {
    // 默认不写快照（省略 → 门控视为有变化）；显式 null 表示不创建文件
    if (opts.snapshot !== undefined) {
      fs.writeFileSync(snapshotFile, JSON.stringify(opts.snapshot));
    }
  }

  const recordFile = path.join(logsDir, 'f23-record.ndjson');
  // 放置流水线 NDJSON 诱饵：F23 不得当主源消费
  const pipelineRuns = path.join(logsDir, 'automation-runs.ndjson');
  fs.writeFileSync(
    pipelineRuns,
    `${JSON.stringify({ kind: 'daily-fix', reason: 'qa_failed', exitCode: 1 })}\n`,
  );
  fs.writeFileSync(path.join(logsDir, 'daily-fix-cron-bait.log'), 'qa_failed bait\n');

  return {
    root,
    logsDir,
    businessFile,
    processFile,
    exportFile,
    ndjsonFile,
    snapshotFile,
    recordFile,
    pipelineRuns,
  };
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

/** 公共 run 参数：指向临时导出夹具，禁 record。 */
function baseOpts(tmp, extra = {}) {
  return {
    root: tmp.root,
    auditExportFile: tmp.exportFile,
    auditNdjsonFile: tmp.ndjsonFile,
    backlogFile: tmp.businessFile,
    snapshotFile: fs.existsSync(tmp.snapshotFile) ? tmp.snapshotFile : path.join(tmp.logsDir, 'no-snapshot.json'),
    record: false,
    ...extra,
  };
}

describe('audit-reason-cli (F23)', () => {
  it('UT-AUDIT-CLI-01: CLI 入口存在且可被直接执行', () => {
    assert.ok(fs.existsSync(CLI_PATH));
    const tmp = setupTempRoot({ exportRows: [], omitExport: false });
    const result = spawnSync(
      process.execPath,
      [
        CLI_PATH,
        '--dry-run',
        '--root', tmp.root,
        '--audit-export', tmp.exportFile,
        '--backlog', tmp.businessFile,
        '--no-record',
      ],
      { encoding: 'utf8', env: { ...process.env, AUTOMATION_NOTIFY_DISABLE: '1' } },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const src = fs.readFileSync(CLI_PATH, 'utf8');
    assert.match(src, /endsWith\(['"]audit-reason-cli\.js['"]\)/);
  });

  it('UT-AUDIT-CLI-02: 默认串联顺序：先 F21 排行再（非 dry-run）F22 落盘', () => {
    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout', failCount: 8 }),
    });
    /** @type {string[]} */
    const order = [];
    let rankCalls = 0;
    let applyCalls = 0;
    const io = captureIo();
    const result = runAuditRank({
      ...baseOpts(tmp),
      dryRun: false,
      stdout: io.stdout,
      stderr: io.stderr,
      rankFn: (input) => {
        rankCalls += 1;
        order.push('rank');
        return rankAuditReasons(input);
      },
      applyFn: (input) => {
        applyCalls += 1;
        order.push('apply');
        return applyAuditProposals(input);
      },
    });
    assert.ok(rankCalls >= 1);
    assert.ok(applyCalls >= 1);
    assert.deepEqual(order.slice(0, 2), ['rank', 'apply']);
    assert.ok(result.callOrder.indexOf('rank') < result.callOrder.indexOf('apply'));
    const md = fs.readFileSync(tmp.businessFile, 'utf8');
    assert.match(
      md,
      /\|\s*A\d+\s*\|\s*\w+\s*\|\s*audit\s*\|\s*assist\s*\|\s*todo\s*\|\s*\d+\s*\|[^\n]*sse_idle_timeout/,
    );
  });

  it('UT-AUDIT-CLI-03: --dry-run 后业务 backlog 原文不变', () => {
    const businessMd = `${BUSINESS_TEMPLATE}\n<!-- BUSINESS_BACKLOG_SENTINEL_F23_DRY -->\n`;
    const tmp = setupTempRoot({
      businessMd,
      processSentinel: 'PROCESS_BACKLOG_SENTINEL_F23\n',
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const beforeBusiness = fileHash(tmp.businessFile);
    const beforeProcess = fileHash(tmp.processFile);
    const code = main([
      '--dry-run',
      '--root', tmp.root,
      '--audit-export', tmp.exportFile,
      '--backlog', tmp.businessFile,
      '--audit-ndjson', tmp.ndjsonFile,
      '--no-record',
    ]);
    assert.equal(code, 0);
    assert.equal(fileHash(tmp.businessFile), beforeBusiness);
    assert.equal(fileHash(tmp.processFile), beforeProcess);
  });

  it('UT-AUDIT-CLI-04: --dry-run 只打印提案（stdout 可判定）', () => {
    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const io = captureIo();
    let applyCalls = 0;
    runAuditRank({
      ...baseOpts(tmp),
      dryRun: true,
      stdout: io.stdout,
      stderr: io.stderr,
      applyFn: (input) => {
        applyCalls += 1;
        return applyAuditProposals(input);
      },
    });
    assert.match(io.combined, /sse_idle_timeout/);
    assert.match(io.combined, /assist/);
    assert.doesNotMatch(io.combined, /已写入 backlog/);
    assert.equal(applyCalls, 0);
  });

  it('UT-AUDIT-CLI-05: 非 dry-run：临时目录只碰业务 backlog、不碰 process-backlog', () => {
    const realBacklogBefore = fileHash(REAL_BACKLOG);
    const realProcessBefore = fileHash(REAL_PROCESS_BACKLOG);
    const tmp = setupTempRoot({
      processSentinel: 'PROCESS_BACKLOG_SENTINEL_F23\n',
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const beforeBusiness = fileHash(tmp.businessFile);
    const beforeProcess = fileHash(tmp.processFile);
    const code = main([
      '--root', tmp.root,
      '--audit-export', tmp.exportFile,
      '--backlog', tmp.businessFile,
      '--audit-ndjson', tmp.ndjsonFile,
      '--no-record',
    ]);
    assert.equal(code, 0);
    assert.notEqual(fileHash(tmp.businessFile), beforeBusiness);
    const md = fs.readFileSync(tmp.businessFile, 'utf8');
    assert.match(md, /assist\s*\|\s*todo/);
    assert.match(md, /sse_idle_timeout|audit/);
    assert.equal(fileHash(tmp.processFile), beforeProcess);
    assert.equal(fileHash(REAL_BACKLOG), realBacklogBefore);
    assert.equal(fileHash(REAL_PROCESS_BACKLOG), realProcessBefore);
  });

  it('UT-AUDIT-CLI-06: 默认读业务审计（SQLite/导出 + 可选 NDJSON），非流水线主源', () => {
    // 路径契约：默认常量指向业务审计，不含 automation-runs / *cron*.log
    assert.equal(DEFAULT_AUDIT_EXPORT_REL, 'logs/ai-audit-export.json');
    assert.equal(DEFAULT_AUDIT_DB_REL, 'backend/db/bagujing.dev.sqlite3');
    assert.equal(DEFAULT_AUDIT_NDJSON_REL, 'logs/ai-audit.ndjson');
    assert.equal(DEFAULT_SNAPSHOT_REL, 'logs/audit-reason-rank-snapshot.json');
    assert.equal(DEFAULT_BACKLOG_REL, 'docs/backlog.md');
    assert.doesNotMatch(DEFAULT_AUDIT_EXPORT_REL, /automation-runs/);
    assert.doesNotMatch(DEFAULT_AUDIT_NDJSON_REL, /automation-runs/);
    assert.doesNotMatch(DEFAULT_AUDIT_DB_REL, /cron/);

    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'upstream_http', failCount: 8 }),
    });
    const io = captureIo();
    const result = runAuditRank({
      ...baseOpts(tmp),
      dryRun: true,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.ok(result.proposals.some((p) => p.reason === 'upstream_http'));
    assert.match(io.combined, /upstream_http/);

    // 默认路径常量源码不含流水线主源文件名
    const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
    assert.doesNotMatch(
      cliSrc,
      /DEFAULT_[A-Z_]+ = ['"][^'"]*automation-runs\.ndjson/,
    );
    assert.doesNotMatch(
      cliSrc,
      /DEFAULT_[A-Z_]+ = ['"][^'"]*\*cron/,
    );
  });

  it('UT-AUDIT-CLI-07: automation_record 独立 kind，不冒充日修/周扫/F13 计次', () => {
    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const forbidden = new Set([
      'daily-fix',
      'weekly-scan',
      'daily-fix-cron',
      'weekly-scan-cron',
      'log-analyze',
      'process-log-analyze',
      'log-analyze-cron',
    ]);
    assert.ok(!forbidden.has(AUTOMATION_KIND));
    assert.equal(AUTOMATION_KIND, 'audit-rank');
    assert.notEqual(AUTOMATION_KIND, F13_KIND);

    const decideSrc = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(decideSrc, /COUNTED_KINDS/);

    const io = captureIo();
    runAuditRank({
      ...baseOpts(tmp),
      dryRun: false,
      record: true,
      runFile: tmp.recordFile,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.ok(fs.existsSync(tmp.recordFile));
    const lines = fs.readFileSync(tmp.recordFile, 'utf8').trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 1);
    const last = JSON.parse(lines[lines.length - 1]);
    assert.equal(last.kind, 'audit-rank');
    assert.ok(!forbidden.has(last.kind));
    assert.doesNotMatch(io.combined, /已发送通知邮件/);
  });

  it('UT-AUDIT-CLI-08: 与 F13 / process-decide 并存：不调 decide、不调 F11/F12、不改阈值/状态', () => {
    const decideHashBefore = fileHash(PROCESS_DECIDE);
    const decideSrc = fs.readFileSync(PROCESS_DECIDE, 'utf8');
    assert.match(decideSrc, /threshold/);
    assert.match(decideSrc, /\b20\b/);
    assert.match(decideSrc, /\b3\b/);
    assert.ok(fs.existsSync(PROCESS_DECIDE_CRON));
    assert.ok(fs.existsSync(F13_CLI));

    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const stateFile = path.join(tmp.logsDir, 'process-decide-state.json');
    const stateBody = '{"reasons":{"SENTINEL_F23":true}}\n';
    fs.writeFileSync(stateFile, stateBody);

    const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
    assert.doesNotMatch(cliSrc, /decideFromRuns/);
    assert.doesNotMatch(cliSrc, /from ['"].*process-decide/);
    assert.doesNotMatch(cliSrc, /process-log-parse/);
    assert.doesNotMatch(cliSrc, /process-log-write/);
    assert.doesNotMatch(cliSrc, /analyzePipelineLogs|applyLogProposals/);

    main([
      '--root', tmp.root,
      '--audit-export', tmp.exportFile,
      '--backlog', tmp.businessFile,
      '--no-record',
    ]);
    main([
      '--dry-run',
      '--root', tmp.root,
      '--audit-export', tmp.exportFile,
      '--backlog', tmp.businessFile,
      '--no-record',
    ]);

    assert.equal(fileHash(PROCESS_DECIDE), decideHashBefore);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBody);
    assert.ok(fs.existsSync(PROCESS_DECIDE_CRON));
    assert.ok(fs.existsSync(F13_CLI));
    if (fs.existsSync(F13_CRON)) assert.ok(fs.existsSync(F13_CRON));
  });

  it('UT-AUDIT-CLI-09: 可选 cron 壳：风格对齐且调 F23 CLI', () => {
    // 壳可选：本仓库已提供 audit-reason-rank-cron.sh
    if (!fs.existsSync(CRON_SHELL)) {
      assert.ok(fs.existsSync(CLI_PATH));
      return;
    }
    const shell = fs.readFileSync(CRON_SHELL, 'utf8');
    assert.match(shell, /audit-reason-cli\.js/);
    assert.doesNotMatch(shell, /process-decide\.js/);
    assert.doesNotMatch(shell, /process-log-analyze\.js/);
    assert.match(shell, /audit-reason-rank-cron-/);
    const codeLines = shell
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    assert.doesNotMatch(codeLines, /\bcrontab\b|\bschtasks\b|\/etc\/cron/);
    assert.match(shell, /PROJECT_ROOT/);
    assert.match(shell, /\bnode\b/);
  });

  it('UT-AUDIT-CLI-10: 样本不足路径：非 dry-run 亦不改 md', () => {
    const few = Array.from({ length: Math.min(3, MIN_SAMPLES - 1) }, () =>
      auditRow('upstream_http'));
    assert.ok(few.length < MIN_SAMPLES);
    const tmp = setupTempRoot({ exportRows: few });
    const beforeBusiness = fileHash(tmp.businessFile);
    const beforeProcess = fileHash(tmp.processFile);
    const code = main([
      '--root', tmp.root,
      '--audit-export', tmp.exportFile,
      '--backlog', tmp.businessFile,
      '--no-record',
    ]);
    assert.equal(code, 0);
    assert.equal(fileHash(tmp.businessFile), beforeBusiness);
    assert.equal(fileHash(tmp.processFile), beforeProcess);

    // 对照：放大样本后非 dry-run 可变 md
    const tmp2 = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const before2 = fileHash(tmp2.businessFile);
    main([
      '--root', tmp2.root,
      '--audit-export', tmp2.exportFile,
      '--backlog', tmp2.businessFile,
      '--no-record',
    ]);
    assert.notEqual(fileHash(tmp2.businessFile), before2);
  });

  it('UT-AUDIT-CLI-11: 不做：不改 daily-fix.sh 选单 / 不强制插入日修主路径', () => {
    const before = fileHash(DAILY_FIX);
    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    main([
      '--root', tmp.root,
      '--audit-export', tmp.exportFile,
      '--backlog', tmp.businessFile,
      '--no-record',
    ]);
    assert.equal(fileHash(DAILY_FIX), before);
    const daily = fs.readFileSync(DAILY_FIX, 'utf8');
    assert.doesNotMatch(daily, /^[^#\n]*audit-reason-(cli|rank)/m);
  });

  it('UT-AUDIT-CLI-12: 不做：脚本内不注册系统 crontab / Windows 任务', () => {
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

  it('UT-AUDIT-CLI-13: 不做：不以流水线 NDJSON/cron 为主源；不发邮件正文；不改审计 schema', () => {
    const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
    assert.doesNotMatch(cliSrc, /sendMail|automation_notify_human|nodemailer/i);
    assert.doesNotMatch(cliSrc, /ALTER\s+TABLE/i);

    const tmp = setupTempRoot({
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const io = captureIo();
    runAuditRank({
      ...baseOpts(tmp),
      dryRun: true,
      record: true,
      runFile: tmp.recordFile,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    runAuditRank({
      ...baseOpts(tmp),
      dryRun: false,
      record: true,
      runFile: tmp.recordFile,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.doesNotMatch(io.combined, /已发送通知邮件/);
    // 提案 reason 仍为既有失败类字面量，未 rename
    assert.match(io.combined + JSON.stringify(
      rankAuditReasons({
        auditRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
      }),
    ), /sse_idle_timeout/);
  });

  it('UT-AUDIT-CLI-14: 无提案 / 自检未过：两类 md 均不变（含无意义变化）', () => {
    // 样本足够但相对快照无意义变化 → F21 空列表
    const rows = buildExportRows({ failReason: 'sse_idle_timeout', failCount: 8 });
    const proposalsProbe = rankAuditReasons({ auditRows: rows });
    assert.ok(proposalsProbe.length >= 1);
    const top = proposalsProbe.find((p) => p.reason === 'sse_idle_timeout')
      || proposalsProbe[0];
    const snapshot = {
      topReason: top.reason,
      count: top.count,
      ratio: top.ratio,
    };
    // 确认同快照 → 空
    assert.equal(
      rankAuditReasons({ auditRows: rows, previousSnapshot: snapshot }).length,
      0,
    );

    const tmp = setupTempRoot({ exportRows: rows, snapshot });
    const hb = fileHash(tmp.businessFile);
    const hp = fileHash(tmp.processFile);
    const ioDry = captureIo();
    const dry = runAuditRank({
      ...baseOpts(tmp),
      dryRun: true,
      snapshotFile: tmp.snapshotFile,
      stdout: ioDry.stdout,
      stderr: ioDry.stderr,
    });
    assert.equal(dry.exitCode, 0);
    assert.equal(fileHash(tmp.businessFile), hb);
    assert.equal(fileHash(tmp.processFile), hp);
    assert.match(ioDry.combined, /无提案|\[\]/);

    const wet = runAuditRank({
      ...baseOpts(tmp),
      dryRun: false,
      snapshotFile: tmp.snapshotFile,
      stdout: captureIo().stdout,
      stderr: captureIo().stderr,
    });
    assert.equal(wet.exitCode, 0);
    assert.equal(fileHash(tmp.businessFile), hb);
    assert.equal(fileHash(tmp.processFile), hp);
  });

  it('UT-AUDIT-CLI-15: residual：不要求 F24 挂载 / 不要求日修默认串联审计排行', () => {
    assert.ok(fs.existsSync(CLI_PATH));
    assert.equal(typeof parseArgs, 'function');
    assert.equal(typeof main, 'function');
    assert.ok(true, '挂载属 F24；日修默认串联不在本表范围');
  });

  it('UT-AUDIT-CLI-16: 与 UT-LOG-CLI / UT-AUDIT-WRITE / UT-PROCESS 分界：不碰 process、不实施满 3 次、不抢 F13', () => {
    const tmp = setupTempRoot({
      processSentinel: 'PROCESS_BACKLOG_SENTINEL_F23\n',
      exportRows: buildExportRows({ failReason: 'sse_idle_timeout' }),
    });
    const beforeProcess = fileHash(tmp.processFile);
    const beforeBusiness = fileHash(tmp.businessFile);
    runAuditRank({
      ...baseOpts(tmp),
      dryRun: false,
      stdout: captureIo().stdout,
      stderr: captureIo().stderr,
    });
    assert.notEqual(fileHash(tmp.businessFile), beforeBusiness);
    assert.equal(fileHash(tmp.processFile), beforeProcess);
    const md = fs.readFileSync(tmp.businessFile, 'utf8');
    assert.doesNotMatch(md, /\|\s*P\d+\s*\|/); // 非 process 队列 ID 形态被迫追加
    assert.match(md, /sse_idle_timeout|audit/);
    assert.doesNotMatch(md, /qa_failed/); // 流水线诱饵不得被消费进业务 backlog

    const cliSrc = fs.readFileSync(CLI_PATH, 'utf8');
    assert.doesNotMatch(cliSrc, /analyzePipelineLogs|applyLogProposals|process-log-parse|process-log-write/);
  });

  it('辅助：--audit-db 可读临时 SQLite ai_audit_logs', () => {
    // 覆盖 SQLite 路径；非契约必测行，但保证 --audit-db 可用
    const { DatabaseSync } = require('node:sqlite');
    const tmp = setupTempRoot({ omitExport: true, exportRows: null });
    const dbPath = path.join(tmp.logsDir, 'audit-fixture.sqlite');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE ai_audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        reason TEXT,
        detail TEXT
      );
    `);
    const rows = buildExportRows({ failReason: 'circuit_open', failCount: 8 });
    const ins = db.prepare('INSERT INTO ai_audit_logs (reason, detail) VALUES (?, ?)');
    for (const r of rows) {
      ins.run(r.reason, r.detail || '');
    }
    db.close();

    const io = captureIo();
    const result = runAuditRank({
      dryRun: true,
      root: tmp.root,
      auditDbFile: dbPath,
      auditNdjsonFile: tmp.ndjsonFile,
      backlogFile: tmp.businessFile,
      record: false,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    assert.ok(result.proposals.some((p) => p.reason === 'circuit_open'));
  });
});
