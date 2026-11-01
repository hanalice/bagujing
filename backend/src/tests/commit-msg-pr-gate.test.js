/**
 * E12：PR CI 使用与 E11 同一套提交说明校验。
 * 用例 ID 与 docs/test_cases.md §2.38 对齐。
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
const CHECK_SCRIPT = path.join(REPO_ROOT, 'scripts/check-commit-msg.sh');
const PR_WRAPPER = path.join(REPO_ROOT, 'scripts/check-pr-commit-msgs.sh');
const PRE_COMMIT = path.join(REPO_ROOT, '.githooks/pre-commit');
const WF_DIR = path.join(REPO_ROOT, '.github/workflows');
const SCRIPT_REL = 'scripts/check-commit-msg.sh';

/**
 * 用 E11 脚本或 PR 封装（--msg-file）校验临时消息。
 * @param {string} content
 * @param {{ viaWrapper?: boolean }} [opts]
 */
function runMsg(content, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-msg-pr-'));
  const msgFile = path.join(tmpDir, 'MSG');
  fs.writeFileSync(msgFile, content, 'utf8');
  try {
    const args = opts.viaWrapper
      ? [PR_WRAPPER, '--msg-file', msgFile]
      : [CHECK_SCRIPT, msgFile];
    const run = spawnSync('bash', args, {
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
 * 收集 workflows 文本，并定位 PR 提交说明相关 step/封装源码。
 * @returns {{ allYml: string, gateSources: string, qaYml: string }}
 */
function loadGateSources() {
  assert.ok(fs.existsSync(WF_DIR), '.github/workflows 必须存在');
  const files = fs
    .readdirSync(WF_DIR)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
  const allYml = files.map((f) => fs.readFileSync(path.join(WF_DIR, f), 'utf8')).join('\n');
  const qaYml = fs.readFileSync(path.join(WF_DIR, 'qa.yml'), 'utf8');

  const wrapperExists = fs.existsSync(PR_WRAPPER);
  const wrapperSrc = wrapperExists ? fs.readFileSync(PR_WRAPPER, 'utf8') : '';
  // step 文本 + 封装脚本，供断言调用链
  const gateSources = `${allYml}\n${wrapperSrc}`;
  return { allYml, gateSources, qaYml, wrapperSrc, wrapperExists };
}

describe('2.38 PR CI 使用与 E11 同一套提交说明校验（E12）', () => {
  it('UT-COMMIT-PR-01: PR workflow 存在提交说明校验步骤', () => {
    const { qaYml, allYml } = loadGateSources();
    assert.match(qaYml, /^\s*pull_request\s*:/m);
    assert.match(
      allYml,
      /校验 PR 提交说明|check-pr-commit-msgs|check-commit-msg/,
    );
    assert.match(qaYml, /github\.event_name\s*==\s*'pull_request'|if:.*pull_request/);
    assert.match(qaYml, /check-pr-commit-msgs\.sh|check-commit-msg\.sh/);
    // 不得仅以 push main 满足本行
    assert.ok(
      /pull_request/.test(qaYml) && /校验 PR 提交说明|check-pr-commit-msgs/.test(qaYml),
      '必须覆盖 PR 路径',
    );
  });

  it('UT-COMMIT-PR-02: 入口是 E11 的 scripts/check-commit-msg.sh（禁止第二套规则）', () => {
    const { gateSources, wrapperSrc } = loadGateSources();
    assert.ok(fs.existsSync(CHECK_SCRIPT), 'E11 脚本必须存在');
    assert.match(gateSources, /scripts\/check-commit-msg\.sh/);
    assert.ok(
      wrapperSrc.includes(SCRIPT_REL) || wrapperSrc.includes('check-commit-msg.sh'),
      '封装须调用 E11 契约路径',
    );
    const active = stripHashComments(gateSources);
    // 不得再内联完整段落裁决作为唯一门禁
    assert.doesNotMatch(active, /grep\s+-qiE\s+"背景\|Background"/);
    assert.doesNotMatch(active, /动机\|Motivation/);
    assert.doesNotMatch(active, /type_name.*=.*"feat"/);
  });

  it('UT-COMMIT-PR-03: 校验对象为 PR 本次提交范围', () => {
    const { qaYml, wrapperSrc } = loadGateSources();
    assert.match(wrapperSrc, /git\s+.*rev-list|git\s+.*log/);
    assert.match(
      wrapperSrc,
      /BASE_SHA|PR_BASE_SHA|pull_request\.base\.sha|base\.sha/,
    );
    assert.match(wrapperSrc, /HEAD_SHA|PR_HEAD_SHA|HEAD/);
    assert.match(wrapperSrc, /check-commit-msg\.sh/);
    // workflow 传入 base/head
    assert.match(qaYml, /PR_BASE_SHA|pull_request\.base\.sha/);
    assert.match(qaYml, /PR_HEAD_SHA|pull_request\.head\.sha|github\.sha/);
    // 须遍历区间，而非只校验单次 HEAD
    assert.match(wrapperSrc, /rev-list|for\s+\w+\s+in/);
  });

  it('UT-COMMIT-PR-04: 共享脚本非 0 → CI 该检查失败', () => {
    const { qaYml } = loadGateSources();
    // workflow：该 step 未 continue-on-error，且无 || true 抹平
    const stepBlock = qaYml.match(
      /校验 PR 提交说明[\s\S]*?(?=\n\s+- name:|\n\s+jobs:|$)/,
    );
    assert.ok(stepBlock, '须定位到校验 PR 提交说明 step');
    assert.doesNotMatch(stepBlock[0], /continue-on-error:\s*true/);
    assert.doesNotMatch(stepBlock[0], /\|\|\s*true/);

    const bad = runMsg('bad message\n', { viaWrapper: true });
    assert.notEqual(bad.status, 0, '封装须透传共享脚本失败');
  });

  it('UT-COMMIT-PR-05: 合法轻量提交说明 → 校验步骤可通过', () => {
    const r = runMsg('chore(e12): probe\n\n- PR 接线同脚本\n', { viaWrapper: true });
    assert.equal(r.status, 0);
  });

  it('UT-COMMIT-PR-06: residual：Merge 提交保持豁免（同源脚本）', () => {
    const r = runMsg("Merge branch 'main' into feature/x\n", { viaWrapper: true });
    assert.equal(r.status, 0);
    // 封装不得在调用脚本前因非 Conventional 先杀掉 Merge
    const { wrapperSrc } = loadGateSources();
    const active = stripHashComments(wrapperSrc);
    // 在调用 check-commit-msg 之前不得对首行做 Conventional 硬拦
    assert.doesNotMatch(
      active,
      /header_pattern|Conventional[\s\S]{0,80}exit 1/,
    );
  });

  it('UT-COMMIT-PR-07: 豁免与钩子相同：Revert / Initial commit / Release / Version', () => {
    const lines = [
      'Revert "chore(x): y"',
      'Initial commit',
      'Release 1.2.3',
      'Version 1.2.3',
    ];
    for (const line of lines) {
      const r = runMsg(`${line}\n`, { viaWrapper: true });
      assert.equal(r.status, 0, `${line} 须经同源脚本豁免`);
    }
  });

  it('UT-COMMIT-PR-08: 不做：不改 E11 段落规则', () => {
    // 本项不以重写 E11 段落关键词为 PASS 条件；共享脚本仍存在即可
    assert.ok(fs.existsSync(CHECK_SCRIPT));
    const src = fs.readFileSync(CHECK_SCRIPT, 'utf8');
    assert.match(src, /背景\|Background/);
    assert.match(src, /变更内容\|Changes/);
    assert.match(src, /测试与兼容性\|Testing/);
    assert.match(src, /动机\|Motivation/);
    // E12 测码不修改该文件；此处只读断言
    assert.ok(true, '不以重写 UT-COMMIT-MSG-08/10 规则为必要');
  });

  it('UT-COMMIT-PR-09: 不做：pre-commit 不再跑一遍提交说明', () => {
    const pre = fs.readFileSync(PRE_COMMIT, 'utf8');
    assert.doesNotMatch(pre, /check-commit-msg\.sh/);
    assert.doesNotMatch(pre, /check-pr-commit-msgs\.sh/);
    assert.match(pre, /qa-report\.sh/);
  });

  it('UT-COMMIT-PR-10: residual：禁止在 E11 脚本缺失时另写第二套规则', () => {
    const { wrapperSrc, gateSources } = loadGateSources();
    assert.match(wrapperSrc, /check-commit-msg\.sh/);
    // 脚本缺失应显式失败，不得内联 grep 背景/设计回退
    assert.match(wrapperSrc, /缺少 E11|! -f.*check-commit-msg|不存在/);
    const active = stripHashComments(gateSources);
    assert.doesNotMatch(
      active,
      /若脚本不存在|fallback[\s\S]{0,40}背景\|Background|else[\s\S]{0,80}grep.*背景/,
    );
  });

  it('UT-COMMIT-PR-11: 与 E11 分界：本表不以本地钩子未改为 FAIL', () => {
    // 不要求再次断言钩子/沙盒接线；本表范围 = PR/CI
    assert.ok(fs.existsSync(PR_WRAPPER));
    assert.ok(fs.existsSync(path.join(WF_DIR, 'qa.yml')));
    assert.ok(true, '不因日修沙盒未改而 FAIL');
  });

  it('UT-COMMIT-PR-12: checkout 深度足以列出 PR 提交（若用 git log 区间）', () => {
    const { qaYml, wrapperSrc } = loadGateSources();
    assert.match(wrapperSrc, /rev-list|git\s+.*log/);
    assert.match(qaYml, /fetch-depth:\s*0/);
    // 区间为空不得静默 exit 0
    assert.match(wrapperSrc, /区间.*空|为空.*拒绝|未校验任何/);
    const emptyProbe = spawnSync(
      'bash',
      [PR_WRAPPER, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    // 同 SHA 区间为空 → 非 0
    assert.notEqual(emptyProbe.status ?? 1, 0, '空区间不得静默通过');
  });
});
