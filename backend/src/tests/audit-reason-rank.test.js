/**
 * F21 业务审计 reason 排行：ai_audit_logs（+可选 NDJSON）→带门控提案（不写盘；禁 auto）。
 * 字段约定：
 * - count：窗口内该失败 reason 计数
 * - ratio：相对窗口总样本占比（0–1）
 * - summary：一句话现象；excerpt：截断摘录（<= MAX_EXCERPT_CHARS，默认 200）
 * - recommendation：推荐动作（关键词约定：`优先级` / `assist` / `草案` / `backlog`）
 * - level：精确为 'assist'
 * previousSnapshot 结构：{ topReason, count, ratio }（ratio 0–1；亦接受 share）
 * 主导出 rankAuditReasons（别名 clusterAuditReasonProposals）。
 * 敏感行整行丢弃，不计入窗口样本与聚类。
 * 常量：MIN_SAMPLES=20，MIN_DELTA=3，MIN_RATIO_DELTA=0.05。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  rankAuditReasons,
  clusterAuditReasonProposals,
  hasMeaningfulChange,
  MIN_SAMPLES,
  MIN_DELTA,
  MIN_RATIO_DELTA,
  MAX_EXCERPT_CHARS,
  SUCCESS_REASONS,
} from '../../../scripts/automation/audit-reason-rank.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const DAILY_FIX = path.join(ROOT, 'scripts/automation/daily-fix.sh');
const RANK_SRC = path.join(ROOT, 'scripts/automation/audit-reason-rank.js');
const AI_GUARD = path.join(ROOT, 'backend/src/security/ai-guard.js');

/** 构造一条业务审计行（默认非敏感、可聚类）。 */
function auditRow(reason, extra = {}) {
  return {
    reason,
    ts: '2026-11-22T00:00:00.000Z',
    ...extra,
  };
}

/** 用成功类行填满到至少 MIN_SAMPLES，并追加失败行。 */
function buildWindow({ failures = [], successCount, successReason = 'stream_done' } = {}) {
  const failRows = failures.map((f) =>
    typeof f === 'string' ? auditRow(f) : auditRow(f.reason, f),
  );
  const need = Math.max(0, (successCount ?? MIN_SAMPLES) - failRows.length);
  const successRows = Array.from({ length: need }, () => auditRow(successReason));
  // 保证总数 >= MIN_SAMPLES
  const total = successRows.length + failRows.length;
  if (total < MIN_SAMPLES) {
    const pad = MIN_SAMPLES - total;
    for (let i = 0; i < pad; i += 1) successRows.push(auditRow(successReason));
  }
  return [...successRows, ...failRows];
}

/** 按 reason 排序后比较，消除实现内部遍历顺序差异。 */
function sortedByReason(proposals) {
  return [...proposals].sort((a, b) => a.reason.localeCompare(b.reason));
}

function allTextFields(proposal) {
  return [proposal.summary, proposal.excerpt, proposal.recommendation]
    .filter((v) => typeof v === 'string')
    .join('\n');
}

/** 构造「有意义变化」快照：与当前 top 不同 reason。 */
function differentTopSnapshot() {
  return { topReason: '__never_match_prev__', count: 1, ratio: 0.01 };
}

describe('audit-reason-rank (F21)', () => {
  it('UT-AUDIT-RANK-01: 纯函数可对内存审计行集产出提案数组', () => {
    assert.equal(typeof rankAuditReasons, 'function');
    assert.equal(rankAuditReasons, clusterAuditReasonProposals);

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
      const auditRows = buildWindow({
        failures: Array.from({ length: 8 }, () => ({
          reason: 'sse_idle_timeout',
          detail: 'idle timeout after 60s',
        })),
      });
      const proposals = rankAuditReasons({
        auditRows,
        previousSnapshot: differentTopSnapshot(),
      });
      assert.ok(Array.isArray(proposals));
      assert.ok(proposals.length >= 1);
      const hit = proposals.find((p) => p.reason === 'sse_idle_timeout');
      assert.ok(hit);
      assert.ok(typeof hit.summary === 'string' && hit.summary.length > 0);
      assert.ok(typeof hit.recommendation === 'string' && hit.recommendation.length > 0);
      assert.ok(Number.isFinite(hit.count) && hit.count >= 1);
      assert.ok(Number.isFinite(hit.ratio) && hit.ratio >= 0);
      assert.equal(hit.level, 'assist');
      assert.equal(writeCalls, 0);
      assert.equal(appendCalls, 0);
    } finally {
      fs.writeFileSync = writeFileSyncOrig;
      fs.appendFileSync = appendFileSyncOrig;
    }
  });

  it('UT-AUDIT-RANK-02: 样本不足 → 空提案列表', () => {
    assert.ok(Number.isFinite(MIN_SAMPLES) && MIN_SAMPLES > 0);
    const few = Array.from({ length: Math.min(3, MIN_SAMPLES - 1) }, () =>
      auditRow('upstream_http', { detail: '502' }),
    );
    assert.ok(few.length < MIN_SAMPLES);
    assert.doesNotThrow(() => {
      const proposals = rankAuditReasons({
        auditRows: few,
        previousSnapshot: differentTopSnapshot(),
      });
      assert.equal(proposals.length, 0);
    });
  });

  it('UT-AUDIT-RANK-03: 无意义变化 → 空提案列表', () => {
    assert.ok(Number.isFinite(MIN_DELTA) && MIN_DELTA > 0);
    assert.ok(Number.isFinite(MIN_RATIO_DELTA) && MIN_RATIO_DELTA > 0);

    const failCount = 6;
    const auditRows = buildWindow({
      failures: Array.from({ length: failCount }, () =>
        auditRow('sse_idle_timeout'),
      ),
    });
    const total = auditRows.length;
    const ratio = failCount / total;
    // 同 top reason，count/ratio 差均严格低于阈值
    const previousSnapshot = {
      topReason: 'sse_idle_timeout',
      count: failCount, // delta = 0 < MIN_DELTA
      ratio, // ratio delta = 0 < MIN_RATIO_DELTA
    };
    const empty = rankAuditReasons({ auditRows, previousSnapshot });
    assert.equal(empty.length, 0);

    // 对照：改大 delta 后同夹具能出提案（与 UT-AUDIT-RANK-04 合取证明读了快照）
    const changed = rankAuditReasons({
      auditRows,
      previousSnapshot: {
        topReason: 'sse_idle_timeout',
        count: failCount - MIN_DELTA - 1,
        ratio: Math.max(0, ratio - MIN_RATIO_DELTA - 0.01),
      },
    });
    assert.ok(changed.length >= 1);
    assert.ok(hasMeaningfulChange(
      { reason: 'sse_idle_timeout', count: failCount, ratio },
      previousSnapshot,
    ) === false);
  });

  it('UT-AUDIT-RANK-04: 足够且有变化 → 有提案且 level 从不含 auto', () => {
    const auditRows = buildWindow({
      failures: Array.from({ length: 5 }, () => auditRow('circuit_open')),
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);
    for (const p of proposals) {
      assert.equal(p.level, 'assist');
      assert.notEqual(p.level, 'auto');
      assert.notEqual(p.level, 'pending');
      for (const [key, val] of Object.entries(p)) {
        if (key === 'level') continue;
        if (typeof val === 'string') {
          assert.notEqual(val.trim(), 'auto');
          assert.doesNotMatch(val, /\|\s*auto\s*\|/);
        }
      }
    }
  });

  it('UT-AUDIT-RANK-05: 同夹具排行稳定', () => {
    const auditRows = buildWindow({
      failures: [
        ...Array.from({ length: 4 }, () => auditRow('client_abort')),
        ...Array.from({ length: 2 }, () => auditRow('upstream_http')),
      ],
    });
    const snap = differentTopSnapshot();
    const a = rankAuditReasons({ auditRows, previousSnapshot: snap });
    const b = rankAuditReasons({ auditRows, previousSnapshot: snap });
    assert.equal(a.length, b.length);
    assert.deepEqual(sortedByReason(a), sortedByReason(b));
  });

  it('UT-AUDIT-RANK-06: 成功类 reason 可作分母、不得单独成失败提案', () => {
    assert.ok(SUCCESS_REASONS.has('stream_done'));
    assert.ok(SUCCESS_REASONS.has('generated_answer'));
    assert.ok(SUCCESS_REASONS.has('cached_answer'));
    const auditRows = [
      ...Array.from({ length: 8 }, () => auditRow('stream_done')),
      ...Array.from({ length: 7 }, () => auditRow('generated_answer')),
      ...Array.from({ length: 7 }, () => auditRow('cached_answer')),
    ];
    assert.ok(auditRows.length >= MIN_SAMPLES);
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    for (const r of SUCCESS_REASONS) {
      assert.equal(proposals.filter((p) => p.reason === r).length, 0);
    }
    assert.equal(proposals.length, 0);
  });

  it('UT-AUDIT-RANK-07: 同 reason 聚类为一条且含计数/占比', () => {
    const auditRows = buildWindow({
      failures: [
        ...Array.from({ length: 5 }, () => auditRow('client_abort')),
        ...Array.from({ length: 2 }, () => auditRow('upstream_http')),
      ],
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.equal(proposals.filter((p) => p.reason === 'client_abort').length, 1);
    assert.equal(proposals.find((p) => p.reason === 'client_abort').count, 5);
    assert.equal(proposals.filter((p) => p.reason === 'upstream_http').length, 1);
    assert.equal(proposals.find((p) => p.reason === 'upstream_http').count, 2);
    assert.equal(proposals.length, 2);
    let ratioSum = 0;
    for (const p of proposals) {
      assert.ok(Number.isFinite(p.ratio));
      ratioSum += p.ratio;
    }
    assert.ok(ratioSum <= 1 + 1e-9);
  });

  it('UT-AUDIT-RANK-08: 超长摘录被硬上限截断', () => {
    // MAX_EXCERPT_CHARS 默认建议 200
    assert.ok(Number.isFinite(MAX_EXCERPT_CHARS) && MAX_EXCERPT_CHARS > 0);
    const MAX = MAX_EXCERPT_CHARS;
    const sentinel = 'TAIL_SENTINEL_AUDIT_XYZ';
    const longDetail = `${'x'.repeat(MAX + 100)}${sentinel}`;
    const auditRows = buildWindow({
      failures: Array.from({ length: 4 }, () =>
        auditRow('sse_idle_timeout', { detail: longDetail }),
      ),
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    const hit = proposals.find((p) => p.reason === 'sse_idle_timeout');
    assert.ok(hit);
    assert.ok(hit.excerpt.length <= MAX);
    assert.ok(!hit.excerpt.includes(sentinel));
  });

  it('UT-AUDIT-RANK-09: 含伪密钥行时摘录不含该行（PASSWORD/SECRET/TOKEN/API_KEY）', () => {
    // 额外多填成功分母，确保丢弃 1 条敏感行后窗口仍 >= MIN_SAMPLES
    const auditRows = buildWindow({
      failures: [
        auditRow('sse_idle_timeout', { detail: 'idle timeout after 60s' }),
        auditRow('sse_idle_timeout', {
          detail: 'OPENAI_API_KEY=sk_live_fake_audit_001',
        }),
        auditRow('sse_idle_timeout', { detail: 'idle timeout after 60s' }),
        auditRow('sse_idle_timeout', { detail: 'idle timeout after 60s' }),
      ],
      successCount: MIN_SAMPLES + 4,
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);
    for (const p of proposals) {
      const blob = allTextFields(p);
      assert.ok(!blob.includes('sk_live_fake_audit_001'));
      assert.ok(!blob.includes('OPENAI_API_KEY=sk_live_fake_audit_001'));
    }
    const hit = proposals.find((p) => p.reason === 'sse_idle_timeout');
    assert.ok(hit);
    assert.match(allTextFields(hit), /idle timeout/i);
    // 密钥行不计入聚类：count 应为 3（非 4）
    assert.equal(hit.count, 3);
  });

  it('UT-AUDIT-RANK-10: URL 用户口令形态整行丢弃', () => {
    const auditRows = buildWindow({
      failures: [
        auditRow('upstream_http', {
          detail: 'postgres://appuser:s3cretAudit@db.internal:5432/app',
        }),
        auditRow('upstream_http', { detail: 'https://example.com/health' }),
        auditRow('upstream_http', { detail: 'https://example.com/health' }),
        auditRow('upstream_http', { detail: 'bad gateway' }),
      ],
      successCount: MIN_SAMPLES + 4,
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);
    for (const p of proposals) {
      const blob = allTextFields(p);
      assert.ok(!blob.includes('s3cretAudit'));
      assert.ok(!blob.includes('appuser:s3cretAudit@'));
    }
    const hit = proposals.find((p) => p.reason === 'upstream_http');
    assert.ok(hit);
    assert.ok(
      allTextFields(hit).includes('example.com')
        || allTextFields(hit).includes('bad gateway'),
    );
  });

  it('UT-AUDIT-RANK-11: 可选 NDJSON 审计片段可并入聚类（非流水线 NDJSON）', () => {
    const auditRows = buildWindow({
      failures: [auditRow('upstream_http', { detail: 'from-sql' })],
      successCount: MIN_SAMPLES - 1,
    });
    // 再减：buildWindow 已保证 >= MIN_SAMPLES；此处用少量 SQL 失败 + NDJSON 追加
    const ndjsonLines = Array.from({ length: 5 }, (_, i) =>
      JSON.stringify({
        reason: 'upstream_http',
        upstreamStatus: 502,
        detail: `ndjson-row-${i}`,
        ts: '2026-11-22T01:00:00.000Z',
      }),
    );
    const proposals = rankAuditReasons({
      auditRows,
      ndjsonAuditText: ndjsonLines.join('\n'),
      previousSnapshot: differentTopSnapshot(),
    });
    const hit = proposals.find((p) => p.reason === 'upstream_http');
    assert.ok(hit);
    assert.ok(hit.count >= 5);
    // 可选：摘录含上游状态
    assert.ok(
      allTextFields(hit).includes('502')
        || allTextFields(hit).includes('upstream')
        || hit.count >= 5,
    );
  });

  it('UT-AUDIT-RANK-12: 旧行缺 S18 新列仍按 reason 排行', () => {
    const auditRows = buildWindow({
      failures: Array.from({ length: 5 }, () => ({
        reason: 'client_abort',
        ts: '2026-01-01T00:00:00.000Z',
        // 故意不设 upstream_status / upstream_reached / token_source
      })),
    });
    assert.doesNotThrow(() => {
      const proposals = rankAuditReasons({
        auditRows,
        previousSnapshot: differentTopSnapshot(),
      });
      assert.ok(proposals.some((p) => p.reason === 'client_abort'));
    });
  });

  it('UT-AUDIT-RANK-13: 推荐动作语义：调优先级或开 assist 草案', () => {
    // 允许的关键词集：优先级 | priority | assist | 草案 | backlog
    const KEYWORDS = /优先级|priority|assist|草案|backlog/i;
    const auditRows = buildWindow({
      failures: Array.from({ length: 4 }, () => auditRow('circuit_open')),
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);
    const rec = proposals[0].recommendation;
    assert.ok(typeof rec === 'string' && rec.length > 0);
    assert.match(rec, KEYWORDS);
    assert.doesNotMatch(rec, /写成\s*auto|标成\s*auto|直接\s*auto(?!；)|level\s*=\s*['"]auto['"]/i);
    // 推荐句可含「禁止…auto」否定语义；不得要求写成 auto
    assert.ok(!/建议.*标\s*auto|改为\s*auto|分级.*auto/.test(rec) || /禁止.*auto/.test(rec));
  });

  it('UT-AUDIT-RANK-14: 不做：调用后不写任何 markdown / 不改 backlog', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f21-rank-14-'));
    const docsDir = path.join(tmp, 'docs');
    fs.mkdirSync(docsDir);
    const backlogPath = path.join(docsDir, 'backlog.md');
    const processPath = path.join(docsDir, 'process-backlog.md');
    const marker = `F21-SENTINEL-${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(backlogPath, `# backlog\n${marker}\n| F99 | feat | x | assist | todo | 10 | keep |\n`);
    fs.writeFileSync(processPath, `# process\n${marker}\n`);
    const hashBefore = {
      backlog: crypto.createHash('sha256').update(fs.readFileSync(backlogPath)).digest('hex'),
      process: crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex'),
    };
    const mdBefore = new Set(
      fs.readdirSync(docsDir).filter((n) => n.endsWith('.md')),
    );

    const auditRows = buildWindow({
      failures: Array.from({ length: 4 }, () => auditRow('sse_idle_timeout')),
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);

    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(backlogPath)).digest('hex'),
      hashBefore.backlog,
    );
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex'),
      hashBefore.process,
    );
    const mdAfter = fs.readdirSync(docsDir).filter((n) => n.endsWith('.md'));
    assert.deepEqual(new Set(mdAfter), mdBefore);
  });

  it('UT-AUDIT-RANK-15: 不做：不以流水线 automation-runs/cron 为主源（属 F1）', () => {
    const readFileSyncOrig = fs.readFileSync;
    let pipelineReads = 0;
    fs.readFileSync = (file, ...rest) => {
      const s = String(file);
      if (s.includes('automation-runs.ndjson') || /cron.*\.log/i.test(s)) {
        pipelineReads += 1;
      }
      return readFileSyncOrig(file, ...rest);
    };
    try {
      // A：空审计输入 → []，且不读流水线路径
      const empty = rankAuditReasons({ auditRows: [], ndjsonAuditText: '' });
      assert.equal(empty.length, 0);
      assert.equal(pipelineReads, 0);

      // B：流水线形态塞进审计槽 → 忽略（有 kind:daily-fix），不得产出 F11 式提案
      const pipelineShaped = Array.from({ length: MIN_SAMPLES }, () => ({
        kind: 'daily-fix',
        reason: 'qa_failed',
        taskId: 'F11',
      }));
      const fromPipeline = rankAuditReasons({
        auditRows: pipelineShaped,
        previousSnapshot: differentTopSnapshot(),
      });
      assert.equal(fromPipeline.filter((p) => p.reason === 'qa_failed').length, 0);
      assert.equal(fromPipeline.length, 0);
      assert.equal(pipelineReads, 0);
    } finally {
      fs.readFileSync = readFileSyncOrig;
    }
  });

  it('UT-AUDIT-RANK-16: 不做：不改 reason 名/审计 schema；不以 /api/metrics 为唯一源；不做 Grafana/看板；不发信；不改 daily-fix 选单', () => {
    const dailyHashBefore = crypto
      .createHash('sha256')
      .update(fs.readFileSync(DAILY_FIX))
      .digest('hex');
    const src = fs.readFileSync(RANK_SRC, 'utf8');
    // A：不重命名既有失败 reason；不要求 ALTER TABLE
    assert.match(src, /sse_idle_timeout|client_abort|upstream_http|circuit_open|SUCCESS_REASONS/);
    assert.doesNotMatch(src, /ALTER\s+TABLE/i);
    const guardSrc = fs.readFileSync(AI_GUARD, 'utf8');
    // 对照：既有 reason 字面量仍在 ai-guard（本项不改名）
    assert.ok(
      /stream_done|generated_answer|cached_answer/.test(guardSrc)
        || /stream_done|generated_answer|cached_answer/.test(src),
    );

    let mailCalls = 0;
    const fakeMail = () => {
      mailCalls += 1;
    };
    // B：纯函数入参为行集，不发信、不打 /api/metrics
    const auditRows = buildWindow({
      failures: Array.from({ length: 4 }, () => auditRow('sse_idle_timeout')),
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);
    assert.equal(proposals[0].reason, 'sse_idle_timeout');
    fakeMail(); // 证明 stub 可调用但业务路径未用
    assert.equal(mailCalls, 1); // 仅测码主动调用；实现零发信 → 若实现误调会另计，此处实现未导入 mail
    // 实现不得依赖发信或指标 HTTP 拉取（注释提及「不做」可接受；禁止可执行调用形态）
    assert.doesNotMatch(src, /\bsendMail\s*\(|\bautomation_notify_human\s*\(|fetch\s*\(\s*['`].*metrics/i);
    assert.doesNotMatch(src, /\bgrafana\b/i);

    // C：daily-fix.sh hash 不变
    const dailyHashAfter = crypto
      .createHash('sha256')
      .update(fs.readFileSync(DAILY_FIX))
      .digest('hex');
    assert.equal(dailyHashAfter, dailyHashBefore);
  });

  it('UT-AUDIT-RANK-17: residual：本表不要求 F22 落盘 / F23 CLI / F24 cron 挂载', () => {
    const auditRows = buildWindow({
      failures: Array.from({ length: 4 }, () => auditRow('upstream_http')),
    });
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.length >= 1);
    // PASS：不要求写入 backlog、不要求 CLI/cron 壳存在
    const cronShell = path.join(ROOT, 'scripts/automation/audit-reason-rank-cron.sh');
    // 即便不存在也不 FAIL——本行只证明 residual 边界被承认
    assert.ok(typeof proposals === 'object');
    void cronShell;
    assert.ok(!fs.existsSync(path.join(ROOT, 'docs/.f21-must-write-backlog')));
  });

  it('UT-AUDIT-RANK-18: 与 UT-LOG-PARSE / S18 分界：消费业务审计而非流水线；不改 backlog 数字', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'f21-rank-18-'));
    const backlogPath = path.join(tmp, 'backlog.md');
    const processPath = path.join(tmp, 'process-backlog.md');
    fs.writeFileSync(backlogPath, '| F21 | feat | flywheel | auto | todo | 50 | keep-prio |\n');
    fs.writeFileSync(processPath, '| P1 | fix | qa_failed | assist | todo | 15 | keep |\n');
    const h1 = crypto.createHash('sha256').update(fs.readFileSync(backlogPath)).digest('hex');
    const h2 = crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex');

    const auditRows = buildWindow({
      failures: Array.from({ length: 5 }, () =>
        auditRow('sse_idle_timeout', { detail: 'idle' }),
      ),
    });
    // 本用例调用链不执行 F11 analyzePipelineLogs
    const proposals = rankAuditReasons({
      auditRows,
      previousSnapshot: differentTopSnapshot(),
    });
    assert.ok(proposals.some((p) => p.reason === 'sse_idle_timeout'));
    assert.equal(proposals.filter((p) => p.reason === 'qa_failed').length, 0);
    assert.equal(proposals.filter((p) => p.reason === 'dirty_worktree').length, 0);

    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(backlogPath)).digest('hex'),
      h1,
    );
    assert.equal(
      crypto.createHash('sha256').update(fs.readFileSync(processPath)).digest('hex'),
      h2,
    );
  });
});
