#!/usr/bin/env bash
# Windows 任务计划 / 本机 cron 入口：每天从 docs/backlog.md 取一个 auto 项并开 PR。
# 由 register-windows-daily-fix.ps1 注册，也可手动执行。
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

mkdir -p "$PROJECT_ROOT/logs"
# shellcheck source=lib/run-record.sh
source "$PROJECT_ROOT/scripts/automation/lib/run-record.sh"
LOG="$PROJECT_ROOT/logs/daily-fix-cron-$(date +%Y%m%d-%H%M%S).log"
LOCK="$PROJECT_ROOT/logs/daily-fix-cron.lock"

exec >>"$LOG" 2>&1
echo "======== $(date -Iseconds) daily-fix-cron start ========"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "另一实例仍在运行，本次退出。"
  automation_record daily-fix-cron "" cron already_running 0 "" ""
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，拒绝无人值守运行。请先处理本地改动。"
  automation_record daily-fix-cron "" cron dirty_worktree 1 "" ""
  exit 1
fi

# 开机后 DNS/代理可能尚未就绪
ok_fetch=0
for _ in 1 2 3 4 5 6; do
  if git fetch origin; then
    ok_fetch=1
    break
  fi
  sleep 10
done
if [ "$ok_fetch" -ne 1 ]; then
  echo "git fetch 失败，放弃本次。"
  automation_record daily-fix-cron "" cron fetch_failed 1 "" ""
  exit 1
fi

git checkout main
git merge --ff-only origin/main

# 独立脚本：先消化未合并的周扫描 / 日修 PR。失败则今天不新开任务。
if ! ./scripts/automation/merge-remote-prs.sh; then
  echo "远端 PR 未合并，本次不开启新日修。"
  reason="pr_unmerged"
  if grep -q "冲突" "$LOG"; then
    reason="pr_conflict"
  elif grep -E -q "qa 未通过|qa 尚未" "$LOG"; then
    reason="qa_failed"
  fi
  automation_record daily-fix-cron "" cron "$reason" 1 "" ""
  exit 1
fi

# 独立脚本：远端 PR 处理完后，删掉已经合进 main 的本地日修/周扫描分支。
./scripts/automation/prune-merged-branches.sh

# shellcheck source=lib/backlog-queue.sh
source "$PROJECT_ROOT/scripts/automation/lib/backlog-queue.sh"
# shellcheck source=lib/git-sandbox.sh
source "$PROJECT_ROOT/scripts/automation/lib/git-sandbox.sh"

# 无 auto+todo 但有 assist/manual 可拆时：先拆最多 1 条（只 commit、不开 PR），再日修同 PR。
SPLIT_ADOPTED=0
# 拆成功后、日修前冻结的首个 auto（写回 done 后 backlog 会指向下一条，不能再用来取失败任务号）。
SPLIT_PRIMARY_AUTO=""
if [ -z "$(backlog_list_auto_todo_ids)" ]; then
  if [ -n "$(backlog_list_split_candidates)" ]; then
    echo "ℹ️ auto 队列空，尝试拆条（每天最多 1 条，commit 后交日修开 PR）…"
    set +e
    ./scripts/automation/split-item.sh --yes
    split_code=$?
    set -e
    if [ "$split_code" -eq 0 ]; then
      SPLIT_ADOPTED=1
      SPLIT_PRIMARY_AUTO="$(backlog_list_auto_todo_ids 2>/dev/null | head -n 1 || true)"
    else
      echo "拆条未采纳或失败（exit=$split_code）。回到 main 再尝试日修选单。"
      git checkout main >/dev/null 2>&1 || true
    fi
  fi
fi

set +e
./scripts/automation/daily-fix.sh --yes --push
code=$?
set -e

# 从分支名 / 日修落盘标记 / 拆条时冻结的首个 auto 还原「真正失败的任务号」。
resolve_failed_task_id() {
  local cur id from_file
  cur="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$cur" =~ ^auto-(fix|feat)/([a-z0-9]+)-[0-9]{8}$ ]]; then
    # f11 → F11
    id="$(printf '%s' "${BASH_REMATCH[2]}" | tr '[:lower:]' '[:upper:]')"
    printf '%s' "$id"
    return 0
  fi
  from_file="$(tr -d '[:space:]' <"$PROJECT_ROOT/logs/.last-daily-fix-task" 2>/dev/null || true)"
  if [ -n "$from_file" ]; then
    printf '%s' "$from_file"
    return 0
  fi
  printf '%s' "${SPLIT_PRIMARY_AUTO:-}"
}

# 拆条已落盘但日修失败：开 auto-* 兜底 PR，避免 main 无 auto 却永远合不进拆条。
if [ "$code" -ne 0 ] && [ "$SPLIT_ADOPTED" -eq 1 ]; then
  echo "⚠️ 日修未完成，尝试把已拆条分支推成 auto-* 兜底 PR…"
  failed_task="$(resolve_failed_task_id)"
  failed_task_lc="$(printf '%s' "$failed_task" | tr '[:upper:]' '[:lower:]')"
  item_type="fix"
  if [ -n "$failed_task" ]; then
    row="$(backlog_read_row "$failed_task" "" 2>/dev/null || true)"
    if [ -n "$row" ]; then
      IFS=$'\t' read -r _ item_type _ _ _ _ <<<"$row" || true
    fi
  fi
  # 分支已是 auto-feat 时以分支前缀为准
  cur_br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [[ "$cur_br" == auto-feat/* ]]; then
    item_type="feat"
  elif [[ "$cur_br" == auto-fix/* ]]; then
    item_type="fix"
  fi
  set +e
  git_sandbox_push_split_fallback_pr "$failed_task_lc" "$item_type"
  fb=$?
  set -e
  if [ "$fb" -eq 0 ]; then
    automation_record daily-fix-cron "${failed_task:-}" cron split_fallback_pr 0 true ""
    echo "✅ 已开拆条兜底 PR（日修仍失败，请看邮件/日志；taskId=${failed_task:-未知}）。"
  else
    echo "⚠️ 兜底 PR 未推成（exit=$fb）；本地分支可能仍含拆条 commit，请人工处理。"
    automation_record daily-fix-cron "${failed_task:-}" cron split_fallback_failed 1 "" ""
  fi
fi

echo "======== $(date -Iseconds) daily-fix-cron end exit=$code ========"
# 队列空：daily-fix 已记 empty_queue 并尝试发邮件；对 Windows 任务仍记成功，避免「失败重试」刷屏
if [ "$code" -ne 0 ]; then
  if grep -q "队列中没有可执行任务" "$LOG"; then
    echo "队列已空（应已发 empty_queue 邮件）。定时任务记为成功。"
    exit 0
  fi
fi
exit "$code"
