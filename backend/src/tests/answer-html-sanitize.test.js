import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sanitizeHtml } from '../security/html-sanitizer.js';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  invokeRoute,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';
import { createSqlitePool } from '../db/sqlite-pool.js';
import { getProblemDetailById } from '../db/problem-detail-repo.js';

describe('B21 / P0-7: 解析入库前服务端 HTML 白名单消毒', () => {
  describe('单元测试: HTML 白名单消毒器 (html-sanitizer.js)', () => {
    it('UT-HTML-SANITIZE-01: 恶意标签过滤：封杀 script 与高危标签', () => {
      const maliciousInputs = [
        '<script>alert("xss")</script><p>正常段落</p>',
        '<SCRIPT SRC="http://evil.com/xss.js"></SCRIPT><div>内容</div>',
        '<script \n type="text/javascript">console.log(1)</script><p>保留</p>',
        '<iframe></iframe><object data="evil.swf"></object><embed src="bad"><p>文本</p>',
        '<style>body { display: none; }</style><p>样式被剔除</p>',
        '<script>alert(1)<p>未闭合测试</p>',
      ];

      for (const input of maliciousInputs) {
        const output = sanitizeHtml(input);
        assert.equal(/<\/?script/i.test(output), false, `输出不得包含 script 标签: ${output}`);
        assert.equal(/<\/?(?:iframe|object|embed|style)/i.test(output), false, `输出不得包含危险标签: ${output}`);
      }
    });

    it('UT-HTML-SANITIZE-02: 伪协议过滤：封杀 javascript 伪协议', () => {
      const dangerousLinks = [
        '<a href="javascript:alert(1)">点击1</a>',
        '<a href="  javascript :alert(2)">点击2</a>',
        '<a href="vbscript:msgbox(1)">点击3</a>',
        '<a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">点击4</a>',
      ];

      for (const link of dangerousLinks) {
        const output = sanitizeHtml(link);
        assert.equal(/javascript\s*:/i.test(output), false, `输出不得含 javascript 伪协议: ${output}`);
        assert.equal(/vbscript\s*:/i.test(output), false, `输出不得含 vbscript 伪协议: ${output}`);
        assert.equal(/data\s*:/i.test(output), false, `输出不得含 data 伪协议: ${output}`);
      }

      // 合规链接必须放行并附加安全属性
      const safeLink = '<a href="https://example.com" class="link">官网</a>';
      const safeOutput = sanitizeHtml(safeLink);
      assert.match(safeOutput, /href="https:\/\/example\.com"/);
      assert.match(safeOutput, /target="_blank"/);
      assert.match(safeOutput, /rel="noopener noreferrer"/);
    });

    it('UT-HTML-SANITIZE-03: 行内事件属性过滤：封杀 on* 事件处理器', () => {
      const eventInputs = [
        '<p onclick="alert(1)" onmouseover="steal()" class="text">段落</p>',
        '<span onload="evil()" title="提示">内容</span>',
        '<div onfocus="evil()" onerror="bad()">块</div>',
        '<code oncopy="leak()">console.log(1)</code>',
      ];

      for (const input of eventInputs) {
        const output = sanitizeHtml(input);
        assert.equal(/\son[a-z]+\s*=/i.test(output), false, `输出不得包含 on* 事件: ${output}`);
      }

      // 保留合法 class 和 title
      const preserved = sanitizeHtml('<p class="highlight" title="描述">文本</p>');
      assert.match(preserved, /class="highlight"/);
      assert.match(preserved, /title="描述"/);
    });

    it('UT-HTML-SANITIZE-04: 白名单放行：保留常用安全富文本排版标签', () => {
      const richContent = [
        '<h3>面试官解析</h3>',
        '<p>核心在于 <strong>缓存一致性</strong> 与 <em>双写延迟</em>：</p>',
        '<ul><li>1. 先写 DB 再删 Cache；</li><li>2. 延迟双删保证最终一致。</li></ul>',
        '<pre><code>const redis = new Redis();</code></pre>',
        '<blockquote>引用要点说明</blockquote>',
        '<table><thead><tr><th>方案</th><th>延迟</th></tr></thead><tbody><tr><td>双删</td><td>低</td></tr></tbody></table>',
      ].join('\n');

      const output = sanitizeHtml(richContent);
      assert.match(output, /<h3>面试官解析<\/h3>/);
      assert.match(output, /<strong>缓存一致性<\/strong>/);
      assert.match(output, /<em>双写延迟<\/em>/);
      assert.match(output, /<ul>/);
      assert.match(output, /<li>1\. 先写 DB 再删 Cache；<\/li>/);
      assert.match(output, /<pre><code>const redis = new Redis\(\);<\/code><\/pre>/);
      assert.match(output, /<blockquote>引用要点说明<\/blockquote>/);
      assert.match(output, /<table>/);
    });
  });

  describe('集成测试: 生成解析入库端到端闭环 (answer/generate -> SQLite)', () => {
    const savedEnv = saveTestEnv();
    let app;
    let originalFetch;
    let pool;

    before(async () => {
      configureRouteTestEnv();
      await seedPromptBudgetDatabase();
      pool = createSqlitePool({ filename: TEST_DB_PATH });
      ({ app } = await import('../server-express.js'));

      originalFetch = globalThis.fetch;
      // Mock LLM API：返回包含恶意标签和伪协议的复杂 HTML
      globalThis.fetch = async () => new Response(JSON.stringify({
        id: 'chatcmpl-xss-test',
        object: 'chat.completion',
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: '<script>stealTokens()</script><p>解析正文</p><a href="javascript:alert(1)">点我领奖</a><img src="x" onerror="evil()"><p>结论已明确。</p>',
          },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    beforeEach(() => {
      try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    });

    after(async () => {
      globalThis.fetch = originalFetch;
      restoreTestEnv(savedEnv);
      if (pool) await pool.closeAll();
      for (const suffix of ['', '-shm', '-wal']) {
        try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
      }
      try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
    });

    it('IT-HTML-SANITIZE-01: 生成入库端到端闭环：库内无 script 与 javascript', async () => {
      const response = await invokeRoute(app, '/api/problems/42/answer/generate', { force: true });
      assert.equal(response.statusCode, 200);

      const jsonPayload = response.callOrder.find((entry) => entry.op === 'json')?.payload;
      assert.equal(jsonPayload?.code, 0);

      // 1. 验证接口响应中的 answer 已经被白名单消毒
      const apiAnswer = jsonPayload.data.answer;
      assert.equal(/<\/?script/i.test(apiAnswer), false, 'API 响应中不得含 script 标签');
      assert.equal(/javascript\s*:/i.test(apiAnswer), false, 'API 响应中不得含 javascript 伪协议');
      assert.equal(/\sonerror\s*=/i.test(apiAnswer), false, 'API 响应中不得含 onerror');
      assert.match(apiAnswer, /<p>解析正文<\/p>/);
      assert.match(apiAnswer, /<p>结论已明确。<\/p>/);

      // 2. 直接查询 SQLite 数据库 details 表，断言落库数据严格合规
      const row = await getProblemDetailById(pool, 42);
      assert.ok(row, '数据库中应存在题目详情');
      const dbAnswer = row.answer;

      assert.equal(/<\/?script/i.test(dbAnswer), false, `SQLite details.answer 必须无 script 标签: ${dbAnswer}`);
      assert.equal(/javascript\s*:/i.test(dbAnswer), false, `SQLite details.answer 必须无 javascript 伪协议: ${dbAnswer}`);
      assert.equal(/\sonerror\s*=/i.test(dbAnswer), false, `SQLite details.answer 必须无 onerror: ${dbAnswer}`);
      assert.match(dbAnswer, /<p>解析正文<\/p>/);
    });
  });
});
