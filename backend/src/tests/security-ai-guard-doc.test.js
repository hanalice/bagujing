/**
 * S8 / S11：对齐 docs/security-ai-guard.md。
 * S8（§2.33）：签名默认 / 会话验签 / 前端 env 名。
 * S11（§2.36）：去掉未实现的用户/角色配额表述。
 * 只读 Markdown + 对照源码，不发 HTTP / 不连 Redis / 不调 createAiGuard().middleware。
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

describe('2.36 S11 对齐 security-ai-guard.md（去掉未实现的用户/角色配额表述）', () => {
  const doc = fs.readFileSync(DOC_PATH, 'utf8');
  const guardSrc = fs.readFileSync(GUARD_JS, 'utf8');

  /** 从 checkAndConsumeQuota 起切一段源码，缩小 SQL 断言范围。 */
  function quotaFnSource(src) {
    const start = src.indexOf('const checkAndConsumeQuota');
    assert.ok(start >= 0, 'ai-guard.js 须含 checkAndConsumeQuota');
    return src.slice(start, start + 2500);
  }

  it('UT-DOC-QUOTA-01: §4.5 不得把「角色级配额」写成已落地策略', () => {
    const sec45 = sectionBetween(doc, '### 4.5');
    const oldBullet =
      /\*\*角色级配额\*\*[：:].*按用户角色.*日\/?月\s*Token\s*上限/.test(sec45);
    assert.equal(oldBullet, false, '不得保留无限定的旧「角色级配额」bullet');

    // 若仍提及角色与配额同段，必须带「未实现 / 没有 / 不」等现状否定
    if (/角色/.test(sec45) && /配额|Token\s*上限/.test(sec45)) {
      const hasNegation =
        /没有[\s\S]{0,40}角色|未[\s\S]{0,20}按角色|不[\s\S]{0,20}按[\s\S]{0,20}角色|角色级配额未实现|未实现/.test(
          sec45,
        );
      assert.ok(hasNegation, '若保留角色+配额描述，须明确现状未按角色行覆盖');
    }
  });

  it('UT-DOC-QUOTA-02: §4.5 不得把「用户级覆盖」写成已落地策略', () => {
    const sec45 = sectionBetween(doc, '### 4.5');
    const oldBullet =
      /\*\*用户级覆盖\*\*[：:].*单独调优配额/.test(sec45) ||
      /优先级高于角色配额/.test(sec45);
    assert.equal(oldBullet, false, '不得保留无限定的旧「用户级覆盖」bullet');

    if (/用户级/.test(sec45) && /配额/.test(sec45)) {
      const hasNegation =
        /没有[\s\S]{0,40}用户|未实现|用户级[\s\S]{0,20}配额未实现|不[\s\S]{0,30}按登录用户/.test(
          sec45,
        );
      assert.ok(hasNegation, '若保留用户级+配额描述，须带未实现/没有等限定');
    }
  });

  it('UT-DOC-QUOTA-03: §4.5 如实写现状：全局 env + ai_clients，无用户/角色行覆盖', () => {
    const sec45 = sectionBetween(doc, '### 4.5');
    const hasGlobalEnv =
      /AI_GLOBAL_DAILY_TOKEN_LIMIT/.test(sec45) ||
      /AI_DAILY_TOKEN_LIMIT_PER_CLIENT/.test(sec45) ||
      /AI_GLOBAL_DAILY_REQUEST_LIMIT/.test(sec45);
    const hasAiClients =
      /ai_clients/.test(sec45) &&
      (/daily_token_limit/.test(sec45) || /daily_request_limit/.test(sec45));
    assert.ok(
      hasGlobalEnv || hasAiClients,
      '§4.5 须写明限额来自全局 env 与/或 ai_clients',
    );

    const hasCounting =
      /进程内/.test(sec45) ||
      (/ai_audit_logs/.test(sec45) && /client_id/.test(sec45)) ||
      /dbPool/.test(sec45);
    assert.ok(hasCounting, '§4.5 须写明进程内 Map 与/或按 client_id 审计汇总');

    const deniesUserOrRole =
      /(没有|未|不).{0,40}(登录用户|用户主键|角色).{0,40}(配额|上限|覆盖)/.test(sec45) ||
      /(没有|未|不).{0,40}(按登录用户|按.*角色).{0,40}(配额|上限)/.test(sec45) ||
      /用户级\s*\/\s*角色级配额未实现/.test(sec45);
    assert.ok(deniesUserOrRole, '§4.5 须明确否定按登录用户或角色行覆盖 Token 上限');
  });

  it('UT-DOC-QUOTA-04: §4.5「结果」不得宣称已到「具体用户」精细配额管控', () => {
    const sec45 = sectionBetween(doc, '### 4.5');
    const resultLine = sec45.split('\n').find((l) => /\*\*结果\*\*/.test(l)) || '';
    assert.equal(
      /从[“"]客户端[”"]到[“"]具体用户[”"]的精细化管控/.test(resultLine) ||
        /从“客户端”到“具体用户”的精细化管控/.test(resultLine),
      false,
      '不得再写无限定的「从客户端到具体用户的精细化管控」',
    );
    // 允许 429 / client/全局粒度
    assert.ok(
      /429|client|全局/.test(sec45),
      '允许写超限拒绝与 client/全局粒度',
    );
  });

  it('UT-DOC-QUOTA-05: §7 禁止 users/roles 表实时下发与 User>Role>Global 优先级链', () => {
    const sec7 = sectionBetween(doc, '## 7.');
    assert.equal(
      /通过\s*`users`\s*与\s*`roles`[\s\S]{0,40}实时下发/.test(sec7),
      false,
      '§7 不得把 users/roles 实时下发写成现行配置',
    );
    // 无「未实现」限定的优先级链禁止出现
    const priorityAsCurrent =
      /User\s*>\s*Role\s*>\s*Global(\s*Env)?/.test(sec7) &&
      !/(没有|未|不).{0,80}User\s*>\s*Role/.test(sec7);
    assert.equal(
      priorityAsCurrent,
      false,
      '§7 不得出现无「未实现」限定的 User > Role > Global 优先级链',
    );
    assert.equal(
      /\*\*动态配额\*\*[：:].*users[\s\S]{0,80}roles[\s\S]{0,80}User\s*>\s*Role/.test(sec7),
      false,
      '不得保留旧「动态配额」bullet',
    );
  });

  it('UT-DOC-QUOTA-06: §7 列出真实配额配置源（全局 env / ai_clients）', () => {
    const sec7 = sectionBetween(doc, '## 7.');
    const hasGlobal =
      /AI_GLOBAL_DAILY_TOKEN_LIMIT/.test(sec7) ||
      /AI_GLOBAL_DAILY_REQUEST_LIMIT/.test(sec7);
    const hasPerClient =
      /AI_DAILY_TOKEN_LIMIT_PER_CLIENT/.test(sec7) ||
      /AI_DAILY_REQUEST_LIMIT_PER_CLIENT/.test(sec7);
    const hasAiClientsCols =
      /ai_clients/.test(sec7) &&
      (/daily_token_limit/.test(sec7) || /日\s*Token/.test(sec7) || /请求限额/.test(sec7));
    assert.ok(
      (hasGlobal && hasPerClient) || hasAiClientsCols,
      '§7 须出现全局日限额 env 与 per-client env，或 ai_clients + 日限额列',
    );
    assert.ok(
      /进程内|SQLite|未迁 Redis/.test(sec7),
      '§7 须注明计数仍进程内 / SQLite（或未迁 Redis）',
    );
    assert.equal(
      /\*\*动态配额\*\*[：:].*`users`[\s\S]{0,40}`roles`/.test(sec7),
      false,
      '不得用「动态配额 + users/roles」替代真实源',
    );
  });

  it('UT-DOC-QUOTA-07: 清单：用户级配额不得标为已完成', () => {
    const lines = checklistLines(doc);
    assert.equal(
      lines.some(
        (l) =>
          /^-\s\[x\]/.test(l) &&
          /多租户\/多角色隔离策略（用户级配额、角色继承）/.test(l),
      ),
      false,
      '不得仍为 - [x] 多租户/多角色隔离策略（用户级配额、角色继承）原文',
    );

    const withUserQuota = lines.filter((l) => /用户级配额|按角色配额|角色级.*配额|用户级\/角色级\s*Token\s*配额/.test(l));
    for (const line of withUserQuota) {
      assert.ok(
        /^-\s\[\s\]/.test(line),
        `含用户级/角色级配额语义的清单项必须未完成：${line}`,
      );
    }

    // 若保留 [x] 的角色权限条，正文不得再含用户级配额
    const doneRoleLines = lines.filter(
      (l) => /^-\s\[x\]/.test(l) && /角色/.test(l),
    );
    for (const line of doneRoleLines) {
      assert.equal(
        /用户级配额|按角色配额/.test(line),
        false,
        `已勾选的角色相关条不得含用户级配额语义：${line}`,
      );
    }
  });

  it('UT-DOC-QUOTA-08: 清单：配额 Redis / WAF / 封禁 / 告警 / 报表仍未完成', () => {
    const lines = checklistLines(doc);
    const quotaRedisOpen = lines.some(
      (l) =>
        /^-\s\[\s\]/.test(l) &&
        /配额/.test(l) &&
        (/Redis|完全态/.test(l)),
    );
    assert.ok(quotaRedisOpen, '配额迁移到 Redis / 配额完全态须保持未完成');

    const stillOpen = (kw) =>
      lines.some((l) => /^-\s\[\s\]/.test(l) && l.includes(kw));
    assert.ok(stillOpen('WAF'), 'WAF 须仍为未勾选');
    assert.ok(stillOpen('自动封禁'), '自动封禁须仍为未勾选');
    assert.ok(stillOpen('成本告警'), '成本告警须仍为未勾选');
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

  it('UT-DOC-QUOTA-09: 全文禁止把未实现的用户/角色配额标成验收已通过', () => {
    const sec8 = sectionBetween(doc, '## 8.');
    assert.equal(
      /按登录用户.*日限额已实现|角色日限额已实现|用户级配额已实现|角色配额已实现/.test(sec8),
      false,
      '§8 不得宣称按登录用户/角色日限额已实现',
    );
    // 允许保留 client/全局日配额 429
    assert.ok(
      /日配额|全局配额/.test(sec8) && /429/.test(sec8),
      '允许保留达到日配额或全局配额后 429',
    );
    assert.equal(
      /user_daily_|role_daily_/.test(sec8),
      false,
      '§8 不得把日配额改写成 user/role reason',
    );
  });

  it('UT-DOC-QUOTA-10: 对照代码：无 users/roles 配额 SQL', () => {
    const quotaSrc = quotaFnSource(guardSrc);
    assert.equal(
      /FROM\s+users\b/i.test(quotaSrc),
      false,
      '配额路径 SQL 不得 FROM users',
    );
    assert.equal(
      /FROM\s+roles\b/i.test(quotaSrc),
      false,
      '配额路径 SQL 不得 FROM roles',
    );
    assert.ok(
      /FROM\s+ai_clients\b/i.test(quotaSrc) || /FROM\s+ai_audit_logs\b/i.test(quotaSrc),
      '有 db 时须可见 FROM ai_clients 与/或 FROM ai_audit_logs',
    );
    assert.ok(/client_id/.test(quotaSrc), '配额汇总须按 client_id');
  });

  it('UT-DOC-QUOTA-11: 不做：不要求改运行时 / 不实现用户角色配额 / 不改签名默认', () => {
    assert.ok(
      guardSrc.includes(REQUIRE_SIGNED_DEFAULT),
      'ai-guard.js 默认解析式仍为 ?? false（本表不要求改成 true）',
    );
    assert.equal(
      /user_daily_token_limit|user_daily_request_limit/.test(guardSrc),
      false,
      '本表不要求实现 user_daily_* reason（断言源码仍无即可）',
    );
    // 文档对齐边界：本表只锁配额措辞，不强制改运行时
    assert.ok(
      /没有[\s\S]{0,60}(登录用户|角色)|用户级[\s\S]{0,20}配额未实现/.test(doc),
      '文档须承认用户/角色配额未实现（锁措辞，不改代码）',
    );
  });

  it('UT-DOC-QUOTA-12: residual：用户/角色日限额另条；公开文档无利用步骤', () => {
    const exploitHints = [
      /openssl\s+[^\n]+HMAC/i,
      /node\s+-e[\s\S]{0,200}X-Signature/,
      /curl[\s\S]{0,300}X-Signature[\s\S]{0,200}http/,
    ];
    for (const re of exploitHints) {
      assert.equal(re.test(doc), false, `不得给出可复现伪造 HMAC 配方：${re}`);
    }
    assert.ok(/HMAC-SHA256/.test(doc), '允许保留 HMAC-SHA256');
    // residual：不以「文档未实现用户配额」为由要求改代码——源码仍无 user 配额即 PASS
    assert.equal(
      /FROM\s+users\b[\s\S]{0,80}daily_token_limit/i.test(guardSrc),
      false,
      '本阶段不得以文档对齐为由实现 users 表配额 SQL',
    );
  });
});
