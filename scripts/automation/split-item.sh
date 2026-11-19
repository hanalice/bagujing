#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: split-item.sh
# 脚本作用: 将 assist/manual + todo 拆成可日修的 auto 子项（双评 2/2 才落盘）
# 使用方式:
#   ./scripts/automation/split-item.sh                 # 取优先级最高的可拆项
#   ./scripts/automation/split-item.sh --task D3
#   ./scripts/automation/split-item.sh --yes           # 无人值守：采纳后只 commit，留给日修同 PR
#   ./scripts/automation/split-item.sh --yes --push    # 仅手动：采纳后单独开 PR（cron 不要用）
#   ./scripts/automation/split-item.sh --dry-run       # 只打印将要下发的 prompt
# 规则:
#   拆 1 人（不计票）+ 评 A/B（计票）。采用须双评 PASS。
#   同一条目最多：主拆 1 + 改版 1；每轮双评；第二轮仍非 2/2 则不改 auto。
#   拆条 commit 与日修 commit 分开；cron 路径不 --push，由 daily-fix 开同一条 auto-* PR。
# ==============================================================================

set -euo pipefail

AUTOMATION_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$AUTOMATION_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

die() { echo "❌ $*" >&2; exit 1; }

# shellcheck source=lib/agent-loop.sh
source "$AUTOMATION_DIR/lib/agent-loop.sh"
# shellcheck source=lib/git-sandbox.sh
source "$AUTOMATION_DIR/lib/git-sandbox.sh"
# shellcheck source=lib/backlog-queue.sh
source "$AUTOMATION_DIR/lib/backlog-queue.sh"
# shellcheck source=lib/run-record.sh
source "$AUTOMATION_DIR/lib/run-record.sh"

LOG_DIR="$PROJECT_ROOT/logs"
TASK_ID=""
ASSUME_YES=0
DRY_RUN=0
DO_PUSH=0
ENGINE="${ENGINE:-auto}"
RUN_RECORD=1
RUN_KIND="split"
RUN_TASK=""
RUN_STAGE="init"
RUN_REASON="unknown"
RUN_EXIT=1
RUN_PR_OPENED=""
RUN_QA_PASSED=""

while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK_ID="${2:?--task 需要任务号，如 D3}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --engine) ENGINE="${2:?--engine 需要 cursor-agent|claude}"; shift 2 ;;
    -h|--help) RUN_RECORD=0; sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

finish() {
  local code=$?
  if [ "$RUN_RECORD" = "1" ]; then
    RUN_EXIT="$code"
    automation_record "$RUN_KIND" "$RUN_TASK" "$RUN_STAGE" "$RUN_REASON" "$RUN_EXIT" "$RUN_PR_OPENED" "$RUN_QA_PASSED"
  fi
  exit "$code"
}
trap finish EXIT

agent_prepare_cli_path
agent_resolve_engine
[ -f "$BACKLOG_PATH" ] || die "待办队列不存在: $BACKLOG_PATH"

ROW="$(backlog_read_split_candidate "$TASK_ID")"
[ -n "$ROW" ] || die "没有可拆的 assist/manual+todo（--task='${TASK_ID}'）"

IFS=$'\t' read -r ID ITEM_TYPE SOURCE_ID ROW_LEVEL STATUS TASK_TEXT <<< "$ROW"
[ "$STATUS" = "todo" ] || die "$ID 状态为 $STATUS，不能拆"
if [ "$ROW_LEVEL" != "assist" ] && [ "$ROW_LEVEL" != "manual" ]; then
  die "$ID 分级为 $ROW_LEVEL，只拆 assist/manual"
fi

RUN_TASK="$ID"
echo "✂️ 拆条 $ID [$SOURCE_ID] ($ITEM_TYPE/$ROW_LEVEL): $TASK_TEXT"
echo "🔧 引擎：$ENGINE"

CONTEXT="$(backlog_collect_context "$ID" "$SOURCE_ID")"
SKILLS_DIR="$PROJECT_ROOT/.agents/skills"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
SPLIT_LOG="$LOG_DIR/split-${ID}-${STAMP}.log"
REVIEW_A_LOG="$LOG_DIR/split-${ID}-reviewA-${STAMP}.log"
REVIEW_B_LOG="$LOG_DIR/split-${ID}-reviewB-${STAMP}.log"
build_split_prompt() {
  local round="$1"
  local gaps="${2:-}"
  cat <<EOF
你在 DevAsk（职问AI）仓库做**待办拆条**，不是写业务实现。仓库根目录：$PROJECT_ROOT

## 待拆条目
- ID：$ID
- 类型：$ITEM_TYPE
- 来源：$SOURCE_ID
- 分级：$ROW_LEVEL
- 任务：$TASK_TEXT

## 公开队列与上下文
$CONTEXT

## 本阶段唯一交付
只改 \`docs/backlog.md\`：
1. 父项 $ID 状态改为 \`split\`，任务列写明已拆为哪些子 ID。
2. 在队列表中追加子项行（优先级步长 10；可日修的标 \`auto\`+\`todo\`；运维壳可留 \`manual\`+\`todo\`；未冻的勿标 auto）。
3. 在「契约冻结」为每个**新**子项增加 \`### <子ID>\`，必须含「做 / 不做 / residual」三行。
4. 「修订记录」追加一行说明人/机拆条。

## 顶尖拆法（按序思考，再落笔）
1. 边界：一次无人值守 PR 能做完什么；什么必须 residual / 另条。
2. 可测：完成标准须能被单测或只读文档测锁死。
3. 切片：一层一主题；禁止把无关能力捆进同一 auto。
4. 分级：只有契约已冻、可 \`--yes\` 的才标 \`auto\`；真集群/生产开关/批量迁移留 \`manual\`。
5. 去重：不重复已有 done/todo，不抢其它条目范围。
6. 角色：鉴权/签名/消毒参考 \`$SKILLS_DIR/security_expert/SKILL.md\`；接口/检索参考 \`$SKILLS_DIR/system_architect/SKILL.md\`；限流/Redis/env 参考 \`$SKILLS_DIR/devops_expert/SKILL.md\`。

## 硬性要求
1. **禁止**改代码、测试、其它文档。不要 git。
2. 公开表不写利用步骤、payload、攻击细节。
3. 子 ID 用数字后缀（如 ${ID}1 / ${ID}2）或未占用的新号；禁止复用已有 ID。
4. 无人值守：禁止问确认，直接改 \`docs/backlog.md\`。
EOF
  if [ "$round" = "revise" ]; then
    cat <<EOF

## 改版（仅此一轮）
上一轮双评未 2/2。只根据下列否决点修改拆条，不要扩大范围：
$gaps
EOF
  fi
}

build_review_prompt() {
  local reviewer="$1"
  cat <<EOF
你是拆条评委 $reviewer（只读）。对照清单二元判定，不要自由长文。仓库：$PROJECT_ROOT

## 被评父项
- ID：$ID（原分级 $ROW_LEVEL）
- 任务：$TASK_TEXT

## 你要做的事
1. 只读 \`docs/backlog.md\`：父项是否已 \`split\`；子项行与 \`###\` 契约。
2. 对下列 5 条逐条判定 PASS/FAIL（有一条 FAIL 则总评 FAIL）：
   1. 一次 PR 能做完，单层单主题
   2. 「做 / 不做 / residual」互不打架、单测能锁
   3. manual 运维壳与代码切片已分开（若适用；纯 assist 无运维壳可标本条 PASS）
   4. 不会误标 auto 导致日修无人值守踩坑
   5. 与已有 done/todo 不重复、不抢别项范围
3. **禁止**修改任何文件。不要 git。

## 输出格式（必须逐字遵守）
先各写一行：
CHECK-1: PASS|FAIL
CHECK-2: PASS|FAIL
CHECK-3: PASS|FAIL
CHECK-4: PASS|FAIL
CHECK-5: PASS|FAIL
然后：
VERDICT: PASS
或
VERDICT: FAIL
FAIL_CODES: 1,4
（FAIL_CODES 为未过条款编号，逗号分隔；PASS 时不要写 FAIL_CODES）
最后可用不超过 5 行说明否决点（可选）。
EOF
}

parse_round() {
  local log_a="$1"
  local log_b="$2"
  local revision_used="$3"
  local review_js="$AUTOMATION_DIR/lib/split-review.js"
  DECIDE_JSON="$(
    export REVIEW_A_TEXT REVIEW_B_TEXT REVISION_USED REVIEW_JS
    REVIEW_A_TEXT="$(cat "$log_a")"
    REVIEW_B_TEXT="$(cat "$log_b")"
    REVISION_USED="$revision_used"
    REVIEW_JS="$review_js"
    node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(process.env.REVIEW_JS).href);
const reviewA = mod.parseReviewerOutput(process.env.REVIEW_A_TEXT);
const reviewB = mod.parseReviewerOutput(process.env.REVIEW_B_TEXT);
const d = mod.decideSplitRound({
  reviewA,
  reviewB,
  revisionUsed: process.env.REVISION_USED === '1',
});
process.stdout.write(JSON.stringify({ reviewA, reviewB, ...d }));
NODE
  )"
}

if [ "$DRY_RUN" = "1" ]; then
  echo "===== 拆条 prompt（主拆）====="
  build_split_prompt main
  echo "===== 评委 prompt A ====="
  build_review_prompt A
  RUN_REASON="dry_run"
  RUN_EXIT=0
  exit 0
fi

git_sandbox_ensure_clean
agent_check_auth
if [ "$DO_PUSH" = "1" ]; then
  git_sandbox_require_gh
fi

# 在当前分支上拆（cron 已在 main）；开 docs/split 分支隔离
git_sandbox_open_branch "docs/split-${ID,,}-$(date +%Y%m%d)"
# 记录拆前 backlog，否决时恢复
git show HEAD:"docs/backlog.md" > "$LOG_DIR/.split-${ID}-backlog.before.md" 2>/dev/null \
  || cp "$BACKLOG_PATH" "$LOG_DIR/.split-${ID}-backlog.before.md"

run_split_agent() {
  local round="$1"
  local gaps="${2:-}"
  local tag="$3"
  RUN_STAGE="split_$tag"
  echo "🤖 拆条 agent（$tag）日志：$SPLIT_LOG"
  {
    echo "======== split $tag $(date -Iseconds) ========"
    build_split_prompt "$round" "$gaps" | invoke_engine
  } >>"$SPLIT_LOG" 2>&1 || true
  if [ -z "$(git status --porcelain -- docs/backlog.md)" ]; then
    die "拆条 agent 未修改 docs/backlog.md"
  fi
  # 只允许 backlog
  local bad
  bad="$(git_sandbox_list_paths | grep -v '^docs/backlog.md$' || true)"
  if [ -n "$bad" ]; then
    echo "⚠️ 拆条改动了额外文件，将还原非 backlog 路径："
    echo "$bad"
    while IFS= read -r p; do
      [ -n "$p" ] || continue
      git checkout HEAD -- "$p" 2>/dev/null || rm -f "$p"
    done <<< "$bad"
  fi
}

run_dual_review() {
  local tag="$1"
  RUN_STAGE="review_$tag"
  echo "🔎 双评并行（$tag）..."
  build_review_prompt A | invoke_review_engine >"$REVIEW_A_LOG" 2>&1 &
  local pid_a=$!
  build_review_prompt B | invoke_review_engine >"$REVIEW_B_LOG" 2>&1 &
  local pid_b=$!
  wait "$pid_a" || true
  wait "$pid_b" || true
  echo "----- 评A 尾部 -----"
  tail -n 30 "$REVIEW_A_LOG" || true
  echo "----- 评B 尾部 -----"
  tail -n 30 "$REVIEW_B_LOG" || true
}

run_split_agent main "" v1
run_dual_review r1
parse_round "$REVIEW_A_LOG" "$REVIEW_B_LOG" 0
ACTION="$(printf '%s' "$DECIDE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log(JSON.parse(s).action)})')"
SUMMARY="$(printf '%s' "$DECIDE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log(JSON.parse(s).summary)})')"
echo "⚖️ 第一轮裁决：$ACTION — $SUMMARY"

if [ "$ACTION" = "revise" ]; then
  GAPS="$(printf '%s' "$DECIDE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);console.log((j.failCodes||[]).join(",")+"\n"+j.summary)})')"
  run_split_agent revise "$GAPS" v2
  run_dual_review r2
  parse_round "$REVIEW_A_LOG" "$REVIEW_B_LOG" 1
  ACTION="$(printf '%s' "$DECIDE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log(JSON.parse(s).action)})')"
  SUMMARY="$(printf '%s' "$DECIDE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{console.log(JSON.parse(s).summary)})')"
  echo "⚖️ 第二轮裁决：$ACTION — $SUMMARY"
fi

if [ "$ACTION" != "adopt" ]; then
  echo "🚫 拆条未采纳：不新增 auto；写入待决（若尚无同行）"
  cp "$LOG_DIR/.split-${ID}-backlog.before.md" "$BACKLOG_PATH"
  PENDING_EXISTS=0
  if backlog_list_pending_rows | awk -F'\t' -v id="$ID" '$1 == id { found=1 } END { exit found ? 0 : 1 }'; then
    PENDING_EXISTS=1
  fi
  if [ "$PENDING_EXISTS" -eq 0 ]; then
    PENDING_LINE="| $ID | $(date +%Y-%m-%d) | Split | 双评未 2/2：$SUMMARY | 保持 $ROW_LEVEL，改口径后再拆 |"
    awk -v line="$PENDING_LINE" '
      /^##[[:space:]]/ { if ($0 ~ /待决/) in_p=1; else in_p=0 }
      { print }
      in_p && /^\| ---/ && !done {
        print line
        done=1
      }
    ' "$BACKLOG_PATH" > "$BACKLOG_PATH.tmp" && mv "$BACKLOG_PATH.tmp" "$BACKLOG_PATH"
  fi
  RUN_REASON="split_rejected"
  # 仅手动 --push 才为否决开 PR；cron（--yes 无 --push）不留本地否决 commit，避免挡住日修。
  if [ "$ASSUME_YES" = "1" ] && [ "$DO_PUSH" = "1" ] && [ -n "$(git status --porcelain -- docs/backlog.md)" ]; then
    MSG_FILE="$LOG_DIR/.split-commit-msg"
    cat >"$MSG_FILE" <<EOF
docs(backlog): [$ID] 拆条双评未通过，记入待决

- 双评未达 2/2，未新增 auto 子项
- $SUMMARY
EOF
    git_sandbox_confirm "$ASSUME_YES" || die "已取消"
    git_sandbox_commit_all "$MSG_FILE"
    git_sandbox_push_pr "$DO_PUSH" "$MSG_FILE" "docs(backlog): [$ID] 拆条双评未通过"
    RUN_PR_OPENED="true"
  else
    git checkout -- docs/backlog.md 2>/dev/null || cp "$LOG_DIR/.split-${ID}-backlog.before.md" "$BACKLOG_PATH"
    git_sandbox_abandon_if_empty || true
  fi
  exit 1
fi

# 采纳：校验父项 split + 至少一条新 auto 契约
RUN_STAGE="validate"
if ! grep -E "^\|[[:space:]]*${ID}[[:space:]]*\|.*\|[[:space:]]*split[[:space:]]*\|" "$BACKLOG_PATH" >/dev/null; then
  die "采纳前校验失败：父项 $ID 未标为 split"
fi
NEW_AUTOS="$(backlog_list_auto_todo_ids)"
[ -n "$NEW_AUTOS" ] || die "采纳前校验失败：拆后仍无 auto+todo"
# 抽查：每个 auto+todo 若是新后缀相关则须冻契约——简化为：所有 auto+todo 都须冻（既有亦应冻）
while IFS= read -r aid; do
  [ -n "$aid" ] || continue
  backlog_contract_frozen "$aid" || die "子项/条目 $aid 缺少契约冻结三行"
done <<< "$NEW_AUTOS"

RUN_REASON="split_adopted"
MSG_FILE="$LOG_DIR/.split-commit-msg"
cat >"$MSG_FILE" <<EOF
docs(backlog): [$ID] 双评通过，拆成可日修子项

【背景 (Background)】
- $ID 为 $ROW_LEVEL，日修无法直接领取；空队列时需拆成 auto。

【设计概述 (Design)】
- 拆 1 + 评 A/B；提案不计票，双评 2/2 才落盘。
- $SUMMARY

【变更内容 (Changes)】
- 更新 docs/backlog.md：父项 split，子项与契约冻结已写入。

【测试与兼容性 (Testing & Compatibility)】
- 拆条裁决单测 UT-SPLIT-*；本提交仅队列文档。
EOF

git_sandbox_confirm "$ASSUME_YES" || die "已取消"
git_sandbox_commit_all "$MSG_FILE"
RUN_QA_PASSED="true"
if [ "$DO_PUSH" = "1" ]; then
  git_sandbox_push_pr "$DO_PUSH" "$MSG_FILE" "docs(backlog): [$ID] 双评通过拆成 auto 子项"
  RUN_PR_OPENED="true"
else
  echo "ℹ️ 拆条已 commit 在 $WORK_BRANCH，未开 PR（供同次日修复用同一条 auto-* 分支）。"
fi

echo "✅ 拆条已采纳：$ID"
RUN_EXIT=0
exit 0
