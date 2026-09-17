#!/usr/bin/env bash
# Windows 任务计划 / 本机 cron 入口：每周扫描一次并把新 auto 项写入 docs/backlog.md。
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

mkdir -p "$PROJECT_ROOT/logs"
LOG="$PROJECT_ROOT/logs/weekly-scan-cron-$(date +%Y%m%d-%H%M%S).log"
LOCK="$PROJECT_ROOT/logs/weekly-scan-cron.lock"

exec >>"$LOG" 2>&1
echo "======== $(date -Iseconds) weekly-scan-cron start ========"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "另一实例仍在运行，本次退出。"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，拒绝无人值守运行。请先处理本地改动。"
  exit 1
fi

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
  exit 1
fi

git checkout main
git merge --ff-only origin/main

set +e
./scripts/automation/weekly-scan.sh --yes --push
code=$?
set -e

echo "======== $(date -Iseconds) weekly-scan-cron end exit=$code ========"
exit "$code"
