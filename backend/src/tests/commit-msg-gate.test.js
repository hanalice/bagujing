/**
 * E11：提交说明校验脚本共用（feat 四段 / refactor 三段 / 轻量 type 有正文）。
 * 用例 ID 与 docs/test_cases.md §2.37 对齐。
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
const HOOK_PATH = path.join(REPO_ROOT, '.githooks/commit-msg');
const SANDBOX_PATH = path.join(REPO_ROOT, 'scripts/automation/lib/git-sandbox.sh');
const SCRIPT_REL = 'scripts/check-commit-msg.sh';

/**
 * 写入临时消息文件并用共享脚本校验。
 * @param {string} content
 * @param {{ env?: Record<string, string>, viaHook?: boolean }} [opts]
 */
function runCheck(content, opts = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-msg-gate-'));
  const msgFile = path.join(tmpDir, 'COMMIT_EDITMSG');
  fs.writeFileSync(msgFile, content, 'utf8');
  const script = opts.viaHook ? HOOK_PATH : CHECK_SCRIPT;
  try {
    const run = spawnSync('bash', [script, msgFile], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, ...(opts.env || {}) },
    });
    return {
      status: run.status ?? 1,
      stdout: run.stdout || '',
      stderr: run.stderr || '',
      combined: `${run.stdout || ''}\n${run.stderr || ''}`,
      msgFile,
      tmpDir,
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

const FIX_FULL = `fix(ai-guard): 修复示例

【问题现象 (Symptoms)】
- 现象说明
【根因分析 (Root Cause)】
- 根因说明
【解决方案 (Solution)】
- 方案说明
`;

const FEAT_FULL = `feat(test): 四段齐全示例

【背景 (Background)】
- 背景说明
【设计概述 (Design)】
- 设计说明
【变更内容 (Changes)】
- 变更说明
【测试与兼容性 (Testing & Compatibility)】
- 测试说明
`;

const REFACTOR_FULL = `refactor(backend): 三段齐全示例

【动机 (Motivation)】
- 动机说明
【变更内容 (Changes)】
- 变更说明
【验证 (Verification)】
- 验证说明
`;

describe('2.37 提交说明校验脚本共用（E11）', () => {
  it('UT-COMMIT-MSG-01: 共享校验脚本存在且可单独喂消息文件', () => {
    assert.ok(fs.existsSync(CHECK_SCRIPT), 'scripts/check-commit-msg.sh 必须存在');
    const head = fs.readFileSync(CHECK_SCRIPT, 'utf8').slice(0, 40);
    assert.match(head, /^#!\/usr\/bin\/env (bash|sh)/);
    const r = runCheck('chore(test): probe\n\nprobe body\n');
    assert.equal(r.status, 0);
  });

  it('UT-COMMIT-MSG-02: .githooks/commit-msg 调用共享脚本而非自维护第二套段落规则', () => {
    const hook = fs.readFileSync(HOOK_PATH, 'utf8');
    assert.match(hook, /scripts\/check-commit-msg\.sh/);
    assert.match(hook, /check-commit-msg\.sh/);
    const active = stripHashComments(hook);
    // 钩子不得再内联 feat 四段 / refactor 三段完整裁决
    assert.doesNotMatch(active, /type_name.*=.*"feat"/);
    assert.doesNotMatch(active, /grep\s+-qiE\s+"背景\|Background"/);
    assert.doesNotMatch(active, /动机\|Motivation/);
    assert.match(hook, /Co-authored-by|Made-with|Made with Cursor/);
    assert.match(hook, /COMMIT_MSG_GATE/);
  });

  it('UT-COMMIT-MSG-03: git-sandbox.sh 调用同一共享脚本', () => {
    const sandbox = fs.readFileSync(SANDBOX_PATH, 'utf8');
    assert.match(sandbox, /scripts\/check-commit-msg\.sh/);
    assert.ok(
      sandbox.includes(SCRIPT_REL) || sandbox.includes('check-commit-msg.sh'),
      '沙盒须引用与钩子同一脚本',
    );
    const active = stripHashComments(sandbox);
    // 不得再以内联仅两段 feat 作为唯一通过条件
    assert.doesNotMatch(
      active,
      /grep -qE '背景\|Background'[\s\S]*grep -qE '设计\|Design'/,
    );
    assert.match(sandbox, /git_sandbox_commit_msg_ok/);
    assert.match(sandbox, /bash\s+"\$_CHECK_COMMIT_MSG_SH"|bash\s+".*check-commit-msg\.sh"/);
  });

  it('UT-COMMIT-MSG-04: Header：合法 Conventional Commits 通过', () => {
    const withScope = runCheck(FIX_FULL);
    assert.equal(withScope.status, 0);
    const styleOnly = runCheck('style: 调整缩进\n');
    assert.equal(styleOnly.status, 0);
  });

  it('UT-COMMIT-MSG-05: Header：非法首行拦截', () => {
    const r = runCheck('更新了一点东西\n');
    assert.notEqual(r.status, 0);
    assert.match(r.combined, /Header|不符合规范|type/i);
  });

  it('UT-COMMIT-MSG-06: fix：缺任一段失败', () => {
    const base = (omit) => {
      const parts = {
        symptoms: '【问题现象 (Symptoms)】\n- x\n',
        root: '【根因分析 (Root Cause)】\n- y\n',
        solution: '【解决方案 (Solution)】\n- z\n',
      };
      delete parts[omit];
      return `fix(x): subject\n\n${Object.values(parts).join('')}`;
    };
    for (const omit of ['symptoms', 'root', 'solution']) {
      const r = runCheck(base(omit));
      assert.notEqual(r.status, 0, `缺 ${omit} 须失败`);
      assert.match(r.combined, /问题现象|根因分析|解决方案|Symptoms|Root Cause|Solution|缺失/);
    }
  });

  it('UT-COMMIT-MSG-07: fix：三段齐全通过', () => {
    const r = runCheck(FIX_FULL);
    assert.equal(r.status, 0);
  });

  it('UT-COMMIT-MSG-08: feat：仅背景+设计（旧两段）失败', () => {
    const r = runCheck(`feat(gate): 旧两段样例

【背景 (Background)】
- 背景
【设计概述 (Design)】
- 设计
`);
    assert.notEqual(r.status, 0);
    assert.match(r.combined, /变更内容|测试与兼容性|Changes|Testing/);
  });

  it('UT-COMMIT-MSG-09: feat：缺「变更内容」或「测试与兼容性」分别失败', () => {
    const noChanges = runCheck(`feat(gate): 缺第三段样例

【背景 (Background)】
- a
【设计概述 (Design)】
- b
【测试与兼容性 (Testing & Compatibility)】
- c
`);
    assert.notEqual(noChanges.status, 0);
    assert.match(noChanges.combined, /变更内容|Changes/);

    const noTesting = runCheck(`feat(gate): 缺第四段样例

【背景 (Background)】
- a
【设计概述 (Design)】
- b
【变更内容 (Changes)】
- c
`);
    assert.notEqual(noTesting.status, 0);
    assert.match(noTesting.combined, /测试与兼容性|Testing/);
  });

  it('UT-COMMIT-MSG-10: feat：四段齐全通过', () => {
    const r = runCheck(FEAT_FULL);
    assert.equal(r.status, 0);
  });

  it('UT-COMMIT-MSG-11: refactor：缺任一段失败', () => {
    const base = (omit) => {
      const parts = {
        motivation: '【动机 (Motivation)】\n- m\n',
        changes: '【变更内容 (Changes)】\n- c\n',
        verification: '【验证 (Verification)】\n- v\n',
      };
      delete parts[omit];
      return `refactor(backend): subject\n\n${Object.values(parts).join('')}`;
    };
    for (const omit of ['motivation', 'changes', 'verification']) {
      const r = runCheck(base(omit));
      assert.notEqual(r.status, 0, `缺 ${omit} 须失败`);
      assert.match(r.combined, /动机|变更内容|验证|Motivation|Changes|Verification|缺失/);
    }
  });

  it('UT-COMMIT-MSG-12: refactor：三段齐全通过', () => {
    const r = runCheck(REFACTOR_FULL);
    assert.equal(r.status, 0);
  });

  it('UT-COMMIT-MSG-13: 轻量 type：仅 header、无非空正文失败', () => {
    const headers = [
      'docs(readme): 更新说明',
      'chore(deps): 升级依赖',
      'test(gate): 补充用例',
      'perf(api): 降低延迟',
      'ci(qa): 调整门禁',
    ];
    for (const h of headers) {
      const r = runCheck(`${h}\n`);
      assert.notEqual(r.status, 0, `${h} 无正文须失败`);
      assert.match(r.combined, /正文|body|非空/);
      assert.doesNotMatch(r.combined, /【背景 \(Background\)】|缺失的关键小节/);
    }
  });

  it('UT-COMMIT-MSG-14: 轻量 type：header + 一行非空正文通过', () => {
    const headers = [
      'docs(readme): 更新说明',
      'chore(deps): 升级依赖',
      'test(gate): 补充用例',
      'perf(api): 降低延迟',
      'ci(qa): 调整门禁',
    ];
    for (const h of headers) {
      const r = runCheck(`${h}\n\n- 更新部署章节环境变量表\n`);
      assert.equal(r.status, 0, `${h} 有正文须通过`);
    }
  });

  it('UT-COMMIT-MSG-15: style / build / revert：仅 header 通过', () => {
    for (const h of ['style: 格式化空白', 'build: 调整打包配置', 'revert: 回滚误提交']) {
      const r = runCheck(`${h}\n`);
      assert.equal(r.status, 0, `${h} 仅 header 须通过`);
    }
  });

  it('UT-COMMIT-MSG-16: 豁免：Merge / Revert / Initial commit / Release / Version 直接放行', () => {
    const lines = [
      "Merge branch 'main' into x",
      'Revert "feat(x): y"',
      'Initial commit',
      'Release 1.2.3',
      'Version 1.2.3',
    ];
    for (const line of lines) {
      const r = runCheck(`${line}\n`);
      assert.equal(r.status, 0, `${line} 须豁免`);
    }
  });

  it('UT-COMMIT-MSG-17: residual：COMMIT_MSG_GATE=off 时钩子跳过', () => {
    const bad = 'bad message\n';
    const off = runCheck(bad, { viaHook: true, env: { COMMIT_MSG_GATE: 'off' } });
    assert.equal(off.status, 0);
    const on = runCheck(bad, { viaHook: true });
    assert.notEqual(on.status, 0);
  });

  it('UT-COMMIT-MSG-18: 不做：轻量 type 不得被要求 feat 四段', () => {
    const r = runCheck('chore(e11): 调整脚本\n\n- 抽出共享校验脚本\n');
    assert.equal(r.status, 0);
  });

  it('UT-COMMIT-MSG-19: 不做：本表不要求 PR/CI 接线（E12 分界）', () => {
    const wfDir = path.join(REPO_ROOT, '.github/workflows');
    if (fs.existsSync(wfDir)) {
      const ymls = fs.readdirSync(wfDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
      const all = ymls.map((f) => fs.readFileSync(path.join(wfDir, f), 'utf8')).join('\n');
      // E11 不要求 CI 接线；即便尚未接线也不得本表 FAIL
      assert.ok(typeof all === 'string');
    }
    assert.ok(true, 'E12 另表锁 PR 调同一脚本；本表只锁本地钩子 + 日修沙盒');
  });

  it('UT-COMMIT-MSG-20: 不做：不要求密钥扫描 / 不改历史提交（E13 分界）', () => {
    // 测码只写临时消息文件，不 git commit --amend；不要求 pre-commit 扫密钥
    const r = runCheck('chore(e11): probe\n\nbody\n');
    assert.equal(r.status, 0);
    const preCommit = path.join(REPO_ROOT, '.githooks/pre-commit');
    // E11 不要求在本项实现密钥扫描；不以 pre-commit 未扫密钥为 FAIL
    assert.ok(fs.existsSync(preCommit) || !fs.existsSync(preCommit));
  });

  it('UT-COMMIT-MSG-21: residual：不强制重写 commit-message SKILL 全文', () => {
    const skill = path.join(REPO_ROOT, '.agents/skills/commit-message/SKILL.md');
    // 允许 SKILL 仍描述旧两段；不以未改为 FAIL
    if (fs.existsSync(skill)) {
      assert.ok(fs.statSync(skill).isFile());
    }
    assert.ok(true, '运行时门禁以共享脚本 + UT-COMMIT-MSG-08/10 为准');
  });
});
