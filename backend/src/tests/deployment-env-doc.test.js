/**
 * E17：部署文档 §3 环境变量名 ↔ 代码 ↔ `.env.example` 三方一致。
 * 只读 Markdown / example / 源码文本扫描，不启动 Express / Vite，不连 Redis，不发 HTTP。
 * 合法修法：补 §3 表或补 example；禁止删掉业务仍在读的 env 访问来凑绿。
 * residual：两份 example 都没有的内部开关不要求进表。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DEPLOY_DOC = path.join(REPO_ROOT, 'docs/deployment-and-operations.md');
const BACKEND_EXAMPLE = path.join(REPO_ROOT, 'backend/.env.example');
const FRONTEND_EXAMPLE = path.join(REPO_ROOT, 'frontend/.env.example');
const BACKEND_SRC = path.join(REPO_ROOT, 'backend/src');
const FRONTEND_SRC = path.join(REPO_ROOT, 'frontend/src');

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const FIRST_COL_NAME_RE = /`([A-Z][A-Z0-9_]*)`|^([A-Z][A-Z0-9_]*)$/;

/**
 * 按 ATX 切出从 `## 3.`（标题含「环境变量」）到下一同级 `## ` 之前的正文。
 * @param {string} md
 * @returns {string}
 */
export function extractSection3(md) {
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+3\./.test(lines[i]) && /环境变量/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/**
 * 从 §3 Markdown 切片解析表格第一列环境变量名集合 T。
 * @param {string} section3
 * @returns {Set<string>}
 */
export function parseTableEnvNames(section3) {
  const names = new Set();
  for (const line of section3.split('\n')) {
    if (!/^\|/.test(line) || /^\|\s*:?-+:?\s*\|/.test(line)) continue;
    // 标准 Markdown 表：首尾为空段，parts[0] 为第一列
    const parts = line.split('|').slice(1, -1).map((c) => c.trim());
    if (parts.length === 0) continue;
    const first = parts[0];
    if (!first || /配置项|环境变量|必填/.test(first)) continue;
    const m = first.match(FIRST_COL_NAME_RE);
    if (!m) continue;
    const name = m[1] || m[2];
    if (ENV_NAME_RE.test(name)) names.add(name);
  }
  return names;
}

/**
 * 解析 `.env.example` 文本中的 KEY 集合（忽略空行与整行 # 注释）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function parseEnvExampleKeys(text) {
  const keys = new Set();
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Z][A-Z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * 源码中是否出现 process.env.<名> / process.env['名'] / process.env["名"]。
 * @param {string} corpus
 * @param {string} name
 */
export function hasProcessEnvAccess(corpus, name) {
  return (
    corpus.includes(`process.env.${name}`)
    || corpus.includes(`process.env['${name}']`)
    || corpus.includes(`process.env["${name}"]`)
  );
}

/**
 * 源码中是否出现 import.meta.env.<名> 等价字面。
 * @param {string} corpus
 * @param {string} name
 */
export function hasImportMetaEnvAccess(corpus, name) {
  return (
    corpus.includes(`import.meta.env.${name}`)
    || corpus.includes(`import.meta.env['${name}']`)
    || corpus.includes(`import.meta.env["${name}"]`)
  );
}

/**
 * 递归收集目录下源码文本（可排除子目录名）。
 * @param {string} rootDir
 * @param {{ excludeDirNames?: string[], extensions?: string[] }} [opts]
 * @returns {string}
 */
export function collectSourceCorpus(rootDir, opts = {}) {
  const exclude = new Set(opts.excludeDirNames || []);
  const extensions = opts.extensions || ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.vue'];
  const chunks = [];

  /**
   * @param {string} dir
   */
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (exclude.has(ent.name)) continue;
        walk(full);
        continue;
      }
      if (!extensions.some((ext) => ent.name.endsWith(ext))) continue;
      chunks.push(fs.readFileSync(full, 'utf8'));
    }
  }

  walk(rootDir);
  return chunks.join('\n');
}

/**
 * 完整三方校验。返回 { ok, errors[] }；errors 条目含方向语义与缺失标识符。
 * @param {{ tableNames: Set<string>, backendExampleKeys: Set<string>, frontendExampleKeys: Set<string>, backendCorpus: string, frontendCorpus: string }} input
 */
export function validateDeployEnvConsistency(input) {
  const {
    tableNames,
    backendExampleKeys,
    frontendExampleKeys,
    backendCorpus,
    frontendCorpus,
  } = input;
  /** @type {string[]} */
  const errors = [];

  for (const k of backendExampleKeys) {
    if (!tableNames.has(k)) {
      errors.push(`example 有但表无: ${k} (backend/.env.example)`);
    }
  }
  for (const k of frontendExampleKeys) {
    if (!tableNames.has(k)) {
      errors.push(`example 有但表无: ${k} (frontend/.env.example)`);
    }
  }

  for (const n of tableNames) {
    if (n.startsWith('VITE_')) {
      if (!hasImportMetaEnvAccess(frontendCorpus, n)) {
        errors.push(`表中有但代码无: ${n} (须 frontend import.meta.env)`);
      }
    } else if (!hasProcessEnvAccess(backendCorpus, n)) {
      errors.push(`表中有但代码无: ${n} (须 backend process.env)`);
    }
  }

  return { ok: errors.length === 0, errors };
}

const deployDoc = fs.readFileSync(DEPLOY_DOC, 'utf8');
const section3 = extractSection3(deployDoc);
const tableNames = parseTableEnvNames(section3);
const backendExampleKeys = parseEnvExampleKeys(fs.readFileSync(BACKEND_EXAMPLE, 'utf8'));
const frontendExampleKeys = parseEnvExampleKeys(fs.readFileSync(FRONTEND_EXAMPLE, 'utf8'));
// 扫描根：backend/src/**，排除 tests（测试文件命中不算生产配置契约）
const backendCorpus = collectSourceCorpus(BACKEND_SRC, { excludeDirNames: ['tests'] });
const frontendCorpus = collectSourceCorpus(FRONTEND_SRC, {
  extensions: ['.ts', '.tsx', '.vue', '.js'],
});

describe('2.41 E17 部署文档 §3 环境变量名三方一致', () => {
  it('UT-DOC-DEPLOY-01: 部署文档存在且可切出 §3', () => {
    assert.ok(fs.existsSync(DEPLOY_DOC), 'docs/deployment-and-operations.md 必须存在');
    assert.ok(deployDoc.length > 0, '部署文档不得为空');
    assert.ok(section3.length > 0, '须切出非空 §3');
    assert.equal(
      /^##\s+4\./m.test(section3),
      false,
      '§3 切片不得包含下一节 ## 4. 标题行',
    );
    assert.ok(
      /\|\s*:?-+:?\s*\|/.test(section3),
      '§3 内至少出现一处 Markdown 表格分隔行',
    );
  });

  it('UT-DOC-DEPLOY-02: §3 表格第一列可解析出环境变量名集合 T', () => {
    assert.ok(tableNames.size >= 1, 'T 至少含 1 个环境变量名');
    assert.ok(tableNames.has('PORT'), '现网后端表须含 PORT');
    assert.ok(tableNames.has('OPENAI_API_KEY'), '现网后端表须含 OPENAI_API_KEY');
    assert.equal(tableNames.has('配置项'), false, '表头中文不得进入 T');
    assert.equal(tableNames.has('环境变量'), false, '表头「环境变量」不得进入 T');
  });

  it('UT-DOC-DEPLOY-03: 非 VITE_ 表名须出现 process.env.<名>', () => {
    const missing = [];
    for (const n of tableNames) {
      if (n.startsWith('VITE_')) continue;
      if (!hasProcessEnvAccess(backendCorpus, n)) missing.push(n);
    }
    assert.equal(
      missing.length,
      0,
      `表中有但代码无（backend process.env）: ${missing.join(', ')}`,
    );
  });

  it('UT-DOC-DEPLOY-04: VITE_ 表名只查前端 import.meta.env.<名>', () => {
    const viteNames = [...tableNames].filter((n) => n.startsWith('VITE_'));
    const missing = [];
    for (const n of viteNames) {
      if (!hasImportMetaEnvAccess(frontendCorpus, n)) missing.push(n);
      // 仅后端命中不足以 PASS：即使后端误写 process.env.VITE_*，仍要求前端字面
      assert.equal(
        hasImportMetaEnvAccess(frontendCorpus, n),
        true,
        `${n} 须在 frontend 出现 import.meta.env 访问形`,
      );
    }
    assert.equal(missing.length, 0, `VITE_ 表名前端缺失: ${missing.join(', ')}`);
  });

  it('UT-DOC-DEPLOY-05: backend/.env.example 每个键 ∈ T', () => {
    const orphans = [...backendExampleKeys].filter((k) => !tableNames.has(k));
    assert.equal(
      orphans.length,
      0,
      `example 有但表无: ${orphans.join(', ')} (backend/.env.example)`,
    );
  });

  it('UT-DOC-DEPLOY-06: frontend/.env.example 每个键 ∈ T', () => {
    const orphans = [...frontendExampleKeys].filter((k) => !tableNames.has(k));
    assert.equal(
      orphans.length,
      0,
      `example 有但表无: ${orphans.join(', ')} (frontend/.env.example)`,
    );
  });

  it('UT-DOC-DEPLOY-07: example→表与表→代码同时满足（主路径合取）', () => {
    const result = validateDeployEnvConsistency({
      tableNames,
      backendExampleKeys,
      frontendExampleKeys,
      backendCorpus,
      frontendCorpus,
    });
    assert.equal(
      result.ok,
      true,
      `三方一致性失败:\n${result.errors.join('\n')}`,
    );
  });

  it('UT-DOC-DEPLOY-08: 夹具：表有名但代码无读 → 失败', () => {
    const result = validateDeployEnvConsistency({
      tableNames: new Set(['NOT_A_REAL_ENV_VAR_XYZ']),
      backendExampleKeys: new Set(),
      frontendExampleKeys: new Set(),
      backendCorpus: 'const x = 1;\n',
      frontendCorpus: '',
    });
    assert.equal(result.ok, false);
    const msg = result.errors.join(';');
    assert.match(msg, /表中有但代码无/);
    assert.match(msg, /NOT_A_REAL_ENV_VAR_XYZ/);
  });

  it('UT-DOC-DEPLOY-09: 夹具：example 有键但表无 → 失败', () => {
    const result = validateDeployEnvConsistency({
      tableNames: new Set(['PORT']),
      backendExampleKeys: new Set(['PORT', 'ORPHAN_EXAMPLE_KEY_XYZ']),
      frontendExampleKeys: new Set(),
      backendCorpus: 'process.env.PORT\n',
      frontendCorpus: '',
    });
    assert.equal(result.ok, false);
    const msg = result.errors.join(';');
    assert.match(msg, /example 有但表无/);
    assert.match(msg, /ORPHAN_EXAMPLE_KEY_XYZ/);
  });

  it('UT-DOC-DEPLOY-10: 夹具：VITE_ 名不得用后端 process.env 冒充', () => {
    const result = validateDeployEnvConsistency({
      tableNames: new Set(['VITE_FAKE_ONLY']),
      backendExampleKeys: new Set(),
      frontendExampleKeys: new Set(),
      backendCorpus: 'process.env.VITE_FAKE_ONLY\n',
      frontendCorpus: 'const x = 1;\n',
    });
    assert.equal(result.ok, false, '不得因后端命中而 PASS');
    assert.match(result.errors.join(';'), /VITE_FAKE_ONLY/);
    assert.match(result.errors.join(';'), /表中有但代码无/);
  });

  it('UT-DOC-DEPLOY-11: 扫描范围不含把测试文件当唯一命中源', () => {
    // 夹具：仅 tests 语料含访问形 → 业务 corpus 无命中应失败
    const fixtureTable = new Set(['ONLY_IN_TEST_ENV']);
    const businessCorpus = 'export const noop = 1;\n';
    const testsOnlyCorpus = "process.env.ONLY_IN_TEST_ENV = 'x';\n";
    assert.equal(hasProcessEnvAccess(businessCorpus, 'ONLY_IN_TEST_ENV'), false);
    assert.equal(hasProcessEnvAccess(testsOnlyCorpus, 'ONLY_IN_TEST_ENV'), true);
    const result = validateDeployEnvConsistency({
      tableNames: fixtureTable,
      backendExampleKeys: new Set(),
      frontendExampleKeys: new Set(),
      backendCorpus: businessCorpus,
      frontendCorpus: '',
    });
    assert.equal(result.ok, false, '测试文件命中不算');

    // 真实业务已读变量：backendCorpus（已排除 tests）仍应命中
    assert.ok(
      hasProcessEnvAccess(backendCorpus, 'PORT'),
      '真实 PORT 须在非 tests 业务源码中可读',
    );
  });

  it('UT-DOC-DEPLOY-12: 修法：允许补表/补 example，禁止删代码读凑绿', () => {
    // 契约锁在本文件注释与断言语义：PASS 不要求删除业务 process.env 读
    const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.match(src, /禁止删掉业务仍在读的 env/);
    assert.match(src, /合法修法：补 §3 表或补 example/);
    assert.equal(
      /删除业务源码中的 `?process\.env/.test(src) && /使本表变绿的合法步骤/.test(src),
      false,
    );
    // 现网主路径已绿，证明修法走的是补表而非删代码读
    const result = validateDeployEnvConsistency({
      tableNames,
      backendExampleKeys,
      frontendExampleKeys,
      backendCorpus,
      frontendCorpus,
    });
    assert.equal(result.ok, true);
  });

  it('UT-DOC-DEPLOY-13: 不做：不改 AI 防护白皮书', () => {
    // 本表只锁部署文档 §3；不得把 AI 防护白皮书列为必读路径常量
    const pathConsts = [DEPLOY_DOC, BACKEND_EXAMPLE, FRONTEND_EXAMPLE];
    for (const p of pathConsts) {
      assert.equal(
        path.basename(p) === 'security-ai-guard.md',
        false,
        '必读路径不得指向 AI 防护白皮书',
      );
    }
    assert.ok(fs.existsSync(DEPLOY_DOC));
    // 与 UT-DOC-GUARD-* 分界：那些 ID 锁防护白皮书，本表不读、不改
    assert.equal(
      pathConsts.some((p) => p.endsWith('security-ai-guard.md')),
      false,
    );
  });

  it('UT-DOC-DEPLOY-14: 不做：不对齐散文 / 架构图 / Nginx / §6 字典', () => {
    // T 仅来自 §3；§6 静态服变量名不得自动并入
    const section6Start = deployDoc.indexOf('## 6.');
    assert.ok(section6Start > 0, '文档须有 §6');
    const section6 = deployDoc.slice(section6Start);
    assert.ok(/PM2_SERVE_PATH/.test(section6) || /STATIC_API_PROXY/.test(section6));
    assert.equal(
      tableNames.has('PM2_SERVE_PATH'),
      false,
      '§6 名不得因未进 §3 而自动进入 T（且 example 无该键时主路径不因此失败）',
    );
  });

  it('UT-DOC-DEPLOY-15: 不做：不要求业务代码新增环境变量', () => {
    // 表中出现从未读取的名 → 表→代码失败；修法改表/example，不强制加读取
    const result = validateDeployEnvConsistency({
      tableNames: new Set(['BRAND_NEW_ENV_NEVER_READ_XYZ']),
      backendExampleKeys: new Set(['BRAND_NEW_ENV_NEVER_READ_XYZ']),
      frontendExampleKeys: new Set(),
      backendCorpus,
      frontendCorpus,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join(';'), /表中有但代码无/);
    assert.match(result.errors.join(';'), /BRAND_NEW_ENV_NEVER_READ_XYZ/);
  });

  it('UT-DOC-DEPLOY-16: residual：两份 example 都没有的内部开关不要求进表', () => {
    const internal = 'AI_GUARD_DEBUG';
    assert.ok(
      hasProcessEnvAccess(backendCorpus, internal),
      '现网候选内部开关须仍在业务源码中',
    );
    assert.equal(backendExampleKeys.has(internal), false);
    assert.equal(frontendExampleKeys.has(internal), false);
    assert.equal(tableNames.has(internal), false);
    // 主路径不得仅因「代码有读、§3 无该名」失败
    const result = validateDeployEnvConsistency({
      tableNames,
      backendExampleKeys,
      frontendExampleKeys,
      backendCorpus,
      frontendCorpus,
    });
    assert.equal(result.ok, true);
  });

  it('UT-DOC-DEPLOY-17: .env.example 解析忽略注释与空行', () => {
    const fixture = [
      '',
      '# PORT=ignore',
      'PORT=3000',
      'garbage-without-equals',
      'JWT_SECRET=abc#def',
      '  ',
    ].join('\n');
    const keys = parseEnvExampleKeys(fixture);
    assert.ok(keys.has('PORT'));
    assert.ok(keys.has('JWT_SECRET'));
    assert.equal(keys.has('ignore'), false);
    assert.equal(keys.size, 2);
  });

  it('UT-DOC-DEPLOY-18: §3 范围：不得把 §4/§6 表误并入 T', () => {
    assert.equal(/^##\s+4\./m.test(section3), false);
    assert.equal(/全量环境变量字典/.test(section3), false);
    // 人为把 §6 名排除在 §3 外且不在 example → 主路径不失败
    assert.equal(backendExampleKeys.has('PM2_SERVE_PORT'), false);
    assert.equal(tableNames.has('PM2_SERVE_PORT'), false);
  });

  it('UT-DOC-DEPLOY-19: 与 E13/E14 分界：本表不锁密钥扫描或覆盖率门禁', () => {
    // 范围 = 部署 §3 变量名 ↔ 代码 ↔ .env.example；不得以 E13/E14 的 PASS 替代本表
    const thisFile = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
    assert.match(thisFile, /E17/);
    assert.match(thisFile, /deployment-and-operations\.md/);
    // 本表不 import / 不 spawn 密钥扫描脚本或覆盖率报告脚本
    assert.equal(
      /from ['"].*qa-report|spawnSync\([^)]*qa-report|require\([^)]*pre-commit/.test(thisFile),
      false,
    );
  });

  it('UT-DOC-DEPLOY-20: 失败信息可判定：点名缺失侧与标识符', () => {
    const a = validateDeployEnvConsistency({
      tableNames: new Set(['NOT_A_REAL_ENV_VAR_XYZ']),
      backendExampleKeys: new Set(),
      frontendExampleKeys: new Set(),
      backendCorpus: '',
      frontendCorpus: '',
    });
    const b = validateDeployEnvConsistency({
      tableNames: new Set(['PORT']),
      backendExampleKeys: new Set(['ORPHAN_EXAMPLE_KEY_XYZ']),
      frontendExampleKeys: new Set(),
      backendCorpus: 'process.env.PORT',
      frontendCorpus: '',
    });
    assert.match(a.errors.join(';'), /表中有但代码无/);
    assert.match(a.errors.join(';'), /NOT_A_REAL_ENV_VAR_XYZ/);
    assert.match(b.errors.join(';'), /example 有但表无/);
    assert.match(b.errors.join(';'), /ORPHAN_EXAMPLE_KEY_XYZ/);
  });
});
