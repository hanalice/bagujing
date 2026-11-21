/**
 * F13：低频分析 CLI 壳。
 * 默认读 logs/automation-runs.ndjson + 近日 logs/*cron*.log，串联 F11→F12。
 * 支持 --dry-run（只打印提案、不改 md）；与 process-decide 并存。
 * 本机任务计划挂载属 F14；本文件不注册系统定时任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePipelineLogs } from './process-log-parse.js';
import { applyLogProposals } from './process-log-write.js';

/** 独立 automation_record kind；不得进入 process-decide COUNTED_KINDS。 */
export const AUTOMATION_KIND = 'log-analyze';

/** 近日 cron 日志回看天数（按 mtime；测码注释锁死）。 */
export const CRON_LOOKBACK_DAYS = 7;

/** 默认 cron 文件名匹配（basename）。 */
export const DEFAULT_CRON_GLOB = /cron/i;

/**
 * 解析 CLI 参数。
 * 旗标约定（测码锁死）：
 * - --dry-run：只打印提案，不改 md
 * - --root：项目根（默认 cwd 或本文件上溯两级）
 * - --runs：NDJSON 路径（默认 <root>/logs/automation-runs.ndjson）
 * - --backlog：process-backlog 路径（默认 <root>/docs/process-backlog.md）
 * - --logs-dir：cron 日志目录（默认 <root>/logs）
 * - --today：修订记录日期 YYYY-MM-DD
 * - --no-record：跳过写入 AUTOMATION_RUN_FILE
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   root: string | null,
 *   runs: string | null,
 *   backlog: string | null,
 *   logsDir: string | null,
 *   today: string | null,
 *   noRecord: boolean,
 * }}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const out = {
    dryRun: false,
    root: null,
    runs: null,
    backlog: null,
    logsDir: null,
    today: null,
    noRecord: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--dry-run') {
      out.dryRun = true;
      continue;
    }
    if (a === '--no-record') {
      out.noRecord = true;
      continue;
    }
    if (a === '--root' || a === '--runs' || a === '--backlog' || a === '--logs-dir' || a === '--today') {
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`旗标 ${a} 需要取值`);
      }
      if (a === '--root') out.root = val;
      else if (a === '--runs') out.runs = val;
      else if (a === '--backlog') out.backlog = val;
      else if (a === '--logs-dir') out.logsDir = val;
      else if (a === '--today') out.today = val;
      i += 1;
      continue;
    }
    throw new Error(`未知参数: ${a}`);
  }
  return out;
}

/**
 * 读取文件；不存在则返回空串。
 * @param {string} file
 * @returns {string}
 */
function readTextOrEmpty(file) {
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

/**
 * 拼接近日 *cron*.log 文本（按 mtime 过滤；新→旧排序后拼接）。
 * @param {string} logsDir
 * @param {{ now?: Date, lookbackDays?: number, nameRe?: RegExp }} [opts]
 * @returns {string}
 */
export function collectCronLogText(logsDir, opts = {}) {
  if (!logsDir || !fs.existsSync(logsDir)) return '';
  const now = opts.now instanceof Date ? opts.now : new Date();
  const days = Number.isFinite(opts.lookbackDays) ? opts.lookbackDays : CRON_LOOKBACK_DAYS;
  const nameRe = opts.nameRe instanceof RegExp ? opts.nameRe : DEFAULT_CRON_GLOB;
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;

  /** @type {{ file: string, mtimeMs: number }[]} */
  const hits = [];
  for (const name of fs.readdirSync(logsDir)) {
    if (!nameRe.test(name) || !name.endsWith('.log')) continue;
    const file = path.join(logsDir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs < cutoff) continue;
    hits.push({ file, mtimeMs: st.mtimeMs });
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return hits.map((h) => readTextOrEmpty(h.file)).filter(Boolean).join('\n');
}

/**
 * 追加一行独立 kind 的运行记录（不发邮件；通知属另条）。
 * @param {{ runFile: string, kind: string, reason: string, exitCode: number, stage?: string }} row
 */
export function appendAutomationRecord(row) {
  const runFile = row.runFile;
  if (!runFile) return;
  fs.mkdirSync(path.dirname(runFile), { recursive: true });
  const payload = {
    ts: new Date().toISOString(),
    kind: row.kind,
    taskId: null,
    stage: row.stage || 'analyze',
    reason: row.reason,
    exitCode: row.exitCode,
    prOpened: null,
    qaPassed: null,
  };
  fs.appendFileSync(runFile, `${JSON.stringify(payload)}\n`);
}

/**
 * 串联 F11→F12 的可测入口。
 * @param {{
 *   dryRun?: boolean,
 *   root?: string,
 *   runsFile?: string,
 *   backlogFile?: string,
 *   logsDir?: string,
 *   today?: string,
 *   record?: boolean,
 *   runFile?: string,
 *   analyzeFn?: typeof analyzePipelineLogs,
 *   applyFn?: typeof applyLogProposals,
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 * }} [opts]
 * @returns {{
 *   exitCode: number,
 *   proposals: Array<object>,
 *   action: string,
 *   callOrder: string[],
 * }}
 */
export function runLogAnalyze(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const root = opts.root
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const runsFile = opts.runsFile || path.join(root, 'logs', 'automation-runs.ndjson');
  const backlogFile = opts.backlogFile || path.join(root, 'docs', 'process-backlog.md');
  const logsDir = opts.logsDir || path.join(root, 'logs');
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const shouldRecord = opts.record !== false;
  const runFile = opts.runFile
    || process.env.AUTOMATION_RUN_FILE
    || path.join(root, 'logs', 'automation-runs.ndjson');
  const analyzeFn = opts.analyzeFn || analyzePipelineLogs;
  const applyFn = opts.applyFn || applyLogProposals;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;

  /** @type {string[]} */
  const callOrder = [];

  const ndjsonText = readTextOrEmpty(runsFile);
  const cronLogText = collectCronLogText(logsDir);

  callOrder.push('analyze');
  const proposals = analyzeFn({ ndjsonText, cronLogText });

  if (dryRun) {
    // dry-run：只打印提案 JSON，不调用 F12 写盘
    if (!proposals.length) {
      stdout.write('[]\n无提案\n');
    } else {
      stdout.write(`${JSON.stringify(proposals, null, 2)}\n`);
    }
    if (shouldRecord) {
      appendAutomationRecord({
        runFile,
        kind: AUTOMATION_KIND,
        reason: 'dry_run',
        exitCode: 0,
      });
    }
    return { exitCode: 0, proposals, action: 'dry_run', callOrder };
  }

  const beforeMd = readTextOrEmpty(backlogFile);
  callOrder.push('apply');
  const result = applyFn({
    proposals,
    processBacklogMarkdown: beforeMd,
    today,
  });

  if (result.markdown !== beforeMd) {
    fs.mkdirSync(path.dirname(backlogFile), { recursive: true });
    fs.writeFileSync(backlogFile, result.markdown);
    stdout.write(`已写入 process-backlog（action=${result.action}）\n`);
  } else if (!proposals.length) {
    stdout.write('无提案\n');
  } else {
    stdout.write(`无变更（action=${result.action}）\n`);
  }

  if (shouldRecord) {
    appendAutomationRecord({
      runFile,
      kind: AUTOMATION_KIND,
      reason: 'ok',
      exitCode: 0,
    });
  }

  // 静默 stderr 占位：保持接口对称，当前无诊断写出
  void stderr;

  return {
    exitCode: 0,
    proposals,
    action: result.action,
    callOrder,
  };
}

/**
 * CLI main：解析 argv 并执行；无提案仍退出 0（测码锁死）。
 * @param {string[]} [argv]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const root = parsed.root
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = runLogAnalyze({
    dryRun: parsed.dryRun,
    root,
    runsFile: parsed.runs || undefined,
    backlogFile: parsed.backlog || undefined,
    logsDir: parsed.logsDir || undefined,
    today: parsed.today || undefined,
    record: !parsed.noRecord,
  });
  return result.exitCode;
}

if (process.argv[1] && process.argv[1].endsWith('process-log-analyze.js')) {
  try {
    const code = main();
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
