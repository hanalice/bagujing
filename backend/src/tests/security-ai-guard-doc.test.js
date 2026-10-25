/**
 * S8：对齐 docs/security-ai-guard.md 与签名默认 / 会话验签 / 前端 env 名。
 * 用例 ID 与 docs/test_cases.md §2.33 对齐；只读 Markdown + 对照源码，不发 HTTP / 不连 Redis。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const DOC_PATH = path.join(REPO_ROOT, 'docs/security-ai-guard.md');
const GUARD_JS = path.join(REPO_ROOT, 'backend/src/security/ai-guard.js');
const AI_AUTH_TS = path.join(REPO_ROOT, 'frontend/src/utils/ai-auth.ts');

const REQUIRE_SIGNED_DEFAULT =
  "String(process.env.AI_REQUIRE_SIGNED_HEADERS ?? 'false').toLowerCase() === 'true'";

/**
 * 按 ATX 标题切出从 startHeading 到下一个同级或更高级标题之间的正文。
 * @param {string} md
 * @param {string} startHeading 如 `## 7.` 或 `### 5.3`
 */
function sectionBetween(md, startHeading) {
  const startIdx = md.indexOf(startHeading);
  assert.ok(startIdx >= 0, `文档须含标题 ${startHeading}`);
  const afterStart = md.slice(startIdx);
  const level = startHeading.match(/^#+/)[0].length;
  const nextRe = new RegExp(`\\n#{1,${level}}\\s`, 'g');
  nextRe.lastIndex = afterStart.indexOf('\n') + 1;
  const m = nextRe.exec(afterStart);
  return m ? afterStart.slice(0, m.index) : afterStart;
}

/**
 * 文末 checklist 行（`- [x]` / `- [ ]`）。
 * @param {string} md
 */
function checklistLines(md) {
  return md.split('\n').filter((line) => /^-\s\[[ x]\]\s/.test(line));
}

describe('2.33 S8 对齐 security-ai-guard.md（签名默认 / 会话验签 / 前端 env）', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const guardSrc = fs.readFileSync(GUARD_JS, 'utf8');
  const aiAuthSrc = fs.readFileSync(AI_AUTH_TS, 'utf8');

  it('UT-DOC-GUARD-01: 白皮书存在且含验签开关名与默认 false', () => {
    assert.ok(fs.existsSync(DOC_PATH), 'docs/security-ai-guard.md 必须存在');
    assert.ok(doc.includes('AI_REQUIRE_SIGNED_HEADERS'), '文档须出现 AI_REQUIRE_SIGNED_HEADERS');

    const switchIdx = doc.indexOf('AI_REQUIRE_SIGNED_HEADERS');
    const window = doc.slice(Math.max(0, switchIdx - 80), switchIdx + 220);
    const hasDefaultFalse =
      (/默认/.test(window) && /false/.test(window)) ||
      window.includes("?? 'false'") ||
      window.includes('?? "false"');
    assert.ok(hasDefaultFalse, '同一段落或相邻句须写明代码默认 false / 未设置不强制验签');

    assert.ok(
      guardSrc.includes(REQUIRE_SIGNED_DEFAULT),
      `ai-guard.js 须保留 ${REQUIRE_SIGNED_DEFAULT}`,
    );
  });

  it('UT-DOC-GUARD-02: 开关 true 时写明有登录会话也验签（B31）', () => {
    const hasSessionAlso =
      /AI_REQUIRE_SIGNED_HEADERS[\s\S]{0,400}(有登录会话也|有会话也必须验签|登录会话也必须)/.test(doc) ||
      /(有登录会话也|有会话也必须验签)[\s\S]{0,200}AI_REQUIRE_SIGNED_HEADERS/.test(doc) ||
      /开关为\s*`?true`?[\s\S]{0,200}有登录会话也/.test(doc);
    assert.ok(hasSessionAlso, '文档须明确：开关 true 时有登录会话也必须验签');

    const namesB31 =
      doc.includes('B31') ||
      /forceSignatureCheck[\s\S]{0,120}req\.user/.test(doc) ||
      /与是否有\s*`?req\.user`?/.test(doc);
    assert.ok(namesB31, '须点名 B31 或写 forceSignatureCheck 与 req.user 无关');
  });

  it('UT-DOC-GUARD-03: 禁止「仅无会话才验签」过时措辞', () => {
    const forbidden = [
      /仅无会话/,
      /仅无登录会话/,
      /无登录会话的机调/,
    ];
    for (const re of forbidden) {
      assert.equal(re.test(doc), false, `全文不得出现过时措辞：${re}`);
    }

    const sec51 = sectionBetween(doc, '### 5.1');
    assert.equal(
      /解析与校验签名头（无登录会话的机调）/.test(sec51),
      false,
      '§5.1 不得再把验签职责写成只服务无登录会话的机调',
    );
  });

  it('UT-DOC-GUARD-04: 「默认拒绝 / fail closed」限定为开关打开后', () => {
    const principleLine = doc
      .split('\n')
      .find((l) => /默认拒绝|fail closed/i.test(l));
    assert.ok(principleLine, '设计原则须含「默认拒绝」或 fail closed');
    const principleOk =
      /AI_REQUIRE_SIGNED_HEADERS\s*=\s*true/.test(principleLine) ||
      /开关打开后/.test(principleLine) ||
      /强制验签开启时/.test(principleLine);
    assert.ok(principleOk, '原则中「默认拒绝」句须带开关限定语');

    const sec8 = sectionBetween(doc, '## 8.');
    const accept1 = sec8
      .split('\n')
      .find((l) => /未携带签名头|签名错误|nonce/.test(l));
    assert.ok(accept1, '§8 须有签名拒绝相关验收条');
    const acceptOk =
      /AI_REQUIRE_SIGNED_HEADERS\s*=\s*true/.test(accept1) ||
      /开关打开后/.test(accept1) ||
      /强制验签开启时/.test(accept1);
    assert.ok(acceptOk, '§8 签名拒绝条须限定为开关打开后');
  });

  it('UT-DOC-GUARD-05: 「双重验证」限定为开关打开后', () => {
    const dualRe = /双重验证|身份\s*\+\s*签名|身份 \+ 签名/;
    if (dualRe.test(doc)) {
      const idx = doc.search(dualRe);
      const window = doc.slice(Math.max(0, idx - 200), idx + 120);
      const limited =
        /AI_REQUIRE_SIGNED_HEADERS\s*=\s*true/.test(window) ||
        /验签开关打开/.test(window) ||
        /开关打开/.test(window);
      assert.ok(limited, '若保留「身份 + 签名 / 双重验证」须限定为开关打开后');
    }

    const sec53 = sectionBetween(doc, '### 5.3');
    assert.equal(
      /AI 路由优先校验[\s\S]{0,80}双重验证/.test(sec53) &&
        !/AI_REQUIRE_SIGNED_HEADERS|验签开关打开|开关打开/.test(
          sec53.match(/AI 路由优先校验[\s\S]{0,200}/)?.[0] || '',
        ),
      false,
      '不得写无开关限定的旧 §5.3「双重验证」blockquote',
    );

    assert.ok(
      /默认关闭|默认\s*`?false`?|未设开关/.test(doc) &&
        /无 HMAC|可无签名头|可无 HMAC/.test(doc),
      '默认关闭时须承认有会话可无 HMAC 头进入后续限流/业务',
    );
  });

  it('UT-DOC-GUARD-06: 前端 env 名为 VITE_AI_CLIENT_SECRET', () => {
    assert.ok(doc.includes('VITE_AI_CLIENT_SECRET'), '文档须出现 VITE_AI_CLIENT_SECRET');
    assert.equal(
      doc.includes('VITE_AI_CLIENT_TOKEN'),
      false,
      '全文不得出现错误名 VITE_AI_CLIENT_TOKEN',
    );
    assert.ok(
      aiAuthSrc.includes('import.meta.env.VITE_AI_CLIENT_SECRET'),
      'ai-auth.ts 须从 VITE_AI_CLIENT_SECRET 取值',
    );
    assert.equal(
      /\bVITE_AI_CLIENT_TOKEN\b/.test(aiAuthSrc),
      false,
      'ai-auth.ts 源码不得含 VITE_AI_CLIENT_TOKEN 标识符',
    );
  });

  it('UT-DOC-GUARD-07: 清单：有 Redis 时限流/并发已完成（B51/B52）', () => {
    const lines = checklistLines(doc);
    const rateDone = lines.some(
      (l) =>
        /^-\s\[x\]/.test(l) &&
        (/限流/.test(l) || /rl:/.test(l) || /B51/.test(l)),
    );
    const concDone = lines.some(
      (l) =>
        /^-\s\[x\]/.test(l) &&
        (/并发/.test(l) || /cc:/.test(l) || /B52/.test(l)),
    );
    assert.ok(rateDone, '清单须将有 Redis 时限流标为已完成');
    assert.ok(concDone, '清单须将有 Redis 时并发标为已完成');

    const mentionsImpl =
      /B51/.test(doc) && /B52/.test(doc) ||
      (/INCR/.test(doc) && (/rl:/.test(doc) || /cc:/.test(doc)));
    assert.ok(mentionsImpl, '须能看到 B51/B52 或 INCR + rl:/cc: 已实现说明');

    assert.equal(
      lines.some(
        (l) =>
          /^-\s\[\s\]/.test(l) &&
          /完全态/.test(l) &&
          /限流/.test(l) &&
          /配额/.test(l),
      ),
      false,
      '不得仍用一条未勾选「完全态」把 Redis 限流+并发整段标成未做',
    );
  });

  it('UT-DOC-GUARD-08: 清单：配额仍进程内/SQL，未标 Redis 完成', () => {
    const lines = checklistLines(doc);
    const quotaOpen = lines.some(
      (l) =>
        /^-\s\[\s\]/.test(l) &&
        (/配额/.test(l) || /quota/i.test(l) || /Token 上限/.test(l)),
    );
    const quotaBodyIncomplete =
      /配额[\s\S]{0,80}(仍进程内|SQLite|dbPool|尚未.*Redis|未迁 Redis)/.test(doc);
    assert.ok(
      quotaOpen || quotaBodyIncomplete,
      '配额迁移 Redis / 配额完全态须保持未完成',
    );

    assert.equal(
      /日\/月 Token 配额[\s\S]{0,40}已走 Redis INCR|配额写成已走 Redis INCR/.test(doc),
      false,
      '不得把日/月 Token 配额写成已走 Redis INCR',
    );
  });

  it('UT-DOC-GUARD-09: §5.3：换票 JWT 与 HMAC 六头（B33）分写，禁止「全面注入」', () => {
    const sec53 = sectionBetween(doc, '### 5.3');
    assert.ok(sec53.includes('buildAiAuthHeaders'), '§5.3 须点名 buildAiAuthHeaders');
    for (const h of [
      'X-Client-Id',
      'X-Client-Token',
      'X-Ts',
      'X-Nonce',
      'X-Body-Sha256',
      'X-Signature',
    ]) {
      assert.ok(sec53.includes(h), `§5.3 须列出六头 ${h}`);
    }
    assert.ok(/\/api\/chat/.test(sec53), '§5.3 须限定 POST /api/chat');
    assert.ok(
      /answer\/generate/.test(sec53),
      '§5.3 须限定 answer/generate',
    );
    assert.ok(sec53.includes('B33'), '§5.3 须指向 B33');

    assert.ok(
      /fetchAiSessionToken|ensureAiSessionToken/.test(sec53),
      '§5.3 须另写换票 JWT 路径',
    );
    assert.ok(/\/api\/auth\/token/.test(sec53), '§5.3 须点名 POST /api/auth/token');

    // 旧句「对受保护路径自动注入签名头」若仍出现，同段必须带路径/B33/isAiProtectedPath 范围
    if (/对受保护路径自动注入签名头/.test(sec53)) {
      assert.ok(
        /B33|isAiProtectedPath|\/api\/chat/.test(sec53),
        '若保留「自动注入签名头」措辞须带路径/B33 范围',
      );
    }
    // 禁止肯定式「已全面注入」；允许说明「不作用于全部路由」
    assert.equal(
      /已全面注入\s*HMAC|HMAC\s*已全面注入|所有前端请求均.*HMAC|全部 AI 路径已/.test(sec53),
      false,
      '不得写成 HMAC 已全面注入所有路由',
    );
  });

  it('UT-DOC-GUARD-10: residual：WAF / 封禁 / 告警 / 报表仍未完成', () => {
    const lines = checklistLines(doc);
    const stillOpen = (kw) =>
      lines.some((l) => /^-\s\[\s\]/.test(l) && l.includes(kw)) ||
      new RegExp(`${kw}[\\s\\S]{0,40}(未来|未完成|尚未)`).test(doc);

    assert.ok(stillOpen('WAF'), 'WAF 须仍为未勾选或标明未来项');
    assert.ok(stillOpen('自动封禁'), '自动封禁须仍为未勾选或标明未来项');
    assert.ok(stillOpen('成本告警'), '成本告警须仍为未勾选或标明未来项');
    assert.ok(
      lines.some((l) => /^-\s\[\s\]/.test(l) && /审计/.test(l) && /报表|可视化/.test(l)),
      '审计可视化/报表须仍为未勾选',
    );

    for (const kw of ['WAF', '自动封禁', '成本告警']) {
      assert.equal(
        lines.some((l) => /^-\s\[x\]/.test(l) && l.includes(kw)),
        false,
        `不得因本项把 ${kw} 改成 [x]`,
      );
    }
  });

  it('UT-DOC-GUARD-11: residual：公开文档不写利用步骤', () => {
    const exploitHints = [
      /openssl\s+[^\n]+HMAC/i,
      /node\s+-e[\s\S]{0,200}X-Signature/,
      /curl[\s\S]{0,300}X-Signature[\s\S]{0,200}http/,
    ];
    for (const re of exploitHints) {
      assert.equal(re.test(doc), false, `不得给出可复现伪造 HMAC 配方：${re}`);
    }
    // 允许算法名与基串模板
    assert.ok(/HMAC-SHA256/.test(doc), '允许保留 HMAC-SHA256');
  });

  it('UT-DOC-GUARD-12: 不做：本表不要求改代码默认或打开 B32', () => {
    assert.ok(
      guardSrc.includes(REQUIRE_SIGNED_DEFAULT),
      'ai-guard.js 默认解析式仍为 ?? false（本表不要求改成 true）',
    );
    // 本用例仅锁「不做」边界：文档对齐不得迫使改默认；断言文档未宣称「已默认强制验签」
    assert.equal(
      /代码默认\s*`?true`?[\s\S]{0,40}AI_REQUIRE_SIGNED_HEADERS|AI_REQUIRE_SIGNED_HEADERS[\s\S]{0,40}代码默认\s*`?true`?/.test(
        doc,
      ),
      false,
      '文档不得把代码默认写成 true',
    );
  });

  it('UT-DOC-GUARD-13: 配置基线节列出验签开关', () => {
    const sec7 = sectionBetween(doc, '## 7.');
    assert.ok(
      sec7.includes('AI_REQUIRE_SIGNED_HEADERS'),
      '§7 须列出 AI_REQUIRE_SIGNED_HEADERS',
    );
    assert.ok(sec7.includes('AI_GUARD_ENABLED'), '§7 须保留 AI_GUARD_ENABLED');

    const switchLine = sec7
      .split('\n')
      .find((l) => l.includes('AI_REQUIRE_SIGNED_HEADERS'));
    assert.ok(switchLine, '§7 须有含 AI_REQUIRE_SIGNED_HEADERS 的列表项');
    const notesDefault =
      /默认\s*`?false`?/.test(switchLine) ||
      /未设则不强制验签/.test(switchLine) ||
      /未设置不强制/.test(switchLine);
    assert.ok(notesDefault, '该条须注明默认 false 或未设则不强制验签');
  });
});
