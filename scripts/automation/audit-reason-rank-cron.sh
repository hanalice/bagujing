#!/usr/bin/env bash
# 低频调用 audit-reason-cli.js（F23），与 process-decide-cron / F13 并存。
# 不改 daily-fix.sh；不在本脚本内注册系统定时任务（挂载属 F24）。
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"
mkdir -p "$PROJECT_ROOT/logs"

exec >>"$PROJECT_ROOT/logs/audit-reason-rank-cron-$(date +%Y%m%d-%H%M%S).log" 2>&1
echo "======== $(date -Iseconds) audit-reason-rank start ========"

node "$PROJECT_ROOT/scripts/automation/audit-reason-cli.js" \
  --root "$PROJECT_ROOT" \
  --backlog "$PROJECT_ROOT/docs/backlog.md" \
  --audit-ndjson "$PROJECT_ROOT/logs/ai-audit.ndjson" \
  --snapshot "$PROJECT_ROOT/logs/audit-reason-rank-snapshot.json"

echo "======== $(date -Iseconds) audit-reason-rank end ========"
