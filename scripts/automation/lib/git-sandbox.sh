#!/usr/bin/env bash
# Git 沙箱：干净工作区、任务分支、脚本提交与可选开 PR。
# Agent 禁止 git；本文件只给编排脚本调用。须在 set -euo pipefail 下 source。

if ! declare -F die >/dev/null 2>&1; then
  die() { echo "❌ $*" >&2; exit 1; }
fi

git_sandbox_ensure_clean() {
  [ -z "$(git status --porcelain)" ] || die "工作区有未提交改动，请先处理干净再运行"
}

git_sandbox_require_gh() {
  command -v gh >/dev/null 2>&1 || die "未找到 gh CLI（已安装位置: ~/.local/bin/gh），请确认 PATH"
  if ! gh auth status -h github.com >/dev/null 2>&1; then
    die "gh 未登录，无法自动开 PR。请先执行: gh auth login --hostname github.com --git-protocol ssh --web"
  fi
}

# 从当前 HEAD 开任务分支；已存在则检出。设置 BASE_BRANCH、WORK_BRANCH。
# PR 基线默认与 BASE_BRANCH 相同（见 git_sandbox_prepare_task_branch 可拆开）。
git_sandbox_open_branch() {
  local name="$1"
  BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  PR_BASE_BRANCH="${PR_BASE_BRANCH:-$BASE_BRANCH}"
  WORK_BRANCH="$name"
  git checkout -b "$WORK_BRANCH" >/dev/null 2>&1 || git checkout "$WORK_BRANCH"
  echo "🌿 工作分支：$WORK_BRANCH（基线 $BASE_BRANCH）"
}

# 日修用：合入基线固定为 integration（默认 main）。
# 若当前已不在 integration 且领先它（例如拆条刚 commit 留在 docs/split-*），则改名复用，
# BASE_BRANCH 钉成当前 HEAD（日修 diff / 回写队列的起点，不含把拆条 commit 重审一遍）；
# PR 仍指向 integration，避免再开一条合不进的拆条独占 PR。
git_sandbox_prepare_task_branch() {
  local name="$1"
  local integration="${2:-main}"
  local cur ahead
  PR_BASE_BRANCH="$integration"
  cur="$(git rev-parse --abbrev-ref HEAD)"
  ahead="$(git rev-list --count "${integration}..HEAD" 2>/dev/null || echo 0)"
  if [ "$cur" != "$integration" ] && [ "$cur" != "HEAD" ] && [ "${ahead:-0}" -gt 0 ]; then
    if [ "$cur" != "$name" ]; then
      git branch -m "$name"
    fi
    WORK_BRANCH="$name"
    BASE_BRANCH="$(git rev-parse HEAD)"
    echo "🌿 复用分支：$WORK_BRANCH（日修基点 ${BASE_BRANCH:0:7}，PR → $PR_BASE_BRANCH）"
  else
    BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
    WORK_BRANCH="$name"
    git checkout -b "$WORK_BRANCH" >/dev/null 2>&1 || git checkout "$WORK_BRANCH"
    echo "🌿 工作分支：$WORK_BRANCH（基线 $BASE_BRANCH，PR → $PR_BASE_BRANCH）"
  fi
}

# 相对基线的已跟踪改动 + 未跟踪文件。
git_sandbox_list_paths() {
  {
    git diff --name-only "$BASE_BRANCH"
    git diff --cached --name-only "$BASE_BRANCH"
    git ls-files --others --exclude-standard
  } | sort -u
}

# 无改动则删分支并回到合入基线（PR_BASE_BRANCH，默认 BASE_BRANCH），返回 1。
# BASE_BRANCH 可能是日修起点的 commit SHA，不能 checkout 成游离头。
git_sandbox_abandon_if_empty() {
  if [ -z "$(git status --porcelain)" ]; then
    local back="${PR_BASE_BRANCH:-$BASE_BRANCH}"
    echo "⚠️ 没有产生任何代码改动，回退分支。"
    git checkout "$back" >/dev/null 2>&1
    git branch -D "$WORK_BRANCH" >/dev/null 2>&1
    return 1
  fi
  return 0
}

# 提交说明预检：与 .githooks/commit-msg 共用 scripts/check-commit-msg.sh（E11）。
_GIT_SANDBOX_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_GIT_SANDBOX_REPO_ROOT="$(cd "$_GIT_SANDBOX_LIB_DIR/../../.." && pwd)"
_CHECK_COMMIT_MSG_SH="$_GIT_SANDBOX_REPO_ROOT/scripts/check-commit-msg.sh"

git_sandbox_commit_msg_ok() {
  local file="$1"
  bash "$_CHECK_COMMIT_MSG_SH" "$file"
}

git_sandbox_confirm() {
  local assume_yes="$1"
  local reply=""
  if [ "$assume_yes" != "1" ]; then
    # 非交互环境（stdin 非终端）读不到输入时视为不确认，改动保留在分支上
    read -r -p "确认提交？(y/N) " reply || true
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || {
      echo "已取消，改动保留在 $WORK_BRANCH，确认后可手动 git commit。"
      return 1
    }
  fi
  return 0
}

git_sandbox_commit_all() {
  local msg_file="$1"
  git add -A
  git commit -F "$msg_file"
  echo "✅ 已提交到 $WORK_BRANCH"
}

# $1=DO_PUSH $2=提交说明文件 $3=可选 PR 标题（默认用提交头）。未 push 时只打印后续命令。
# 合入基线优先 PR_BASE_BRANCH（日修复用拆条分支时应为 main），避免 --base 落到 commit SHA。
git_sandbox_push_pr() {
  local do_push="$1"
  local msg_file="$2"
  local pr_title="${3:-}"
  local pr_base="${PR_BASE_BRANCH:-$BASE_BRANCH}"
  if [ "$do_push" = "1" ]; then
    git push -u origin "$WORK_BRANCH"
    echo "🚀 已推送分支 $WORK_BRANCH"

    local pr_url
    [ -n "$pr_title" ] || pr_title="$(head -n 1 "$msg_file")"
    if gh pr view --json url -q .url 2>/dev/null; then
      echo "ℹ️ 该分支已有 PR，跳过创建。"
    else
      pr_url="$(gh pr create --base "$pr_base" --head "$WORK_BRANCH" --title "$pr_title" --body-file "$msg_file")"
      echo "📬 已自动创建 PR: $pr_url"
    fi
  else
    echo "ℹ️ 未推送。确认无误后执行："
    echo "    git push -u origin $WORK_BRANCH"
    echo "    gh pr create --base $pr_base --head $WORK_BRANCH --fill"
  fi
}

# 日修失败但拆条已落盘时：把当前领先 main 的分支改成 auto-fix|feat 名并开 PR，避免 empty_queue 死循环。
# $1=首选任务号（小写，可空）$2=fix|feat
git_sandbox_push_split_fallback_pr() {
  local task_lc="${1:-}"
  local kind="${2:-fix}"
  local integration="${PR_BASE_BRANCH:-main}"
  local cur ahead stamp name msg_file
  cur="$(git rev-parse --abbrev-ref HEAD)"
  [ "$cur" != "$integration" ] && [ "$cur" != "HEAD" ] || return 1
  ahead="$(git rev-list --count "${integration}..HEAD" 2>/dev/null || echo 0)"
  [ "${ahead:-0}" -gt 0 ] || return 1
  stamp="$(date +%Y%m%d)"
  if [[ "$cur" == docs/split-* ]]; then
    if [ -z "$task_lc" ]; then
      task_lc="$(echo "$cur" | sed -E 's|^docs/split-([a-z0-9]+)-[0-9]{8}$|\1|')"
    fi
    [ -n "$task_lc" ] || task_lc="split"
    if [ "$kind" = "feat" ]; then
      name="auto-feat/${task_lc}-${stamp}"
    else
      name="auto-fix/${task_lc}-${stamp}"
    fi
    git branch -m "$name"
    cur="$name"
  fi
  WORK_BRANCH="$cur"
  PR_BASE_BRANCH="$integration"
  git_sandbox_require_gh
  mkdir -p "$_GIT_SANDBOX_REPO_ROOT/logs"
  msg_file="$_GIT_SANDBOX_REPO_ROOT/logs/.split-fallback-pr-msg"
  cat >"$msg_file" <<EOF
docs(backlog): 拆条已落盘，日修未完成（兜底 PR）

【背景 (Background)】
- 空队列拆条已 commit，但同次日修未完成；单独 docs/split PR 不会自动合并，会导致 main 持续 empty_queue。

【设计概述 (Design)】
- 本 PR 使用 auto-fix/feat 分支名，便于 merge-remote-prs 在 qa 通过后合入。
- 拆条与日修保持独立 commit；合入后下次 cron 即可领 auto。

【变更内容 (Changes)】
- 分支 $WORK_BRANCH 相对 $integration 含已落盘的拆条（及可能的未完成日修改动）。

【测试与兼容性 (Testing & Compatibility)】
- 以 CI qa 为准；合入后由下次日修继续实现。
EOF
  git_sandbox_push_pr 1 "$msg_file" "docs(backlog): 拆条已落盘，日修未完成"
}
