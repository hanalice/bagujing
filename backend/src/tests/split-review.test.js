/**
 * 拆条双评裁决（提案不计票；2/2 才采纳）。
 * 对应对 docs/test_cases 风格的流程测：UT-SPLIT-*
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReviewerOutput,
  decideSplitRound,
} from '../../../scripts/automation/lib/split-review.js';

describe('split-review', () => {
  it('UT-SPLIT-01: 解析 PASS 与空 FAIL_CODES', () => {
    const r = parseReviewerOutput('说明若干\nVERDICT: PASS\n');
    assert.equal(r.verdict, 'PASS');
    assert.deepEqual(r.failCodes, []);
  });

  it('UT-SPLIT-02: 解析 FAIL 与 FAIL_CODES', () => {
    const r = parseReviewerOutput('VERDICT: FAIL\nFAIL_CODES: 1, 4\n');
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.failCodes, [1, 4]);
  });

  it('UT-SPLIT-03: PASS 却带失败条款 → 按 FAIL', () => {
    const r = parseReviewerOutput('CHECK-2: FAIL\nVERDICT: PASS\n');
    assert.equal(r.verdict, 'FAIL');
    assert.deepEqual(r.failCodes, [2]);
  });

  it('UT-SPLIT-04: 双评 PASS → adopt', () => {
    const d = decideSplitRound({
      reviewA: parseReviewerOutput('VERDICT: PASS'),
      reviewB: parseReviewerOutput('VERDICT: PASS'),
      revisionUsed: false,
    });
    assert.equal(d.action, 'adopt');
  });

  it('UT-SPLIT-05: 一过一否且未改版 → revise', () => {
    const d = decideSplitRound({
      reviewA: parseReviewerOutput('VERDICT: PASS'),
      reviewB: parseReviewerOutput('VERDICT: FAIL\nFAIL_CODES: 3'),
      revisionUsed: false,
    });
    assert.equal(d.action, 'revise');
    assert.deepEqual(d.failCodes, [3]);
  });

  it('UT-SPLIT-06: 改版后仍非 2/2 → reject', () => {
    const d = decideSplitRound({
      reviewA: parseReviewerOutput('VERDICT: FAIL\nFAIL_CODES: 1'),
      reviewB: parseReviewerOutput('VERDICT: PASS'),
      revisionUsed: true,
    });
    assert.equal(d.action, 'reject');
    assert.deepEqual(d.failCodes, [1]);
  });

  it('UT-SPLIT-07: 未知结论不当作 PASS', () => {
    const d = decideSplitRound({
      reviewA: parseReviewerOutput('我觉得还行'),
      reviewB: parseReviewerOutput('VERDICT: PASS'),
      revisionUsed: false,
    });
    assert.equal(d.action, 'revise');
  });
});
