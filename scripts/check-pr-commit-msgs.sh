#!/usr/bin/env bash
# ==============================================================================
# PR 提交说明门禁：对 base…head 区间逐条调用 E11 共享脚本
# 用法:
#   bash scripts/check-pr-commit-msgs.sh [--msg-file <路径>]
#   bash scripts/check-pr-commit-msgs.sh [<base_sha> <head_sha>]
# 环境变量（CI）: PR_BASE_SHA / PR_HEAD_SHA（或 GITHUB 等价）
# 退出码: 0 = 全部通过；非 0 = 任一失败或区间为空未校验
# 契约: docs/backlog.md §E12；规则本体 scripts/check-commit-msg.sh（E11）
# ==============================================================================

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_SCRIPT="$ROOT/scripts/check-commit-msg.sh"

if [ ! -f "$CHECK_SCRIPT" ]; then
  echo "❌ [PR Commit Msg] 缺少 E11 共享脚本: scripts/check-commit-msg.sh"
  echo "👉 禁止另写第二套段落规则；请先合入 E11。"
  exit 1
fi

# 单文件模式：供单测验证「共享脚本非 0 → 封装非 0」透传
if [ "${1:-}" = "--msg-file" ]; then
  msg_file="${2:-}"
  if [ -z "$msg_file" ] || [ ! -f "$msg_file" ]; then
    echo "❌ [PR Commit Msg] --msg-file 需要有效消息文件路径"
    exit 1
  fi
  bash "$CHECK_SCRIPT" "$msg_file"
  exit $?
fi

BASE_SHA="${1:-${PR_BASE_SHA:-${GITHUB_BASE_SHA:-}}}"
HEAD_SHA="${2:-${PR_HEAD_SHA:-${GITHUB_SHA:-HEAD}}}"

if [ -z "$BASE_SHA" ]; then
  echo "❌ [PR Commit Msg] 未提供 base SHA（参数或 PR_BASE_SHA / GITHUB_BASE_SHA）"
  exit 1
fi

# 列出 base…head 内的提交（不含 base 自身）
mapfile -t commits < <(git -C "$ROOT" rev-list --reverse "${BASE_SHA}..${HEAD_SHA}" 2>/dev/null || true)

if [ "${#commits[@]}" -eq 0 ]; then
  echo "❌ [PR Commit Msg] 区间 ${BASE_SHA}..${HEAD_SHA} 为空，未校验任何提交，拒绝静默通过"
  exit 1
fi

echo "🔍 [PR Commit Msg] 校验 ${#commits[@]} 条提交（${BASE_SHA}..${HEAD_SHA}）…"

failed=0
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

for sha in "${commits[@]}"; do
  msg_file="$tmp_dir/${sha}.msg"
  git -C "$ROOT" log -1 --format=%B "$sha" > "$msg_file"
  # 跳过纯空消息（极少见）；其余一律喂给 E11 脚本
  if ! grep -q '[^[:space:]]' "$msg_file"; then
    continue
  fi
  subject="$(git -C "$ROOT" log -1 --format=%s "$sha")"
  if ! bash "$CHECK_SCRIPT" "$msg_file"; then
    echo "❌ [PR Commit Msg] 提交 $sha 未通过: $subject"
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "❌ [PR Commit Msg] 存在不合规提交说明，PR 检查失败"
  echo "👉 规则与本地钩子相同，见 docs/git-commit-convention.md 与 scripts/check-commit-msg.sh"
  exit 1
fi

echo "✅ [PR Commit Msg] 区间内提交说明全部通过"
exit 0
