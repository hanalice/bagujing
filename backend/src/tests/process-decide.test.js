/**
 * 流程飞轮：运行记录归类，重复原因才改流程队列，次数不降则改待决。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { decide } from '../../../scripts/automation/process-decide.js';

const TEMPLATE = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../../docs/process-backlog.md'),
  'utf8',
);

function runs(reasons) {
  return reasons.map((reason) => JSON.stringify({
    ts: '2026-11-17T00:00:00.000Z',
    kind: 'daily-fix',
    taskId: 'S14',
    stage: 'qa',
    reason,
    exitCode: reason === 'ok' ? 0 : 1,
    prOpened: false,
    qaPassed: reason !== 'qa_failed',
  })).join('\n');
}

describe('process-decide', () => {
  it('UT-PROCESS-01: 未达 3 次不改流程队列', () => {
    const result = decide({
      runsText: runs(['qa_failed', 'qa_failed', 'ok']),
      backlog: TEMPLATE,
      state: { reasons: {} },
      threshold: 3,
      limit: 20,
      today: '2026-11-17',
    });
    assert.equal(result.action, 'none');
    assert.equal(result.backlog, TEMPLATE);
  });

  it('UT-PROCESS-02: 同一原因满 3 次追加 assist，不标 auto', () => {
    const result = decide({
      runsText: runs(['qa_failed', 'qa_failed', 'qa_failed']),
      backlog: TEMPLATE,
      state: { reasons: {} },
      threshold: 3,
      limit: 20,
      today: '2026-11-17',
    });
    assert.equal(result.action, 'assist');
    assert.match(result.backlog, /\| P1 \| fix \| qa_failed \| assist \| todo \| 10 \|/);
    assert.equal(result.state.reasons.qa_failed.itemId, 'P1');
    assert.equal(result.state.reasons.qa_failed.countAtAction, 3);
  });

  it('UT-PROCESS-03: 次数没下降就写待决，不再降低同一项优先级', () => {
    const first = decide({
      runsText: runs(['qa_failed', 'qa_failed', 'qa_failed']),
      backlog: TEMPLATE,
      state: { reasons: {} },
      threshold: 3,
      limit: 20,
      today: '2026-11-17',
    });
    const second = decide({
      runsText: runs(['qa_failed', 'qa_failed', 'qa_failed', 'qa_failed']),
      backlog: first.backlog,
      state: first.state,
      threshold: 3,
      limit: 20,
      today: '2026-11-18',
    });
    assert.equal(second.action, 'pending');
    assert.match(second.backlog, /\| P1 \| fix \| qa_failed \| assist \| todo \| 10 \|/);
    assert.match(second.backlog, /原因 qa_failed 反复出现且次数没有下降/);
    assert.doesNotMatch(second.backlog, /\| auto \| todo \|/);
  });

  it('UT-PROCESS-04: 记录脚本写出一行且原因可归类', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-record-'));
    const file = path.join(root, 'automation-runs.ndjson');
    const lib = path.resolve(import.meta.dirname, '../../../scripts/automation/lib/run-record.sh');
    execFileSync('bash', ['-c', `
      set -euo pipefail
      PROJECT_ROOT=${JSON.stringify(root)}
      AUTOMATION_RUN_FILE=${JSON.stringify(file)}
      source ${JSON.stringify(lib)}
      test "$(automation_classify_message '队列中没有可执行任务')" = empty_queue
      test "$(automation_classify_message '缺少契约冻结')" = contract_missing
      automation_record daily-fix S14 qa qa_failed 1 false false
    `], { encoding: 'utf8' });
    const row = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(row.kind, 'daily-fix');
    assert.equal(row.taskId, 'S14');
    assert.equal(row.reason, 'qa_failed');
    assert.equal(row.exitCode, 1);
    assert.equal(row.prOpened, false);
    assert.equal(row.qaPassed, false);
  });
});
