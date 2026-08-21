#!/usr/bin/env bash
# Windows 任务计划 / 本机 cron 入口：每天修一个 auto 级缺陷并开 PR。
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
LOG="$PROJECT_ROOT/logs/daily-fix-cron-$(date +%Y%m%d-%H%M%S).log"
LOCK="$PROJECT_ROOT/logs/daily-fix-cron.lock"

exec >>"$LOG" 2>&1
echo "======== $(date -Iseconds) daily-fix-cron start ========"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "另一实例仍在运行，本次退出。"
  exit 0
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "工作区不干净，拒绝无人值守运行。请先处理本地改动。"
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
  exit 1
fi

git checkout main
git merge --ff-only origin/main

set +e
./scripts/automation/daily-fix.sh --yes --push
code=$?
set -e

echo "======== $(date -Iseconds) daily-fix-cron end exit=$code ========"
# 队列空或当日无 auto 项时 daily-fix 返回非 0，对定时任务视为「今天没事做」
if [ "$code" -ne 0 ]; then
  if grep -q "队列中没有可执行任务" "$LOG"; then
    echo "队列已空，定时任务记为成功。"
    exit 0
  fi
fi
exit "$code"
