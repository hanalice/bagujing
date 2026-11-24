#!/usr/bin/env bash
# SQLite 生产库每日热备份脚本（由 deploy 用户经 cron 定时执行，或手动执行）。
# 职责：
#   1. 使用 sqlite3 .backup 在 WAL 模式下进行在线一致热备份（避免直接 cp 导致脏页/损坏）；
#   2. gzip 压缩后校验完整性，权限设为 600；
#   3. 严格滚动保留最近 KEEP_COUNT 份（默认 7 份，约 50MB），避免占满 40GB 磁盘。

set -euo pipefail

DB_FILE="${BAGUJING_DB_FILE:-/var/lib/bagujing/bagujing.sqlite3}"
BACKUP_DIR="${BAGUJING_BACKUP_DIR:-/var/backups/bagujing}"
KEEP_COUNT="${KEEP_COUNT:-7}"

if [[ ! -f "${DB_FILE}" ]]; then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] 跳过备份：数据库文件尚不存在（${DB_FILE}）"
  exit 0
fi

if ! command -v sqlite3 >/dev/null 2>&1 && ! command -v python3 >/dev/null 2>&1; then
  echo "错误：未安装 sqlite3 或 python3，无法执行在线热备份。" >&2
  exit 1
fi

mkdir -p "${BACKUP_DIR}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
TMP_DB="${BACKUP_DIR}/.bagujing-${STAMP}.sqlite3.tmp"
TMP_GZ="${BACKUP_DIR}/.bagujing-${STAMP}.sqlite3.gz.tmp"
FINAL_GZ="${BACKUP_DIR}/bagujing-${STAMP}.sqlite3.gz"

trap 'rm -f "${TMP_DB}" "${TMP_GZ}"' EXIT

umask 077
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${DB_FILE}" ".timeout 5000" ".backup '${TMP_DB}'"
else
  python3 - "${DB_FILE}" "${TMP_DB}" <<'PYEOF'
import sqlite3, sys
src_path, dst_path = sys.argv[1], sys.argv[2]
with sqlite3.connect(src_path, timeout=5.0) as src, sqlite3.connect(dst_path) as dst:
    src.backup(dst)
PYEOF
fi
gzip -9 -c "${TMP_DB}" > "${TMP_GZ}"
gzip -t "${TMP_GZ}"
chmod 600 "${TMP_GZ}"
mv -f "${TMP_GZ}" "${FINAL_GZ}"
rm -f "${TMP_DB}"

# 严格滚动清理：仅保留最新的 KEEP_COUNT 份
mapfile -t OLD_BACKUPS < <(ls -1t "${BACKUP_DIR}"/bagujing-*.sqlite3.gz 2>/dev/null | tail -n +$((KEEP_COUNT + 1)) || true)
for old_file in "${OLD_BACKUPS[@]}"; do
  if [[ -n "${old_file}" && -f "${old_file}" ]]; then
    rm -f "${old_file}"
  fi
done

SIZE="$(du -h "${FINAL_GZ}" | cut -f1)"
TOTAL="$(ls -1 "${BACKUP_DIR}"/bagujing-*.sqlite3.gz 2>/dev/null | wc -l | tr -d ' ')"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] 备份完成：${FINAL_GZ} (${SIZE})，当前保留 ${TOTAL}/${KEEP_COUNT} 份"
