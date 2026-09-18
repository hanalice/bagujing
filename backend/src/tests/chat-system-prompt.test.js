/**
 * B22 / P0-7：助教 system 不再要求仅 HTML 输出。
 * 用例 ID 与 docs/test_cases.md §2.18 对齐；PASS 仅锁 system 字符串，不判模型输出形态。
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_AUDIT_PATH,
  configureRouteTestEnv,
  installMockModelFetch,
  invokeRoute,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_EXPRESS_PATH = path.resolve(__dirname, '../server-express.js');
const THIS_TEST_PATH = fileURLToPath(import.meta.url);

/**
 * 从 server-express.js 源码中，按路由锚点抽取其后首个 `const systemPrompt = ...;` 拼接字面量。
 * @param {string} source
 * @param {string} routeNeedle 例如 `app.post('/api/chat'`
 * @returns {string}
 */
function extractSystemPromptForRoute(source, routeNeedle) {
  const routePos = source.indexOf(routeNeedle);
  assert.ok(routePos >= 0, `源码中未找到路由锚点: ${routeNeedle}`);
  const region = source.slice(routePos, routePos + 4000);
  const match = region.match(
    /const systemPrompt\s*=\s*((?:'(?:\\.|[^'\\])*'\s*(?:\+\s*)?)+);/,
  );
  assert.ok(match, `路由 ${routeNeedle} 后未解析到 systemPrompt 字面量拼接`);
  // eslint-disable-next-line no-new-func -- 仅求值已校验过的单引号字面量拼接，不执行其它代码
  return Function(`"use strict"; return (${match[1]});`)();
}

/**
 * 断言 chat system 满足 UT-CHAT-PROMPT-01（不再要求仅 HTML / 禁止 markdown）。
 * @param {string} systemPrompt
 */
function assertNoHtmlOnlyMandate(systemPrompt) {
  assert.equal(systemPrompt.includes('仅 body 内'), false, '不得含「仅 body 内」');
  assert.equal(
    systemPrompt.includes('请直接输出可用于前端展示的 HTML 片段'),
    false,
    '不得含「请直接输出可用于前端展示的 HTML 片段」',
  );
  assert.match(systemPrompt, /./, 'system 不得为空');
  assert.equal(
    /仅输出\s*HTML|只输出\s*HTML/i.test(systemPrompt),
    false,
    '不得含「仅/只输出 HTML」硬性指令',
  );
  // 禁令句：含「不要/禁止」且同句提及 markdown
  assert.equal(
    /(?:不要|禁止)[^\n]{0,40}markdown/i.test(systemPrompt),
    false,
    '不得含「不要/禁止 markdown」类禁令',
  );
}

/**
 * 断言 chat system 满足 UT-CHAT-PROMPT-02（不再强制 HTML 标签排版）。
 * @param {string} systemPrompt
 */
function assertNoForcedHtmlTags(systemPrompt) {
  assert.equal(
    systemPrompt.includes('<p>/<h3>/<ul>/<li>'),
    false,
    '不得含「使用 <p>/<h3>/<ul>/<li>」硬性指令',
  );
  assert.equal(
    /HTML\s*标签进行格式化/.test(systemPrompt),
    false,
    '不得含「HTML 标签进行格式化」',
  );
  assert.equal(
    /必须输出\s*HTML\s*标签/.test(systemPrompt),
    false,
    '不得出现「必须输出 HTML 标签」',
  );
}

/**
 * 断言 chat system 满足 UT-CHAT-PROMPT-03（保留角色与回答结构）。
 * @param {string} systemPrompt
 */
function assertRoleAndStructurePreserved(systemPrompt) {
  assert.ok(systemPrompt.trim().length > 20, '去掉 HTML 约束后 system 不得近乎空串');
  assert.ok(systemPrompt.includes('面试官'), '须保留「面试官」角色定位');
  assert.ok(systemPrompt.includes('简短结论'), '须保留「简短结论」结构要求');
  assert.ok(systemPrompt.includes('分点说明'), '须保留「分点说明」结构要求');
  assert.ok(
    /下一步|可操作/.test(systemPrompt),
    '须保留「下一步」或可操作建议类要求',
  );
  // 不得退化成仅防注入声明（防注入 notice 由 buildPromptMessages 另拼，不在本字面量内）
  assert.equal(
    /^\s*(?:忽略|不要泄露|UNTRUSTED)/i.test(systemPrompt.trim()),
    false,
    'system 不得仅剩防注入声明',
  );
}

describe('B22 / P0-7: 助教 system 不再要求仅 HTML 输出', () => {
  const serverSource = fs.readFileSync(SERVER_EXPRESS_PATH, 'utf8');
  const chatSystemPrompt = extractSystemPromptForRoute(serverSource, "app.post('/api/chat'");
  const generateSystemPrompt = extractSystemPromptForRoute(
    serverSource,
    "app.post('/api/problems/:id/answer/generate'",
  );

  it('UT-CHAT-PROMPT-01: 助教 system 不再要求「仅 body 内 HTML」', () => {
    assertNoHtmlOnlyMandate(chatSystemPrompt);
  });

  it('UT-CHAT-PROMPT-02: 助教 system 不再强制 HTML 标签排版', () => {
    assertNoForcedHtmlTags(chatSystemPrompt);
  });

  it('UT-CHAT-PROMPT-03: 助教 system 仍保留角色与回答结构', () => {
    assertRoleAndStructurePreserved(chatSystemPrompt);
  });

  it('UT-CHAT-PROMPT-04: 对照：answer/generate 的 HTML Prompt 不在 B22 范围', () => {
    assertNoHtmlOnlyMandate(chatSystemPrompt);
    assertNoForcedHtmlTags(chatSystemPrompt);
    // generate 仍可含 HTML 指令；出现时不得因此判本项 FAIL（此处仅作范围对照，不要求其去掉）
    const generateStillMentionsHtml =
      generateSystemPrompt.includes('HTML 片段')
      || generateSystemPrompt.includes('仅 body 内')
      || generateSystemPrompt.includes('<p>/<h3>');
    assert.equal(
      typeof generateStillMentionsHtml,
      'boolean',
      '对照：generate Prompt 是否含 HTML 字样不影响 B22 PASS',
    );
    // 证明两处文案不同路由、本项只约束 chat
    assert.notEqual(chatSystemPrompt, generateSystemPrompt);
    assert.ok(
      chatSystemPrompt.includes('面试题库') || chatSystemPrompt.includes('小助手'),
      'chat Prompt 应可识别为助教路径文案',
    );
  });

  it('UT-CHAT-PROMPT-05: 禁止用模型输出形态作为本项 PASS 判据', () => {
    const testSource = fs.readFileSync(THIS_TEST_PATH, 'utf8');
    // 只审查断言语句，避免本用例字面量自匹配
    const assertLines = testSource
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(?:assert\.|expect\()/.test(line));
    const assertBlob = assertLines.join('\n');

    const frontendTokens = ['AiAssistant.vue', 'DOM' + 'Purify', 'v-' + 'html'];
    for (const token of frontendTokens) {
      assert.equal(
        assertBlob.includes(token),
        false,
        `断言语句不得引入前端渲染判据: ${token}`,
      );
    }

    // 不得对 delta / completionText 做 HTML/Markdown 形态断言作为本项通过条件
    for (const line of assertLines) {
      const touchesOutputShape =
        /\bdelta\b|\bcompletionText\b/.test(line)
        && /HTML|Markdown|markdown|<p>|<h3>/.test(line);
      assert.equal(
        touchesOutputShape,
        false,
        `不得用模型输出形态作 PASS 判据: ${line}`,
      );
    }

    // 正向：断言应围绕 system / SystemMessage.content / messages[0]
    assert.ok(
      /systemPrompt|messages\[0\]|systemMessage\.content/i.test(assertBlob),
      'PASS 判据应围绕 system / messages[0] 字符串',
    );
  });

  describe('集成：上游 SystemMessage', () => {
    const savedEnv = saveTestEnv();
    /** @type {import('express').Express} */
    let app;
    let restoreFetch;
    /** @type {object[]} */
    let modelCalls;

    before(async () => {
      configureRouteTestEnv();
      await seedPromptBudgetDatabase();
      ({ app } = await import('../server-express.js'));
      modelCalls = [];
      restoreFetch = installMockModelFetch(modelCalls);
    });

    beforeEach(() => {
      modelCalls.length = 0;
      try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    });

    after(() => {
      restoreFetch?.();
      restoreTestEnv(savedEnv);
      try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    });

    it('IT-CHAT-PROMPT-01: POST /api/chat 上游 SystemMessage 与锁定文案一致', async () => {
      const response = await invokeRoute(app, '/api/chat', {
        message: '请简述 CAP 定理',
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers['content-type'], 'text/event-stream; charset=utf-8');
      assert.equal(modelCalls.length, 1, '上游调用恰好 1 次');

      const [systemMessage] = modelCalls[0].messages;
      assert.equal(systemMessage.role, 'system');
      assertNoHtmlOnlyMandate(systemMessage.content);
      assertNoForcedHtmlTags(systemMessage.content);
      assertRoleAndStructurePreserved(systemMessage.content);
      // 上游 system 槽须包含锁定的 chat systemPrompt 核心文案
      assert.ok(
        systemMessage.content.includes('面试官'),
        '上游 system content 须含助教角色文案',
      );
      assert.ok(
        systemMessage.content.includes('简短结论'),
        '上游 system content 须含结构要求',
      );

      const sseTypes = response.callOrder
        .filter((entry) => entry.op === 'write')
        .map((entry) => JSON.parse(String(entry.data).slice('data: '.length)).type);
      assert.deepEqual(sseTypes, ['context', 'delta', 'done']);
      // 刻意不根据 delta 文本是否为 HTML/Markdown 判 PASS/FAIL
    });
  });
});
