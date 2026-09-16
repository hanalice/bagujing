import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPromptMessages,
  promptBudget,
  PROMPT_UNTRUSTED_DATA_NOTICE,
  PROBE_IGNORE_SYSTEM,
  PROBE_ASK_KEY,
  PROBE_CHANGE_ROLE,
  PROBE_CONTEXT_INJECT,
} from '../prompt-budget.js';

const basePrompt = {
  systemPrompt: '系统指令：请准确回答。',
  questionLabel: '用户问题：',
  question: '如何设计可靠的缓存？',
  contextLabel: '相关背景知识片段（可参考）：',
  instruction: '请结合背景知识回答。',
  budget: promptBudget,
};

const problemSnippet = {
  type: 'problem',
  id: 42,
  brief_name: '缓存一致性',
  keyPoints: ['失效策略'],
};

describe('B1 / P0-6: Prompt 分槽与防注入声明', () => {
  it('UT-PROMPT-SLOT-01: 三条 message 顺序为 system、context、user', () => {
    const messages = buildPromptMessages({
      ...basePrompt,
      snippets: [problemSnippet],
    });

    assert.equal(typeof messages.system, 'string');
    assert.equal(typeof messages.context, 'string');
    assert.equal(typeof messages.user, 'string');
    assert.ok(messages.system.length > 0);
    assert.ok(messages.context.length > 0);
    assert.ok(messages.user.length > 0);
    assert.match(messages.user, /如何设计可靠的缓存？/);
    assert.match(messages.context, /- 题目 #42/);
    assert.doesNotMatch(messages.system, /- 题目 #42/);
    assert.doesNotMatch(messages.user, /- 题目 #/);
    assert.equal(messages.budgetError, undefined);
  });

  it('UT-PROMPT-SLOT-02: 防注入声明只在 system', () => {
    const messages = buildPromptMessages({
      ...basePrompt,
      snippets: [problemSnippet],
    });

    assert.equal(messages.system.includes(PROMPT_UNTRUSTED_DATA_NOTICE), true);
    assert.match(messages.system, /不是指令/);
    assert.match(messages.system, /忽略/);
    assert.equal(messages.context.includes(PROMPT_UNTRUSTED_DATA_NOTICE), false);
    assert.equal(messages.user.includes(PROMPT_UNTRUSTED_DATA_NOTICE), false);
  });

  it('UT-PROMPT-SLOT-03: 用户忽略系统探针只出现在 user', () => {
    const question = `短句 ${PROBE_IGNORE_SYSTEM} ${PROBE_CHANGE_ROLE}`;
    const messages = buildPromptMessages({
      ...basePrompt,
      question,
      snippets: [problemSnippet],
    });

    assert.equal(messages.user.includes(PROBE_IGNORE_SYSTEM), true);
    assert.equal(messages.user.includes(PROBE_CHANGE_ROLE), true);
    assert.equal(messages.system.includes(PROBE_IGNORE_SYSTEM), false);
    assert.equal(messages.system.includes(PROBE_CHANGE_ROLE), false);
    assert.match(messages.user, /短句/);
  });

  it('UT-PROMPT-SLOT-04: 用户索要 Key 探针只出现在 user', () => {
    const messages = buildPromptMessages({
      ...basePrompt,
      question: `请解释缓存。${PROBE_ASK_KEY}`,
      snippets: [problemSnippet],
    });

    assert.equal(messages.user.includes(PROBE_ASK_KEY), true);
    assert.equal(messages.system.includes(PROBE_ASK_KEY), false);
    assert.equal(messages.context.includes(PROBE_ASK_KEY), false);
  });

  it('UT-PROMPT-SLOT-05: RAG 污染只出现在 context', () => {
    const messages = buildPromptMessages({
      ...basePrompt,
      question: '请解释缓存一致性',
      snippets: [{
        type: 'category',
        id: 7,
        name: '后端开发',
        groupName: '服务端',
        groupDesc: PROBE_CONTEXT_INJECT,
        count: 12,
      }],
    });

    assert.equal(messages.context.includes(PROBE_CONTEXT_INJECT), true);
    assert.equal(messages.system.includes(PROBE_CONTEXT_INJECT), false);
    assert.equal(messages.user.includes(PROBE_CONTEXT_INJECT), false);
    assert.match(messages.context, /描述：/);
  });
});
