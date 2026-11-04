/**
 * E14：qa-report 采集前后端行覆盖率并写入报告、不因比例失败。
 * 用例 ID 与 docs/test_cases.md §2.40 对齐。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const PROJECT_ROOT = path.resolve(BACKEND_ROOT, '..');
const QA_REPORT_SH = path.join(PROJECT_ROOT, 'scripts', 'qa-report.sh');
const FORMAT_QA_REPORT_JS = path.join(PROJECT_ROOT, 'scripts', 'format-qa-report.js');
const BACKEND_PACKAGE_JSON = path.join(BACKEND_ROOT, 'package.json');
const FRONTEND_PACKAGE_JSON = path.join(PROJECT_ROOT, 'frontend', 'package.json');
const FRONTEND_VITEST_CONFIG = path.join(PROJECT_ROOT, 'frontend', 'vitest.config.ts');

/**
 * 构造通过态 payload；可覆盖覆盖率字段。
 * @param {object} [overrides]
 */
function basePassingPayload(overrides = {}) {
  return {
    backendCode: 0,
    backendOutput: '# tests 1\n# pass 1\n# fail 0\n# duration_ms 10.0\n',
    frontendCode: 0,
    frontendOutput: 'Tests 4 passed\n1 passed (1.0s)\n',
    dbCode: 0,
    dbOutput: 'QA_DB_VERIFY_SKIPPED\n',
    backendLintCode: 0,
    backendLintOutput: '✖ 0 problems (0 errors, 0 warnings)\n',
    backendCoverageCode: 0,
    backendCoverageOutput:
      '# start of coverage report\n# all files                   |  70.61 |    76.17 |   77.10 | \n# end of coverage report\n',
    frontendCoverageCode: 0,
    frontendCoverageOutput:
      '=============================== Coverage summary ===============================\nLines        : 67.54% ( 460/681 )\n================================================================================\n',
    ...overrides,
  };
}

/**
 * 写入临时 results.json 并调用 format-qa-report.js。
 * 报告经 QA_REPORT_PATH 隔离到临时目录，避免与其它套件并行争用 docs/qa_report.md。
 * @param {object} payload
 * @param {{ QA_GATE?: string }} [envExtra]
 */
function runFormatQaReport(payload, envExtra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-cov-gate-'));
  const jsonPath = path.join(tmpDir, 'results.json');
  const reportPath = path.join(tmpDir, 'qa_report.md');
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
  try {
    const run = spawnSync(process.execPath, [FORMAT_QA_REPORT_JS, jsonPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...envExtra, QA_REPORT_PATH: reportPath },
    });
    const report = fs.existsSync(reportPath) ? fs.readFileSync(reportPath, 'utf8') : '';
    return {
      status: run.status,
      stdout: run.stdout || '',
      stderr: run.stderr || '',
      combined: `${run.stdout || ''}\n${run.stderr || ''}`,
      report,
      reportPath,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * 去掉以 # 开头的整行注释，便于断言「非死代码」。
 * @param {string} source
 */
function stripHashComments(source) {
  return source
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

describe('2.40 qa-report 采集前后端行覆盖率（E14）', () => {
  it('UT-QA-COV-01: qa-report.sh 在报告链路中执行后端 npm run test:coverage', () => {
    assert.ok(fs.existsSync(QA_REPORT_SH), 'scripts/qa-report.sh 必须存在');
    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);

    const covCallIdx = activeSh.search(
      /\(cd\s+"\$PROJECT_ROOT\/backend"\s+&&\s+npm\s+run\s+test:coverage\)/,
    );
    assert.ok(covCallIdx >= 0, '须存在 (cd "$PROJECT_ROOT/backend" && npm run test:coverage)');
    assert.match(activeSh, /BE_COV_CODE=\$\?|backendCoverageCode/, '须捕获后端覆盖率退出码');

    const formatIdx = activeSh.indexOf('format-qa-report.js');
    assert.ok(formatIdx > covCallIdx, '后端覆盖率调用须在 format-qa-report.js 之前');

    const payloadBlock = activeSh.slice(
      activeSh.indexOf('payload'),
      activeSh.indexOf('fs.writeFileSync'),
    );
    assert.match(payloadBlock, /backendCoverageCode/, 'results.json 须含 backendCoverageCode');
    assert.match(payloadBlock, /backendCoverageOutput/, 'results.json 须含 backendCoverageOutput');

    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');
    assert.match(formatSrc, /backendCoverageCode/, 'format-qa-report.js 须读取 backendCoverageCode');
    assert.match(
      formatSrc,
      /backendCoverageOutput/,
      'format-qa-report.js 须读取 backendCoverageOutput',
    );
  });

  it('UT-QA-COV-02: 后端 test:coverage 口径：src/** 含、src/tests/** 排除', () => {
    const pkg = JSON.parse(fs.readFileSync(BACKEND_PACKAGE_JSON, 'utf8'));
    const script = pkg.scripts?.['test:coverage'] || '';
    assert.match(script, /--test-coverage-include=src\/\*\*/, '须 include src/**');
    assert.match(script, /--test-coverage-exclude=src\/tests\/\*\*/, '须 exclude src/tests/**');
    assert.match(script, /--experimental-test-coverage/, '须启用 experimental-test-coverage');
  });

  it('UT-QA-COV-03: qa-report.sh 执行前端 Vitest 行覆盖率采集', () => {
    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);

    const feCovIdx = activeSh.search(
      /\(cd\s+"\$PROJECT_ROOT\/frontend"\s+&&\s+npm\s+run\s+test:coverage\)/,
    );
    assert.ok(feCovIdx >= 0, '须存在 frontend npm run test:coverage');

    const formatIdx = activeSh.indexOf('format-qa-report.js');
    assert.ok(formatIdx > feCovIdx, '前端覆盖率调用须在 format-qa-report.js 之前');

    // 不得仅复用 npm test 冒充覆盖率：须有独立 test:coverage 调用
    const feTestIdx = activeSh.search(
      /\(cd\s+"\$PROJECT_ROOT\/frontend"\s+&&\s+npm\s+test\)/,
    );
    assert.ok(feTestIdx >= 0, '既有 frontend npm test 仍须保留');
    assert.notEqual(feTestIdx, feCovIdx, '覆盖率不得与 npm test 为同一调用');

    const payloadBlock = activeSh.slice(
      activeSh.indexOf('payload'),
      activeSh.indexOf('fs.writeFileSync'),
    );
    assert.match(payloadBlock, /frontendCoverageCode/, 'results.json 须含 frontendCoverageCode');
    assert.match(payloadBlock, /frontendCoverageOutput/, 'results.json 须含 frontendCoverageOutput');

    const fePkg = JSON.parse(fs.readFileSync(FRONTEND_PACKAGE_JSON, 'utf8'));
    const covScript = fePkg.scripts?.['test:coverage'] || '';
    assert.match(covScript, /vitest.*--coverage|coverage/, 'frontend test:coverage 须启用 coverage');
    assert.equal(
      /^\s*vitest\s+run\s+&&\s+playwright/.test(covScript),
      false,
      'test:coverage 不得等于含 Playwright 的 npm test',
    );
  });

  it('UT-QA-COV-04: 前端覆盖范围只统计 frontend/src，不含 e2e', () => {
    const vitestSrc = fs.readFileSync(FRONTEND_VITEST_CONFIG, 'utf8');
    assert.match(vitestSrc, /coverage\s*:/, 'vitest.config 须含 coverage 配置');
    assert.match(
      vitestSrc,
      /include\s*:\s*\[[^\]]*src\/\*\*/,
      'coverage.include 须限定 src/**',
    );
    // e2e 出现在 exclude，或不在 include 内
    const includeHasE2e = /include\s*:\s*\[[^\]]*e2e/.test(vitestSrc);
    assert.equal(includeHasE2e, false, 'coverage.include 不得含 e2e');
    assert.match(
      vitestSrc,
      /exclude\s*:\s*\[[^\]]*e2e/,
      'coverage.exclude 须含 e2e（或等价排除）',
    );
  });

  it('UT-QA-COV-05: 报告写入后端与前端两个可解析的行覆盖率百分比', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        backendLineCoveragePct: 42.5,
        frontendLineCoveragePct: 37,
        backendCoverageOutput: '',
        frontendCoverageOutput: '',
      }),
      { QA_GATE: '' },
    );
    assert.equal(result.status, 0, `期望退出 0，实际 ${result.status}\n${result.combined}`);

    assert.match(result.report, /行覆盖率|line|Lines/i, '报告须体现行覆盖率口径');
    assert.match(result.report, /后端[\s\S]{0,120}42\.5%/u, '须含可区分的后端百分比');
    assert.match(result.report, /前端[\s\S]{0,120}37%/u, '须含可区分的前端百分比');
  });

  it('UT-QA-COV-06: 行覆盖率低于 60% 时门禁仍为 0（不做 E15）', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        backendLineCoveragePct: 12.3,
        frontendLineCoveragePct: 5,
        backendCoverageOutput: '',
        frontendCoverageOutput: '',
      }),
      { QA_GATE: '' },
    );
    assert.equal(result.status, 0, `低比例不得拦截，实际 ${result.status}`);

    assert.match(result.report, /12\.3%/, '报告须写出后端低百分比');
    assert.match(result.report, /5%/, '报告须写出前端低百分比');
    // 覆盖率采集行应为 PASS，不得因比例 FAIL
    assert.match(result.report, /\*\*后端覆盖率采集\*\*.*✅ PASS/s);
    assert.match(result.report, /\*\*前端覆盖率采集\*\*.*✅ PASS/s);
  });

  it('UT-QA-COV-07: 行覆盖率高于门槛时门禁仍只由既有套件裁决', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        backendLineCoveragePct: 95,
        frontendLineCoveragePct: 88,
        backendCoverageOutput: '',
        frontendCoverageOutput: '',
      }),
      { QA_GATE: '' },
    );
    assert.equal(result.status, 0, `高比例仍只由既有套件裁决，实际 ${result.status}`);
  });

  it('UT-QA-COV-08: 后端覆盖率采集命令非 0 → 门禁失败', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        backendCoverageCode: 1,
        backendCoverageOutput: 'command not found: test:coverage\n',
        backendLineCoveragePct: undefined,
      }),
      { QA_GATE: '' },
    );
    assert.notEqual(result.status, 0, '后端覆盖率采集失败须非 0');
    assert.match(
      result.combined,
      /覆盖率采集|质量门禁未通过/i,
      '输出须可区分采集失败',
    );

    assert.match(result.report, /后端覆盖率采集失败|采集失败/u, '报告须标明采集失败而非比例过低');
  });

  it('UT-QA-COV-09: 前端覆盖率采集命令非 0 → 门禁失败', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        frontendCoverageCode: 1,
        frontendCoverageOutput: 'Missing @vitest/coverage-v8\n',
        frontendLineCoveragePct: undefined,
      }),
      { QA_GATE: '' },
    );
    assert.notEqual(result.status, 0, '前端覆盖率采集失败须非 0');

    assert.match(result.report, /前端覆盖率采集失败|采集失败/u, '报告须标明前端采集失败');
  });

  it('UT-QA-COV-10: 覆盖率输出缺失百分比但命令 exit 0 时的契约', () => {
    // 选定分支 A：视为采集失败 → 门禁非 0，报告注明无法解析 / 未解析
    const result = runFormatQaReport(
      basePassingPayload({
        backendCoverageCode: 0,
        backendCoverageOutput: '(empty coverage, no percent)\n',
        frontendCoverageCode: 0,
        frontendCoverageOutput:
          'Lines        : 67.54% ( 460/681 )\n',
        // 清除预解析字段，迫使走输出解析
        backendLineCoveragePct: undefined,
        frontendLineCoveragePct: undefined,
      }),
      { QA_GATE: '' },
    );
    assert.notEqual(result.status, 0, '分支 A：无法解析百分比须门禁非 0');

    assert.match(result.report, /未解析|无法解析/u, '报告须注明无法解析');
    assert.equal(/伪造|按比例拦截/.test(result.report), false);
  });

  it('UT-QA-COV-11: 不做：不因比例拦截（E15/E16 分界）', () => {
    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');

    // 不得存在「历史行覆盖率 < 60 → 非 0」或「新增 < 80 → 非 0」的必经裁决
    assert.equal(
      /(?:linePct|LineCoveragePct)\s*[<>=]=?\s*(?:60|80)/.test(formatSrc),
      false,
      'format-qa-report.js 不得按 60%/80% 比例比较后裁决',
    );
    // 低比例回归（与 UT-QA-COV-06 合取）
    const low = runFormatQaReport(
      basePassingPayload({
        backendLineCoveragePct: 1,
        frontendLineCoveragePct: 2,
        backendCoverageOutput: '',
        frontendCoverageOutput: '',
      }),
      { QA_GATE: '' },
    );
    assert.equal(low.status, 0, 'E14 不做比例拦截');
  });

  it('UT-QA-COV-12: 不做：不把 E2E 算进行覆盖率', () => {
    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);
    // 前端覆盖率命令是 test:coverage，不是 playwright
    const covLines = activeSh
      .split('\n')
      .filter((line) => /test:coverage/.test(line) && /frontend/.test(line));
    assert.ok(covLines.length >= 1, '须有 frontend test:coverage');
    for (const line of covLines) {
      assert.equal(/playwright/i.test(line), false, `覆盖率行不得含 playwright：${line}`);
    }
    // 不要求先跑 E2E 才写出前端行覆盖率：format 只读 frontendCoverageOutput
    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');
    assert.equal(
      /playwright.*line|line-rate.*playwright/i.test(formatSrc),
      false,
      '不得从 Playwright 报告解析行覆盖率',
    );
  });

  it('UT-QA-COV-13: 不做：不为凑比例改业务代码 / 缩小 include', () => {
    // 本用例只断言配置与约定一致，不修改 backend/src / frontend/src 业务文件
    const pkg = JSON.parse(fs.readFileSync(BACKEND_PACKAGE_JSON, 'utf8'));
    assert.match(pkg.scripts['test:coverage'], /include=src\/\*\*/);
    assert.match(pkg.scripts['test:coverage'], /exclude=src\/tests\/\*\*/);
    const vitestSrc = fs.readFileSync(FRONTEND_VITEST_CONFIG, 'utf8');
    assert.match(vitestSrc, /include\s*:\s*\[[^\]]*src\/\*\*/);
  });

  it('UT-QA-COV-14: residual：不提前实现 E15/E16 的 auto 阈值门禁', () => {
    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');
    // 不读取队列表改 auto；不以未加 60%/80% 阈值为 FAIL
    assert.equal(/docs\/backlog\.md/.test(formatSrc), false, '不得读 backlog 改分级');
    // 不得存在「linePct 与 60/80 比较」的必经裁决（文案提及 E15/E16 允许）
    assert.equal(
      /(?:linePct|LineCoveragePct)\s*[<>=]=?\s*(?:60|80)/.test(formatSrc),
      false,
      '不得对行覆盖率数值做 60/80 阈值比较',
    );
  });

  it('UT-QA-COV-15: 与 A82 lint 门禁共存：覆盖率采集不取代 lint', () => {
    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);
    assert.match(
      activeSh,
      /\(cd\s+"\$PROJECT_ROOT\/backend"\s+&&\s+npm\s+run\s+lint\)/,
      'backend lint 调用仍须存在',
    );
    assert.match(activeSh, /npm\s+test/, '既有 npm test 门禁须保留');
    assert.match(activeSh, /test:coverage/, '覆盖率为新增采集步骤');
  });

  it('UT-QA-COV-16: 既有测试 FAIL 时门禁仍非 0（覆盖率数字不放行）', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        backendCode: 1,
        backendOutput: '# tests 1\n# pass 0\n# fail 1\n# duration_ms 5.0\nnot ok 1 - sample\n',
        backendLineCoveragePct: 99,
        frontendLineCoveragePct: 99,
        backendCoverageOutput: '',
        frontendCoverageOutput: '',
      }),
      { QA_GATE: '' },
    );
    assert.notEqual(result.status, 0, '高覆盖率不得掩盖 backend test FAIL');
  });
});
