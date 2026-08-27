#!/usr/bin/env bash
# 通用 Agent 循环：引擎调用、登录探测、有限次返修、审核结论解析。
# 禁止写入项目文档路径或业务 prompt；由调用方以函数/参数注入。
# 须在 set -euo pipefail 的脚本中 source。

if ! declare -F die >/dev/null 2>&1; then
  die() { echo "❌ $*" >&2; exit 1; }
fi

# 补齐 cron 下缺失的 agent CLI / node 路径。
agent_prepare_cli_path() {
  export PATH="$HOME/.local/bin:$PATH"
  if ! command -v claude >/dev/null 2>&1; then
    # shellcheck disable=SC1090
    [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
  fi
}

# 将 ENGINE=auto 解析为 cursor-agent 或 claude，并确认在 PATH 中。
agent_resolve_engine() {
  if [ "${ENGINE:-auto}" = "auto" ]; then
    if command -v cursor-agent >/dev/null 2>&1; then
      ENGINE="cursor-agent"
    elif command -v claude >/dev/null 2>&1; then
      ENGINE="claude"
    else
      die "未找到可用的编码 agent（cursor-agent / claude），cron 场景需确认 PATH"
    fi
  fi
  command -v "$ENGINE" >/dev/null 2>&1 || die "指定的引擎 $ENGINE 不在 PATH 中"
}

# 编码 agent：可改文件、可跑测试。从 stdin 读 prompt。
invoke_engine() {
  case "$ENGINE" in
    cursor-agent)
      cursor-agent -p --force --trust --output-format text ${AGENT_MODEL:+--model "$AGENT_MODEL"}
      ;;
    claude)
      claude -p --permission-mode acceptEdits \
        --allowedTools "Read Edit Write Grep Glob Bash(cd:*) Bash(npm test:*) Bash(npm run:*) Bash(node:*)"
      ;;
    *) die "不支持的引擎: $ENGINE" ;;
  esac
}

# 审核 agent：只读，禁止改代码。从 stdin 读 prompt。
invoke_review_engine() {
  case "$ENGINE" in
    cursor-agent)
      # 新会话 + ask 模式：没有编码上下文，也不能把未完成的实现「改完再自称通过」
      cursor-agent -p --trust --mode ask --output-format text ${REVIEW_MODEL:+--model "$REVIEW_MODEL"}
      ;;
    claude)
      claude -p --permission-mode plan \
        --allowedTools "Read Grep Glob Bash(git diff:*) Bash(git status:*) Bash(git log:*)"
      ;;
    *) die "不支持的引擎: $ENGINE" ;;
  esac
}

# 登录态在建分支之前校验：token 失效时不留下空分支。
agent_check_auth() {
  local probe
  probe="$(echo "回复 ok" | invoke_engine 2>&1 || true)"
  case "$probe" in
    *"Authentication required"*|*"OAuth"*|*"authenticate"*|*"401"*|*"Invalid API key"*)
      if [ "$ENGINE" = "cursor-agent" ]; then
        die "cursor-agent 未登录，请先执行 cursor-agent login（cron 场景改用 CURSOR_API_KEY）"
      fi
      die "claude 登录态失效，请先执行 claude login（cron 场景改用 ANTHROPIC_API_KEY）"
      ;;
  esac
}

# 从审核日志取出最后一次 REVIEW_VERDICT（PASS|FAIL），无则空。
extract_review_verdict() {
  local log="$1"
  awk '
    match($0, /REVIEW_VERDICT:[[:space:]]*(PASS|FAIL)/) {
      line=$0
      if (toupper(line) ~ /FAIL/) v="FAIL"
      else if (toupper(line) ~ /PASS/) v="PASS"
    }
    END { print v }
  ' "$log"
}

# 取出最后一次 REVIEW_VERDICT 之后的 "- " 缺口列表。
extract_review_fail_bullets() {
  local log="$1"
  awk '
    { buf[NR]=$0 }
    /REVIEW_VERDICT:/ { last=NR }
    END {
      if (!last) exit
      for (i=last+1; i<=NR; i++) if (buf[i] ~ /^- /) print buf[i]
    }
  ' "$log"
}

# 根据审核日志设置 REVIEW_GAPS；PASS 返回 0，否则 1。
# $2 为 FAIL 但未列出条目时的兜底说明（由调用方提供，避免 lib 写死业务文档名）。
agent_apply_review_verdict() {
  local review_log="$1"
  local empty_fail_msg="$2"
  local verdict_line
  verdict_line="$(extract_review_verdict "$review_log")"
  case "$(printf '%s' "$verdict_line" | tr '[:lower:]' '[:upper:]')" in
    *PASS*)
      echo "✅ 审核通过"
      REVIEW_GAPS=""
      return 0
      ;;
    *FAIL*)
      REVIEW_GAPS="$(extract_review_fail_bullets "$review_log")"
      [ -n "$REVIEW_GAPS" ] || REVIEW_GAPS="$empty_fail_msg"
      echo "🚫 审核未通过："
      echo "$REVIEW_GAPS"
      return 1
      ;;
    *)
      REVIEW_GAPS="审核 agent 未输出可解析的 REVIEW_VERDICT 行，按失败处理（默认拒绝提交）。"
      echo "🚫 $REVIEW_GAPS"
      return 1
      ;;
  esac
}

# 先执行 run_fn，直到 pred_fn 成功；失败则 before_retry_fn attempt 后重跑。超限 die。
# 参数：pred_fn max die_msg run_fn before_retry_fn
agent_until_pred() {
  local pred_fn="$1"
  local max="$2"
  local exceed_msg="$3"
  local run_fn="$4"
  local before_retry_fn="$5"
  local attempt=0
  "$run_fn"
  while ! "$pred_fn"; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$max" ]; then
      die "$exceed_msg"
    fi
    "$before_retry_fn" "$attempt"
    "$run_fn"
  done
}

# 反复执行 check_fn 直至成功；失败则 repair_fn attempt。超限 echo fail_msg 并返回 1。
# 参数：max fail_msg check_fn repair_fn
agent_until_ok() {
  local max="$1"
  local fail_msg="$2"
  local check_fn="$3"
  local repair_fn="$4"
  local attempt=0
  while true; do
    if "$check_fn"; then
      return 0
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$max" ]; then
      echo "$fail_msg"
      return 1
    fi
    "$repair_fn" "$attempt"
  done
}
