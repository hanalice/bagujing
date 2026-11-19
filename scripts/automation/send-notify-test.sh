#!/usr/bin/env bash
# 试发一封通知，验证 163 SMTP 配置。用法：./scripts/automation/send-notify-test.sh
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib/notify-email.sh
source "$PROJECT_ROOT/scripts/automation/lib/notify-email.sh"
automation_notify_send "[bagujing] 通知试发成功" "$(cat <<EOF
这是 bagujing 自动化邮件试发。

若你收到此信，说明本机 SMTP（163）配置可用。
之后 empty_queue / dirty_worktree / 门禁失败等需要人工时会自动发信。

时间：$(date -Iseconds)
仓库：$PROJECT_ROOT
EOF
)"
