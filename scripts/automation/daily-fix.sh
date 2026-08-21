#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: daily-fix.sh
# 脚本作用: 从内部缺陷队列取一项，驱动编码 agent 完成修复，跑质量门禁后提交
# 使用方式:
#   ./scripts/automation/daily-fix.sh                 # 取队列中第一个 auto/todo 项，提交前人工确认
#   ./scripts/automation/daily-fix.sh --task A4       # 指定任务号
#   ./scripts/automation/daily-fix.sh --dry-run       # 只打印将要下发的 prompt
#   ./scripts/automation/daily-fix.sh --yes --push    # 无人值守（供 cron 使用）
# 环境变量:
#   ENGINE=cursor-agent|claude  指定编码 agent，默认优先 cursor-agent
# ==============================================================================

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$PROJECT_ROOT"

HLD_PATH="${HLD_PATH:-$PROJECT_ROOT/docs/internal/HLD-llm-call-pipeline.md}"
LOG_DIR="$PROJECT_ROOT/logs"
LEVEL="auto"
TASK_ID=""
ASSUME_YES=0
DRY_RUN=0
DO_PUSH=0
MAX_REPAIR="${MAX_REPAIR:-1}"
ENGINE="${ENGINE:-auto}"

while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK_ID="${2:?--task 需要任务号，如 A4}"; shift 2 ;;
    --level) LEVEL="${2:?--level 需要 auto|assist|manual}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --engine) ENGINE="${2:?--engine 需要 cursor-agent|claude}"; shift 2 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

die() { echo "❌ $*" >&2; exit 1; }

# cron 环境不加载用户 shell 配置，需显式补齐 agent CLI 与 node 所在路径
export PATH="$HOME/.local/bin:$PATH"
if ! command -v claude >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi

if [ "$ENGINE" = "auto" ]; then
  if command -v cursor-agent >/dev/null 2>&1; then
    ENGINE="cursor-agent"
  elif command -v claude >/dev/null 2>&1; then
    ENGINE="claude"
  else
    die "未找到可用的编码 agent（cursor-agent / claude），cron 场景需确认 PATH"
  fi
fi
command -v "$ENGINE" >/dev/null 2>&1 || die "指定的引擎 $ENGINE 不在 PATH 中"
[ -f "$HLD_PATH" ] || die "内部缺陷文档不存在: $HLD_PATH"

# 以 stdin 接收 prompt，把补全内容打到 stdout
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

# 登录态在建分支之前校验：token 失效时不留下空分支
check_auth() {
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

# ------------------------------------------------------------------------------
# 1. 选取任务
# ------------------------------------------------------------------------------
read_queue_row() {
  # 只解析「自动化修复队列」小节内的表格：第 3 节的人读表格里也有同名 ID 开头的行
  awk -F'|' -v want_id="$1" -v want_level="$2" '
    /^##[[:space:]]/ { in_queue = ($0 ~ /自动化修复队列/) }
    !in_queue { next }
    NF < 7 { next }
    /^\|[[:space:]]*[A-D][0-9]+[[:space:]]*\|/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $5)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $6)
      if (want_id != "") {
        if ($2 == want_id) { print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6; exit }
      } else if ($4 == want_level && $5 == "todo") {
        print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6; exit
      }
    }
  ' "$HLD_PATH"
}

ROW="$(read_queue_row "$TASK_ID" "$LEVEL")"
[ -n "$ROW" ] || die "队列中没有可执行任务（--task='$TASK_ID' --level='$LEVEL'）"

IFS=$'\t' read -r ID DEFECT_ID ROW_LEVEL STATUS TASK_TEXT <<< "$ROW"

[ "$STATUS" = "todo" ] || die "$ID 状态为 $STATUS，无需重复修复"
if [ "$ROW_LEVEL" = "manual" ]; then
  die "$ID 分级为 manual（涉及运维依赖或数据迁移），不允许自动修复"
fi
if [ "$ROW_LEVEL" = "assist" ] && [ "$ASSUME_YES" = "1" ]; then
  die "$ID 分级为 assist，需要人工确认方向，不能与 --yes 同用"
fi

echo "🎯 任务 $ID [$DEFECT_ID] ($ROW_LEVEL): $TASK_TEXT"
echo "🔧 编码引擎：$ENGINE"

# ------------------------------------------------------------------------------
# 2. 组装 prompt（把 HLD 中提到该任务号的上下文一并带上）
# ------------------------------------------------------------------------------
CONTEXT="$(grep -n -E "(^|[^A-Za-z0-9])($ID|$DEFECT_ID)([^A-Za-z0-9]|$)" "$HLD_PATH" || true)"

# 放在 logs/（已被 gitignore）而非 /tmp：Claude Code 的写工具默认只允许写工作区内路径
mkdir -p "$LOG_DIR"
MSG_FILE="$LOG_DIR/.daily-fix-commit-msg"
rm -f "$MSG_FILE"
trap 'rm -f "$MSG_FILE"' EXIT

build_prompt() {
  cat <<EOF
你在 DevAsk（职问AI）仓库中修复一个已登记的缺陷。仓库根目录：$PROJECT_ROOT

## 待修任务
- 队列编号：$ID
- 缺陷编号：$DEFECT_ID
- 任务描述：$TASK_TEXT

## 内部设计文档（$HLD_PATH）中与该任务相关的原文
$CONTEXT

## 硬性要求
1. 只修这一个任务，不要顺手改无关代码、不要重排格式、不要升级依赖。
2. 必须在 backend/src/tests/ 下新增或扩展单元测试锁定本次行为，测试要能在不联网、不调真实上游的前提下跑过（沿用现有 mock 风格）。
3. 后端测试命令是 \`cd backend && npm test\`（node:test），自己跑一遍确认通过。
4. 不要修改 docs/internal/ 下的任何文件，状态回写由调用方脚本负责。
5. 不要执行任何 git 命令（add / commit / push / checkout 一律禁止）。
6. 完成后，把一行符合 Conventional Commits 的提交标题写入文件 $MSG_FILE，
   格式为：fix(<scope>): [$DEFECT_ID][$ID] <不超过 40 字的中文摘要>
   scope 取主要改动模块，例如 ai-guard / chat / answer / llm。

${EXTRA_INSTRUCTION:-}
EOF
}

if [ "$DRY_RUN" = "1" ]; then
  build_prompt
  exit 0
fi

# ------------------------------------------------------------------------------
# 3. 前置检查：工作区必须干净，切到独立分支
# ------------------------------------------------------------------------------
[ -z "$(git status --porcelain)" ] || die "工作区有未提交改动，请先处理干净再运行"
check_auth

BASE_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
WORK_BRANCH="auto-fix/${ID,,}-$(date +%Y%m%d)"
git checkout -b "$WORK_BRANCH" >/dev/null 2>&1 || git checkout "$WORK_BRANCH"
echo "🌿 工作分支：$WORK_BRANCH（基线 $BASE_BRANCH）"

RUN_LOG="$LOG_DIR/daily-fix-$ID-$(date +%Y%m%d-%H%M%S).log"

run_agent() {
  echo "🤖 调用 $ENGINE 修复中（日志：$RUN_LOG）..."
  build_prompt | invoke_engine 2>&1 | tee -a "$RUN_LOG"
}

# ------------------------------------------------------------------------------
# 4. 修复 → 质量门禁 →（失败时）有限次返修
# ------------------------------------------------------------------------------
run_agent

attempt=0
while true; do
  echo "🧪 执行质量门禁 ./scripts/qa-report.sh ..."
  if ./scripts/qa-report.sh 2>&1 | tee -a "$RUN_LOG"; then
    break
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -gt "$MAX_REPAIR" ]; then
    echo "🚫 门禁连续未通过，已保留改动在分支 $WORK_BRANCH 供人工接手。"
    exit 1
  fi

  echo "🔁 门禁未通过，发起第 $attempt 次返修..."
  EXTRA_INSTRUCTION="## 上一轮结果
你的改动没有通过质量门禁。以下是 docs/qa_report.md 中的失败详情，请定位并修复，不要回退已完成的功能改动：

$(sed -n '/## 2. 失败用例追踪/,/## 3./p' "$PROJECT_ROOT/docs/qa_report.md")"
  run_agent
done

echo "✅ 质量门禁通过"

# ------------------------------------------------------------------------------
# 5. 展示改动并确认
# ------------------------------------------------------------------------------
if [ -z "$(git status --porcelain)" ]; then
  echo "⚠️ 没有产生任何代码改动，回退分支。"
  git checkout "$BASE_BRANCH" >/dev/null 2>&1
  git branch -D "$WORK_BRANCH" >/dev/null 2>&1
  exit 1
fi

echo ""
echo "================= 本次改动 ================="
git --no-pager diff --stat
echo "==========================================="
git --no-pager diff

COMMIT_MSG="$(head -n 1 "$MSG_FILE" 2>/dev/null | tr -d '\r' || true)"
if ! printf '%s' "$COMMIT_MSG" | grep -qE '^(feat|fix|chore|refactor|test|docs|perf)(\(.+\))?: '; then
  COMMIT_MSG="fix(llm-pipeline): [$DEFECT_ID][$ID] $TASK_TEXT"
fi

echo ""
echo "📝 提交信息：$COMMIT_MSG"

if [ "$ASSUME_YES" != "1" ]; then
  # 非交互环境（stdin 非终端）读不到输入时视为不确认，改动保留在分支上
  reply=""
  read -r -p "确认提交？(y/N) " reply || true
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "已取消，改动保留在 $WORK_BRANCH，确认后可手动 git commit。"; exit 0; }
fi

# ------------------------------------------------------------------------------
# 6. 提交与状态回写
# ------------------------------------------------------------------------------
git add -A
git commit -m "$COMMIT_MSG"
echo "✅ 已提交到 $WORK_BRANCH"

# HLD 被 gitignore，状态回写只影响本地视图；真相源是 git log
sed -i -E "s/^(\| $ID \| $DEFECT_ID \| $ROW_LEVEL \| )todo( \|)/\1done\2/" "$HLD_PATH"
echo "📄 已将 $ID 在内部队列中标记为 done"

if [ "$DO_PUSH" = "1" ]; then
  git push -u origin "$WORK_BRANCH"
  echo "🚀 已推送分支 $WORK_BRANCH，请在 GitHub 上发起 PR 合入 $BASE_BRANCH"
else
  echo "ℹ️ 未推送。确认无误后执行：git push -u origin $WORK_BRANCH"
fi
