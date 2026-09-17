#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: weekly-scan.sh
# 脚本作用: 扫描代码与现有队列，把新发现写入 docs/backlog.md（进 git）
# 使用方式:
#   ./scripts/automation/weekly-scan.sh                 # 扫描并改 backlog，提交前人工确认
#   ./scripts/automation/weekly-scan.sh --dry-run       # 只打印将要下发的 prompt
#   ./scripts/automation/weekly-scan.sh --yes --push    # 无人值守：提交并用 gh 开 PR
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

LOG_DIR="$PROJECT_ROOT/logs"
ASSUME_YES=0
DRY_RUN=0
DO_PUSH=0
ENGINE="${ENGINE:-auto}"
MAX_NEW_AUTO="${MAX_NEW_AUTO:-3}"
MAX_PENDING="${MAX_PENDING:-3}"
SKILLS_DIR="$PROJECT_ROOT/.agents/skills"

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --push) DO_PUSH=1; shift ;;
    --engine) ENGINE="${2:?--engine 需要 cursor-agent|claude}"; shift 2 ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

agent_prepare_cli_path
agent_resolve_engine
[ -f "$BACKLOG_PATH" ] || die "待办队列不存在: $BACKLOG_PATH"

EXISTING_AUTO_IDS="$(backlog_list_auto_todo_ids | tr '\n' ' ')"
NEXT_S_ID="$(awk -F'|' '
  /^\|[[:space:]]*S[0-9]+[[:space:]]*\|/ {
    gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
    n = substr($2, 2) + 0
    if (n > max) max = n
  }
  END { print "S" (max + 1) }
' "$BACKLOG_PATH")"

CUTOFF="$(backlog_pending_cutoff_date)"
HLD_HINT=""
if [ -f "$HLD_PATH" ]; then
  HLD_HINT="本地存在内部 HLD（$HLD_PATH）。可作背景，禁止把利用方式、威胁细节抄进公开 backlog。"
else
  HLD_HINT="本机没有内部 HLD。只根据公开文档与源码扫描。"
fi

build_scan_prompt() {
  cat <<EOF
你在 DevAsk（职问AI）仓库做**周扫描入库**，不是写业务实现。仓库根目录：$PROJECT_ROOT

不要启动 MAF 任务（不写 maf_manifest、不开 tmux）。只借用角色技能做分级。

## 唯一交付
只改 \`docs/backlog.md\`：
1. 能冻契约的缺口：写入「队列表」为 \`auto\` + \`todo\`，并在「契约冻结」增加 \`### <ID>\`（做 / 不做 / residual）。
2. 必须叫人的缺口：写入「待决」表（不是 auto）。格式：\`| ID | 提出日(今天 YYYY-MM-DD) | 角色 | 一句话问题 | 推荐 |\`
3. 已逾期的待决（提出日 ≤ $CUTOFF）：按「推荐」落盘（写入队列表+契约或 assist/manual），并从待决表删掉该行。
4. 「修订记录」追加一行。

## 角色路由（每条最多请一个角色，先读对应 SKILL.md 再定级）
- 鉴权、消毒、签名、哈希、注入 → \`$SKILLS_DIR/security_expert/SKILL.md\`（Security）
- 接口形状、前后端契约、检索/FTS → \`$SKILLS_DIR/system_architect/SKILL.md\`（Architect）
- 限流、Redis、env、部署 → \`$SKILLS_DIR/devops_expert/SKILL.md\`（DevOps）：代码切片可 auto；生产开关保持 manual，**不要**写入待决
- 产品表现分叉（渲染形态、N 轮多少） → \`$SKILLS_DIR/project_manager/SKILL.md\`（PM）：几乎总是待决
- lint、缺测、死 import、文档漂移 → **不读角色**，直接 auto

## 什么时候才写入待决（其它情况不要叫人）
1. 产品分叉：两个都能冻的方案。
2. 破坏性默认值（例如把生产签名默认改成 true）。
3. 角色意见冲突（若你发现两条路由都沾边且结论相反）。
4. 公开表措辞可能泄威胁细节，需要人改句子。

不要写入待决：去重、lint、补测、已能写出做/不做/residual 的拆条、纯运维壳留 manual。

## 限额与编号
- 本次最多新增 **$MAX_NEW_AUTO** 条 \`auto\` + \`todo\`（拆出来的子项也计入）。
- 待决表合计最多 **$MAX_PENDING** 行（含未逾期的旧行）。超出则只留最需要人拍板的，其余写成 assist/manual。
- 新号从 \`$NEXT_S_ID\` 起用 \`S\` 前缀。拆现有 A/B/C/D 父项时用数字后缀，不要复用已有 ID。
- 当前已是 auto+todo、不要重复登记：$EXISTING_AUTO_IDS
- 待决中的 ID **禁止**同时出现在队列表的 auto+todo（否则日修会误跑）。

## 扫描范围（先窄后宽）
只看与 LLM 调用、AI Guard、助教/解析相关的缺口：
- \`backend/src/server-express.js\`、\`backend/src/llm.js\`、\`backend/src/security/ai-guard.js\`
- 前端助教 / 题目解析页
- \`docs/security-ai-guard.md\` 与代码是否漂移
- 现有 \`docs/backlog.md\` 里仍为 assist/manual 的行：若能冻契约，拆成 auto 子项

$HLD_HINT

## 硬性要求
1. **禁止**修改任何代码、测试、其它文档。不要 git。
2. 公开表只写要改什么和完成标准，**禁止**写利用步骤、payload、攻击细节。
3. 过不了「契约已冻 / 单层单主题 / 无运维迁移 / 完成标准无互斥全称」的，写成 \`assist\` 或 \`manual\` + \`todo\`，**不要**标 auto。
4. 不要改已有 \`done\` / \`split\` 行的状态（除非你正在把某条 assist/manual 父项改为 split 并新增子项）。
5. 若没有新发现且无逾期待决：不要编造条目；队列表可不变。
6. **无人值守**：禁止问确认，直接改 \`docs/backlog.md\`。叫人只通过待决表，扫描过程不要停下来等。

EOF
}

if [ "$DRY_RUN" = "1" ]; then
  echo "===== 周扫描 prompt ====="
  build_scan_prompt
  exit 0
fi

git_sandbox_ensure_clean
agent_check_auth
[ "$DO_PUSH" = "1" ] && git_sandbox_require_gh

git_sandbox_open_branch "chore/weekly-scan-$(date +%Y%m%d)"

mkdir -p "$LOG_DIR"
RUN_LOG="$LOG_DIR/weekly-scan-$(date +%Y%m%d-%H%M%S).log"
MSG_FILE="$LOG_DIR/.weekly-scan-commit-msg"
rm -f "$MSG_FILE"
trap 'rm -f "$MSG_FILE"' EXIT

BEFORE_IDS="$(backlog_list_auto_todo_ids | sort)"

echo "🔍 周扫描改 docs/backlog.md（日志：$RUN_LOG）..."
build_scan_prompt | invoke_engine 2>&1 | tee -a "$RUN_LOG"

backlog_only_changed() {
  local paths
  paths="$(git_sandbox_list_paths)"
  [ -n "$paths" ] || return 1
  echo "$paths" | grep -qx 'docs/backlog.md' || return 1
  [ "$(echo "$paths" | wc -l)" -eq 1 ]
}

if ! backlog_only_changed; then
  extra="$(git_sandbox_list_paths | grep -v '^docs/backlog.md$' || true)"
  if [ -z "$(git_sandbox_list_paths)" ]; then
    echo "本周无新发现，队列未改。删除空分支。"
    git_sandbox_abandon_if_empty || true
    exit 0
  fi
  die "周扫描只允许改 docs/backlog.md，额外改动：$extra"
fi

AFTER_IDS="$(backlog_list_auto_todo_ids | sort)"
NEW_IDS="$(comm -13 <(printf '%s\n' "$BEFORE_IDS" | sed '/^$/d') <(printf '%s\n' "$AFTER_IDS" | sed '/^$/d'))"
NEW_COUNT="$(printf '%s\n' "$NEW_IDS" | sed '/^$/d' | grep -c . || true)"
if [ "$NEW_COUNT" -gt "$MAX_NEW_AUTO" ]; then
  die "新增 auto/todo $NEW_COUNT 条，超过上限 $MAX_NEW_AUTO。请删减后再跑。"
fi

while IFS= read -r new_id; do
  [ -n "$new_id" ] || continue
  backlog_contract_frozen "$new_id" || die "新 auto 项 $new_id 缺少契约冻结（### $new_id 须含做 / 不做 / residual）"
done <<< "$NEW_IDS"

PENDING_COUNT="$(backlog_list_pending_rows | sed '/^$/d' | grep -c . || true)"
if [ "$PENDING_COUNT" -gt "$MAX_PENDING" ]; then
  die "待决 $PENDING_COUNT 条，超过上限 $MAX_PENDING。"
fi

EXPIRED_IDS="$(backlog_list_expired_pending_ids "$CUTOFF" | tr '\n' ' ')"
if [ -n "$(backlog_list_expired_pending_ids "$CUTOFF")" ]; then
  die "逾期待决未按推荐落盘：$EXPIRED_IDS（提出日 ≤ $CUTOFF 的行必须从待决删除并写入队列表）"
fi

# 待决 ID 不得同时是 auto+todo，否则日修会误跑
while IFS=$'\t' read -r pid _rest; do
  [ -n "$pid" ] || continue
  if printf '%s\n' "$AFTER_IDS" | grep -qx "$pid"; then
    die "待决 $pid 同时出现在 auto+todo，日修会误跑。待决项不能标 auto。"
  fi
done < <(backlog_list_pending_rows)

echo "✅ 新增 auto/todo $NEW_COUNT 条：${NEW_IDS:-（无）}"
echo "🗳️ 待决 $PENDING_COUNT 条（无则不必叫人）"

NEED_YOU_BODY=""
if [ "$PENDING_COUNT" -gt 0 ]; then
  NEED_YOU_BODY="$(backlog_list_pending_rows | awk -F'\t' '
    BEGIN { print "## 需要你拍板（没有本节 = 直接合）" }
    $1 != "" {
      printf "- [ ] %s（%s）%s  推荐：%s。不回复则 7 天后采用推荐。\n", $1, $3, $4, $5
    }
  ')"
  TITLE="docs(backlog): [need-you] 周扫描入库 $(date +%Y-%m-%d)"
else
  NEED_YOU_BODY="本周无待决，可直接合。"
  TITLE="docs(backlog): [scan] 周扫描入库 $(date +%Y-%m-%d)"
fi

cat > "$MSG_FILE" <<EOF
$TITLE

$NEED_YOU_BODY

【背景 (Background)】
- 周扫描把可自动执行的缺口写入公开待办 docs/backlog.md；只有待决才需要人拍板。

【设计概述 (Design)】
- 分级借用角色技能，不启动 MAF。
- 新增 auto：$NEW_COUNT 条（${NEW_IDS:-无}）；待决：$PENDING_COUNT 条。
EOF

git_sandbox_confirm "$ASSUME_YES" || exit 0
git_sandbox_commit_all "$MSG_FILE"
git_sandbox_push_pr "$DO_PUSH" "$MSG_FILE" "$TITLE"
