#!/usr/bin/env bash
# 读 logs/automation-runs.ndjson，只改 docs/process-backlog.md 的优先级或追加 assist / 待决。
# 不改 daily-fix.sh、weekly-scan.sh，也不读业务队列 docs/backlog.md。
set -euo pipefail

export PATH="$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"
mkdir -p "$PROJECT_ROOT/logs"

exec >>"$PROJECT_ROOT/logs/process-decide-cron-$(date +%Y%m%d-%H%M%S).log" 2>&1
echo "======== $(date -Iseconds) process-decide start ========"

node "$PROJECT_ROOT/scripts/automation/process-decide.js" \
  --runs "$PROJECT_ROOT/logs/automation-runs.ndjson" \
  --backlog "$PROJECT_ROOT/docs/process-backlog.md" \
  --state "$PROJECT_ROOT/logs/process-decide-state.json"

echo "======== $(date -Iseconds) process-decide end ========"
