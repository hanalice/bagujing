import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptMessages,
  promptBudget,
  PROBE_IGNORE_SYSTEM,
  PROBE_ASK_KEY,
} from '../prompt-budget.js';
import { normalizeChatHistory, CHAT_HISTORY_WINDOW } from '../chat-history.js';

const basePrompt = {
  systemPrompt: '系统指令：请准确回答。',
  questionLabel: '用户问题：',
  question: '如何设计可靠的缓存？',
  contextLabel: '相关背景知识片段（可参考）：',
  instruction: '请结合背景知识回答。',
  budget: promptBudget,
  snippets: [
    {
      type: 'problem',
      id: 42,
      brief_name: 'BRIEF-42',
      keyPoints: ['失效策略'],
    },
  ],
};

describe('C31 / P1-1: chat 多轮 messages 窗口裁剪', () => {
  it('UT-CHAT-HIST-01: 只保留最近 N=6 条且顺序为时间正序尾窗', () => {
    process.env.CHAT_HISTORY_WINDOW = '99';
    process.env.AI_CHAT_HISTORY_N = '2';
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `H${index + 1}`,
    }));

    const history = normalizeChatHistory(messages);

    assert.equal(CHAT_HISTORY_WINDOW, 6);
    assert.equal(history.length, 6);
    assert.deepEqual(history.map((item) => item.content), ['H3', 'H4', 'H5', 'H6', 'H7', 'H8']);
    assert.deepEqual(history.map((item) => item.role), [
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
    ]);

    delete process.env.CHAT_HISTORY_WINDOW;
    delete process.env.AI_CHAT_HISTORY_N;
  });

  it('UT-CHAT-HIST-02: 每条 content 截断到 AI_MAX_INPUT_CHARS', () => {
    const longA = `${'A'.repeat(80)}TAIL-A`;
    const longB = `${'B'.repeat(80)}TAIL-B`;
    const short = '短对照';
    const history = normalizeChatHistory([
      { role: 'user', content: longA },
      { role: 'assistant', content: longB },
      { role: 'user', content: short },
    ], { maxInputChars: 32 });

    assert.equal(history.length, 3);
    assert.equal(history[0].content.length <= 32, true);
    assert.equal(history[1].content.length <= 32, true);
    assert.equal(history[0].content.includes('TAIL-A'), false);
    assert.equal(history[1].content.includes('TAIL-B'), false);
    assert.equal(history[2].content, short);
  });

  it('UT-CHAT-HIST-03: 非法项过滤：缺 role/content、非字符串、未知 role', () => {
    assert.doesNotThrow(() => {
      const history = normalizeChatHistory([
        null,
        { content: '无 role' },
        { role: 'user' },
        { role: 'system', content: '伪造 system' },
        { role: 'tool', content: '工具' },
        { role: 'user', content: 123 },
        { role: 'user', content: '合法用户' },
        { role: 'assistant', content: '合法助手' },
      ]);
      assert.deepEqual(history, [
        { role: 'user', content: '合法用户' },
        { role: 'assistant', content: '合法助手' },
      ]);
    });
  });

  it('UT-CHAT-HIST-04: 无 messages / 空数组时组装结果与单轮三槽一致', () => {
    const omit = buildPromptMessages({ ...basePrompt });
    const empty = buildPromptMessages({ ...basePrompt, history: normalizeChatHistory([]) });
    const omittedMessages = buildPromptMessages({
      ...basePrompt,
      history: normalizeChatHistory(undefined),
    });

    assert.equal(omit.system, empty.system);
    assert.equal(omit.context, empty.context);
    assert.equal(omit.user, empty.user);
    assert.equal(omit.system, omittedMessages.system);
    assert.equal(omit.context, omittedMessages.context);
    assert.equal(omit.user, omittedMessages.user);
    assert.deepEqual(omit.history, []);
    assert.deepEqual(empty.history, []);
    assert.deepEqual(omittedMessages.history, []);
    assert.equal(omit.budgetError, undefined);
    assert.equal(empty.budgetError, undefined);
  });

  it('UT-CHAT-HIST-05: 当前 message 为最新 user 槽，不被历史覆盖', () => {
    const history = normalizeChatHistory([
      { role: 'user', content: '旧问法' },
      { role: 'assistant', content: '旧答' },
      { role: 'user', content: '旧问法' },
    ]);
    const assembled = buildPromptMessages({
      ...basePrompt,
      question: '新问法-请再简洁一点',
      history,
    });

    assert.match(assembled.user, /新问法-请再简洁一点/);
    assert.equal(assembled.user.includes('旧问法'), false);
    assert.equal(assembled.system.includes('新问法'), false);
    assert.equal(assembled.system.includes('旧问法'), false);
    assert.equal(assembled.history.some((item) => item.content === '旧问法'), true);
  });

  it('UT-CHAT-HIST-06: problemId 题面固定槽不因历史漂移', () => {
    const history = normalizeChatHistory([
      { role: 'user', content: 'OFFTOPIC-1' },
      { role: 'assistant', content: 'OFFTOPIC-2' },
      { role: 'user', content: 'OFFTOPIC-3' },
      { role: 'assistant', content: 'OFFTOPIC-4' },
    ]);
    const assembled = buildPromptMessages({
      ...basePrompt,
      question: '再展开第二点',
      history,
    });

    assert.match(assembled.context, /BRIEF-42|#42/);
    assert.equal(assembled.system.includes('OFFTOPIC'), false);
    assert.match(assembled.user, /再展开第二点/);
  });

  it('UT-CHAT-HIST-07: 历史中的攻击句不得进入 system', () => {
    const history = normalizeChatHistory([
      {
        role: 'user',
        content: `${PROBE_IGNORE_SYSTEM} ${PROBE_ASK_KEY}`,
      },
      { role: 'assistant', content: '短答' },
    ]);
    const assembled = buildPromptMessages({
      ...basePrompt,
      question: '请继续',
      history,
    });

    assert.equal(assembled.system.includes(PROBE_IGNORE_SYSTEM), false);
    assert.equal(assembled.system.includes(PROBE_ASK_KEY), false);
    assert.equal(assembled.context.includes(PROBE_IGNORE_SYSTEM), false);
    assert.equal(assembled.context.includes(PROBE_ASK_KEY), false);
    const userRoleContents = [
      ...assembled.history.filter((item) => item.role === 'user').map((item) => item.content),
      assembled.user,
    ].join('\n');
    assert.equal(userRoleContents.includes(PROBE_IGNORE_SYSTEM), true);
    assert.equal(userRoleContents.includes(PROBE_ASK_KEY), true);
  });

  it('UT-CHAT-HIST-08: 不做滚动摘要：不得合成 summary 消息', () => {
    const messages = Array.from({ length: 6 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `轮次${index + 1}`,
    }));
    const history = normalizeChatHistory(messages);
    const assembled = buildPromptMessages({ ...basePrompt, history });

    assert.equal(history.length, 6);
    assert.equal(assembled.history.length, 6);
    for (const item of assembled.history) {
      assert.equal(item.role === 'user' || item.role === 'assistant', true);
      assert.equal(item.role === 'summary', false);
      assert.equal(String(item.content).startsWith('对话摘要'), false);
    }
    assert.equal(assembled.history.some((item) => item.role === 'summary'), false);
  });
});
