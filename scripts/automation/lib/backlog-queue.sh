#!/usr/bin/env bash
# 公开待办队列 docs/backlog.md：选行、回写 done、校验契约冻结。
# 须在 set -euo pipefail 下 source。调用方需设置 PROJECT_ROOT。

if ! declare -F die >/dev/null 2>&1; then
  die() { echo "❌ $*" >&2; exit 1; }
fi

BACKLOG_PATH="${BACKLOG_PATH:-$PROJECT_ROOT/docs/backlog.md}"
HLD_PATH="${HLD_PATH:-$PROJECT_ROOT/docs/internal/HLD-llm-call-pipeline.md}"

# 队列表行：| ID | 类型 | 来源 | 分级 | 状态 | 任务 |
# 输出：ID \t TYPE \t SOURCE \t LEVEL \t STATUS \t TASK
backlog_read_row() {
  local want_id="$1"
  local want_level="$2"
  awk -F'|' -v want_id="$want_id" -v want_level="$want_level" '
    /^##[[:space:]]/ { in_queue = ($0 ~ /队列表/) }
    !in_queue { next }
    NF < 8 { next }
    /^\|[[:space:]]*[A-Z][0-9]+[[:space:]]*\|/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $5)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $6)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $7)
      if (want_id != "") {
        if ($2 == want_id) {
          print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7
          exit
        }
      } else if ($5 == want_level && $6 == "todo") {
        print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7
        exit
      }
    }
  ' "$BACKLOG_PATH"
}

# 收集 ID 在 backlog（及可选内部 HLD）中的上下文，供编码/审核 prompt 使用。
backlog_collect_context() {
  local id="$1"
  local source="$2"
  local ctx=""
  ctx="$(grep -n -E "(^|[^A-Za-z0-9])($id|$source)([^A-Za-z0-9]|$)" "$BACKLOG_PATH" || true)"
  if [ -f "$HLD_PATH" ]; then
    ctx="${ctx}"$'\n'"$(grep -n -E "(^|[^A-Za-z0-9])($id|$source)([^A-Za-z0-9]|$)" "$HLD_PATH" || true)"
  fi
  printf '%s' "$ctx"
}

# 已冻结契约：### <ID> 小节内必须出现「做」「不做」「residual」（大小写不敏感）。
backlog_contract_frozen() {
  local id="$1"
  awk -v id="$id" '
    BEGIN { IGNORECASE = 1 }
    /^###[[:space:]]+/ {
      heading = $0
      gsub(/^###[[:space:]]+/, "", heading)
      gsub(/[[:space:]].*$/, "", heading)
      in_sec = (heading == id)
      next
    }
    /^##[[:space:]]/ { in_sec = 0 }
    in_sec {
      if ($0 ~ /做/) has_do = 1
      if ($0 ~ /不做/) has_dont = 1
      if ($0 ~ /residual/) has_res = 1
    }
    END { exit (has_do && has_dont && has_res) ? 0 : 1 }
  ' "$BACKLOG_PATH"
}

# 列出当前 auto+todo 的 ID，每行一个，供周扫描限额校验。
backlog_list_auto_todo_ids() {
  awk -F'|' '
    /^##[[:space:]]/ { in_queue = ($0 ~ /队列表/) }
    !in_queue { next }
    /^\|[[:space:]]*[A-Z][0-9]+[[:space:]]*\|/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $5)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $6)
      if ($5 == "auto" && $6 == "todo") print $2
    }
  ' "$BACKLOG_PATH"
}

# 待决表：| ID | 提出日 | 角色 | 问题 | 推荐 |
# 输出：ID \t DATE \t ROLE \t QUESTION \t RECOMMEND
backlog_list_pending_rows() {
  awk -F'|' '
    /^##[[:space:]]/ { in_p = ($0 ~ /待决/) }
    !in_p { next }
    /^\|[[:space:]]*[A-Z][0-9]+[[:space:]]*\|/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $3)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $5)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $6)
      print $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6
    }
  ' "$BACKLOG_PATH"
}

backlog_pending_cutoff_date() {
  if date -d '7 days ago' +%Y-%m-%d >/dev/null 2>&1; then
    date -d '7 days ago' +%Y-%m-%d
  else
    date -v-7d +%Y-%m-%d
  fi
}

# 提出日早于或等于截止日期的待决 ID，每行一个。
backlog_list_expired_pending_ids() {
  local cutoff="$1"
  backlog_list_pending_rows | awk -F'\t' -v cutoff="$cutoff" '$2 != "" && $2 <= cutoff { print $1 }'
}

# 提交前把指定 ID 的 todo 改为 done，并在「修订记录」表追加一行。
backlog_writeback_done() {
  local id="$1"
  local task_text="$2"
  local pr_note="${3:-}"
  local tmp="${BACKLOG_PATH}.tmp"
  local date_str note
  date_str="$(date +%Y-%m-%d)"
  note="$(printf '%s 完成：%s%s' "$id" "$task_text" "${pr_note:+（$pr_note）}" | tr '\n|' ' /')"

  awk -v id="$id" -v rev_date="$date_str" -v rev_note="$note" '
    /^##[[:space:]]/ {
      in_queue = ($0 ~ /队列表/)
      in_rev = ($0 ~ /修订记录/)
    }
    {
      n++
      line = $0
      if (in_queue && line ~ ("^\\|[[:space:]]*" id "[[:space:]]*\\|") && line ~ /\\|[[:space:]]*todo[[:space:]]*\\|/) {
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
  ' "$BACKLOG_PATH" > "$tmp" || { rm -f "$tmp"; die "未能把 $id 从 todo 改为 done，请检查 $BACKLOG_PATH 队列表"; }
  mv "$tmp" "$BACKLOG_PATH"
}
