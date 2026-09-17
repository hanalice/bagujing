/**
 * A81 / P2-6：后端 ESLint flat config 契约测试。
 * 用例 ID 与 docs/test_cases.md §2.15 对齐。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ESLint } from 'eslint';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_ROOT = path.resolve(__dirname, '../..');
const ESLINT_CONFIG_PATH = path.join(BACKEND_ROOT, 'eslint.config.js');
const PACKAGE_JSON_PATH = path.join(BACKEND_ROOT, 'package.json');

const LEGACY_ESLINTRC_NAMES = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
];

/**
 * 汇总 ESLint 结果中的 error / warning 计数。
 * @param {import('eslint').ESLint.LintResult[]} results
 */
function sumCounts(results) {
  let errorCount = 0;
  let warningCount = 0;
  for (const r of results) {
    errorCount += r.errorCount;
    warningCount += r.warningCount;
  }
  return { errorCount, warningCount };
}

describe('2.15 后端 ESLint flat config（A81 / P2-6）', () => {
  it('UT-BE-LINT-01: flat config 文件存在且可被 ESLint 9 加载', async () => {
    assert.ok(fs.existsSync(ESLINT_CONFIG_PATH), 'backend/eslint.config.js 必须存在');
    assert.ok(fs.statSync(ESLINT_CONFIG_PATH).isFile(), 'eslint.config.js 须为可读文件');

    for (const name of LEGACY_ESLINTRC_NAMES) {
      assert.equal(
        fs.existsSync(path.join(BACKEND_ROOT, name)),
        false,
        `不得依赖遗留 ${name} 作为唯一配置源（本项要求 flat config）`,
      );
    }

    const mod = await import(pathToFileURL(ESLINT_CONFIG_PATH).href);
    assert.ok(Array.isArray(mod.default), 'eslint.config.js 默认导出须为数组');
    assert.ok(mod.default.length > 0, 'flat 配置数组不得为空');

    const printed = spawnSync(
      process.execPath,
      [path.join(BACKEND_ROOT, 'node_modules/eslint/bin/eslint.js'), '--print-config', 'src/server-express.js'],
      { cwd: BACKEND_ROOT, encoding: 'utf8' },
    );
    const combined = `${printed.stdout || ''}\n${printed.stderr || ''}`;
    assert.equal(printed.status, 0, `--print-config 退出码应为 0，实际 ${printed.status}\n${combined}`);
    assert.equal(
      combined.includes("ESLint couldn't find a configuration file"),
      false,
      '加载不得报缺配置',
    );
    const configJson = JSON.parse(printed.stdout);
    assert.ok(configJson.rules && typeof configJson.rules === 'object', '--print-config 输出须含 rules');
  });

  it('UT-BE-LINT-02: npm run lint 跑完且当前树 0 error', () => {
    const run = spawnSync('npm', ['run', 'lint'], {
      cwd: BACKEND_ROOT,
      encoding: 'utf8',
      shell: false,
    });
    const combined = `${run.stdout || ''}\n${run.stderr || ''}`;
    assert.equal(run.status, 0, `npm run lint 退出码应为 0，实际 ${run.status}\n${combined}`);
    assert.equal(
      combined.includes("ESLint couldn't find a configuration file"),
      false,
      '不得因缺 config 崩溃',
    );

    // 与 CLI 同源：API 汇总 errorCount
    // 注意：异步断言放到同步 spawn 之后，用同步 wait 风格不可行，改用 spawn eslint --format json
    const jsonRun = spawnSync(
      process.execPath,
      [
        path.join(BACKEND_ROOT, 'node_modules/eslint/bin/eslint.js'),
        '--ext',
        '.js',
        'src',
        '--format',
        'json',
      ],
      { cwd: BACKEND_ROOT, encoding: 'utf8' },
    );
    assert.equal(jsonRun.status, 0, `eslint json 退出码应为 0\n${jsonRun.stderr}`);
    const results = JSON.parse(jsonRun.stdout);
    const { errorCount, warningCount } = sumCounts(results);
    assert.equal(errorCount, 0, `当前树 errorCount 之和须为 0，实际 ${errorCount}`);
    assert.ok(warningCount >= 0, '允许 warningCount >= 0');
  });

  it('UT-BE-LINT-03: 规则集为 ESLint 9 recommended，未额外加严打红', async () => {
    const source = fs.readFileSync(ESLINT_CONFIG_PATH, 'utf8');
    assert.ok(
      /configs\.recommended|js\.configs\.recommended/.test(source),
      '配置源码须显式纳入 recommended',
    );
    assert.equal(
      /rules\s*:\s*\{[^}]*['"]error['"]/.test(source) && !/configs\.recommended/.test(source),
      false,
      '不得用空扫描冒充 recommended',
    );

    // 不得整表关闭 recommended：检测把大量规则设为 off 的写法
    assert.equal(
      /recommended[\s\S]*:\s*['"]off['"]/.test(source) && /Object\.fromEntries|for\s*\(.*recommended/.test(source),
      false,
      '不得通过批量 off 关闭整个 recommended',
    );

    const eslint = new ESLint({ cwd: BACKEND_ROOT });
    const results = await eslint.lintFiles(['src']);
    const { errorCount } = sumCounts(results);
    assert.equal(errorCount, 0, '当前树在 recommended 下须 0 error（与 UT-BE-LINT-02 一致）');
  });

  it('UT-BE-LINT-04: 扫描范围限 backend，不牵连前端', async () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
    const lintScript = pkg.scripts?.lint || '';
    assert.ok(
      /\bsrc\b/.test(lintScript),
      `scripts.lint 须覆盖 backend/src，当前: ${lintScript}`,
    );
    assert.equal(
      /frontend/.test(lintScript),
      false,
      'scripts.lint 不得指向 frontend',
    );

    const eslint = new ESLint({ cwd: BACKEND_ROOT });
    const results = await eslint.lintFiles(['src']);
    assert.ok(results.length > 0, '须至少扫描到 backend/src 下文件');

    const backendRootNorm = path.resolve(BACKEND_ROOT);
    for (const r of results) {
      const filePath = path.resolve(r.filePath);
      assert.ok(
        filePath.startsWith(backendRootNorm + path.sep) || filePath === backendRootNorm,
        `filePath 须位于 backend/ 内: ${filePath}`,
      );
      assert.equal(
        filePath.includes(`${path.sep}frontend${path.sep}`),
        false,
        `结果不得包含 frontend 路径: ${filePath}`,
      );
    }
  });

  it('UT-BE-LINT-05: 对故意违规 fixture 仍能报 error（非空跑）', async () => {
    // 探针放在 backend 树内的隔离目录，避免 ESLint 忽略 cwd 外路径；测后删除，不污染业务 src
    const probeDir = path.join(__dirname, 'fixtures', 'eslint-probe');
    const probePath = path.join(probeDir, 'eslint-probe-undef.js');
    fs.mkdirSync(probeDir, { recursive: true });
    try {
      fs.writeFileSync(probePath, 'eslintProbeUndeclared = 1;\n', 'utf8');

      const eslint = new ESLint({ cwd: BACKEND_ROOT });
      const results = await eslint.lintFiles([probePath]);
      const { errorCount } = sumCounts(results);
      assert.ok(errorCount >= 1, `探针文件 errorCount 须 >= 1，实际 ${errorCount}`);

      const messages = results.flatMap((r) => r.messages);
      assert.ok(
        messages.some((m) => m.ruleId === 'no-undef' && m.severity === 2),
        '至少一条 recommended 规则 error（如 no-undef）',
      );

      const cli = spawnSync(
        process.execPath,
        [path.join(BACKEND_ROOT, 'node_modules/eslint/bin/eslint.js'), probePath],
        { cwd: BACKEND_ROOT, encoding: 'utf8' },
      );
      assert.notEqual(cli.status, 0, `针对探针的 CLI 退出码须非 0，实际 ${cli.status}`);
    } finally {
      try { fs.rmSync(probePath, { force: true }); } catch { /* 清理失败可忽略 */ }
      try { fs.rmdirSync(probeDir); } catch { /* 目录非空或已删可忽略 */ }
    }
  });
});
