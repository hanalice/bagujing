/**
 * C41 / P1-4：结构化 JSON 三字段解析/校验单元测试。
 * 用例 ID 与 docs/test_cases.md §2.25 对齐。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATE_ANSWER_SYSTEM_PROMPT,
  parseStructuredAnswer,
  persistStructuredAnswerIfValid,
} from '../structured-answer.js';

describe('C41 / P1-4: 解析生成结构化 JSON 三字段', () => {
  it('UT-GEN-JSON-01: 合法三字段 JSON 解析通过', () => {
    const input = '{"summary":"结论A","keyPoints":["要点1","要点2"],"nextStep":"下一步B"}';
    const result = parseStructuredAnswer(input);
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, '结论A');
    assert.equal(result.value.nextStep, '下一步B');
    assert.equal(Array.isArray(result.value.keyPoints), true);
    assert.deepEqual(result.value.keyPoints, ['要点1', '要点2']);
  });

  it('UT-GEN-JSON-02: keyPoints 必须为字符串数组', () => {
    const base = { summary: 'S', nextStep: 'N' };
    const cases = [
      { ...base, keyPoints: '要点1' },
      { ...base, keyPoints: [1, 2] },
      { ...base, keyPoints: null },
      { summary: 'S', nextStep: 'N' },
    ];
    for (const input of cases) {
      const result = parseStructuredAnswer(JSON.stringify(input));
      assert.equal(result.ok, false, `应失败: ${JSON.stringify(input)}`);
      assert.equal('value' in result && result.value != null, false);
    }
  });

  it('UT-GEN-JSON-03: 缺字段或空字符串失败', () => {
    const cases = [
      { keyPoints: ['K'], nextStep: 'N' },
      { summary: 'S', keyPoints: ['K'] },
      { summary: '', keyPoints: ['K'], nextStep: 'N' },
      { summary: 'S', keyPoints: ['K'], nextStep: '   ' },
      { summary: 'S', keyPoints: [], nextStep: 'N' },
      { summary: 'S', keyPoints: [''], nextStep: 'N' },
    ];
    for (const input of cases) {
      const result = parseStructuredAnswer(JSON.stringify(input));
      assert.equal(result.ok, false, `应失败: ${JSON.stringify(input)}`);
    }
  });

  it('UT-GEN-JSON-04: 非整 JSON / 纯 HTML 失败', () => {
    const cases = [
      '<p>结论</p><ul><li>要点</li></ul>',
      '这是一段非 JSON 散文说明',
      '{"summary":"x"',
    ];
    for (const input of cases) {
      const result = parseStructuredAnswer(input);
      assert.equal(result.ok, false, `应失败: ${input}`);
    }
  });

  it('UT-GEN-JSON-05: Markdown 代码围栏包裹的 JSON 可解析', () => {
    const fenced = '```json\n{"summary":"S","keyPoints":["K"],"nextStep":"N"}\n```';
    const result = parseStructuredAnswer(fenced);
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, 'S');
    assert.deepEqual(result.value.keyPoints, ['K']);
    assert.equal(result.value.nextStep, 'N');

    const fencedNoLang = '```\n{"summary":"S","keyPoints":["K"],"nextStep":"N"}\n```';
    const result2 = parseStructuredAnswer(fencedNoLang);
    assert.equal(result2.ok, true);
    assert.equal(result2.value.summary, 'S');
  });

  it('UT-GEN-JSON-06: 额外未知字段可忽略', () => {
    const input = JSON.stringify({
      summary: 'S',
      keyPoints: ['K'],
      nextStep: 'N',
      extra: 'x',
      html: '<p>y</p>',
    });
    const result = parseStructuredAnswer(input);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      summary: 'S',
      keyPoints: ['K'],
      nextStep: 'N',
    });
    assert.equal('html' in result.value, false);
    assert.equal('extra' in result.value, false);
  });

  it('UT-GEN-JSON-07: generate systemPrompt 要求 JSON 三字段而非 HTML', () => {
    const systemPrompt = GENERATE_ANSWER_SYSTEM_PROMPT;
    assert.match(systemPrompt, /JSON/i);
    assert.ok(systemPrompt.includes('summary'));
    assert.ok(systemPrompt.includes('keyPoints'));
    assert.ok(systemPrompt.includes('nextStep'));
    assert.equal(systemPrompt.includes('仅 body 内'), false);
    assert.equal(
      systemPrompt.includes('请直接输出可用于前端展示的 HTML 片段'),
      false,
    );
    assert.equal(systemPrompt.includes('<p>/<h3>/<ul>/<li>'), false);
    assert.equal(/HTML\s*标签进行格式化/i.test(systemPrompt), false);
  });

  it('UT-GEN-JSON-08: 校验失败路径不得调用入库', () => {
    let writeCount = 0;
    const result = persistStructuredAnswerIfValid(
      '<p>脏 HTML</p>',
      () => { writeCount += 1; },
    );
    assert.equal(result.ok, false);
    assert.equal(writeCount, 0);

    const ok = persistStructuredAnswerIfValid(
      '{"summary":"S","keyPoints":["K"],"nextStep":"N"}',
      () => { writeCount += 1; },
    );
    assert.equal(ok.ok, true);
    assert.equal(writeCount, 1);
  });
});
