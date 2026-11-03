#!/usr/bin/env bash
# ==============================================================================
# 暂存区硬编码口令 / 密钥 / 私钥 / 连接串扫描（可单独喂 diff 文本）
# 用法:
#   bash scripts/check-staged-secrets.sh              # 扫描 git diff --cached
#   bash scripts/check-staged-secrets.sh <diff 文件>  # 扫描构造的 unified diff
# 退出码: 0 = 放行；非 0 = 拦截
# 契约: docs/backlog.md §E13；用例 docs/test_cases.md §2.39
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

DIFF_ARG="${1:-}"
TMP_DIFF=""

cleanup() {
  if [ -n "${TMP_DIFF}" ] && [ -f "${TMP_DIFF}" ]; then
    rm -f "${TMP_DIFF}"
  fi
}
trap cleanup EXIT

# 解析输入：显式 diff 文件，或读取当前暂存 diff（不扫历史）
if [ -n "${DIFF_ARG}" ]; then
  if [ ! -f "${DIFF_ARG}" ]; then
    echo "❌ [Secret Scan] diff 文件不存在: ${DIFF_ARG}" >&2
    exit 1
  fi
  INPUT_FILE="${DIFF_ARG}"
else
  TMP_DIFF="$(mktemp)"
  git -C "${REPO_ROOT}" diff --cached --no-color > "${TMP_DIFF}"
  INPUT_FILE="${TMP_DIFF}"
fi

# 路径是否属于放行表
is_allowed_path() {
  local p="$1"
  p="${p#./}"
  case "${p}" in
    *.example) return 0 ;;
    docs|docs/*) return 0 ;;
    *.test.js|*.spec.ts|*.test.ts) return 0 ;;
  esac
  local base="${p##*/}"
  if [ "${base}" = "package-lock.json" ]; then
    return 0
  fi
  return 1
}

# ③ 类占位字面量放行
is_placeholder_literal() {
  local lit="$1"
  if [ "${lit}" = "change_me" ]; then
    return 0
  fi
  case "${lit}" in
    your_*|example*) return 0 ;;
  esac
  return 1
}

# 去掉首尾空白
trim_ws() {
  local s="$1"
  # 去前导空白
  s="${s#"${s%%[![:space:]]*}"}"
  # 去尾随空白
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "${s}"
}

# 从赋值右侧取出首个引号字面量内容（单/双引号）
extract_first_quoted() {
  local rest="$1"
  local i c quote="" out=""
  local len=${#rest}
  for ((i = 0; i < len; i++)); do
    c="${rest:i:1}"
    if [ -z "${quote}" ]; then
      if [ "${c}" = '"' ] || [ "${c}" = "'" ]; then
        quote="${c}"
      fi
      continue
    fi
    if [ "${c}" = "${quote}" ]; then
      printf '%s' "${out}"
      return 0
    fi
    out+="${c}"
  done
  return 1
}

# 整行 shell 注释且没有 PEM 装甲头：只是规则说明，不是私钥块。
# 注释里若出现装甲头，仍交给调用方按私钥规则判断。
is_rule_comment_without_pem_armor() {
  local line="$1"
  local trimmed
  trimmed="$(trim_ws "${line}")"
  [[ "${trimmed}" == '#'* ]] || return 1
  [[ "${line}" == *'-----BEGIN'* ]] && return 1
  return 0
}

# 判断新增行是否命中三类之一；命中则向 stdout 打印原因标签
line_hits_secret() {
  local line="$1"

  # ① PEM 私钥块。标记分两行存放，避免本脚本的规则行把自己判成私钥。
  if ! is_rule_comment_without_pem_armor "${line}"; then
    local pem_begin='BEGIN'
    local pem_label='PRIVATE KEY'
    if [[ "${line}" == *"${pem_begin}"* && "${line}" == *"${pem_label}"* ]]; then
      echo "pem"
      return 0
    fi
  fi

  # ② 带用户名和密码的 URL：:// … : … @
  if echo "${line}" | grep -qE '://[^[:space:]/@]+:[^[:space:]/@]+@'; then
    echo "url"
    return 0
  fi

  # ③ 变量名含敏感关键词 + 右侧引号字面量长度 ≥ 8
  if ! echo "${line}" | grep -qiE '[A-Za-z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY|PRIVATE_KEY)[A-Za-z0-9_]*[[:space:]]*[=:][[:space:]]*["'\'']'; then
    return 1
  fi

  local lower rhs=""
  lower="$(echo "${line}" | tr '[:upper:]' '[:lower:]')"
  local keys=("api_key" "private_key" "password" "secret" "token")
  local key pos key_pos=-1
  for key in "${keys[@]}"; do
    pos="$(awk -v s="${lower}" -v k="${key}" 'BEGIN{print index(s,k)}')"
    if [ "${pos}" -gt 0 ]; then
      # 较长关键词优先已靠排列；同起点取最先出现者
      if [ "${key_pos}" -lt 0 ] || [ "${pos}" -lt "${key_pos}" ]; then
        key_pos="${pos}"
      fi
    fi
  done
  if [ "${key_pos}" -lt 0 ]; then
    return 1
  fi

  # 从关键词起点向后找第一个 = 或 :，再取引号字面量
  local from="$((key_pos - 1))"
  local slice="${line:from}"
  local j c op_found=0
  for ((j = 0; j < ${#slice}; j++)); do
    c="${slice:j:1}"
    if [ "${op_found}" -eq 0 ]; then
      if [ "${c}" = "=" ] || [ "${c}" = ":" ]; then
        op_found=1
      fi
      continue
    fi
    rhs="${slice:j}"
    break
  done
  if [ "${op_found}" -eq 0 ] || [ -z "${rhs}" ]; then
    return 1
  fi

  local lit
  if ! lit="$(extract_first_quoted "${rhs}")"; then
    return 1
  fi
  lit="$(trim_ws "${lit}")"
  if [ "${#lit}" -lt 8 ]; then
    return 1
  fi
  if is_placeholder_literal "${lit}"; then
    return 1
  fi
  echo "assignment"
  return 0
}

hits=()
current_path=""
new_lineno=0
in_hunk=0

while IFS= read -r raw || [ -n "${raw}" ]; do
  # 新文件头：+++ b/path 或 +++ path
  if [[ "${raw}" == +++\ * ]]; then
    current_path="${raw#+++ }"
    current_path="${current_path#b/}"
    # 去掉可能的 tab 后时间戳
    current_path="${current_path%%$'\t'*}"
    current_path="${current_path%% *}"
    in_hunk=0
    new_lineno=0
    continue
  fi

  # 旧文件头 / diff 元数据
  if [[ "${raw}" == ---\ * || "${raw}" == diff\ * || "${raw}" == index\ * || "${raw}" == old\ mode\ * || "${raw}" == new\ mode\ * || "${raw}" == similarity\ * || "${raw}" == rename\ * || "${raw}" == copy\ * || "${raw}" == Binary\ * ]]; then
    continue
  fi

  # hunk 头：@@ -a,b +c,d @@
  if [[ "${raw}" == @@\ * ]]; then
    in_hunk=1
    local_plus="${raw#*+}"
    local_plus="${local_plus%% *}"
    new_lineno="${local_plus%%,*}"
    if ! [[ "${new_lineno}" =~ ^[0-9]+$ ]]; then
      new_lineno=0
    fi
    continue
  fi

  if [ "${in_hunk}" -ne 1 ] || [ -z "${current_path}" ]; then
    continue
  fi

  # 仅扫描新增行（+），忽略 +++ 已在上面处理；删除行与上下文不拦
  if [[ "${raw}" == +* && "${raw}" != +++* ]]; then
    content="${raw:1}"
    lineno="${new_lineno}"
    new_lineno=$((new_lineno + 1))

    if is_allowed_path "${current_path}"; then
      continue
    fi
    if [ "${current_path}" = "/dev/null" ]; then
      continue
    fi

    if hit_kind="$(line_hits_secret "${content}")"; then
      hits+=("${current_path}:${lineno}")
    fi
    continue
  fi

  # 上下文行（首字符为空格）推进新文件行号
  if [[ "${raw}" == ' '* ]]; then
    new_lineno=$((new_lineno + 1))
    continue
  fi

  if [[ "${raw}" == -* && "${raw}" != ---* ]]; then
    # 删除行不推进新文件行号
    continue
  fi

  # "\ No newline at end of file"
  if [[ "${raw}" == '\\'* ]]; then
    continue
  fi
done < "${INPUT_FILE}"

if [ "${#hits[@]}" -eq 0 ]; then
  exit 0
fi

echo ""
echo "❌ [Secret Scan] 暂存区疑似硬编码口令/密钥/私钥/连接串，提交已拦截。"
echo "👉 明文不要入库，请改走环境变量（或移出暂存区）。"
echo "👉 命中位置："
for h in "${hits[@]}"; do
  echo "   ${h}"
done
echo ""
exit 1
