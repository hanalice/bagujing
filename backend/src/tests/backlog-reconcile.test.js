/**
 * 并发日修把队列表合并错之后的收回规则。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reconcileText, unionTexts } from '../../../scripts/automation/backlog-reconcile.js';

const ROOT = path.resolve(import.meta.dirname, '../../..');

function doc(queueRows, revisionRows, contract = '### S22\n\n- **做**：清会话\n') {
  return [
    '# 队列',
    '',
    '## 队列表',
    '',
    '| ID | 类型 | 来源 | 分级 | 状态 | 优先级 | 任务 |',
    '| --- | -- | --- | ---- | --- | --- | -- |',
    ...queueRows,
    '',
    '## 契约冻结',
    '',
    contract,
    '## 修订记录',
    '',
    '| 日期 | 说明 |',
    '| --- | -- |',
    ...revisionRows,
    '',
  ].join('\n');
}

function queueLines(text) {
  return text.split('\n').filter((line) => /^\|\s*[A-Z][0-9]+\s*\|/.test(line));
}

describe('backlog reconcile', () => {
  it('UT-QUEUE-MERGE-01: 修订记录已完成时，todo 行改回 done', () => {
    const text = doc(
      ['| S22 | fix | user | auto | todo | 10 | 401 清会话 |'],
      ['| 2026-11-25 | S22 完成：401 清会话 |'],
    );
    const result = reconcileText(text);
    assert.equal(result.changed, true);
    assert.match(queueLines(result.text)[0], /\| done \|/);
    assert.equal(queueLines(result.text).length, 1);
    assert.match(result.text, /S22 完成/);
  });

  it('UT-QUEUE-MERGE-02: 同一 ID 的 todo 与 done 只留 done', () => {
    const text = doc(
      [
        '| S23 | fix | user | auto | todo | 20 | 键盘提交 |',
        '| S23 | fix | user | auto | done | 20 | 键盘提交 |',
        '| S20 | fix | scan | auto | todo | 110 | 仍待做 |',
      ],
      ['| 2026-11-25 | S23 完成：键盘提交 |'],
    );
    const rows = queueLines(reconcileText(text).text);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /S23/);
    assert.match(rows[0], /\| done \|/);
    assert.match(rows[1], /S20/);
    assert.match(rows[1], /\| todo \|/);
  });

  it('UT-QUEUE-MERGE-03: 没有完成记录的 todo 保持不动', () => {
    const text = doc(
      ['| S20 | fix | scan | auto | todo | 110 | 仍待做 |'],
      ['| 2026-11-25 | 登记 S22 |'],
    );
    const result = reconcileText(text);
    assert.equal(result.changed, false);
    assert.match(queueLines(result.text)[0], /\| todo \|/);
  });

  it('UT-QUEUE-MERGE-04: 两边队列取并集，done 胜出，契约分歧则拒绝', () => {
    const ours = doc(
      ['| S22 | fix | user | auto | done | 10 | 401 清会话 |'],
      ['| 2026-11-25 | S22 完成：401 清会话 |'],
    );
    const theirs = doc(
      [
        '| S22 | fix | user | auto | todo | 10 | 401 清会话 |',
        '| S23 | fix | user | auto | done | 20 | 键盘提交 |',
      ],
      ['| 2026-11-25 | S23 完成：键盘提交 |'],
    );
    const merged = unionTexts(ours, theirs);
    assert.equal(merged.ok, true);
    const rows = queueLines(merged.text);
    assert.equal(rows.length, 2);
    assert.match(rows[0], /S22/);
    assert.match(rows[0], /\| done \|/);
    assert.match(rows[1], /S23/);
    assert.match(rows[1], /\| done \|/);
    assert.match(merged.text, /S22 完成/);
    assert.match(merged.text, /S23 完成/);

    const drifted = unionTexts(ours, doc(
      ['| S22 | fix | user | auto | todo | 10 | 401 清会话 |'],
      ['| 2026-11-25 | S22 完成：401 清会话 |'],
      '### S22\n\n- **做**：另一套契约\n',
    ));
    assert.equal(drifted.ok, false);
  });

  it('UT-QUEUE-MERGE-05: 选单跳过修订记录已完成、队列表仍是 todo 的 ID', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-merge-'));
    const backlog = path.join(dir, 'backlog.md');
    fs.writeFileSync(backlog, doc(
      [
        '| S22 | fix | user | auto | todo | 10 | 401 清会话 |',
        '| S20 | fix | scan | auto | todo | 110 | 仍待做 |',
      ],
      ['| 2026-11-25 | S22 完成：401 清会话 |'],
    ));
    const run = spawnSync('bash', ['-c', `
      set -euo pipefail
      die() { echo "$*" >&2; exit 1; }
      PROJECT_ROOT="${ROOT}"
      BACKLOG_PATH="${backlog}"
      source "${ROOT}/scripts/automation/lib/backlog-queue.sh"
      backlog_read_row "" auto
    `], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /^S20\t/);
    assert.doesNotMatch(run.stdout, /^S22\t/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
