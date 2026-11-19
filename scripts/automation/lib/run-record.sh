#!/usr/bin/env bash
# 把一次日修 / 周扫描 / 定时入口的结局追加到 logs/automation-runs.ndjson。
# 文件在 logs/ 下，不进 git。失败不得改变调用方的退出码。
# 需要人工的原因会尝试发邮件（见 lib/notify-email.sh）；发信失败不改变退出码。

# shellcheck source=notify-email.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/notify-email.sh"

# 把 die 文案收成固定原因。对不上则 unknown。
automation_classify_message() {
  local msg="$1"
  case "$msg" in
    *队列中没有可执行任务*) printf '%s' empty_queue ;;
    *缺少契约*|*契约冻结*) printf '%s' contract_missing ;;
    *未登录*|*不在\ PATH*|*登录态失效*) printf '%s' agent_auth ;;
    *门禁*) printf '%s' qa_failed ;;
    *审核*) printf '%s' review_rejected ;;
    *工作区*) printf '%s' dirty_worktree ;;
    *git\ fetch*|*fetch\ 失败*) printf '%s' fetch_failed ;;
    *冲突*) printf '%s' pr_conflict ;;
    *qa\ 未通过*|*qa\ 尚未*) printf '%s' qa_failed ;;
    *只允许改*|*超过上限*|*逾期待决*|*同时出现*) printf '%s' scan_rejected ;;
    *) printf '%s' unknown ;;
  esac
}

# 参数：kind taskId stage reason exitCode prOpened qaPassed
# prOpened / qaPassed：true、false，或空表示未执行。
automation_record() {
  local kind="$1"
  local task_id="$2"
  local stage="$3"
  local reason="$4"
  local exit_code="$5"
  local pr_opened="${6:-}"
  local qa_passed="${7:-}"
  local file="${AUTOMATION_RUN_FILE:-$PROJECT_ROOT/logs/automation-runs.ndjson}"
  mkdir -p "$(dirname "$file")"
  AUTOMATION_RUN_FILE="$file" \
  AUTOMATION_KIND="$kind" \
  AUTOMATION_TASK="$task_id" \
  AUTOMATION_STAGE="$stage" \
  AUTOMATION_REASON="$reason" \
  AUTOMATION_EXIT="$exit_code" \
  AUTOMATION_PR="$pr_opened" \
  AUTOMATION_QA="$qa_passed" \
  node --input-type=module -e '
    import fs from "node:fs";
    const bool = (v) => (v === "true" ? true : v === "false" ? false : null);
    const row = {
      ts: new Date().toISOString(),
      kind: process.env.AUTOMATION_KIND,
      taskId: process.env.AUTOMATION_TASK || null,
      stage: process.env.AUTOMATION_STAGE,
      reason: process.env.AUTOMATION_REASON,
      exitCode: Number(process.env.AUTOMATION_EXIT),
      prOpened: bool(process.env.AUTOMATION_PR),
      qaPassed: bool(process.env.AUTOMATION_QA),
    };
    fs.appendFileSync(process.env.AUTOMATION_RUN_FILE, JSON.stringify(row) + "\n");
  ' || true
  automation_notify_human "$reason" "$kind" "$task_id" "$stage" "$exit_code" || true
}
