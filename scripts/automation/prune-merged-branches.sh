#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: prune-merged-branches.sh
# 脚本作用: 删除已经合进 origin/main 的本地日修 / 周扫描分支。
#           不读 backlog，不查看、不合并远端 PR，不选日修任务。
# 使用方式:
#   ./scripts/automation/prune-merged-branches.sh
# 退出码:
#   0  清理结束（含没有可删分支）。调用方可继续开新一轮日修。
#   1  git fetch 失败，无法判断哪些分支已在 main 上。
# 范围:
#   本地分支 auto-fix/*、auto-feat/*、chore/weekly-scan-<日期>
#   仅当其 tip 已是 origin/main 的祖先时删除（merge commit 合入）。
#   当前检出的分支不删。squash 合入的 tip 不在 main 历史上，会保留。
# ==============================================================================

set -euo pipefail

AUTOMATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$AUTOMATION_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

die() { echo "❌ $*" >&2; exit 1; }

# 日修与周扫描在本地留下的分支名。其它本地分支不动。
is_automation_branch() {
  local name="$1"
  [[ "$name" =~ ^auto-(fix|feat)/[A-Za-z0-9._-]+$ ]] && return 0
  [[ "$name" =~ ^chore/weekly-scan-[0-9]{8}$ ]] && return 0
  return 1
}

# 拉最新 main，并丢掉远端已删除的跟踪引用，避免 origin/* 一直堆着。
fetch_main() {
  local attempt=1
  while [ "$attempt" -le 3 ]; do
    git fetch origin --prune && return 0
    [ "$attempt" -eq 3 ] && die "git fetch 失败，无法清理已合并分支"
    attempt=$((attempt + 1))
    sleep 5
  done
}

# 删掉 tip 已经在 origin/main 里的本地自动化分支。
prune_merged_local_branches() {
  local current branch deleted=0 kept=0
  current="$(git branch --show-current)"
  git rev-parse --verify origin/main >/dev/null 2>&1 || die "找不到 origin/main"

  while IFS= read -r branch; do
    [ -n "$branch" ] || continue
    is_automation_branch "$branch" || continue
    if [ -n "$current" ] && [ "$branch" = "$current" ]; then
      echo "⏭️ 跳过当前检出的分支 $branch"
      continue
    fi
    if git merge-base --is-ancestor "$branch" origin/main; then
      git branch -d "$branch"
      echo "🗑️ 已删除已合并的本地分支 $branch"
      deleted=$((deleted + 1))
    else
      echo "ℹ️ 保留未合并的本地分支 $branch"
      kept=$((kept + 1))
    fi
  done < <(git for-each-ref --format='%(refname:short)' refs/heads)

  echo "✅ 本地分支清理完毕：删除 ${deleted} 条，保留未合并 ${kept} 条"
}

fetch_main
prune_merged_local_branches
