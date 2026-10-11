/**
 * C41 / P1-4：解析生成 JSON 三字段校验（单元）。
 * 用例 ID 对齐 docs/test_cases.md §2.25。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseStructuredAnswer, serializeStructuredAnswer } from '../answer-structured.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_EXPRESS_PATH = path.resolve(__dirname, '../server-express.js');

/**
 * 从 server-express.js 按路由锚点抽取 generate 的 systemPrompt 字面量。
 * @param {string} source
 * @param {string} routeNeedle
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
  // eslint-disable-next-line no-new-func -- 仅求值已校验过的单引号字面量拼接
  return Function(`"use strict"; return (${match[1]});`)();
}

describe('C41 / P1-4: 解析生成 JSON 三字段校验', () => {
  it('UT-GEN-STRUCT-01: generate systemPrompt 要求 JSON 三字段而非整篇 HTML', () => {
    const source = fs.readFileSync(SERVER_EXPRESS_PATH, 'utf8');
    const systemPrompt = extractSystemPromptForRoute(
      source,
      "app.post('/api/problems/:id/answer/generate'",
    );

    assert.ok(systemPrompt.includes('JSON'), '须要求输出 JSON');
    assert.ok(systemPrompt.includes('summary'), '须点名 summary');
    assert.ok(systemPrompt.includes('keyPoints'), '须点名 keyPoints');
    assert.ok(systemPrompt.includes('nextStep'), '须点名 nextStep');
    assert.equal(
      systemPrompt.includes('请直接输出可用于前端展示的 HTML 片段'),
      false,
    );
    assert.equal(systemPrompt.includes('仅 body 内'), false);
    assert.equal(systemPrompt.includes('<p>/<h3>/<ul>/<li>'), false);
    assert.ok(systemPrompt.includes('面试官'), '须保留资深面试官角色');
    assert.ok(/结论|summary/.test(systemPrompt), '须保留结论语义');
    assert.ok(/分点|keyPoints/.test(systemPrompt), '须保留分点语义');
    assert.ok(/下一步|nextStep/.test(systemPrompt), '须保留下一步语义');
  });

  it('UT-GEN-STRUCT-02: 合法 JSON 三字段校验通过', () => {
    const result = parseStructuredAnswer(
      '{"summary":"先结论","keyPoints":["要点A","要点B"],"nextStep":"去练一题"}',
    );
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, '先结论');
    assert.equal(result.value.nextStep, '去练一题');
    assert.equal(Array.isArray(result.value.keyPoints), true);
    assert.equal(result.value.keyPoints.length, 2);
    assert.equal(typeof result.value.keyPoints[0], 'string');
    assert.equal(typeof result.value.keyPoints[1], 'string');
  });

  it('UT-GEN-STRUCT-03: Markdown 代码围栏包裹的 JSON 仍可解析', () => {
    const fenced = '```json\n{"summary":"S","keyPoints":["K"],"nextStep":"N"}\n```';
    const result = parseStructuredAnswer(fenced);
    assert.equal(result.ok, true);
    assert.equal(result.value.summary, 'S');
    assert.deepEqual(result.value.keyPoints, ['K']);
    assert.equal(result.value.nextStep, 'N');
  });

  it('UT-GEN-STRUCT-04: 缺少任一必填字段 → 校验失败', () => {
    const cases = [
      { keyPoints: ['有点'], nextStep: '下一步' },
      { summary: '有结论', nextStep: '下一步' },
      { summary: '有结论', keyPoints: ['有点'] },
    ];
    for (const input of cases) {
      const result = parseStructuredAnswer(input);
      assert.equal(result.ok, false, `缺字段应失败: ${JSON.stringify(input)}`);
      assert.equal(result.value, undefined);
    }
  });

  it('UT-GEN-STRUCT-05: keyPoints 类型错误或空数组 → 校验失败', () => {
    const base = { summary: 'S', nextStep: 'N' };
    const cases = [
      { ...base, keyPoints: '只要一点' },
      { ...base, keyPoints: [] },
      { ...base, keyPoints: ['', '  '] },
    ];
    for (const input of cases) {
      const result = parseStructuredAnswer(input);
      assert.equal(result.ok, false, `keyPoints 非法应失败: ${JSON.stringify(input)}`);
    }
  });

  it('UT-GEN-STRUCT-06: summary/nextStep 空串或非字符串 → 校验失败', () => {
    const keyPoints = ['合法要点'];
    const cases = [
      { summary: '', keyPoints, nextStep: 'N' },
      { summary: '   ', keyPoints, nextStep: 'N' },
      { summary: 1, keyPoints, nextStep: 'N' },
      { summary: 'S', keyPoints, nextStep: null },
    ];
    for (const input of cases) {
      const result = parseStructuredAnswer(input);
      assert.equal(result.ok, false, `应失败: ${JSON.stringify(input)}`);
    }
  });

  it('UT-GEN-STRUCT-07: 整篇 HTML / 非 JSON → 校验失败', () => {
    assert.equal(parseStructuredAnswer('<p>结论</p><ul><li>点</li></ul>').ok, false);
    assert.equal(parseStructuredAnswer('{not json').ok, false);
  });

  it('UT-GEN-STRUCT-08: 额外未知字段不影响三字段成功', () => {
    const result = parseStructuredAnswer({
      summary: '结论',
      keyPoints: ['点'],
      nextStep: '下一步',
      extra: '<script>x</script>',
      html: '<p>z</p>',
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, {
      summary: '结论',
      keyPoints: ['点'],
      nextStep: '下一步',
    });
    assert.equal('extra' in result.value, false);
    assert.equal('html' in result.value, false);
    const stored = serializeStructuredAnswer(result.value);
    assert.equal(stored.includes('<script>'), false);
    assert.equal(stored.includes('<p>z</p>'), false);
    assert.deepEqual(JSON.parse(stored), result.value);
  });
});
