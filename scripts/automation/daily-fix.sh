#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: daily-fix.sh
# 脚本作用: 从内部缺陷队列取一项，驱动编码 agent 完成修复，跑质量门禁后提交
# 使用方式:
#   ./scripts/automation/daily-fix.sh                 # 取队列中第一个 auto/todo 项，提交前人工确认
#   ./scripts/automation/daily-fix.sh --task A4       # 指定任务号
#   ./scripts/automation/daily-fix.sh --dry-run       # 只打印规格阶段 + 编码阶段将要下发的 prompt
#   ./scripts/automation/daily-fix.sh --yes --push    # 无人值守：提交、推送并用 gh 开 PR
# 环境变量:
#   ENGINE=cursor-agent|claude  指定编码 agent，默认优先 cursor-agent
#   REVIEW_MODEL                审核 agent 的模型；不设则与编码 agent 同引擎但新开会话
#   MAX_REVIEW_REPAIR           审核失败后允许编码 agent 返修的次数，默认 1
#   GH_TOKEN / gh auth login    --push 时自动 gh pr create，需已登录
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

HLD_PATH="${HLD_PATH:-$PROJECT_ROOT/docs/internal/HLD-llm-call-pipeline.md}"
LOG_DIR="$PROJECT_ROOT/logs"
LEVEL="auto"
TASK_ID=""
ASSUME_YES=0
DRY_RUN=0
DO_PUSH=0
SKIP_REVIEW=0
MAX_REPAIR="${MAX_REPAIR:-1}"
MAX_REVIEW_REPAIR="${MAX_REVIEW_REPAIR:-1}"
ENGINE="${ENGINE:-auto}"

while [ $# -gt 0 ]; do
  case "$1" in
    --task) TASK_ID="${2:?--task 需要任务号，如 A4}"; shift 2 ;;
    --level) LEVEL="${2:?--level 需要 auto|assist|manual}"; shift 2 ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --skip-review) SKIP_REVIEW=1; shift ;;
    --engine) ENGINE="${2:?--engine 需要 cursor-agent|claude}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

agent_prepare_cli_path
agent_resolve_engine
[ -f "$HLD_PATH" ] || die "内部缺陷文档不存在: $HLD_PATH"

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

# HLD 被 gitignore，状态回写只影响本地视图。队列表有对齐空格，不能要求「恰好一格」。
# 提交成功后：第 6 节 todo→done，第 7 节追加一行修订记录（已有「$ID 完成」则跳过）。
writeback_queue_done() {
  local tmp="${HLD_PATH}.tmp"
  local date_str pr_bit note
  date_str="$(date +%Y-%m-%d)"
  pr_bit=""
  [ -n "${PR_NOTE:-}" ] && pr_bit="（${PR_NOTE}）"
  note="$(printf '%s 完成：%s%s；队列状态改为 done' "$ID" "$TASK_TEXT" "$pr_bit" | tr '\n|' ' /')"

  awk -v id="$ID" -v rev_date="$date_str" -v rev_note="$note" '
    /^##[[:space:]]/ {
      in_queue = ($0 ~ /自动化修复队列/)
      in_rev = ($0 ~ /修订记录/)
    }
    {
      n++
      line = $0
      if (in_queue && line ~ ("^\\|[[:space:]]*" id "[[:space:]]*\\|") && line ~ /\|[[:space:]]*todo[[:space:]]*\|/) {
        sub(/\|[[:space:]]*todo[[:space:]]*\|/, "| done |", line)
        queue_ok = 1
      }
      if (in_rev && line ~ /^\| 20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/) last_rev = n
      if (index(line, id " 完成") > 0) has_rev = 1
      lines[n] = line
    }
    END {
      if (!queue_ok) exit 1
      for (i = 1; i <= n; i++) {
        print lines[i]
        if (!has_rev && last_rev && i == last_rev)
          print "| " rev_date " | " rev_note " |"
      }
    }
  ' "$HLD_PATH" > "$tmp" || { rm -f "$tmp"; die "未能把 $ID 从 todo 改为 done，请检查 $HLD_PATH 第 6 节表格对齐"; }
  mv "$tmp" "$HLD_PATH"
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

spec_doc_changed() {
  git_sandbox_list_paths | grep -qx 'docs/test_cases.md'
}

tests_source_changed() {
  git_sandbox_list_paths | grep -qE '^(backend/src/tests/|frontend/.+\.spec\.ts$|frontend/e2e/)'
}

build_spec_prompt() {
  cat <<EOF
你在 DevAsk（职问AI）仓库中做**测试设计**，还不是写实现。仓库根目录：$PROJECT_ROOT

## 待修任务
- 队列编号：$ID
- 缺陷编号：$DEFECT_ID
- 任务描述：$TASK_TEXT

## 内部设计文档（$HLD_PATH）中与该任务相关的原文
$CONTEXT

## 本阶段唯一交付
只改 \`docs/test_cases.md\`。先读现有编号与章节（UT / IT / SEC / E2E / UT-FE），找出覆盖本次完成标准所缺的用例。

## 硬性要求
1. **禁止**修改任何代码、测试文件、\`docs/internal/\`、其它文档。不要 git。
2. 若现有表格已完整覆盖本任务的风险与期望，仍须把对应用例的「描述 / 预期结果」对齐本次完成标准（补测试文件路径、补时序/协议细节），保证本阶段 \`docs/test_cases.md\` 相对工作区基线有改动。
3. 新增行遵循现有 ID 规则：\`层级-主题-序号\`（如 UT-CHAT-SSE-01）。能并入现有小节就并入，否则在对应大章下开新小节。
4. 每一行必须写清：场景（输入/前置）和可判定的预期结果（含关键报文、状态码或调用顺序）。不要写「应表现正常」这类空话。
5. 这些 ID 是下一阶段测试代码的契约：\`it()\` 标题必须包含该 ID。
6. **无人值守**：由 daily-fix.sh 拉起，没有人类操作员。禁止问「请确认」「能否开始」「等同意再改文件」。仓库里「先出计划再等确认」对本任务视为调用方已授权，必须直接改 \`docs/test_cases.md\`；只写计划不改文件视为失败。

${EXTRA_INSTRUCTION:-}
EOF
}

build_prompt() {
  cat <<EOF
你在 DevAsk（职问AI）仓库中修复一个已登记的缺陷。仓库根目录：$PROJECT_ROOT

## 待修任务
- 队列编号：$ID
- 缺陷编号：$DEFECT_ID
- 任务描述：$TASK_TEXT

## 内部设计文档（$HLD_PATH）中与该任务相关的原文
$CONTEXT

## 工作顺序（必须按序，禁止先写测试再补文档）
1. 打开 \`docs/test_cases.md\`，确认上一阶段已登记的、覆盖本任务的用例 ID、场景与预期结果。若仍缺行，先补文档再写代码。
2. 再改生产代码。
3. 最后在 \`backend/src/tests/\` 新增或扩展单测：每个新 \`it()\` 标题包含文档中的用例 ID（如 \`UT-CHAT-SSE-01: ...\`），断言必须与表格「预期结果」一致。测试不联网、不调真实上游（沿用现有 mock 风格）。

## 硬性要求
1. 只修这一个任务，不要顺手改无关代码、不要重排格式、不要升级依赖。
2. 必须同步 \`docs/test_cases.md\` 与可执行单测；只写测试不改文档、或只改文档不写测试，均视为未完成。
3. 后端测试命令是 \`cd backend && npm test\`（node:test），自己跑一遍确认通过。
4. 不要修改 docs/internal/ 下的任何文件，状态回写由调用方脚本负责。
5. 不要执行任何 git 命令（add / commit / push / checkout 一律禁止）。
6. 完成后，把**完整的提交信息**（标题加正文）写入文件 $MSG_FILE，格式必须满足
   docs/git-commit-convention.md 与 .githooks/commit-msg 的校验，否则提交会被拦下：

   第一行：fix(<scope>): [$DEFECT_ID][$ID] <不超过 40 字的中文摘要>
   （scope 取主要改动模块，例如 ai-guard / chat / answer / llm）
   第二行：空行
   之后依次给出三个小节，小节标题必须使用【】包裹，不要用 # 开头：

   【问题现象 (Symptoms)】
   - 用户可见的异常表现与影响范围
   【根因分析 (Root Cause)】
   - 定位到的代码位置与导致异常的因果链
   【解决方案 (Solution)】
   - 具体改动点，以及新增/修改了哪些测试与 \`docs/test_cases.md\` 中的用例 ID、验证结果如何

   正文用中文，只陈述这次改动的事实，不要写推销式总结。
7. **无人值守**：禁止问「请确认」「能否开始」；必须直接改代码与测试。仓库「等确认再执行」对本任务视为已授权。

${EXTRA_INSTRUCTION:-}
EOF
}

if [ "$DRY_RUN" = "1" ]; then
  echo "===== 阶段 1：测试设计（只改 docs/test_cases.md） ====="
  build_spec_prompt
  echo ""
  echo "===== 阶段 2：实现 + 按 ID 写测试 ====="
  build_prompt
  exit 0
fi

# ------------------------------------------------------------------------------
# 3. 前置检查：工作区必须干净，切到独立分支
# ------------------------------------------------------------------------------
git_sandbox_ensure_clean
agent_check_auth
[ "$DO_PUSH" = "1" ] && git_sandbox_require_gh

git_sandbox_open_branch "auto-fix/${ID,,}-$(date +%Y%m%d)"

RUN_LOG="$LOG_DIR/daily-fix-$ID-$(date +%Y%m%d-%H%M%S).log"

run_agent() {
  echo "🤖 调用 $ENGINE 修复中（日志：$RUN_LOG）..."
  build_prompt | invoke_engine 2>&1 | tee -a "$RUN_LOG"
}

run_spec_agent() {
  echo "📋 阶段 1：登记 docs/test_cases.md（日志：$RUN_LOG）..."
  build_spec_prompt | invoke_engine 2>&1 | tee -a "$RUN_LOG"
}

on_spec_retry() {
  echo "🔁 docs/test_cases.md 无改动，发起第 $1 次规格返修..."
  EXTRA_INSTRUCTION="你没有改 docs/test_cases.md。禁止再问确认。本阶段禁止写代码。必须立刻在该文件中新增或修订覆盖 $ID / $DEFECT_ID 的用例行（ID、场景、可判定的预期结果）。"
}

run_spec_phase() {
  EXTRA_INSTRUCTION=""
  agent_until_pred spec_doc_changed "$MAX_REPAIR" \
    "规格阶段未更新 docs/test_cases.md，拒绝继续编码。" \
    run_spec_agent on_spec_retry
  EXTRA_INSTRUCTION=""
  echo "✅ 已更新 docs/test_cases.md，进入实现阶段"
}

ensure_spec_synced_with_tests() {
  if tests_source_changed && ! spec_doc_changed; then
    return 1
  fi
  return 0
}

build_review_prompt() {
  cat <<EOF
你是独立的代码审核员，不是这次改动的作者。仓库：$PROJECT_ROOT
当前分支相对 $BASE_BRANCH 的 diff 就是待审对象。禁止修改任何文件，禁止 git add/commit/push。

## 任务完成标准（必须逐条对照，缺一条就 FAIL）
- 队列编号：$ID
- 缺陷编号：$DEFECT_ID
- 任务描述：$TASK_TEXT

## 内部设计文档中的原文
$CONTEXT

## 请检查
1. 用 \`git diff $BASE_BRANCH\` 看工作区相对基线的完整 diff（此时尚未 commit，不要只用 HEAD）。是否覆盖完成标准的全部动作，而不是只做了容易的一半。
2. \`docs/test_cases.md\` 是否先登记了本任务的用例（ID、场景、可判定预期结果）。只有测试代码、没有文档行，必须 FAIL。
3. 新增测试的 \`it()\` 标题是否包含文档中的用例 ID，断言是否与表格预期一致；是否锁住真正风险（例如把「失败应回补」测成正确行为，必须 FAIL）。
4. 测试全绿不等于任务完成。实现与 HLD 完成标准不一致，即使测试通过也判 FAIL。

无人值守：禁止问「请确认」；直接给出审查结论和 REVIEW_VERDICT 行。

## 输出格式（脚本只认最后一次出现的 REVIEW_VERDICT 行）
先用中文写理由：对照了完成标准的哪几条、diff 里的证据、测试是否锁住了真正风险。
然后单独一行：
REVIEW_VERDICT: PASS
或
REVIEW_VERDICT: FAIL
FAIL 时紧接着用 "- " 列出缺口，每条一行。不要在分析正文里写 REVIEW_VERDICT 示例。
EOF
}

run_review() {
  local review_log="$LOG_DIR/daily-fix-$ID-review-$(date +%Y%m%d-%H%M%S).log"
  echo "🔎 独立审核 agent 对照完成标准审 diff（只读，日志：$review_log）..."
  build_review_prompt | invoke_review_engine 2>&1 | tee -a "$RUN_LOG" | tee "$review_log"
  agent_apply_review_verdict "$review_log" "审核未列出具体缺口，请对照 HLD 完成标准自行补全。"
}

run_qa_gate() {
  echo "🧪 执行质量门禁 ./scripts/qa-report.sh ..."
  if ./scripts/qa-report.sh 2>&1 | tee -a "$RUN_LOG"; then
    echo "✅ 质量门禁通过"
    return 0
  fi
  return 1
}

repair_after_gate() {
  echo "🔁 门禁未通过，发起第 $1 次返修..."
  EXTRA_INSTRUCTION="## 上一轮结果
你的改动没有通过质量门禁。以下是 docs/qa_report.md 中的失败详情，请定位并修复，不要回退已完成的功能改动：

$(sed -n '/## 2. 失败用例追踪/,/## 3. 上线准出门禁/p' "$PROJECT_ROOT/docs/qa_report.md")"
  run_agent
}

run_gate_with_repair() {
  agent_until_ok "$MAX_REPAIR" \
    "🚫 门禁连续未通过，已保留改动在分支 $WORK_BRANCH 供人工接手。" \
    run_qa_gate repair_after_gate
}

repair_after_review() {
  echo "🔁 按审核缺口发起第 $1 次返修..."
  EXTRA_INSTRUCTION="## 独立审核未通过——禁止把当前实现当成已完成
审核员对照 HLD 完成标准列出的缺口：

$REVIEW_GAPS

请补全实现、\`docs/test_cases.md\` 用例行与回归测试（it 标题含用例 ID）。不要修改 docs/internal/，不要 git commit。"
  run_agent
  run_gate_with_repair || exit 1
  ensure_spec_synced_with_tests || die "返修后测试已改但 docs/test_cases.md 仍未同步，拒绝提交。"
}

# ------------------------------------------------------------------------------
# 4. 测试设计 → 修复 → 质量门禁 → 独立审核 →（失败时）有限次返修
# ------------------------------------------------------------------------------
run_spec_phase
run_agent

run_gate_with_repair || exit 1

git_sandbox_abandon_if_empty || exit 1

if ! ensure_spec_synced_with_tests; then
  echo "🚫 测试源码有改动但 docs/test_cases.md 相对基线无改动，回喂编码 agent..."
  EXTRA_INSTRUCTION="测试文件已改，但 docs/test_cases.md 没有同步。先补文档中的用例 ID / 场景 / 预期结果，再让 it() 标题包含这些 ID。不要修改 docs/internal/，不要 git commit。"
  run_agent
  run_gate_with_repair || exit 1
  ensure_spec_synced_with_tests || die "返修后仍未同步 docs/test_cases.md，拒绝提交。"
fi

if [ "$SKIP_REVIEW" = "1" ]; then
  echo "⚠️ 已跳过独立审核（--skip-review），完成标准未由第二 agent 核对。"
else
  if ! agent_until_ok "$MAX_REVIEW_REPAIR" \
    "🚫 审核未通过且返修次数用尽，拒绝提交。改动保留在 $WORK_BRANCH。" \
    run_review repair_after_review; then
    echo "   缺口："
    echo "$REVIEW_GAPS"
    exit 1
  fi
fi

echo ""
echo "================= 本次改动 ================="
git --no-pager diff --stat
echo "==========================================="
git --no-pager diff

# commit-msg 钩子要求 fix 类型带三段式正文，兜底信息也必须满足，否则提交会被拦下
write_fallback_msg() {
  cat > "$MSG_FILE" <<EOF
fix(llm-pipeline): [$DEFECT_ID][$ID] $TASK_TEXT

【问题现象 (Symptoms)】
- 内部缺陷队列登记项 $ID（缺陷号 $DEFECT_ID）：$TASK_TEXT

【根因分析 (Root Cause)】
- 详见 docs/internal/HLD-llm-call-pipeline.md 中 $DEFECT_ID 的证据与影响说明。

【解决方案 (Solution)】
- 由 scripts/automation/daily-fix.sh 驱动 $ENGINE 完成改动，已通过全栈质量门禁。
- 注意：agent 未按规范写出提交信息，本条为脚本兜底生成，建议人工补充细节。
EOF
}

if ! git_sandbox_commit_msg_ok "$MSG_FILE"; then
  echo "⚠️ agent 给出的提交信息不符合 docs/git-commit-convention.md，改用脚本兜底模板。"
  write_fallback_msg
fi

echo ""
echo "📝 提交信息："
echo "-------------------------------------------"
cat "$MSG_FILE"
echo "-------------------------------------------"

git_sandbox_confirm "$ASSUME_YES" || exit 0

# ------------------------------------------------------------------------------
# 6. 提交与状态回写
# ------------------------------------------------------------------------------
git_sandbox_commit_all "$MSG_FILE"

PR_NOTE=""
git_sandbox_push_pr "$DO_PUSH" "$MSG_FILE"
if [ "$DO_PUSH" = "1" ]; then
  pr_n="$(gh pr view --json number -q .number 2>/dev/null || true)"
  [ -n "$pr_n" ] && PR_NOTE="PR #$pr_n"
fi

writeback_queue_done
echo "📄 已将 $ID 在内部队列中标记为 done，并追加第 7 节修订记录"
