#!/usr/bin/env bash
# 阿里云 ECS 端零编译原子部署脚本（由非 root 账号 deploy 执行，全程无需 sudo）。
# 职责：
#   1. 校验发布产物包路径与 SHA256，防路径遍历与传输损坏；
#   2. 解压至 /opt/bagujing/releases/<release_id>（含前端 dist + 后端生产 node_modules）；
#   3. 校验 ECS 本地 /var/lib/bagujing/.env.production 与 SQLite 数据（绝不覆盖业务数据）；
#   4. 原子切换 /opt/bagujing/current 软链，重启 PM2 单实例（500M 上限）；
#   5. 探活 http://127.0.0.1:3000/api/health，失败自动回滚到上一版本；
#   6. 仅保留最近 3 个历史版本，控制 40GB 磁盘占用。
#
# 用法：
#   /opt/bagujing/incoming/deploy-ecs.sh /opt/bagujing/incoming/release-<id>.tar.gz

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "用法：$0 /opt/bagujing/incoming/release-<id>.tar.gz" >&2
  exit 1
fi

APP_DIR="${BAGUJING_APP_DIR:-/opt/bagujing}"
INCOMING_DIR="${APP_DIR}/incoming"
RELEASES_DIR="${APP_DIR}/releases"
LOGS_DIR="${APP_DIR}/logs"
CURRENT_LINK="${APP_DIR}/current"
DATA_DIR="${BAGUJING_DATA_DIR:-/var/lib/bagujing}"
ENV_FILE="${DATA_DIR}/.env.production"
DB_FILE="${DATA_DIR}/bagujing.sqlite3"
SEED_DIR="${DATA_DIR}/seed"
KEEP_RELEASES="${KEEP_RELEASES:-3}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/api/health}"

# 严格校验发布包路径必须在 incoming 目录内，阻断路径遍历
TARBALL_INPUT="$1"
TARBALL_PATH="$(readlink -f "${TARBALL_INPUT}")"
INCOMING_REAL="$(readlink -f "${INCOMING_DIR}")"
if [[ ! -f "${TARBALL_PATH}" || "${TARBALL_PATH}" != "${INCOMING_REAL}/"* ]]; then
  echo "错误：发布包路径非法或不存在（必须位于 ${INCOMING_REAL}/ 下）：${TARBALL_INPUT}" >&2
  exit 1
fi

TARBALL_NAME="$(basename "${TARBALL_PATH}")"
if [[ ! "${TARBALL_NAME}" =~ ^release-[A-Za-z0-9._-]+\.tar\.gz$ ]]; then
  echo "错误：发布包文件名不符合规范：${TARBALL_NAME}" >&2
  exit 1
fi
RELEASE_ID="${TARBALL_NAME#release-}"
RELEASE_ID="${RELEASE_ID%.tar.gz}"
RELEASE_DIR="${RELEASES_DIR}/${RELEASE_ID}"

# 校验 SHA256（若伴随 .sha256 文件存在）
CHECKSUM_FILE="${TARBALL_PATH}.sha256"
if [[ -f "${CHECKSUM_FILE}" ]]; then
  echo "==> [1/6] 校验发布包 SHA256"
  (cd "${INCOMING_REAL}" && sha256sum -c "$(basename "${CHECKSUM_FILE}")")
fi

# 校验 ECS 本地生产配置（绝不覆盖）
echo "==> [2/6] 校验本地生产环境变量：${ENV_FILE}"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "错误：缺少 ${ENV_FILE}。请先完成 ECS 初始化并填写真实密钥。" >&2
  exit 1
fi
if grep -q 'CHANGE_ME_' "${ENV_FILE}"; then
  echo "错误：${ENV_FILE} 仍包含未替换的 CHANGE_ME_ 占位符，已中止发版。" >&2
  exit 1
fi

echo "==> [3/6] 解压发布产物至 ${RELEASE_DIR}（零编译）"
mkdir -p "${RELEASES_DIR}" "${LOGS_DIR}" "${DATA_DIR}"
rm -rf "${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"
tar --no-same-owner --no-same-permissions -xzf "${TARBALL_PATH}" -C "${RELEASE_DIR}"

if [[ ! -f "${RELEASE_DIR}/frontend/index.html" || ! -f "${RELEASE_DIR}/backend/src/server-express.js" ]]; then
  echo "错误：发布包结构不完整（缺少 frontend/index.html 或 backend/src/server-express.js）。" >&2
  rm -rf "${RELEASE_DIR}"
  exit 1
fi

# 确保 nginx worker 可只读穿透访问前端静态目录
chmod 755 "${RELEASE_DIR}"
chmod -R a+rX "${RELEASE_DIR}/frontend"

# 保护生产 SQLite：仅在库文件不存在且存在 seed ndjson 时首次导入，已有库绝不覆盖
if [[ ! -f "${DB_FILE}" ]]; then
  CATEGORIES="${SEED_DIR}/categories.ndjson"
  PROBLEMS="${SEED_DIR}/problems.ndjson"
  DETAILS="${SEED_DIR}/problem-detail.ndjson"
  if [[ -f "${CATEGORIES}" && -f "${PROBLEMS}" ]]; then
    echo "==> 检测到首次部署且存在 seed，正在导入初始题库至 ${DB_FILE}"
    (
      cd "${RELEASE_DIR}/backend"
      node scripts/import-ndjson-to-sqlite.js --db "${DB_FILE}" --only categories --categories "${CATEGORIES}"
      node scripts/import-ndjson-to-sqlite.js --db "${DB_FILE}" --only problems --problems "${PROBLEMS}"
      if [[ -f "${DETAILS}" ]]; then
        node scripts/import-ndjson-to-sqlite.js --db "${DB_FILE}" --only details --details "${DETAILS}"
      fi
    )
  else
    echo "警告：未发现生产数据库 ${DB_FILE}，服务仍会启动但题库为空。请手动上传 SQLite 库至 ${DB_FILE} 后重启 PM2。"
  fi
else
  echo "==> 保留已有生产数据库：${DB_FILE}"
fi

# 记录切换前的旧版本，用于健康检查失败时自动回滚
PREV_TARGET=""
if [[ -L "${CURRENT_LINK}" ]]; then
  PREV_TARGET="$(readlink -f "${CURRENT_LINK}" || true)"
fi

swap_current_link() {
  local target_dir="$1"
  local tmp_link="${APP_DIR}/.current.tmp.$$"
  ln -sfn "${target_dir}" "${tmp_link}"
  mv -Tf "${tmp_link}" "${CURRENT_LINK}"
}

reload_pm2() {
  cp "${CURRENT_LINK}/deploy/ecosystem.ecs.cjs" "${APP_DIR}/ecosystem.config.cjs"
  if pm2 describe bagujing-be-prod >/dev/null 2>&1; then
    pm2 restart "${APP_DIR}/ecosystem.config.cjs" --env production --update-env
  else
    pm2 start "${APP_DIR}/ecosystem.config.cjs" --env production
  fi
}

echo "==> [4/6] 原子切换版本并重载 PM2（版本：${RELEASE_ID}）"
swap_current_link "${RELEASE_DIR}"
reload_pm2

echo "==> [5/6] 探活检测：${HEALTH_URL}"
HEALTH_OK=0
for i in $(seq 1 20); do
  if RESP="$(curl -fsS --max-time 2 "${HEALTH_URL}" 2>/dev/null)" && echo "${RESP}" | grep -q '"ok":true'; then
    echo "探活成功（第 ${i} 次）：${RESP}"
    HEALTH_OK=1
    break
  fi
  sleep 1
done

if [[ "${HEALTH_OK}" -ne 1 ]]; then
  echo "错误：新版本 ${RELEASE_ID} 探活失败！" >&2
  if [[ -n "${PREV_TARGET}" && -d "${PREV_TARGET}" ]]; then
    echo "==> 正在自动回滚至上一版本：${PREV_TARGET}" >&2
    swap_current_link "${PREV_TARGET}"
    reload_pm2 || true
  fi
  echo "==> 最近后端错误日志：" >&2
  tail -n 40 "${LOGS_DIR}/backend-error.log" 2>/dev/null || true
  exit 1
fi

pm2 save

echo "==> [6/6] 清理过期发布包与历史版本（保留最近 ${KEEP_RELEASES} 个）"
rm -f "${TARBALL_PATH}" "${CHECKSUM_FILE}"
if [[ -d "${RELEASES_DIR}" ]]; then
  CURRENT_REAL="$(readlink -f "${CURRENT_LINK}")"
  mapfile -t OLD_RELEASES < <(ls -1dt "${RELEASES_DIR}"/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) || true)
  for old_dir in "${OLD_RELEASES[@]}"; do
    if [[ -n "${old_dir}" && "${old_dir}" != "${CURRENT_REAL}" ]]; then
      rm -rf "${old_dir}"
    fi
  done
fi

echo "部署成功！当前生效版本：${RELEASE_ID}"
