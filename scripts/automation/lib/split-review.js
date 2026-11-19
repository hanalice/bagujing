/**
 * 拆条双评裁决：提案人不计票；两评均为 PASS 才采纳。
 * 供 split-item.sh 与单测调用。
 */

const CHECKLIST_COUNT = 5;

/**
 * 从评委输出解析二元结论。
 * 约定末尾含：
 *   VERDICT: PASS|FAIL
 *   FAIL_CODES: 1,3   （可选；FAIL 时建议有）
 * @param {string} text
 * @returns {{ verdict: 'PASS'|'FAIL'|'UNKNOWN', failCodes: number[], raw: string }}
 */
export function parseReviewerOutput(text) {
  const raw = String(text ?? '');
  let verdict = 'UNKNOWN';
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/VERDICT:\s*(PASS|FAIL)\b/i);
    if (m) verdict = m[1].toUpperCase();
  }

  const failCodes = new Set();
  for (const line of lines) {
    const m = line.match(/FAIL_CODES:\s*([0-9,\s]+)/i);
    if (m) {
      for (const part of m[1].split(/[,\s]+/)) {
        const n = Number(part);
        if (Number.isInteger(n) && n >= 1 && n <= CHECKLIST_COUNT) failCodes.add(n);
      }
    }
  }

  // 兼容逐条：CHECK-1: FAIL
  for (const line of lines) {
    const m = line.match(/CHECK\s*-?\s*([1-5])\s*[:：]\s*FAIL\b/i);
    if (m) failCodes.add(Number(m[1]));
  }

  if (verdict === 'PASS' && failCodes.size > 0) {
    // 自相矛盾：有失败条款却写 PASS → 按 FAIL
    verdict = 'FAIL';
  }
  if (verdict === 'FAIL' && failCodes.size === 0) {
    // 未点名时记 0，方便改版提示「未点名条款」
    failCodes.add(0);
  }

  return { verdict, failCodes: [...failCodes].sort((a, b) => a - b), raw };
}

/**
 * 一轮双评后的动作。
 * @param {{ reviewA: ReturnType<typeof parseReviewerOutput>, reviewB: ReturnType<typeof parseReviewerOutput>, revisionUsed: boolean }} input
 * @returns {{ action: 'adopt'|'revise'|'reject', failCodes: number[], summary: string }}
 */
export function decideSplitRound({ reviewA, reviewB, revisionUsed }) {
  const a = reviewA?.verdict === 'PASS';
  const b = reviewB?.verdict === 'PASS';
  const failCodes = [...new Set([...(reviewA?.failCodes || []), ...(reviewB?.failCodes || [])])]
    .filter((n) => n > 0)
    .sort((a, b) => a - b);

  if (a && b) {
    return {
      action: 'adopt',
      failCodes: [],
      summary: '双评均为 PASS（2/2），采纳拆条并写入 backlog。',
    };
  }

  const summaryParts = [];
  if (!a) summaryParts.push(`评A=${reviewA?.verdict || 'UNKNOWN'}`);
  if (!b) summaryParts.push(`评B=${reviewB?.verdict || 'UNKNOWN'}`);
  if (failCodes.length) summaryParts.push(`否决条款 ${failCodes.join(',')}`);

  if (!revisionUsed) {
    return {
      action: 'revise',
      failCodes,
      summary: `未达 2/2（${summaryParts.join('；')}）。交给拆的人改一版后再双评。`,
    };
  }

  return {
    action: 'reject',
    failCodes,
    summary: `第二轮仍未 2/2（${summaryParts.join('；')}）。不改 auto，父项保持 assist/manual。`,
  };
}

export const SPLIT_CHECKLIST = [
  '一次 PR 能做完，单层单主题',
  '「做 / 不做 / residual」互不打架、单测能锁',
  'manual 运维壳与代码切片已分开（若适用）',
  '不会误标 auto 导致日修无人值守踩坑',
  '与已有 done/todo 不重复、不抢别项范围',
];
