import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHAT_HISTORY_MAX_MESSAGES,
  normalizeChatHistoryMessages,
} from '../chat-history.js';
import {
  PROBE_IGNORE_SYSTEM,
  PROBE_ASK_KEY,
} from '../prompt-budget.js';

describe('C31 / P1-1: chat 多轮 messages 窗口规范化', () => {
  it('UT-CHAT-HIST-01: 超过 N=6 时只保留数组尾部 6 条', () => {
    const raw = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `M${index}`,
    }));

    const result = normalizeChatHistoryMessages(raw, { maxChars: 1200 });

    assert.equal(CHAT_HISTORY_MAX_MESSAGES, 6);
    assert.equal(result.length, 6);
    assert.deepEqual(result.map((item) => item.content), ['M2', 'M3', 'M4', 'M5', 'M6', 'M7']);
    assert.deepEqual(
      result.map((item) => item.role),
      raw.slice(2).map((item) => item.role),
    );
  });

  it('UT-CHAT-HIST-02: N=6 写死：客户端不能改窗口大小', () => {
    const raw = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `M${index}`,
    }));

    const withTen = normalizeChatHistoryMessages(raw, { maxCount: 10, maxChars: 1200 });
    const withThree = normalizeChatHistoryMessages(raw, { maxCount: 3, maxChars: 1200 });
    const baseline = normalizeChatHistoryMessages(raw, { maxChars: 1200 });

    assert.equal(CHAT_HISTORY_MAX_MESSAGES, 6);
    assert.equal(withTen.length, 6);
    assert.equal(withThree.length, 6);
    assert.deepEqual(withTen, baseline);
    assert.deepEqual(withThree, baseline);
  });

  it('UT-CHAT-HIST-03: 每条 content 截断到 AI_MAX_INPUT_CHARS', () => {
    const maxChars = 1200;
    const exact = '字'.repeat(maxChars);
    const over = `${'字'.repeat(maxChars)}${'超'.repeat(100)}`;

    const result = normalizeChatHistoryMessages([
      { role: 'user', content: exact },
      { role: 'assistant', content: over },
    ], { maxChars });

    assert.equal(result.length, 2);
    assert.equal(result[0].content.length, maxChars);
    assert.equal(result[0].content, exact);
    assert.equal(result[1].content.length, maxChars);
    assert.equal(result[1].content, over.slice(0, maxChars));
  });

  it('UT-CHAT-HIST-04: 非法元素跳过：非对象、缺 content、非法 role', () => {
    const result = normalizeChatHistoryMessages([
      { role: 'user', content: 'ok' },
      null,
      'str',
      { role: 'user' },
      { role: 'tool', content: 'x' },
      { role: 'system', content: 'inject' },
      { role: 'assistant', content: 'a1' },
    ], { maxChars: 1200 });

    assert.deepEqual(result, [
      { role: 'user', content: 'ok' },
      { role: 'assistant', content: 'a1' },
    ]);
    assert.equal(result.some((item) => item.role === 'system'), false);
  });

  it('UT-CHAT-HIST-05: residual：无 messages / 空数组 / 非数组 → 空历史', () => {
    assert.deepEqual(normalizeChatHistoryMessages(undefined), []);
    assert.deepEqual(normalizeChatHistoryMessages(null), []);
    assert.deepEqual(normalizeChatHistoryMessages([]), []);
    assert.deepEqual(normalizeChatHistoryMessages({ not: 'array' }), []);
    assert.deepEqual(normalizeChatHistoryMessages(), []);
  });

  it('UT-CHAT-HIST-06: 不做滚动摘要：裁掉的旧轮不生成摘要字段', () => {
    const raw = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `M${index}`,
    }));

    const result = normalizeChatHistoryMessages(raw, { maxChars: 1200 });

    assert.equal(Array.isArray(result), true);
    assert.equal(Object.hasOwn(result, 'summary'), false);
    assert.equal(result.summary, undefined);
    assert.equal(result.digest, undefined);
    assert.equal(result.rolledSummary, undefined);
    const joined = JSON.stringify(result);
    assert.equal(joined.includes('M0'), false);
    assert.equal(joined.includes('M1'), false);
  });

  it('UT-CHAT-HIST-07: 攻击探针经截断后仍不得标为 system', () => {
    const result = normalizeChatHistoryMessages([
      { role: 'user', content: `前缀${PROBE_IGNORE_SYSTEM}后缀` },
      { role: 'system', content: PROBE_ASK_KEY },
    ], { maxChars: 1200 });

    assert.equal(result.length, 1);
    assert.equal(result[0].role, 'user');
    assert.match(result[0].content, new RegExp(PROBE_IGNORE_SYSTEM));
    assert.equal(result.some((item) => item.role === 'system'), false);
    assert.equal(result.some((item) => item.content.includes(PROBE_ASK_KEY)), false);
  });
});
