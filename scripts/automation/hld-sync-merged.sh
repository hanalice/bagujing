#!/usr/bin/env bash
# 根据 main 上已合入的 [任务号] 提交，把本机 HLD 第 6 节 todo 改为 done。
# HLD 被 gitignore，不会产生可提交的 git 改动。
set -euo pipefail

AUTOMATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$AUTOMATION_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

HLD_PATH="${HLD_PATH:-$PROJECT_ROOT/docs/internal/HLD-llm-call-pipeline.md}"
export HLD_PATH

# shellcheck source=lib/hld-queue.sh
source "$AUTOMATION_DIR/lib/hld-queue.sh"

if [ ! -f "$HLD_PATH" ]; then
  echo "内部缺陷文档不存在: $HLD_PATH" >&2
  exit 1
fi

hld_sync_merged_from_git
