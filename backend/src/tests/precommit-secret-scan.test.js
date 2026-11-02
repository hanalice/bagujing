/**
 * E13：pre-commit 拦截暂存区硬编码口令、密钥、私钥与连接串。
 * 用例 ID 与 docs/test_cases.md §2.39 对齐。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const SCAN_SCRIPT = path.join(REPO_ROOT, 'scripts/check-staged-secrets.sh');
const PRE_COMMIT = path.join(REPO_ROOT, '.githooks/pre-commit');
const WF_DIR = path.join(REPO_ROOT, '.github/workflows');

/**
 * 构造最小 unified diff（单文件、单 hunk）。
 * @param {string} filePath 相对仓库根路径
 * @param {string[]} addedLines 不含前缀 + 的新增行内容；空数组且 deletedLines 非空时只造删除
 * @param {{ deletedLines?: string[] }} [opts]
 */
function buildDiff(filePath, addedLines, opts = {}) {
  const deleted = opts.deletedLines || [];
  const lines = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
  ];
  if (addedLines.length > 0 && deleted.length === 0) {
    lines.push(`@@ -0,0 +1,${addedLines.length} @@`);
    for (const t of addedLines) lines.push(`+${t}`);
  } else if (addedLines.length === 0 && deleted.length > 0) {
    lines.push(`@@ -1,${deleted.length} +0,0 @@`);
    for (const t of deleted) lines.push(`-${t}`);
  } else {
    lines.push(`@@ -1,${deleted.length} +1,${addedLines.length} @@`);
    for (const t of deleted) lines.push(`-${t}`);
    for (const t of addedLines) lines.push(`+${t}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 将构造的 diff 写入临时文件并调用扫描脚本。
 * @param {string} diffText
 */
function runScan(diffText) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-scan-'));
  const diffFile = path.join(tmpDir, 'probe.diff');
  fs.writeFileSync(diffFile, diffText, 'utf8');
  try {
    const run = spawnSync('bash', [SCAN_SCRIPT, diffFile], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env },
    });
    return {
      status: run.status ?? 1,
      stdout: run.stdout || '',
      stderr: run.stderr || '',
      combined: `${run.stdout || ''}\n${run.stderr || ''}`,
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** @param {string} src */
function stripHashComments(src) {
  return src
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/**
 * 断言拦截输出含 文件:行 与环境变量提示。
 * @param {{ status: number, combined: string }} result
 * @param {string} filePath
 */
function assertBlocked(result, filePath) {
  assert.notEqual(result.status, 0, `应拦截 ${filePath}`);
  assert.match(result.combined, new RegExp(`${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`));
  assert.match(result.combined, /明文不要入库/);
  assert.match(result.combined, /环境变量/);
}

describe('2.39 pre-commit 拦截暂存区硬编码口令/密钥（E13）', () => {
  it('UT-SECRET-SCAN-01: 扫描入口可单独喂构造的 diff 文本', () => {
    assert.ok(fs.existsSync(SCAN_SCRIPT), '契约脚本 scripts/check-staged-secrets.sh 必须存在');
    const diff = buildDiff('src/ok.js', ['const x = 1;']);
    const result = runScan(diff);
    assert.equal(result.status, 0);
    // 证明以构造文本为输入：同一入口喂脏内容会非 0（对照）
    const dirty = runScan(
      buildDiff('backend/src/leak.js', ['const DB_PASSWORD = "abcdefgh";']),
    );
    assert.notEqual(dirty.status, 0);
  });

  it('UT-SECRET-SCAN-02: .githooks/pre-commit 在 qa-report.sh 之前调用扫描', () => {
    const src = fs.readFileSync(PRE_COMMIT, 'utf8');
    const active = stripHashComments(src);
    const scanIdx = active.search(/check-staged-secrets\.sh/);
    const qaIdx = active.search(/qa-report\.sh/);
    assert.ok(scanIdx >= 0, '钩子必须调用 check-staged-secrets.sh');
    assert.ok(qaIdx >= 0, '钩子必须调用 qa-report.sh');
    assert.ok(scanIdx < qaIdx, '密钥扫描必须出现在 qa-report.sh 之前');
    // 扫描失败路径 exit 非 0，且因 set -e / if ! 短路不再跑 qa-report
    assert.match(active, /if\s+!\s+\.\/scripts\/check-staged-secrets\.sh/);
    assert.match(active, /exit\s+1/);
  });

  it('UT-SECRET-SCAN-03: 命中① PEM 私钥块 → 非 0 + 文件:行', () => {
    const file = 'backend/src/leak-key.js';
    const result = runScan(
      buildDiff(file, ['const k = "-----BEGIN RSA PRIVATE KEY-----";']),
    );
    assertBlocked(result, file);
  });

  it('UT-SECRET-SCAN-04: 命中② 带用户名密码的连接串 URL → 非 0', () => {
    const file = 'backend/src/db.js';
    const result = runScan(
      buildDiff(file, [
        "const url = 'postgres://appuser:s3cretPW@db.internal:5432/app';",
      ]),
    );
    assertBlocked(result, file);
  });

  it('UT-SECRET-SCAN-05: 命中③ PASSWORD/SECRET/TOKEN/API_KEY/PRIVATE_KEY + ≥8 引号字面量', () => {
    const probes = [
      { file: 'backend/src/p1.js', line: 'const DB_PASSWORD = "abcdefgh";' },
      { file: 'backend/src/p2.js', line: "API_SECRET = '12345678';" },
      { file: 'backend/src/p3.js', line: 'export AUTH_TOKEN = "tok_abcd12";' },
      { file: 'backend/src/p4.js', line: 'OPENAI_API_KEY = "sk_live_xx";' },
      { file: 'backend/src/p5.js', line: 'CLIENT_PRIVATE_KEY = "pk_abcd12";' },
    ];
    for (const p of probes) {
      const result = runScan(buildDiff(p.file, [p.line]));
      assertBlocked(result, p.file);
    }
  });

  it('UT-SECRET-SCAN-06: ③类字面量长度 < 8 不拦', () => {
    const result = runScan(
      buildDiff('backend/src/short.js', ['const API_SECRET = "short";']),
    );
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.combined, /backend\/src\/short\.js:\d+/);
  });

  it('UT-SECRET-SCAN-07: ③类变量名不含敏感关键词则不拦', () => {
    const result = runScan(
      buildDiff('backend/src/host.js', ['const DB_HOST = "abcdefghij";']),
    );
    assert.equal(result.status, 0);
  });

  it('UT-SECRET-SCAN-08: ②类无密码段的 URL 不拦', () => {
    const a = runScan(
      buildDiff('backend/src/u1.js', ["const u = 'https://example.com/path';"]),
    );
    const b = runScan(
      buildDiff('backend/src/u2.js', ["const u = 'https://user@host/db';"]),
    );
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
  });

  it('UT-SECRET-SCAN-09: 放行字面量 change_me', () => {
    const result = runScan(
      buildDiff('backend/src/tok.js', ['AI_CLIENT_TOKEN = "change_me";']),
    );
    assert.equal(result.status, 0);
  });

  it('UT-SECRET-SCAN-10: 放行字面量以 your_ 或 example 开头', () => {
    const a = runScan(
      buildDiff('backend/src/a.js', ['API_SECRET = "your_api_secret_here";']),
    );
    const b = runScan(
      buildDiff('backend/src/b.js', ['DB_PASSWORD = "example_password_xx";']),
    );
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
  });

  it('UT-SECRET-SCAN-11: 放行路径 *.example / docs/**', () => {
    const a = runScan(
      buildDiff('backend/.env.example', ['OPENAI_API_KEY="sk_live_realish";']),
    );
    const b = runScan(
      buildDiff('docs/runbook.md', ['-----BEGIN PRIVATE KEY-----']),
    );
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
  });

  it('UT-SECRET-SCAN-12: 放行 *.test.js / *.spec.ts / *.test.ts', () => {
    const probes = [
      {
        file: 'backend/src/tests/foo.test.js',
        line: 'const API_SECRET = "abcdefghijklmnop";',
      },
      {
        file: 'frontend/src/x.spec.ts',
        line: '-----BEGIN RSA PRIVATE KEY-----',
      },
      {
        file: 'frontend/src/y.test.ts',
        line: "const url = 'postgres://u:p@host/db';",
      },
    ];
    for (const p of probes) {
      const result = runScan(buildDiff(p.file, [p.line]));
      assert.equal(result.status, 0, p.file);
    }
  });

  it('UT-SECRET-SCAN-13: 放行 package-lock.json', () => {
    const result = runScan(
      buildDiff('backend/package-lock.json', [
        '"_token": "abcdefghijklmnop"',
      ]),
    );
    assert.equal(result.status, 0);
  });

  it('UT-SECRET-SCAN-14: 干净 diff 放行后钩子可继续 qa-report', () => {
    const src = fs.readFileSync(PRE_COMMIT, 'utf8');
    const active = stripHashComments(src);
    const scanIdx = active.search(/check-staged-secrets\.sh/);
    const qaIdx = active.search(/qa-report\.sh/);
    assert.ok(scanIdx >= 0 && qaIdx > scanIdx);
    // 扫描非 0 时显式 exit 1，qa-report 在成功分支之后
    const failBlock = active.slice(scanIdx, qaIdx);
    assert.match(failBlock, /exit\s+1/);
    assert.doesNotMatch(failBlock, /qa-report\.sh/);
  });

  it('UT-SECRET-SCAN-15: 不做：不并进 OSV / vulnerability-report.yml', () => {
    const vrPath = path.join(WF_DIR, 'vulnerability-report.yml');
    assert.ok(fs.existsSync(vrPath));
    const vr = fs.readFileSync(vrPath, 'utf8');
    const scanSrc = fs.readFileSync(SCAN_SCRIPT, 'utf8');
    assert.doesNotMatch(vr, /check-staged-secrets/);
    assert.doesNotMatch(vr, /PRIVATE KEY|PASSWORD|SECRET.*TOKEN/);
    assert.doesNotMatch(scanSrc, /osv-scanner|vulnerability-report/);
  });

  it('UT-SECRET-SCAN-16: 不做：不扫描 git 历史 / 不改写已入库密钥', () => {
    const scanSrc = fs.readFileSync(SCAN_SCRIPT, 'utf8');
    assert.doesNotMatch(scanSrc, /git\s+log\b|git\s+rev-list\b|filter-repo|\bbfg\b/);
    // 无参时仅 git diff --cached；有参时读文件
    assert.match(scanSrc, /diff --cached|DIFF_ARG|diff 文件/);
  });

  it('UT-SECRET-SCAN-17: 不做：不升级依赖；不让 qa.yml 因漏洞失败', () => {
    const qa = fs.readFileSync(path.join(WF_DIR, 'qa.yml'), 'utf8');
    assert.doesNotMatch(qa, /osv-scanner|dependency.?vulnerabilit/i);
    // 本项实现不要求升级 lockfile；脚本不引用 npm upgrade
    const scanSrc = fs.readFileSync(SCAN_SCRIPT, 'utf8');
    assert.doesNotMatch(scanSrc, /npm\s+(install|update|ci).*upgrade|osv-scanner/);
  });

  it('UT-SECRET-SCAN-18: residual：不要求检出混淆/编码秘密', () => {
    const a = runScan(
      buildDiff('backend/src/ob1.js', [
        "const API_SECRET = Buffer.from('YWI=', 'base64').toString();",
      ]),
    );
    const b = runScan(
      buildDiff('backend/src/ob2.js', [
        "const API_SECRET = ['a','b'].join('');",
      ]),
    );
    assert.equal(a.status, 0);
    assert.equal(b.status, 0);
  });

  it('UT-SECRET-SCAN-19: 与 E11/E12 分界：本表不锁提交说明段落', () => {
    const src = fs.readFileSync(PRE_COMMIT, 'utf8');
    assert.doesNotMatch(src, /check-commit-msg\.sh/);
    assert.match(src, /check-staged-secrets\.sh/);
    assert.match(src, /qa-report\.sh/);
  });

  it('UT-SECRET-SCAN-20: 删除行（-）中的旧秘密不拦', () => {
    const result = runScan(
      buildDiff(
        'backend/src/cfg.js',
        [],
        { deletedLines: ['const API_SECRET = "abcdefghijklmnop";'] },
      ),
    );
    assert.equal(result.status, 0);
  });

  it('UT-SECRET-SCAN-21: 规则注释点名 BEGIN 与 PRIVATE KEY 不拦', () => {
    const comment = runScan(
      buildDiff('scripts/check-staged-secrets.sh', [
        '# ① PEM 私钥块：同行同时含 BEGIN 与 PRIVATE KEY',
      ]),
    );
    assert.equal(comment.status, 0);

    const code = runScan(
      buildDiff('backend/src/leak-marker.js', [
        'const marker = "BEGIN RSA PRIVATE KEY";',
      ]),
    );
    assertBlocked(code, 'backend/src/leak-marker.js');

    const armoredComment = runScan(
      buildDiff('backend/src/note.js', [
        '# leak -----BEGIN RSA PRIVATE KEY-----',
      ]),
    );
    assertBlocked(armoredComment, 'backend/src/note.js');
  });
});
