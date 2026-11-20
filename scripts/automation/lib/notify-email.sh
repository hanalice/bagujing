#!/usr/bin/env bash
# 日修/周扫描需要人工时，经本机 SMTP（如网易 163）发邮件。
# 配置文件（任选其一，先到先用，不进 git）：
#   $BAGUJING_NOTIFY_ENV
#   ~/.config/bagujing/automation-notify.env
#   $PROJECT_ROOT/scripts/automation/automation-notify.env.local
# 必填：SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM MAIL_TO
# 可选：SMTP_SSL=1（默认，465）或 SMTP_STARTTLS=1（587）
#
# 须在 set -euo pipefail 下 source。调用方通常已设 PROJECT_ROOT。

# 加载本地发信配置；找不到则返回 1（调用方应跳过发信，不失败主流程）。
automation_notify_load_env() {
  local f
  for f in \
    "${BAGUJING_NOTIFY_ENV:-}" \
    "${HOME}/.config/bagujing/automation-notify.env" \
    "${PROJECT_ROOT:-}/scripts/automation/automation-notify.env.local"
  do
    [ -n "$f" ] || continue
    [ -f "$f" ] || continue
    set -a
    # shellcheck disable=SC1090
    . "$f"
    set +a
    return 0
  done
  return 1
}

# 这些原因需要人介入；成功 / 互斥占用 / 用户取消不发。
# split_fallback_pr：日修失败但已开兜底 PR，仍需人知悉（看 PR / 日志）。
automation_notify_needed() {
  case "$1" in
    empty_queue|dirty_worktree|fetch_failed|pr_conflict|pr_unmerged|qa_failed|review_rejected|agent_auth|contract_missing|scan_rejected|split_rejected|split_fallback_failed|split_fallback_pr|secret_scan|commit_hook_failed|unknown)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# 中文一行摘要，方便手机预览。
automation_notify_reason_zh() {
  case "$1" in
    empty_queue) printf '%s' 'auto 队列已空：请拆 assist/manual 或等周扫描补题' ;;
    dirty_worktree) printf '%s' '工作区不干净：日修/周扫拒绝无人值守' ;;
    fetch_failed) printf '%s' 'git fetch 失败：检查网络或 GitHub 连通' ;;
    pr_conflict) printf '%s' '日修/周扫 PR 冲突：需人工处理合并' ;;
    pr_unmerged) printf '%s' '仍有未合并的日修 PR：今日未开新任务' ;;
    qa_failed) printf '%s' '质量门禁失败且返修未过' ;;
    review_rejected) printf '%s' '审核未通过且返修用尽' ;;
    agent_auth) printf '%s' 'cursor-agent / gh 登录态失效' ;;
    contract_missing) printf '%s' '条目缺少契约冻结三行' ;;
    scan_rejected) printf '%s' '周扫描结果被脚本拒绝' ;;
    split_rejected) printf '%s' '拆条双评未 2/2：父项仍 assist/manual，请看待决或改口径' ;;
    split_fallback_failed) printf '%s' '拆条已落盘但日修失败，且兜底 auto-* PR 未推成' ;;
    split_fallback_pr) printf '%s' '日修未完成，但已开 auto-* 兜底 PR（请看 PR，勿当 QA 红）' ;;
    secret_scan) printf '%s' '提交被密钥扫描拦截（常见：规则字面量/注释形似口令 URL）' ;;
    commit_hook_failed) printf '%s' 'git 提交钩子失败（非门禁用例红）' ;;
    unknown) printf '%s' '未分类失败，请看当天 cron 日志' ;;
    *) printf '%s' "$1" ;;
  esac
}

# 只展开与本次 reason 相关的处置提示，避免把 qa_failed 手册当成「本次原因」。
automation_notify_action_for_reason() {
  local reason="$1"
  local log_hint="$2"
  case "$reason" in
    empty_queue)
      printf '%s\n' "- cron 会先 split-item（只 commit）再日修同 PR；仍空则等周扫描或改口径。"
      printf '%s\n' "- 先读 ${log_hint}"
      ;;
    secret_scan)
      printf '%s\n' "- 这不是 QA 用例失败：pre-commit 密钥扫描拦了暂存 diff。"
      printf '%s\n' "- 查日志里「命中位置」：规则字面量/注释勿写成连续的 URL userinfo 形态；测试夹具放 *.test.js。"
      printf '%s\n' "- 修好后在同一 auto-* 分支补 commit 并推 PR。"
      ;;
    commit_hook_failed)
      printf '%s\n' "- 提交未写入：看钩子输出（secret scan / commit-msg / qa-report）。"
      printf '%s\n' "- 先读 ${log_hint} 尾部，再对症修。"
      ;;
    split_fallback_pr)
      printf '%s\n' "- 日修本身失败，但拆条变更已推成 auto-* 兜底 PR，避免 empty_queue 死循环。"
      printf '%s\n' "- 打开该 PR：先看是否缺实现 commit；再对照同次 daily-fix 失败原因。"
      printf '%s\n' "- 日志：${log_hint}"
      ;;
    split_fallback_failed)
      printf '%s\n' "- 拆条已在本地，兜底 PR 未推成：看分支与 ${log_hint}。"
      ;;
    dirty_worktree)
      printf '%s\n' "- 处理干净工作区后再跑日修。"
      ;;
    fetch_failed|agent_auth)
      printf '%s\n' "- 检查网络、gh / cursor-agent 登录与 PATH。"
      ;;
    pr_conflict|pr_unmerged)
      printf '%s\n' "- 打开未合并 PR，处理冲突或等 qa 变绿后再跑日修。"
      ;;
    qa_failed)
      printf '%s\n' "- 打开 docs/qa_report.md 与当天 daily-fix 日志，修红后返修或人工接手。"
      ;;
    review_rejected)
      printf '%s\n' "- 看独立审核缺口列表，补实现/用例后再跑。"
      ;;
    contract_missing)
      printf '%s\n' "- 给条目补齐 ### 契约三行（做 / 不做 / residual）。"
      ;;
    scan_rejected|split_rejected)
      printf '%s\n' "- 看周扫/拆条日志与待决表，改口径后再跑。"
      ;;
    *)
      printf '%s\n' "- 先读 ${log_hint}，按尾部错误对症处理。"
      ;;
  esac
}

# 找当天最新 cron 日志路径（相对仓库根），找不到则给通配提示。
automation_notify_latest_cron_log() {
  local root="${PROJECT_ROOT:-.}"
  local day
  day="$(date +%Y%m%d)"
  local hit=""
  hit="$(ls -1t "$root/logs/daily-fix-cron-${day}"-*.log 2>/dev/null | head -n 1 || true)"
  if [ -z "$hit" ]; then
    hit="$(ls -1t "$root/logs/weekly-scan-cron-${day}"-*.log 2>/dev/null | head -n 1 || true)"
  fi
  if [ -n "$hit" ]; then
    printf '%s' "${hit#"$root"/}"
  else
    printf '%s' "logs/daily-fix-cron-${day}-*.log"
  fi
}

# 取日志尾部若干非空行，供邮件锚定（截断防爆）。
automation_notify_log_excerpt() {
  local log_rel="$1"
  local root="${PROJECT_ROOT:-.}"
  local abs="$root/$log_rel"
  [ -f "$abs" ] || return 0
  local excerpt
  # 优先钩子/失败标记行，避免从 diff 正文里扫到「硬编码」说明文字。
  excerpt="$(grep -E '^❌|^🚫|Secret Scan|命中位置|Git Hook 拦截|质量门禁失败|拆条未采纳|🎯 任务 ' "$abs" 2>/dev/null | tail -n 8 || true)"
  if [ -z "$excerpt" ]; then
    excerpt="$(tail -n 12 "$abs" 2>/dev/null || true)"
  fi
  [ -n "$excerpt" ] || return 0
  # 单行过长截断
  printf '%s\n' "$excerpt" | awk '{
    s=$0
    if (length(s) > 200) s=substr(s,1,200) "…"
    print s
  }'
}

# 发一封纯文本邮件。参数：主题 正文。失败只打日志，返回非 0。
automation_notify_send() {
  local subject="$1"
  local body="$2"
  if ! automation_notify_load_env; then
    echo "ℹ️ 未配置 automation-notify.env，跳过邮件通知。" >&2
    return 1
  fi
  local missing=0
  for v in SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASS MAIL_FROM MAIL_TO; do
    if [ -z "${!v:-}" ]; then
      echo "⚠️ 发信配置缺少 $v" >&2
      missing=1
    fi
  done
  [ "$missing" -eq 0 ] || return 1

  SUBJECT="$subject" BODY="$body" \
  SMTP_HOST="$SMTP_HOST" SMTP_PORT="$SMTP_PORT" \
  SMTP_USER="$SMTP_USER" SMTP_PASS="$SMTP_PASS" \
  MAIL_FROM="$MAIL_FROM" MAIL_TO="$MAIL_TO" \
  SMTP_SSL="${SMTP_SSL:-1}" SMTP_STARTTLS="${SMTP_STARTTLS:-0}" \
  python3 - <<'PY'
import os, smtplib, ssl, sys
from email.message import EmailMessage

host = os.environ["SMTP_HOST"]
port = int(os.environ["SMTP_PORT"])
user = os.environ["SMTP_USER"]
password = os.environ["SMTP_PASS"]
mail_from = os.environ["MAIL_FROM"]
mail_to = os.environ["MAIL_TO"]
subject = os.environ["SUBJECT"]
body = os.environ["BODY"]
use_ssl = os.environ.get("SMTP_SSL", "1").lower() in ("1", "true", "yes")
use_starttls = os.environ.get("SMTP_STARTTLS", "0").lower() in ("1", "true", "yes")

msg = EmailMessage()
msg["From"] = mail_from
msg["To"] = mail_to
msg["Subject"] = subject
msg.set_content(body)

try:
    if use_ssl:
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(host, port, context=context, timeout=30) as smtp:
            smtp.login(user, password)
            smtp.send_message(msg)
    else:
        with smtplib.SMTP(host, port, timeout=30) as smtp:
            smtp.ehlo()
            if use_starttls:
                context = ssl.create_default_context()
                smtp.starttls(context=context)
                smtp.ehlo()
            smtp.login(user, password)
            smtp.send_message(msg)
except Exception as e:
    print(f"⚠️ 发信失败: {e}", file=sys.stderr)
    sys.exit(1)
print("✅ 已发送通知邮件")
PY
}

# 若 reason 需要人，则发信。参数：reason kind taskId stage exitCode [extra]
# 永不因发信失败让调用方崩掉。
automation_notify_human() {
  local reason="$1"
  local kind="${2:-}"
  local task_id="${3:-}"
  local stage="${4:-}"
  local exit_code="${5:-}"
  local extra="${6:-}"
  automation_notify_needed "$reason" || return 0

  local zh subject body root log_rel actions excerpt
  zh="$(automation_notify_reason_zh "$reason")"
  subject="[bagujing] 需要人工：${zh}"
  root="${PROJECT_ROOT:-.}"
  log_rel="$(automation_notify_latest_cron_log)"
  actions="$(automation_notify_action_for_reason "$reason" "$log_rel")"
  excerpt="$(automation_notify_log_excerpt "$log_rel" || true)"
  body="$(cat <<EOF
bagujing 自动化需要你介入。

原因：${reason}
摘要：${zh}
任务：kind=${kind} taskId=${task_id:-（无）} stage=${stage} exit=${exit_code}
日志：${log_rel}

请你做的事（仅针对本次原因）：
${actions}
仓库：${root}
${extra}

EOF
)"
  if [ -n "$excerpt" ]; then
    body="${body}日志摘录：
${excerpt}

"
  fi
  body="${body}（本机 SMTP 自动发送；勿回复此邮件地址除非你知道发件箱。）
"
  automation_notify_send "$subject" "$body" || true
}
