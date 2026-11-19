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
automation_notify_needed() {
  case "$1" in
    empty_queue|dirty_worktree|fetch_failed|pr_conflict|pr_unmerged|qa_failed|review_rejected|agent_auth|contract_missing|scan_rejected|unknown)
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
    unknown) printf '%s' '未分类失败，请看当天 cron 日志' ;;
    *) printf '%s' "$1" ;;
  esac
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

  local zh subject body root log_hint
  zh="$(automation_notify_reason_zh "$reason")"
  subject="[bagujing] 需要人工：${zh}"
  root="${PROJECT_ROOT:-.}"
  log_hint="logs/ 下当天 daily-fix-cron-*.log / weekly-scan-cron-*.log"
  body="$(cat <<EOF
bagujing 自动化需要你介入。

原因：${reason}
摘要：${zh}
任务：kind=${kind} taskId=${task_id:-（无）} stage=${stage} exit=${exit_code}

请你做的事：
- empty_queue：拆 assist/manual 成 auto，或确认周扫描会补题；当前 auto+todo 为空会一直空着。
- dirty_worktree：处理干净工作区后再跑日修。
- fetch_failed / agent_auth：检查网络、gh / cursor-agent 登录。
- pr_* / qa_failed / review_rejected：打开对应 PR 或本地分支看日志。
- 其它：先读 ${log_hint}

仓库：${root}
${extra}

（本机 SMTP 自动发送；勿回复此邮件地址除非你知道发件箱。）
EOF
)"
  automation_notify_send "$subject" "$body" || true
}
