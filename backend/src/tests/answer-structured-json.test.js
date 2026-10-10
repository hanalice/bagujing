/**
 * C41 / P1-4：解析生成 JSON 三字段校验（单元）。
 * 用例 ID 对齐 docs/test_cases.md §2.25。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATE_ANSWER_SYSTEM_PROMPT,
  parseGeneratedAnswerJson,
} from '../answer-structured-json.js';

describe('C41 / P1-4: 解析生成 JSON 三字段校验', () => {
  it('UT-ANSWER-JSON-01: 合法三字段 JSON 解析成功', () => {
    const raw = '{"summary":"结论A","keyPoints":["要点1","要点2"],"nextStep":"去练题"}';
    const result = parseGeneratedAnswerJson(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      summary: '结论A',
      keyPoints: ['要点1', '要点2'],
      nextStep: '去练题',
    });
    assert.equal(Array.isArray(result.value.keyPoints), true);
    assert.ok(result.value.keyPoints.every((item) => typeof item === 'string'));
  });

  it('UT-ANSWER-JSON-02: markdown 围栏包裹的 JSON 可剥离解析', () => {
    const raw = '```json\n{"summary":"S","keyPoints":["K"],"nextStep":"N"}\n```';
    const result = parseGeneratedAnswerJson(`  ${raw}  `);
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      summary: 'S',
      keyPoints: ['K'],
      nextStep: 'N',
    });
  });

  it('UT-ANSWER-JSON-03: 非整 JSON 的 HTML 片段校验失败', () => {
    const raw = '<p>简短结论</p><ul><li>要点</li></ul>';
    const result = parseGeneratedAnswerJson(raw);
    assert.equal(result.ok, false);
    assert.ok(
      result.reason === 'invalid_json' || result.reason === 'schema_mismatch',
      `失败 reason 须可区分，实际: ${result.reason}`,
    );
    assert.equal(result.value, undefined);
  });

  it('UT-ANSWER-JSON-04: JSON 语法错误 / 截断失败', () => {
    const cases = ['{ "summary": "断', 'not-json', '', '   '];
    for (const raw of cases) {
      const result = parseGeneratedAnswerJson(raw);
      assert.equal(result.ok, false, `应失败: ${JSON.stringify(raw)}`);
      assert.equal(result.reason, 'invalid_json');
    }
  });

  it('UT-ANSWER-JSON-05: 缺字段或字段名漂移失败', () => {
    const cases = [
      '{"keyPoints":["k"],"nextStep":"n"}',
      '{"summary":"s","nextStep":"n"}',
      '{"summary":"s","keyPoints":["k"]}',
      '{"conclusion":"s","points":["k"],"next":"n"}',
      '{"Summary":"s","keyPoints":["k"],"nextStep":"n"}',
    ];
    for (const raw of cases) {
      const result = parseGeneratedAnswerJson(raw);
      assert.equal(result.ok, false, `应失败: ${raw}`);
      assert.equal(result.reason, 'schema_mismatch');
    }
  });

  it('UT-ANSWER-JSON-06: keyPoints 类型必须为字符串数组', () => {
    const cases = [
      '{"summary":"s","keyPoints":"单字符串","nextStep":"n"}',
      '{"summary":"s","keyPoints":{"a":1},"nextStep":"n"}',
      '{"summary":"s","keyPoints":[1,"x"],"nextStep":"n"}',
      '{"summary":"s","keyPoints":null,"nextStep":"n"}',
      '{"summary":"s","nextStep":"n"}',
    ];
    for (const raw of cases) {
      const result = parseGeneratedAnswerJson(raw);
      assert.equal(result.ok, false, `应失败: ${raw}`);
      assert.equal(result.reason, 'schema_mismatch');
    }
  });

  it('UT-ANSWER-JSON-07: summary/nextStep 非空字符串；keyPoints 允许空数组', () => {
    assert.equal(
      parseGeneratedAnswerJson('{"summary":"","keyPoints":["k"],"nextStep":"n"}').ok,
      false,
    );
    assert.equal(
      parseGeneratedAnswerJson('{"summary":"   ","keyPoints":["k"],"nextStep":"n"}').ok,
      false,
    );
    assert.equal(
      parseGeneratedAnswerJson('{"summary":"s","keyPoints":["k"],"nextStep":""}').ok,
      false,
    );
    assert.equal(
      parseGeneratedAnswerJson('{"summary":1,"keyPoints":["k"],"nextStep":"n"}').ok,
      false,
    );
    assert.equal(
      parseGeneratedAnswerJson('{"summary":"s","keyPoints":["k"],"nextStep":true}').ok,
      false,
    );

    const emptyPoints = parseGeneratedAnswerJson(
      '{"summary":"有结论","keyPoints":[],"nextStep":"下一步"}',
    );
    assert.equal(emptyPoints.ok, true);
    assert.deepEqual(emptyPoints.value.keyPoints, []);
    assert.equal(emptyPoints.value.summary.trim().length > 0, true);
    assert.equal(emptyPoints.value.nextStep.trim().length > 0, true);
  });

  it('UT-ANSWER-JSON-08: 额外未知字段可忽略', () => {
    const raw = JSON.stringify({
      summary: '结论',
      keyPoints: ['a'],
      nextStep: '下一步',
      html: '<p>x</p>',
      raw: 'extra',
    });
    const result = parseGeneratedAnswerJson(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.value).sort(), ['keyPoints', 'nextStep', 'summary']);
    assert.equal(result.value.html, undefined);
    assert.equal(result.value.raw, undefined);
  });

  it('UT-ANSWER-JSON-09: generate systemPrompt 要求 JSON 三字段而非整篇 HTML', () => {
    const systemPrompt = GENERATE_ANSWER_SYSTEM_PROMPT;
    assert.match(systemPrompt, /JSON/);
    assert.match(systemPrompt, /summary/);
    assert.match(systemPrompt, /keyPoints/);
    assert.match(systemPrompt, /nextStep/);
    assert.equal(systemPrompt.includes('请直接输出可用于前端展示的 HTML 片段'), false);
    assert.equal(systemPrompt.includes('仅 body 内'), false);
    assert.equal(systemPrompt.includes('<p>/<h3>/<ul>/<li>'), false);
  });

  it('UT-ANSWER-JSON-10: 校验失败路径不得调用写库（解析层契约）', () => {
    // 纯函数层：HTML 失败不得产出可入库 value；写库零次由 IT-ANSWER-JSON-02 / SEC 覆盖
    let upsertCalls = 0;
    const upsertProblemAnswerById = () => {
      upsertCalls += 1;
    };
    const result = parseGeneratedAnswerJson('<p>旧式整篇解析</p><ul><li>x</li></ul>');
    assert.equal(result.ok, false);
    if (result.ok) {
      upsertProblemAnswerById({ answer: JSON.stringify(result.value) });
    }
    assert.equal(upsertCalls, 0);
  });
});
