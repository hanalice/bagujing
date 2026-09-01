# HLD 第 6 节队列回写（文件被 gitignore，只改本机视图）。
# 由 daily-fix.sh 在提交后调用，也由 hld-sync-merged.sh 在发现 main 已含 [ID] 提交时调用。

# 将队列中指定 ID 从 todo 改为 done，并在第 7 节追加「ID 完成」行（已有则跳过修订行）。
hld_writeback_queue_done() {
  local id="$1"
  local task_text="$2"
  local pr_note="${3:-}"
  local hld_path="${HLD_PATH:?HLD_PATH 未设置}"
  local tmp="${hld_path}.tmp"
  local date_str pr_bit note

  date_str="$(date +%Y-%m-%d)"
  pr_bit=""
  [ -n "$pr_note" ] && pr_bit="（${pr_note}）"
  note="$(printf '%s 完成：%s%s；队列状态改为 done' "$id" "$task_text" "$pr_bit" | tr '\n|' ' /')"

  awk -v id="$id" -v rev_date="$date_str" -v rev_note="$note" '
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
  ' "$hld_path" > "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$hld_path"
}

# 列出第 6 节中状态为 todo 的任务：ID、分级、任务文案（TAB 分隔）。
hld_list_todo_rows() {
  awk -F'|' '
    /^##[[:space:]]/ { in_queue = ($0 ~ /自动化修复队列/) }
    !in_queue { next }
    NF < 7 { next }
    /^\|[[:space:]]*[A-D][0-9]+[[:space:]]*\|/ {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $4)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $5)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $6)
      if ($5 == "todo") print $2 "\t" $4 "\t" $6
    }
  ' "${HLD_PATH:?}"
}

# 在 main（或 origin/main）历史上查找带 [ID] 的提交；若有合入的 PR 编号则打印 PR #n。
hld_find_merge_note() {
  local id="$1"
  local hash subject pr
  hash="$(git log HEAD --grep="\\[${id}\\]" -1 --format='%H' 2>/dev/null || true)"
  [ -n "$hash" ] || return 1
  subject="$(git log -1 --format='%s' "$hash")"
  pr="$(printf '%s\n' "$subject" | grep -oE '#[0-9]+' | head -1 || true)"
  if [ -z "$pr" ]; then
    pr="$(git log HEAD --merges --ancestry-path "${hash}..HEAD" -1 --format='%s' 2>/dev/null | grep -oE '#[0-9]+' | head -1 || true)"
  fi
  if [ -n "$pr" ]; then
    printf 'PR %s' "$pr"
  else
    printf '%s' "$subject"
  fi
}

# 扫描 todo 项：main 上已有 [ID] 提交则回写 done（覆盖人开 PR、审核失败后手工合入等路径）。
hld_sync_merged_from_git() {
  local id level task note marked=0
  [ -f "${HLD_PATH:?}" ] || return 1

  while IFS=$'\t' read -r id level task; do
    [ -n "$id" ] || continue
    note="$(hld_find_merge_note "$id" || true)"
    [ -n "$note" ] || continue
    if hld_writeback_queue_done "$id" "$task" "$note"; then
      echo "📄 已将 $id 标记为 done（$note）"
      marked=$((marked + 1))
    else
      echo "⚠️ 未能回写 $id，请检查第 6 节表格" >&2
    fi
  done < <(hld_list_todo_rows)

  if [ "$marked" -eq 0 ]; then
    echo "📄 队列中没有「todo 且 main 已含 [ID] 提交」的项"
  fi
  return 0
}
