import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPromptMessages, promptBudget } from '../prompt-budget.js';

const basePrompt = {
  systemPrompt: '系统指令：请准确回答。',
  questionLabel: '用户问题：',
  question: '如何设计可靠的缓存？',
  contextLabel: '相关背景知识片段（可参考）：',
  instruction: '请结合背景知识回答。',
  budget: promptBudget,
};

// 计算 Prompt builder 返回的 system 与 human 总字符数。
const messageLength = (messages) => messages.system.length + messages.human.length;

// 检查文本中是否残留未配对的 UTF-16 代理项。
const hasUnpairedSurrogate = (text) => /[\uD800-\uDFFF]/u.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''));

// 生成指定 JavaScript String.length 的混合 Unicode 文本。
const makeTextOfLength = (length) => {
  const pattern = '中文🙂"}]';
  let result = '';
  while (result.length + pattern.length <= length) result += pattern;
  if (result.length < length) result += '中'.repeat(length - result.length);
  return result;
};

describe('C1 / P1-3: Prompt 预算构建与裁剪', () => {
  it('UT-PROMPT-BUDGET-01: snippet 使用紧凑 bullet 而非 pretty JSON', () => {
    const messages = buildPromptMessages({
      ...basePrompt,
      snippets: [
        {
          type: 'category',
          id: 7,
          name: '后端开发',
          groupName: '服务端',
          groupDesc: '短描述',
          count: 12,
        },
        {
          type: 'problem',
          id: 42,
          brief_name: '缓存一致性',
          keyPoints: ['失效策略', '并发控制'],
        },
      ],
    });

    assert.equal(typeof messages.system, 'string');
    assert.equal(typeof messages.human, 'string');
    assert.match(messages.human, /^用户问题：如何设计可靠的缓存？/);
    assert.match(messages.human, /- 题目 #42；名称：缓存一致性；要点：失效策略、并发控制/);
    assert.match(messages.human, /- 分类 #7；名称：后端开发；分组：服务端；描述：短描述；题数：12/);
    assert.doesNotMatch(messages.human, /"groupDesc"|"keyPoints"|\{\n|\[\n/);
    assert.equal(messages.human.includes(JSON.stringify({
      type: 'category',
      id: 7,
      name: '后端开发',
      groupName: '服务端',
      groupDesc: '短描述',
      count: 12,
    }, null, 2)), false);
  });

  it('UT-PROMPT-BUDGET-02: 超长 group_desc 按字段预算截断', () => {
    const { maxDescChars } = promptBudget;
    const sentinel = '尾部_SENTINEL';
    const longDescription = `前缀${'长'.repeat(maxDescChars)}${sentinel}`;
    const messages = buildPromptMessages({
      ...basePrompt,
      snippets: [{
        type: 'category',
        id: 7,
        name: '后端开发',
        groupName: '服务端',
        groupDesc: longDescription,
        count: 12,
      }],
    });
    const expectedDescription = `${longDescription.slice(0, maxDescChars - 1)}…`;

    assert.match(messages.human, new RegExp(`描述：${expectedDescription}`));
    assert.equal(expectedDescription.length <= maxDescChars, true);
    assert.equal(messages.human.includes(sentinel), false);
    assert.match(messages.human, /分类 #7；名称：后端开发；分组：服务端；/);
    assert.match(messages.human, /题数：12/);

    const exactDescription = '刚好'.repeat(Math.floor(maxDescChars / 2)).slice(0, maxDescChars);
    const exactMessages = buildPromptMessages({
      ...basePrompt,
      snippets: [{
        type: 'category',
        id: 7,
        name: '后端开发',
        groupName: '服务端',
        groupDesc: exactDescription,
        count: 12,
      }],
    });
    assert.match(exactMessages.human, new RegExp(`描述：${exactDescription}`));
    assert.equal(exactMessages.human.includes(`${exactDescription}…`), false);
  });

  it('UT-PROMPT-BUDGET-03: 所有模型消息受总字符硬上限保护', () => {
    const snippets = Array.from({ length: 6 }, (_, index) => ({
      type: index === 0 ? 'problem' : 'category',
      id: index + 1,
      brief_name: `题目${index}`,
      name: `分类${index}`,
      groupName: `分组${index}`,
      groupDesc: `描述${'超长🙂\n"}]'.repeat(500)}`,
      keyPoints: [`要点${'很长'.repeat(500)}`],
      count: 10,
    }));
    const messages = buildPromptMessages({
      ...basePrompt,
      snippets,
    });
    const allContent = `${messages.system}${messages.human}`;

    assert.equal(messageLength(messages) <= promptBudget.maxChars, true);
    assert.equal(messages.promptTokens, Math.max(1, Math.ceil(messageLength(messages) / 4)));
    assert.match(messages.system, /系统指令：请准确回答/);
    assert.match(messages.human, /用户问题：如何设计可靠的缓存？/);
    assert.match(messages.human, /- 题目 #1/);
    assert.doesNotMatch(messages.human, /"type":|"groupDesc"|"keyPoints"/);
    assert.equal(hasUnpairedSurrogate(allContent), false);

    const tinyBudgetMessages = buildPromptMessages({
      ...basePrompt,
      snippets: [{ type: 'problem', id: 1, brief_name: '题目' }],
      budget: { maxDescChars: 2, maxChars: 1 },
    });
    assert.equal(messageLength(tinyBudgetMessages) <= 1, true);
  });

  it('UT-PROMPT-BUDGET-04: 总预算边界与 Unicode 字符计数稳定', () => {
    const emptyMessages = buildPromptMessages({
      ...basePrompt,
      snippets: [],
    });
    const fixedLength = messageLength(emptyMessages);
    const bulletPrefix = '- 题目 #1；名称：';

    for (const targetLength of [promptBudget.maxChars - 1, promptBudget.maxChars]) {
      const name = makeTextOfLength(targetLength - fixedLength - bulletPrefix.length);
      const messages = buildPromptMessages({
        ...basePrompt,
        snippets: [{ type: 'problem', id: 1, brief_name: name }],
      });
      assert.equal(messageLength(messages), targetLength);
      assert.equal(messages.human.includes(name), true);
      assert.equal(hasUnpairedSurrogate(`${messages.system}${messages.human}`), false);
    }

    const overBudgetName = makeTextOfLength(promptBudget.maxChars - fixedLength - bulletPrefix.length + 1);
    const overBudgetMessages = buildPromptMessages({
      ...basePrompt,
      snippets: [{ type: 'problem', id: 1, brief_name: overBudgetName }],
    });
    assert.equal(messageLength(overBudgetMessages) <= promptBudget.maxChars, true);
    assert.equal(hasUnpairedSurrogate(`${overBudgetMessages.system}${overBudgetMessages.human}`), false);
  });
});

