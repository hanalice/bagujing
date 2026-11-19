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

# 无 auto+todo 但有 assist/manual 可拆时：先拆最多 1 条（双评 2/2 才落盘），再日修。
if [ -z "$(backlog_list_auto_todo_ids)" ]; then
  if [ -n "$(backlog_list_split_candidates)" ]; then
    echo "ℹ️ auto 队列空，尝试拆条（每天最多 1 条）…"
    set +e
    ./scripts/automation/split-item.sh --yes --push
    split_code=$?
    set -e
    if [ "$split_code" -ne 0 ]; then
      echo "拆条未采纳或失败（exit=$split_code）。仍继续尝试日修选单。"
    fi
  fi
fi

set +e
./scripts/automation/daily-fix.sh --yes --push
code=$?
set -e

echo "======== $(date -Iseconds) daily-fix-cron end exit=$code ========"
# 队列空：daily-fix 已记 empty_queue 并尝试发邮件；对 Windows 任务仍记成功，避免「失败重试」刷屏
if [ "$code" -ne 0 ]; then
  if grep -q "队列中没有可执行任务" "$LOG"; then
    echo "队列已空（应已发 empty_queue 邮件）。定时任务记为成功。"
    exit 0
  fi
fi
exit "$code"
