#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: merge-remote-prs.sh
# 脚本作用: 独立决定并合并远端未合入的周扫描 / 日修 PR。不读取 backlog，不改 daily-fix 选任务逻辑。
# 使用方式:
#   ./scripts/automation/merge-remote-prs.sh
# 退出码:
#   0  没有待处理 PR，或已按规则合并并快进本地 main。调用方可开新一轮日修。
#   1  日修 PR 不能合并（多于一条、qa 未过、冲突、状态未知）或周扫描合并失败。调用方不得开新任务。
# 规则:
#   chore/weekly-scan-<日期>  不看 qa，可合并则直接 merge。
#   auto-fix/<id>-<日期>、auto-feat/<id>-<日期>
#     0 条：不处理
#     1 条且检查名 qa 为 SUCCESS、GitHub 判定可合并：merge
#     其余：一条都不合，退出 1
# ==============================================================================

set -euo pipefail

AUTOMATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$AUTOMATION_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

die() { echo "❌ $*" >&2; exit 1; }

# 确认 gh 已登录。本脚本的合并与状态查询都走 gh。
require_gh() {
  command -v gh >/dev/null 2>&1 || die "未找到 gh CLI"
  gh auth status -h github.com >/dev/null 2>&1 || die "gh 未登录，无法查看或合并 PR"
}

# 工作区必须干净，并快进到 origin/main。合并结果要落在这条基线上。
ensure_clean_main() {
  [ -z "$(git status --porcelain)" ] || die "工作区有未提交改动，请先处理干净再合并远端 PR"
  local attempt=1
  while [ "$attempt" -le 3 ]; do
    git fetch origin && break
    [ "$attempt" -eq 3 ] && die "git fetch 失败"
    attempt=$((attempt + 1))
    sleep 5
  done
  git checkout main
  git merge --ff-only origin/main
}

# 把刚合并的 origin/main 快进到本地。
ff_main() {
  git fetch origin
  git merge --ff-only origin/main
}

# 列出开放 PR。$1 为 jq 过滤表达式，输出 number、url、headRefName，按创建时间从早到晚。
list_open() {
  local filter="$1"
  gh pr list --base main --state open --limit 100 \
    --json number,url,headRefName,createdAt \
    --jq "[.[] | select(.headRefName | test(\"${filter}\"))] | sort_by(.createdAt) | .[] | [.number, .url, .headRefName] | @tsv"
}

# 读取 GitHub 的 mergeable：MERGEABLE / CONFLICTING / UNKNOWN。
pr_mergeable() {
  gh pr view "$1" --json mergeable -q .mergeable
}

# 日修 PR 的 qa 检查结论：pass / pending / fail / missing。只看这一次，不等待。
pr_qa_verdict() {
  gh pr view "$1" --json statusCheckRollup --jq '
    def qa: [.statusCheckRollup[]? | select(.name == "qa" or .name == "QA / qa")];
    if (qa | length) == 0 then "missing"
    elif (qa[0].status != "COMPLETED") then "pending"
    elif (qa[0].conclusion == "SUCCESS") then "pass"
    else "fail"
    end
  '
}

# 用 merge commit 合入并删除远端分支，然后快进本地 main。
# 删除分支失败但 PR 已是 MERGED 时仍快进，避免合入成功却被当成失败。
merge_and_ff() {
  local url="$1"
  local state
  if ! gh pr merge "$url" --merge --delete-branch; then
    state="$(gh pr view "$url" --json state -q .state)"
    [ "$state" = "MERGED" ] || die "合并失败：$url"
    echo "⚠️ PR 已合并，删除远端分支未完成：$url"
  fi
  ff_main
  echo "✅ 已合并并快进 main：$url"
}

# 周扫描没有 qa 门禁。能合并就合，冲突或状态未知则失败退出。
merge_weekly_scans() {
  local raw line number url head mergeable
  raw="$(list_open '^chore/weekly-scan-[0-9]{8}$')"
  while IFS=$'\t' read -r number url head; do
    [ -n "${number:-}" ] || continue
    mergeable="$(pr_mergeable "$url")"
    case "$mergeable" in
      MERGEABLE)
        echo "🔀 直接合并周扫描 #$number $head"
        merge_and_ff "$url"
        ;;
      CONFLICTING)
        die "周扫描 #$number 与 main 冲突，不合并：$url"
        ;;
      *)
        die "周扫描 #$number 合并状态为 ${mergeable:-空}，本次不合并：$url"
        ;;
    esac
  done <<< "$raw"
}

# 日修 PR：0 条跳过；多于 1 条全部留下；恰好 1 条且 qa 已通过才合并。
merge_auto_prs() {
  local -a rows=()
  local raw line number url head verdict mergeable
  raw="$(list_open '^auto-(fix|feat)/[a-z][0-9]+-[0-9]{8}$')"
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    rows+=("$line")
  done <<< "$raw"

  if [ "${#rows[@]}" -eq 0 ]; then
    echo "ℹ️ 没有未合并的日修 PR"
    return 0
  fi
  if [ "${#rows[@]}" -gt 1 ]; then
    echo "❌ 未合并的日修 PR 多于 1 条，不自动挑选：" >&2
    printf '  %s\n' "${rows[@]}" >&2
    exit 1
  fi

  IFS=$'\t' read -r number url head <<< "${rows[0]}"
  verdict="$(pr_qa_verdict "$url")"
  case "$verdict" in
    pass) ;;
    pending|missing)
      die "日修 #$number qa 尚未完成（$verdict），本次不合并、不开新任务：$url"
      ;;
    *)
      die "日修 #$number qa 未通过（$verdict），本次不合并、不开新任务：$url"
      ;;
  esac

  mergeable="$(pr_mergeable "$url")"
  case "$mergeable" in
    MERGEABLE)
      echo "🔀 合并日修 #$number $head（qa 已通过）"
      merge_and_ff "$url"
      ;;
    CONFLICTING)
      die "日修 #$number 与 main 冲突，不合并：$url"
      ;;
    *)
      die "日修 #$number 合并状态为 ${mergeable:-空}，本次不合并：$url"
      ;;
  esac
}

require_gh
ensure_clean_main
merge_weekly_scans
merge_auto_prs
echo "✅ 远端 PR 处理完毕，可以开启新一轮日修"
