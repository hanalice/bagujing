import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ANSWER_GENERATE_SYSTEM_PROMPT,
  parseStructuredAnswer,
  serializeStructuredAnswer,
} from '../answer-structured.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_EXPRESS_PATH = path.join(__dirname, '../server-express.js');

describe('C41 / P1-4: 解析生成 JSON 三字段与校验', () => {
  it('UT-ANSWER-JSON-01: 合法三字段对象解析成功', () => {
    const result = parseStructuredAnswer(
      '{"summary":"结论A","keyPoints":["点1","点2"],"nextStep":"下一步B"}',
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, '结论A');
    assert.equal(result.value.nextStep, '下一步B');
    assert.equal(Array.isArray(result.value.keyPoints), true);
    assert.deepEqual(result.value.keyPoints, ['点1', '点2']);
  });

  it('UT-ANSWER-JSON-02: keyPoints 必须为字符串数组', () => {
    const base = { summary: '结论', nextStep: '下一步' };
    const invalidCases = [
      { ...base, keyPoints: '点1' },
      { ...base, keyPoints: [1, 'x'] },
      { ...base, keyPoints: null },
      { summary: '结论', nextStep: '下一步' },
    ];
    for (const payload of invalidCases) {
      const result = parseStructuredAnswer(JSON.stringify(payload));
      assert.equal(result.ok, false, `应失败: ${JSON.stringify(payload)}`);
      assert.equal(result.reason, 'invalid_structured_answer');
    }

    // 约定：空数组与单项数组均合法
    const emptyOk = parseStructuredAnswer(JSON.stringify({ ...base, keyPoints: [] }));
    assert.equal(emptyOk.ok, true);
    assert.deepEqual(emptyOk.value.keyPoints, []);

    const oneOk = parseStructuredAnswer(JSON.stringify({ ...base, keyPoints: ['仅一项'] }));
    assert.equal(oneOk.ok, true);
    assert.deepEqual(oneOk.value.keyPoints, ['仅一项']);
  });

  it('UT-ANSWER-JSON-03: summary / nextStep 类型与缺失', () => {
    const cases = [
      { keyPoints: ['a'], nextStep: '下一步' },
      { summary: '结论', keyPoints: ['a'] },
      { summary: '', keyPoints: ['a'], nextStep: '下一步' },
      { summary: 123, keyPoints: ['a'], nextStep: '下一步' },
      { summary: '结论', keyPoints: ['a'], nextStep: null },
    ];
    for (const payload of cases) {
      const result = parseStructuredAnswer(JSON.stringify(payload));
      assert.equal(result.ok, false, `应失败: ${JSON.stringify(payload)}`);
      assert.equal(result.reason, 'invalid_structured_answer');
    }
  });

  it('UT-ANSWER-JSON-04: 整篇 HTML / 非 JSON 文本校验失败', () => {
    const inputs = [
      '<p>结论</p><ul><li>点</li></ul>',
      '先给结论再分点',
      '{not json',
      '["a"]',
      '"hello"',
    ];
    for (const input of inputs) {
      const result = parseStructuredAnswer(input);
      assert.equal(result.ok, false, `应失败: ${input}`);
      assert.equal(result.reason, 'invalid_structured_answer');
    }
  });

  it('UT-ANSWER-JSON-05: 可选：一层 markdown fence 可剥离', () => {
    // 实现约定：支持一层 ```json / ``` 围栏剥离
    const fenced = '```json\n{"summary":"S","keyPoints":["k"],"nextStep":"N"}\n```';
    const result = parseStructuredAnswer(fenced);
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, 'S');
    assert.deepEqual(result.value.keyPoints, ['k']);
    assert.equal(result.value.nextStep, 'N');

    const bareFence = '```\n{"summary":"S","keyPoints":["k"],"nextStep":"N"}\n```';
    assert.equal(parseStructuredAnswer(bareFence).ok, true);

    const proseWrapped = '说明如下：\n```json\n{"summary":"S","keyPoints":["k"],"nextStep":"N"}\n```\n以上';
    assert.equal(parseStructuredAnswer(proseWrapped).ok, false);

    const doubleFence = '```\n```json\n{"summary":"S","keyPoints":["k"],"nextStep":"N"}\n```\n```';
    assert.equal(parseStructuredAnswer(doubleFence).ok, false);
  });

  it('UT-ANSWER-JSON-06: generate system 要求 JSON 三字段、不再要求整篇 HTML', () => {
    const systemPrompt = ANSWER_GENERATE_SYSTEM_PROMPT;
    assert.ok(systemPrompt.includes('JSON'));
    assert.ok(systemPrompt.includes('summary'));
    assert.ok(systemPrompt.includes('keyPoints'));
    assert.ok(systemPrompt.includes('nextStep'));
    assert.equal(systemPrompt.includes('请直接输出可用于前端展示的 HTML 片段'), false);
    assert.equal(systemPrompt.includes('仅 body 内'), false);
    assert.equal(systemPrompt.includes('<p>/<h3>/<ul>/<li>'), false);

    const serverSource = fs.readFileSync(SERVER_EXPRESS_PATH, 'utf8');
    assert.ok(
      serverSource.includes('ANSWER_GENERATE_SYSTEM_PROMPT'),
      'generate 路由须使用 ANSWER_GENERATE_SYSTEM_PROMPT',
    );
  });

  it('UT-ANSWER-JSON-07: 多余字段忽略、未知顶层形态拒绝', () => {
    const withExtra = parseStructuredAnswer(JSON.stringify({
      summary: '结论',
      keyPoints: ['点'],
      nextStep: '下一步',
      extra: '<script>x</script>',
    }));
    assert.equal(withExtra.ok, true);
    assert.deepEqual(Object.keys(withExtra.value).sort(), ['keyPoints', 'nextStep', 'summary']);
    const stored = serializeStructuredAnswer(withExtra.value);
    assert.equal(stored.includes('extra'), false);
    assert.equal(stored.includes('<script>'), false);

    const nested = parseStructuredAnswer(JSON.stringify({
      data: {
        summary: '结论',
        keyPoints: ['点'],
        nextStep: '下一步',
      },
    }));
    assert.equal(nested.ok, false);
    assert.equal(nested.reason, 'invalid_structured_answer');
  });
});
