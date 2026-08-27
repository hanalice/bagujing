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
git_sandbox_open_branch() {
  local name="$1"
  BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
  WORK_BRANCH="$name"
  git checkout -b "$WORK_BRANCH" >/dev/null 2>&1 || git checkout "$WORK_BRANCH"
  echo "🌿 工作分支：$WORK_BRANCH（基线 $BASE_BRANCH）"
}

# 相对基线的已跟踪改动 + 未跟踪文件。
git_sandbox_list_paths() {
  {
    git diff --name-only "$BASE_BRANCH"
    git diff --cached --name-only "$BASE_BRANCH"
    git ls-files --others --exclude-standard
  } | sort -u
}

# 无改动则删分支并回到基线，返回 1。
git_sandbox_abandon_if_empty() {
  if [ -z "$(git status --porcelain)" ]; then
    echo "⚠️ 没有产生任何代码改动，回退分支。"
    git checkout "$BASE_BRANCH" >/dev/null 2>&1
    git branch -D "$WORK_BRANCH" >/dev/null 2>&1
    return 1
  fi
  return 0
}

# Conventional Commits 头 + 现象/根因/方案小节（与 commit-msg 钩子对齐）。
git_sandbox_commit_msg_ok() {
  local file="$1"
  local msg_header msg_body
  msg_header="$(head -n 1 "$file" 2>/dev/null | tr -d '\r' || true)"
  msg_body="$(cat "$file" 2>/dev/null || true)"
  printf '%s' "$msg_header" | grep -qE '^(feat|fix|chore|refactor|test|docs|perf)(\(.+\))?: ' \
    && printf '%s' "$msg_body" | grep -qE '问题现象|Symptoms' \
    && printf '%s' "$msg_body" | grep -qE '根因分析|Root Cause' \
    && printf '%s' "$msg_body" | grep -qE '解决方案|Solution'
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

# $1=DO_PUSH $2=提交说明文件。未 push 时只打印后续命令。
git_sandbox_push_pr() {
  local do_push="$1"
  local msg_file="$2"
  if [ "$do_push" = "1" ]; then
    git push -u origin "$WORK_BRANCH"
    echo "🚀 已推送分支 $WORK_BRANCH"

    local pr_title pr_url
    pr_title="$(head -n 1 "$msg_file")"
    if gh pr view --json url -q .url 2>/dev/null; then
      echo "ℹ️ 该分支已有 PR，跳过创建。"
    else
      pr_url="$(gh pr create --base "$BASE_BRANCH" --head "$WORK_BRANCH" --title "$pr_title" --body-file "$msg_file")"
      echo "📬 已自动创建 PR: $pr_url"
    fi
  else
    echo "ℹ️ 未推送。确认无误后执行："
    echo "    git push -u origin $WORK_BRANCH"
    echo "    gh pr create --base $BASE_BRANCH --head $WORK_BRANCH --fill"
  fi
}
