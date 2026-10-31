#!/usr/bin/env bash
# ==============================================================================
# 提交说明校验（可单独喂消息文件）
# 用法: bash scripts/check-commit-msg.sh <消息文件路径>
# 退出码: 0 = 通过；非 0 = 拦截
# 契约: docs/backlog.md §E11；对齐 docs/git-commit-convention.md
# ==============================================================================

set -euo pipefail

msg_file="${1:-}"
if [ -z "$msg_file" ] || [ ! -f "$msg_file" ]; then
  exit 0
fi

# 过滤单井号开头的 git 提示注释，但保留 Markdown 标题 "## "
cleaned_content=$(sed -E '/^[[:space:]]*#[^#]/d; /^[[:space:]]*#$/d' "$msg_file")
first_line=$(echo "$cleaned_content" | sed -e '/^[[:space:]]*$/d' | head -n 1 || true)

# 空消息交由 git 自行拦截
if [ -z "$first_line" ]; then
  exit 0
fi

# 豁免 Merge / Revert / 自动版本发布等提交
if echo "$first_line" | grep -qE '^(Merge|Revert|Initial commit|Release|Version)'; then
  exit 0
fi

# Header：Conventional Commits（scope 可缺）
header_pattern='^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9_\/-]+\))?: .+$'

if ! echo "$first_line" | grep -qE "$header_pattern"; then
  echo ""
  echo "❌ [Commit Msg] Commit Message Header 不符合规范！"
  echo "👉 当前 Header: $first_line"
  echo "👉 正确格式: <type>(<scope>): <subject>  (例如: fix(ai-guard): 修复 SSE 超时未释放)"
  echo "👉 允许的 type: feat, fix, refactor, docs, chore, test, perf, style, ci, build, revert"
  echo "👉 详见文档: docs/git-commit-convention.md"
  exit 1
fi

type_name=$(echo "$first_line" | sed -E 's/^([a-z]+)(\(.*\))?:.*/\1/')

# 首行之后的非空正文行（轻量 type 用）
body_nonempty=$(echo "$cleaned_content" | sed -e '/^[[:space:]]*$/d' | sed '1d' || true)

fail_missing_sections() {
  local kind="$1"
  shift
  echo ""
  echo "❌ [Commit Msg] ${kind} 类型的提交缺少必需小节！"
  echo "👉 缺失的关键小节: $*"
  echo "👉 详见文档: docs/git-commit-convention.md"
  exit 1
}

if [ "$type_name" = "fix" ]; then
  missing_sections=()
  if ! echo "$cleaned_content" | grep -qiE "问题现象|Symptoms"; then
    missing_sections+=("【问题现象 (Symptoms)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "根因分析|Root Cause"; then
    missing_sections+=("【根因分析 (Root Cause)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "解决方案|Solution"; then
    missing_sections+=("【解决方案 (Solution)】")
  fi
  if [ ${#missing_sections[@]} -gt 0 ]; then
    fail_missing_sections "fix" "${missing_sections[*]}"
  fi
  exit 0
fi

if [ "$type_name" = "feat" ]; then
  missing_sections=()
  if ! echo "$cleaned_content" | grep -qiE "背景|Background"; then
    missing_sections+=("【背景 (Background)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "设计|Design"; then
    missing_sections+=("【设计概述 (Design)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "变更内容|Changes"; then
    missing_sections+=("【变更内容 (Changes)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "测试与兼容性|Testing"; then
    missing_sections+=("【测试与兼容性 (Testing & Compatibility)】")
  fi
  if [ ${#missing_sections[@]} -gt 0 ]; then
    fail_missing_sections "feat" "${missing_sections[*]}"
  fi
  exit 0
fi

if [ "$type_name" = "refactor" ]; then
  missing_sections=()
  if ! echo "$cleaned_content" | grep -qiE "动机|Motivation"; then
    missing_sections+=("【动机 (Motivation)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "变更内容|Changes"; then
    missing_sections+=("【变更内容 (Changes)】")
  fi
  if ! echo "$cleaned_content" | grep -qiE "验证|Verification"; then
    missing_sections+=("【验证 (Verification)】")
  fi
  if [ ${#missing_sections[@]} -gt 0 ]; then
    fail_missing_sections "refactor" "${missing_sections[*]}"
  fi
  exit 0
fi

# 轻量 type：header 之外至少一行非空正文
case "$type_name" in
  docs|chore|test|perf|ci)
    if [ -z "$body_nonempty" ]; then
      echo ""
      echo "❌ [Commit Msg] ${type_name} 类型须包含至少一行非空正文（body）！"
      echo "👉 Header 之外请补充一行说明改动要点（轻量 type 无需结构化小节）。"
      echo "👉 详见文档: docs/git-commit-convention.md"
      exit 1
    fi
    exit 0
    ;;
esac

# style / build / revert：只查 header
exit 0
