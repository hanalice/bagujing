/**
 * A82 / P2-6：qa-report.sh 纳入 backend lint 门禁契约测试。
 * 用例 ID 与 docs/test_cases.md §2.16 对齐。
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

/**
 * 构造通过态的后端/前端/DB 输出片段，便于单独操控 lint 退出码。
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
    ...overrides,
  };
}

/**
 * 写入临时 results.json 并调用 format-qa-report.js，返回退出码与合并输出。
 * @param {object} payload
 * @param {{ QA_GATE?: string }} [envExtra]
 */
function runFormatQaReport(payload, envExtra = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-lint-gate-'));
  const jsonPath = path.join(tmpDir, 'results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8');
  try {
    const run = spawnSync(process.execPath, [FORMAT_QA_REPORT_JS, jsonPath], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...envExtra },
    });
    return {
      status: run.status,
      stdout: run.stdout || '',
      stderr: run.stderr || '',
      combined: `${run.stdout || ''}\n${run.stderr || ''}`,
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

describe('2.16 qa-report.sh 纳入 backend lint 门禁（A82 / P2-6）', () => {
  it('UT-QA-LINT-01: qa-report.sh 在门禁链路中执行 backend npm run lint', () => {
    assert.ok(fs.existsSync(QA_REPORT_SH), 'scripts/qa-report.sh 必须存在');
    assert.ok(fs.existsSync(FORMAT_QA_REPORT_JS), 'scripts/format-qa-report.js 必须存在');

    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);

    // 组装 JSON 之前必须调用 backend lint，并捕获退出码
    const lintCallIdx = activeSh.search(
      /\(cd\s+"\$PROJECT_ROOT\/backend"\s+&&\s+npm\s+run\s+lint\)/,
    );
    assert.ok(lintCallIdx >= 0, '须存在 (cd "$PROJECT_ROOT/backend" && npm run lint)');

    assert.match(activeSh, /BE_LINT_CODE=\$\?|LINT_CODE=\$\?/, '须捕获 lint 退出码');

    const formatIdx = activeSh.indexOf('format-qa-report.js');
    assert.ok(formatIdx > lintCallIdx, 'lint 调用须出现在 format-qa-report.js 之前');

    const payloadBlock = activeSh.slice(
      activeSh.indexOf('payload'),
      activeSh.indexOf('fs.writeFileSync'),
    );
    assert.match(
      payloadBlock,
      /backendLintCode|lintCode/,
      'results.json payload 须含 lint 退出码字段',
    );
    assert.match(
      payloadBlock,
      /backendLintOutput|lintOutput/,
      'results.json payload 须含 lint 输出字段',
    );

    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');
    assert.match(
      formatSrc,
      /backendLintCode|lintCode/,
      'format-qa-report.js 须读取与 shell 一致的 lint 退出码字段',
    );
    assert.match(
      formatSrc,
      /backendLintOutput|lintOutput/,
      'format-qa-report.js 须读取与 shell 一致的 lint 输出字段',
    );
  });

  it('UT-QA-LINT-02: lint 出现 error 时门禁非 0 退出', () => {
    const result = runFormatQaReport(
      basePassingPayload({
        backendLintCode: 1,
        backendLintOutput:
          'src/probe.js\n  1:1  error  "eslintProbeUndeclared" is not defined  no-undef\n\n✖ 1 problem (1 error, 0 warnings)\n',
      }),
      { QA_GATE: '' },
    );

    assert.notEqual(result.status, 0, `lint error 时门禁须非 0，实际 ${result.status}`);
    assert.match(
      result.combined,
      /质量门禁未通过|后端 lint|lint/i,
      '输出须可区分 lint 失败',
    );

    const reportPath = path.join(PROJECT_ROOT, 'docs', 'qa_report.md');
    assert.ok(fs.existsSync(reportPath), '应生成 qa_report.md');
    const report = fs.readFileSync(reportPath, 'utf8');
    assert.match(report, /后端 lint/, '报告须含后端 lint 套件名');
    assert.match(report, /FAIL|❌/, '报告须体现失败');
  });

  it('UT-QA-LINT-03: 仅 warning 不因 lint 拦截门禁', () => {
    const pkg = JSON.parse(fs.readFileSync(BACKEND_PACKAGE_JSON, 'utf8'));
    const lintScript = pkg.scripts?.lint || '';
    assert.equal(
      /--max-warnings\s+0/.test(lintScript),
      false,
      '不得把 scripts.lint 改为 --max-warnings 0',
    );

    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');
    assert.equal(
      /--max-warnings\s+0/.test(shSrc),
      false,
      'qa-report.sh 不得强制 --max-warnings 0',
    );
    // 禁止把 warning 映射为 FAIL 的显式逻辑
    assert.equal(
      /warningCount\s*>\s*0[\s\S]{0,80}status\s*=\s*['"]FAIL['"]/.test(formatSrc),
      false,
      'format-qa-report.js 不得仅因 warningCount>0 标 FAIL',
    );

    const result = runFormatQaReport(
      basePassingPayload({
        backendLintCode: 0,
        backendLintOutput: '✖ 2 problems (0 errors, 2 warnings)\n',
      }),
      { QA_GATE: '' },
    );

    assert.equal(result.status, 0, `仅 warning 时门禁须为 0，实际 ${result.status}\n${result.combined}`);

    const report = fs.readFileSync(path.join(PROJECT_ROOT, 'docs', 'qa_report.md'), 'utf8');
    // 大盘中后端 lint 行应为 PASS
    assert.match(report, /\*\*后端 lint\*\*.*✅ PASS/s, 'lint 套件须为 PASS');
  });

  it('UT-QA-LINT-04: 不改前端 lint 门禁、不执行 frontend npm run lint', () => {
    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);
    const formatSrc = fs.readFileSync(FORMAT_QA_REPORT_JS, 'utf8');

    assert.equal(
      /\(cd\s+[^\n]*frontend[^\n]*&&\s*npm\s+run\s+lint\)/.test(activeSh),
      false,
      '不得执行 frontend npm run lint',
    );
    assert.equal(
      /npm\s+run\s+lint\s+--prefix\s+frontend/.test(activeSh),
      false,
      '不得 --prefix frontend 跑 lint',
    );

    // 前端门禁仍为 npm test
    assert.match(
      activeSh,
      /\(cd\s+"\$PROJECT_ROOT\/frontend"\s+&&\s+npm\s+test\)/,
      '前端门禁须仍为 npm test',
    );

    const payloadBlock = activeSh.slice(
      activeSh.indexOf('payload'),
      activeSh.indexOf('fs.writeFileSync'),
    );
    assert.equal(
      /frontendLintCode/.test(payloadBlock),
      false,
      'results.json 不得要求 frontendLintCode',
    );

    // lint 仅绑定 backend 路径
    const lintLines = activeSh
      .split('\n')
      .filter((line) => /npm\s+run\s+lint/.test(line));
    assert.ok(lintLines.length >= 1, '须至少有一条 backend lint 调用');
    for (const line of lintLines) {
      assert.match(line, /backend/, `lint 调用须在 backend 路径：${line}`);
      assert.equal(/frontend/.test(line), false, `lint 不得落在 frontend：${line}`);
    }

    assert.equal(
      /frontendLintCode/.test(formatSrc),
      false,
      'format-qa-report.js 不得引入 frontendLintCode 必填逻辑',
    );
  });

  it('UT-QA-LINT-05: lint 失败与现有「按测试结果返回退出码」时序一致', () => {
    const shSrc = fs.readFileSync(QA_REPORT_SH, 'utf8');
    const activeSh = stripHashComments(shSrc);

    // 时序：套件（含 lint）→ 写 JSON → format-qa-report → GATE_CODE → exit
    const lintIdx = activeSh.search(/npm\s+run\s+lint/);
    const writeIdx = activeSh.indexOf('fs.writeFileSync');
    const formatIdx = activeSh.indexOf('format-qa-report.js');
    const gateIdx = activeSh.indexOf('GATE_CODE=$?');
    const exitIdx = activeSh.search(/exit\s+\$GATE_CODE/);

    assert.ok(lintIdx >= 0 && writeIdx > lintIdx, '须先跑 lint 再写 JSON');
    assert.ok(formatIdx > writeIdx, '须写 JSON 后再调 format-qa-report.js');
    assert.ok(gateIdx > formatIdx, '须以 format 进程退出码为 GATE_CODE');
    assert.ok(exitIdx > gateIdx, '最终须 exit $GATE_CODE');

    // 默认：lint FAIL → 非 0
    const lintFail = runFormatQaReport(
      basePassingPayload({
        backendLintCode: 1,
        backendLintOutput: '✖ 1 problem (1 error, 0 warnings)\n',
      }),
      { QA_GATE: '' },
    );
    assert.notEqual(lintFail.status, 0, 'lint FAIL 默认须非 0');

    // 对照：lint PASS + backend test FAIL → 仍非 0
    const beFail = runFormatQaReport(
      basePassingPayload({
        backendLintCode: 0,
        backendLintOutput: '✖ 0 problems (0 errors, 0 warnings)\n',
        backendCode: 1,
        backendOutput: '# tests 1\n# pass 0\n# fail 1\n# duration_ms 5.0\nnot ok 1 - sample\n',
      }),
      { QA_GATE: '' },
    );
    assert.notEqual(beFail.status, 0, 'backend test FAIL 仍须非 0');

    // QA_GATE=off：lint FAIL 仍写报告但退出 0
    const gateOff = runFormatQaReport(
      basePassingPayload({
        backendLintCode: 1,
        backendLintOutput: '✖ 1 problem (1 error, 0 warnings)\n',
      }),
      { QA_GATE: 'off' },
    );
    assert.equal(gateOff.status, 0, 'QA_GATE=off 时 lint FAIL 须放行退出 0');
    assert.match(gateOff.combined, /QA_GATE=off|已放行/, '须有放行提示');

    const report = fs.readFileSync(path.join(PROJECT_ROOT, 'docs', 'qa_report.md'), 'utf8');
    assert.match(
      report,
      /cd backend && npm run lint/,
      '报告大盘 lint 行执行命令须为 cd backend && npm run lint',
    );

    // 不以恒 0 / 忽略 lintCode 绕过
    assert.match(activeSh, /backendLintCode:\s*\$BE_LINT_CODE|lintCode:\s*\$/, '不得忽略 lint 退出码写入');
    assert.equal(/exit\s+0\s*$/m.test(activeSh.trim()), false, '不得恒 exit 0');
  });
});
