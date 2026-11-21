#!/usr/bin/env bash
# 低频调用 process-log-analyze.js（F13），与 process-decide-cron 并存。
# 不改 daily-fix.sh；不在本脚本内注册系统定时任务（挂载属 F14）。
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"
mkdir -p "$PROJECT_ROOT/logs"

exec >>"$PROJECT_ROOT/logs/process-log-analyze-cron-$(date +%Y%m%d-%H%M%S).log" 2>&1
echo "======== $(date -Iseconds) process-log-analyze start ========"

node "$PROJECT_ROOT/scripts/automation/process-log-analyze.js" \
  --root "$PROJECT_ROOT" \
  --runs "$PROJECT_ROOT/logs/automation-runs.ndjson" \
  --backlog "$PROJECT_ROOT/docs/process-backlog.md" \
  --logs-dir "$PROJECT_ROOT/logs"

echo "======== $(date -Iseconds) process-log-analyze end ========"
