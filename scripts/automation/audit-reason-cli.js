/**
 * F23：低频审计排行 CLI 壳。
 * 默认读业务审计（导出夹具 / SQLite ai_audit_logs + 可选 NDJSON），串联 F21→F22。
 * 支持 --dry-run（只打印提案、不改 md）；与 F13 / process-decide 并存。
 *
 * CLI 路径约定（测码锁死）：本文件 scripts/automation/audit-reason-cli.js
 * 契约建议名 audit-reason-rank.js 已由 F21 纯函数占用；本文件为可执行入口等价路径。
 * 本机任务计划挂载属 F24；本文件不注册系统定时任务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { rankAuditReasons } from './audit-reason-rank.js';
import { applyAuditProposals } from './audit-reason-write.js';

const require = createRequire(import.meta.url);

/** 独立 automation_record kind；不得进入 process-decide COUNTED_KINDS，亦不得冒充 F13。 */
export const AUTOMATION_KIND = 'audit-rank';

/** 默认相对 root 的业务审计导出夹具（JSON 数组或 NDJSON）；缺文件按空行集。 */
export const DEFAULT_AUDIT_EXPORT_REL = 'logs/ai-audit-export.json';

/** 默认相对 root 的 SQLite（含 ai_audit_logs）；缺库/缺表按空行集。 */
export const DEFAULT_AUDIT_DB_REL = 'backend/db/bagujing.dev.sqlite3';

/** 默认相对 root 的业务审计 NDJSON（非流水线 automation-runs）。 */
export const DEFAULT_AUDIT_NDJSON_REL = 'logs/ai-audit.ndjson';

/** 默认相对 root 的上次排行快照 JSON。 */
export const DEFAULT_SNAPSHOT_REL = 'logs/audit-reason-rank-snapshot.json';

/** 默认相对 root 的业务 backlog。 */
export const DEFAULT_BACKLOG_REL = 'docs/backlog.md';

/**
 * 解析 CLI 参数。
 * 旗标约定（测码锁死）：
 * - --dry-run：只打印提案，不改 md
 * - --root：项目根
 * - --audit-export：审计导出行集（JSON 数组或 NDJSON）
 * - --audit-db：SQLite 路径（读 ai_audit_logs）
 * - --audit-ndjson：可选业务审计 NDJSON
 * - --backlog：业务 docs/backlog.md
 * - --snapshot：上次排行快照 JSON
 * - --today：修订记录日期 YYYY-MM-DD
 * - --no-record：跳过写入 AUTOMATION_RUN_FILE
 *
 * @param {string[]} argv
 * @returns {{
 *   dryRun: boolean,
 *   root: string | null,
 *   auditExport: string | null,
 *   auditDb: string | null,
 *   auditNdjson: string | null,
 *   backlog: string | null,
 *   snapshot: string | null,
 *   today: string | null,
 *   noRecord: boolean,
 * }}
 */
export function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const out = {
    dryRun: false,
    root: null,
    auditExport: null,
    auditDb: null,
    auditNdjson: null,
    backlog: null,
    snapshot: null,
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
    const valued = [
      '--root',
      '--audit-export',
      '--audit-db',
      '--audit-ndjson',
      '--backlog',
      '--snapshot',
      '--today',
    ];
    if (valued.includes(a)) {
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) {
        throw new Error(`旗标 ${a} 需要取值`);
      }
      if (a === '--root') out.root = val;
      else if (a === '--audit-export') out.auditExport = val;
      else if (a === '--audit-db') out.auditDb = val;
      else if (a === '--audit-ndjson') out.auditNdjson = val;
      else if (a === '--backlog') out.backlog = val;
      else if (a === '--snapshot') out.snapshot = val;
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
 * 将导出文本解析为审计行对象数组（整段 JSON 数组 / 单对象 / NDJSON）。
 * @param {string} text
 * @returns {object[]}
 */
export function parseAuditExportText(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((r) => r && typeof r === 'object');
    if (parsed && typeof parsed === 'object') return [parsed];
  } catch {
    /* NDJSON */
  }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (obj && typeof obj === 'object') rows.push(obj);
    } catch {
      /* skip */
    }
  }
  return rows;
}

/**
 * 从 SQLite 读 ai_audit_logs；缺库/缺表/读失败 → 空数组（不抛）。
 * 使用 node:sqlite DatabaseSync；不改 schema。
 * @param {string} dbPath
 * @returns {object[]}
 */
export function loadAuditRowsFromSqlite(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return [];
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const table = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ai_audit_logs'",
        )
        .get();
      if (!table) return [];
      const rows = db.prepare('SELECT * FROM ai_audit_logs').all();
      return Array.isArray(rows) ? rows : [];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/**
 * 解析上次排行快照文件；缺文件/非法 → null。
 * @param {string} file
 * @returns {object | null}
 */
export function loadSnapshot(file) {
  const text = readTextOrEmpty(file);
  if (!text.trim()) return null;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object') return obj;
  } catch {
    /* ignore */
  }
  return null;
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
    stage: row.stage || 'audit-rank',
    reason: row.reason,
    exitCode: row.exitCode,
    prOpened: null,
    qaPassed: null,
  };
  fs.appendFileSync(runFile, `${JSON.stringify(payload)}\n`);
}

/**
 * 加载业务审计行集：优先导出夹具；否则读 SQLite；NDJSON 由调用方另传给 F21。
 * 默认路径常量不含流水线 automation-runs.ndjson / *cron*.log。
 * 显式指定 --audit-export 时即使文件缺失也不回落生产库（按空行集）。
 *
 * @param {{
 *   auditExportFile?: string,
 *   auditDbFile?: string,
 *   exportExplicit?: boolean,
 *   dbExplicit?: boolean,
 * }} opts
 * @returns {object[]}
 */
export function loadAuditRows(opts = {}) {
  const exportFile = opts.auditExportFile || '';
  const dbFile = opts.auditDbFile || '';
  const exportExplicit = Boolean(opts.exportExplicit);
  const dbExplicit = Boolean(opts.dbExplicit);

  if (exportFile && fs.existsSync(exportFile)) {
    return parseAuditExportText(readTextOrEmpty(exportFile));
  }
  if (exportExplicit) {
    // 测码/调用方显式要导出夹具但文件不存在 → 空行集，禁止回落 DB
    return [];
  }
  if (dbFile && fs.existsSync(dbFile)) {
    return loadAuditRowsFromSqlite(dbFile);
  }
  if (dbExplicit) return [];
  return [];
}

/**
 * 串联 F21→F22 的可测入口。
 * @param {{
 *   dryRun?: boolean,
 *   root?: string,
 *   auditExportFile?: string,
 *   auditDbFile?: string,
 *   auditNdjsonFile?: string,
 *   backlogFile?: string,
 *   snapshotFile?: string,
 *   today?: string,
 *   record?: boolean,
 *   runFile?: string,
 *   rankFn?: typeof rankAuditReasons,
 *   applyFn?: typeof applyAuditProposals,
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
export function runAuditRank(opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const root = opts.root
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const auditExportFile = opts.auditExportFile
    || path.join(root, DEFAULT_AUDIT_EXPORT_REL);
  const auditDbFile = opts.auditDbFile
    || path.join(root, DEFAULT_AUDIT_DB_REL);
  const auditNdjsonFile = opts.auditNdjsonFile
    || path.join(root, DEFAULT_AUDIT_NDJSON_REL);
  const backlogFile = opts.backlogFile
    || path.join(root, DEFAULT_BACKLOG_REL);
  const snapshotFile = opts.snapshotFile
    || path.join(root, DEFAULT_SNAPSHOT_REL);
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const shouldRecord = opts.record !== false;
  const runFile = opts.runFile
    || process.env.AUTOMATION_RUN_FILE
    || path.join(root, 'logs', 'automation-runs.ndjson');
  const rankFn = opts.rankFn || rankAuditReasons;
  const applyFn = opts.applyFn || applyAuditProposals;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;

  /** @type {string[]} */
  const callOrder = [];

  // 显式传入 auditExportFile / auditDbFile 时禁止静默回落生产路径
  const auditRows = loadAuditRows({
    auditExportFile,
    auditDbFile,
    exportExplicit: Boolean(opts.auditExportFile),
    dbExplicit: Boolean(opts.auditDbFile) && !opts.auditExportFile,
  });
  const ndjsonAuditText = readTextOrEmpty(auditNdjsonFile);
  const previousSnapshot = loadSnapshot(snapshotFile);

  callOrder.push('rank');
  const proposals = rankFn({
    auditRows,
    ndjsonAuditText,
    previousSnapshot,
  });

  if (dryRun) {
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
    backlogMarkdown: beforeMd,
    today,
  });

  if (result.markdown !== beforeMd) {
    fs.mkdirSync(path.dirname(backlogFile), { recursive: true });
    fs.writeFileSync(backlogFile, result.markdown);
    stdout.write(`已写入 backlog（action=${result.action}）\n`);
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
  const result = runAuditRank({
    dryRun: parsed.dryRun,
    root,
    auditExportFile: parsed.auditExport || undefined,
    auditDbFile: parsed.auditDb || undefined,
    auditNdjsonFile: parsed.auditNdjson || undefined,
    backlogFile: parsed.backlog || undefined,
    snapshotFile: parsed.snapshot || undefined,
    today: parsed.today || undefined,
    record: !parsed.noRecord,
  });
  return result.exitCode;
}

if (process.argv[1] && process.argv[1].endsWith('audit-reason-cli.js')) {
  try {
    const code = main();
    process.exitCode = code;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
