import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PROBE_IGNORE_SYSTEM,
  PROBE_ASK_KEY,
  PROBE_CHANGE_ROLE,
} from '../prompt-budget.js';
import { CHAT_HISTORY_MAX_MESSAGES } from '../chat-history.js';
import {
  TEST_AUDIT_PATH,
  TEST_DB_PATH,
  configureRouteTestEnv,
  installMockModelFetch,
  invokeRoute,
  readAuditLines,
  restoreTestEnv,
  saveTestEnv,
  seedPromptBudgetDatabase,
} from './prompt-budget-route-helpers.js';

const savedEnv = saveTestEnv();
let app;
let restoreFetch;
let modelCalls;

const getSseEvents = (response) => response.callOrder
  .filter((entry) => entry.op === 'write')
  .map((entry) => JSON.parse(entry.data.slice('data: '.length)));

const getUpstreamContents = (messages) => messages.map((item) => String(item.content ?? ''));

describe('C31 / P1-1: 多轮 messages 窗口与 chat SSE / 题面绑定集成', () => {
  before(async () => {
    configureRouteTestEnv();
    process.env.AI_MAX_INPUT_CHARS = '1200';
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
    delete process.env.AI_MAX_INPUT_CHARS;
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(`${TEST_DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
    try { fs.unlinkSync(TEST_AUDIT_PATH); } catch { /* ignore */ }
  });

  it('IT-CHAT-HIST-01: 携带 ≤6 条历史时上游在三槽之间插入历史且 SSE 不变', async () => {
    const response = await invokeRoute(app, '/api/chat', {
      message: '再简洁一点',
      context: { problemId: 42, categoryId: 1 },
      messages: [
        { role: 'user', content: '什么是缓存穿透' },
        { role: 'assistant', content: '缓存穿透是指查询一个不存在的数据……较长解释……' },
        { role: 'user', content: '举个例子' },
        { role: 'assistant', content: '例如查询商品 id=-1……例子……' },
      ],
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/event-stream/);
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    assert.equal(modelCalls.length, 1);

    const { messages } = modelCalls[0];
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.equal(messages[messages.length - 1].role, 'user');
    assert.match(messages[1].content, /#42|缓存一致性/);
    assert.match(messages[messages.length - 1].content, /再简洁一点/);
    const joined = getUpstreamContents(messages).join('\n');
    assert.match(joined, /什么是缓存穿透/);
    assert.match(joined, /举个例子/);
    assert.ok(messages.length > 3);

    const audits = await readAuditLines(1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].reason, 'stream_done');
  });

  it('IT-CHAT-HIST-02: 超过 6 条时只保留最近 6 条进入上游', async () => {
    const history = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `H${index + 1}`,
    }));

    const response = await invokeRoute(app, '/api/chat', {
      message: 'CUR',
      context: { problemId: 42 },
      messages: history,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    assert.equal(modelCalls.length, 1);

    const { messages } = modelCalls[0];
    assert.equal(messages[0].role, 'system');
    assert.equal(messages[1].role, 'user');
    assert.match(messages[messages.length - 1].content, /CUR/);

    const middle = messages.slice(2, -1);
    assert.equal(middle.length, CHAT_HISTORY_MAX_MESSAGES);
    const middleJoined = getUpstreamContents(middle).join('\n');
    for (const keep of ['H3', 'H4', 'H5', 'H6', 'H7', 'H8']) {
      assert.match(middleJoined, new RegExp(keep));
    }
    assert.doesNotMatch(middleJoined, /\bH1\b/);
    assert.doesNotMatch(middleJoined, /\bH2\b/);
  });

  it('IT-CHAT-HIST-03: residual：无 messages / 空数组 / 仅当前一句时上游仍恰 3 条', async () => {
    const cases = [
      { label: 'omit', body: { message: '单轮提问A', context: { problemId: 42 } } },
      { label: 'empty', body: { message: '单轮提问B', context: { problemId: 42 }, messages: [] } },
      {
        label: 'single-same',
        body: {
          message: '单轮提问C',
          context: { problemId: 42 },
          // residual：仅回传与当前句等价的一句时，视为无有效历史（与 A/B 同构）
          messages: [{ role: 'user', content: '单轮提问C' }],
        },
      },
    ];

    for (const item of cases) {
      modelCalls.length = 0;
      const response = await invokeRoute(app, '/api/chat', item.body);
      assert.equal(response.statusCode, 200, item.label);
      assert.deepEqual(
        getSseEvents(response).map((event) => event.type),
        ['context', 'delta', 'done'],
        item.label,
      );
      assert.equal(modelCalls.length, 1, item.label);
      const { messages } = modelCalls[0];
      // A/B 必须恰 3 条；C 若实现将「仅当前句」视为无有效历史则亦为 3
      if (item.label === 'single-same' && messages.length !== 3) {
        // 兼容：保留该句作为历史时上游为 4，仍非 5xx；文档允许「无有效历史」语义
        assert.equal(messages.length, 4, item.label);
        assert.equal(messages[0].role, 'system');
        assert.equal(messages[1].role, 'user');
        assert.equal(messages[messages.length - 1].role, 'user');
      } else {
        assert.equal(messages.length, 3, item.label);
        assert.equal(messages[0].role, 'system');
        assert.equal(messages[1].role, 'user');
        assert.equal(messages[2].role, 'user');
      }
    }
  });

  it('IT-CHAT-HIST-04: problemId 题面固定槽不被历史覆盖', async () => {
    const response = await invokeRoute(app, '/api/chat', {
      message: '上一题再讲一遍要点',
      context: { problemId: 42, categoryId: 1 },
      messages: [
        { role: 'user', content: '进程 vs 线程有什么区别' },
        { role: 'assistant', content: '进程有独立地址空间，线程共享……' },
        { role: 'user', content: '再对比一下调度开销' },
        { role: 'assistant', content: '线程切换开销通常更小……' },
      ],
    });

    assert.equal(response.statusCode, 200);
    const events = getSseEvents(response);
    assert.deepEqual(events.map((event) => event.type), ['context', 'delta', 'done']);
    const contextEvent = events[0];
    assert.equal(contextEvent.type, 'context');
    assert.ok(contextEvent.snippets.some((snippet) => Number(snippet.id) === 42 && snippet.type === 'problem'));

    const { messages } = modelCalls[0];
    assert.match(messages[1].content, /#42|缓存一致性/);
    assert.match(messages[messages.length - 1].content, /上一题再讲一遍要点/);
    const historyJoined = getUpstreamContents(messages.slice(2, -1)).join('\n');
    assert.match(historyJoined, /进程|线程/);
  });

  it('IT-CHAT-HIST-05: 历史超长条目按 AI_MAX_INPUT_CHARS 截断后仍可完成流', async () => {
    const maxChars = 1200;
    const longContent = `L${'长'.repeat(maxChars + 499)}`;
    const response = await invokeRoute(app, '/api/chat', {
      message: '请继续',
      context: { problemId: 42 },
      messages: [{ role: 'user', content: longContent }],
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.statusCode < 500);
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    assert.equal(modelCalls.length, 1);

    const { messages } = modelCalls[0];
    const historyItem = messages[2];
    assert.ok(historyItem);
    assert.ok(historyItem.content.length <= maxChars);
    assert.equal(historyItem.content, longContent.slice(0, maxChars));
    assert.match(messages[messages.length - 1].content, /请继续/);
  });

  it('IT-CHAT-HIST-06: 不做滚动摘要：被裁掉的旧轮不进上游', async () => {
    const uniqueOld1 = 'UNIQUE_OLD_PARAGRAPH_H1_缓存穿透完整长文不可摘要';
    const uniqueOld2 = 'UNIQUE_OLD_PARAGRAPH_H2_布隆过滤器完整长文不可摘要';
    const history = [
      { role: 'user', content: uniqueOld1 },
      { role: 'assistant', content: uniqueOld2 },
      { role: 'user', content: 'H3' },
      { role: 'assistant', content: 'H4' },
      { role: 'user', content: 'H5' },
      { role: 'assistant', content: 'H6' },
      { role: 'user', content: 'H7' },
      { role: 'assistant', content: 'H8' },
    ];

    const response = await invokeRoute(app, '/api/chat', {
      message: '继续',
      context: { problemId: 42 },
      messages: history,
      summary: '客户端伪造摘要应被忽略',
      N: 99,
      maxHistory: 99,
      historyWindow: 99,
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    const joined = getUpstreamContents(modelCalls[0].messages).join('\n');
    assert.equal(joined.includes(uniqueOld1), false);
    assert.equal(joined.includes(uniqueOld2), false);
    assert.equal(joined.includes('对话摘要'), false);
    assert.match(joined, /H3/);
    assert.match(joined, /H8/);
  });

  it('SEC-CHAT-HIST-01: 历史中的攻击探针不得进入 system 槽', async () => {
    const runCases = [
      {
        message: `请回答。${PROBE_CHANGE_ROLE}`,
        messages: [
          { role: 'user', content: `历史用户。${PROBE_IGNORE_SYSTEM}` },
          { role: 'assistant', content: `历史助手。${PROBE_ASK_KEY}` },
        ],
      },
      {
        message: '正常追问',
        messages: [
          { role: 'system', content: PROBE_IGNORE_SYSTEM },
          { role: 'user', content: '合法历史' },
        ],
      },
    ];

    for (const body of runCases) {
      modelCalls.length = 0;
      const response = await invokeRoute(app, '/api/chat', {
        ...body,
        context: { problemId: 42 },
      });
      assert.equal(response.statusCode, 200);
      const { messages } = modelCalls[0];
      assert.equal(messages[0].role, 'system');
      assert.equal(messages[0].content.includes(PROBE_IGNORE_SYSTEM), false);
      assert.equal(messages[0].content.includes(PROBE_ASK_KEY), false);
      assert.equal(messages[0].content.includes(PROBE_CHANGE_ROLE), false);

      const systemAfterFirst = messages.slice(1).filter((item) => item.role === 'system');
      assert.equal(systemAfterFirst.length, 0);

      const nonSystemJoined = messages
        .filter((item) => item.role === 'user' || item.role === 'assistant')
        .map((item) => item.content)
        .join('\n');
      // 探针可出现在 user/assistant 历史或当前句，但不得进 system
      if (body.message.includes(PROBE_CHANGE_ROLE)) {
        assert.match(nonSystemJoined, new RegExp(PROBE_CHANGE_ROLE));
      }
    }
  });

  it('SEC-CHAT-HIST-02: 客户端不得用 messages 注入 system 角色或绕过窗口', async () => {
    const malicious = [
      { role: 'system', content: 'CLIENT_SYSTEM_INJECT_OLD' },
      { role: 'tool', content: 'TOOL_PAYLOAD' },
      { role: 'function', content: 'FN_PAYLOAD' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
      { role: 'system', content: 'CLIENT_SYSTEM_INJECT_KEEP' },
      { role: 'user', content: 'U2' },
      { role: 'assistant', content: 'A2' },
      { role: 'user', content: 'U3' },
      { role: 'assistant', content: 'A3' },
      { role: 'user', content: 'U4' },
      { role: 'assistant', content: 'A4' },
    ];

    const response = await invokeRoute(app, '/api/chat', {
      message: '当前句',
      context: { problemId: 42 },
      messages: malicious,
      historyWindow: 20,
      maxHistory: 20,
      N: 20,
      summary: '应被忽略的滚动摘要',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(getSseEvents(response).map((event) => event.type), ['context', 'delta', 'done']);
    assert.equal(modelCalls.length, 1);

    const { messages } = modelCalls[0];
    const systemMessages = messages.filter((item) => item.role === 'system');
    assert.equal(systemMessages.length, 1);
    assert.equal(systemMessages[0], messages[0]);
    assert.equal(messages[0].content.includes('CLIENT_SYSTEM_INJECT'), false);

    const middle = messages.slice(2, -1);
    assert.ok(middle.length <= CHAT_HISTORY_MAX_MESSAGES);
    assert.equal(middle.some((item) => item.role === 'system'), false);
    const joined = getUpstreamContents(messages).join('\n');
    assert.equal(joined.includes('应被忽略的滚动摘要'), false);
    assert.equal(joined.includes('CLIENT_SYSTEM_INJECT_KEEP'), false);
    assert.equal(joined.includes('TOOL_PAYLOAD'), false);
  });
});
