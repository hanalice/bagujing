#!/usr/bin/env bash
# 收回 docs/backlog.md 的队列表。
# 同一 ID 只留一行；done/split 胜出 todo；修订记录有「ID 完成」则把 todo 改成 done。
# 用法:
#   ./scripts/automation/reconcile-backlog.sh           # 只改工作区文件
#   ./scripts/automation/reconcile-backlog.sh --commit  # 有变化则提交，不 push
set -euo pipefail

AUTOMATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$AUTOMATION_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

DO_COMMIT=0
if [ "${1:-}" = "--commit" ]; then
  DO_COMMIT=1
elif [ -n "${1:-}" ]; then
  echo "未知参数: $1" >&2
  exit 2
fi

node "$AUTOMATION_DIR/backlog-reconcile.js" reconcile "$PROJECT_ROOT/docs/backlog.md"

if [ "$DO_COMMIT" != "1" ]; then
  exit 0
fi
if git diff --quiet -- docs/backlog.md; then
  echo "队列表无需收回"
  exit 0
fi
git add docs/backlog.md
git commit -m "$(cat <<'EOF'
docs(backlog): 按完成记录收回队列表状态

【问题现象 (Symptoms)】
- 并发日修 PR 合并后，已完成项的队列表行回到 todo，或同一 ID 同时留下 todo 与 done。

【根因分析 (Root Cause)】
- 日修只读队列表的 auto+todo。修订记录里的「ID 完成」不会阻止再次选中。

【解决方案 (Solution)】
- 用 backlog-reconcile 收回：done/split 胜出，完成记录把 todo 改回 done，同一 ID 只留一行。
EOF
)"
echo "已提交队列表收回"
