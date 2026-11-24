#!/usr/bin/env bash
# 阿里云 ECS（Alibaba Cloud Linux 3.2104 LTS 64位 / 2核2G）首次初始化脚本。
# 职责：
#   1. 配置 2GB Swap 保护 2C2G 内存；
#   2. 通过 dnf 安装 Nginx / SQLite / 定时任务等基础运行组件（ECS 零编译，不装编译工具链）；
#   3. 安装并 SHA256 校验 Node.js 22 LTS 与 PM2（含 pm2-logrotate 防 40GB 磁盘写满）；
#   4. 创建无 sudo 权限的专用部署账号 deploy 及最小权限目录结构；
#   5. 生成 /var/lib/bagujing/.env.production 模板（已存在则不覆盖）；
#   6. 配置每日 SQLite 压缩热备份定时任务（保留最近 7 份）；
#   7. 安装多子域名隔离 Nginx 模板与 PM2 开机自启。
#
# 用法（需 root 权限执行一次，可安全重复执行）：
#   sudo bash scripts/ecs-bootstrap.sh

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 权限执行：sudo bash scripts/ecs-bootstrap.sh" >&2
  exit 1
fi

if ! command -v dnf >/dev/null 2>&1; then
  echo "错误：未检测到 dnf，本脚本面向 Alibaba Cloud Linux 3 / RHEL 8+ 发行版。" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEPLOY_USER="${DEPLOY_USER:-deploy}"
DOMAIN="${DOMAIN:-devask.hanalice.net}"
APP_DIR="/opt/bagujing"
DATA_DIR="/var/lib/bagujing"
BACKUP_DIR="/var/backups/bagujing"
SSL_DIR="/etc/nginx/ssl/${DOMAIN}"
NODE_VERSION="${NODE_VERSION:-22.14.0}"
SWAP_SIZE_MB="${SWAP_SIZE_MB:-2048}"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

# 严格校验域名与用户名格式，避免路径遍历或命令注入
if [[ ! "${DOMAIN}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "错误：DOMAIN 格式非法：${DOMAIN}" >&2
  exit 1
fi
if [[ ! "${DEPLOY_USER}" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]]; then
  echo "错误：DEPLOY_USER 格式非法：${DEPLOY_USER}" >&2
  exit 1
fi

echo "==> [1/8] 检查并配置 ${SWAP_SIZE_MB}MB Swap（2C2G 内存防 OOM）"
if [[ -z "$(swapon --show --noheadings)" ]]; then
  if [[ ! -f /swapfile ]]; then
    dd if=/dev/zero of=/swapfile bs=1M count="${SWAP_SIZE_MB}" status=progress
    chmod 600 /swapfile
    mkswap /swapfile
  fi
  swapon /swapfile
  if ! grep -q '^/swapfile ' /etc/fstab; then
    echo '/swapfile none swap sw 0 0' >> /etc/fstab
  fi
  sysctl -w vm.swappiness=10 >/dev/null
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-bagujing-swap.conf
  echo "Swap 已启用：$(free -h | awk '/Swap:/ {print $2}')"
else
  echo "已存在 Swap，跳过创建。"
fi

echo "==> [2/8] 安装基础运行依赖（dnf，不装编译工具链）"
dnf install -y nginx sqlite tar gzip xz curl ca-certificates cronie logrotate openssl

echo "==> [3/8] 安装 Node.js v${NODE_VERSION}（含 SHA256 校验）"
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE '^v22\.'; then
  ARCH="$(uname -m)"
  if [[ "${ARCH}" != "x86_64" ]]; then
    echo "错误：当前架构为 ${ARCH}，本脚本仅适配 x86_64（64位）ECS。" >&2
    exit 1
  fi
  NODE_TAR="node-v${NODE_VERSION}-linux-x64.tar.xz"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR}"' EXIT

  MIRROR_BASE="https://npmmirror.com/mirrors/node/v${NODE_VERSION}"
  OFFICIAL_BASE="https://nodejs.org/dist/v${NODE_VERSION}"

  if ! curl -fsSL "${MIRROR_BASE}/${NODE_TAR}" -o "${TMP_DIR}/${NODE_TAR}"; then
    echo "国内镜像拉取失败，回退至官方源..."
    curl -fsSL "${OFFICIAL_BASE}/${NODE_TAR}" -o "${TMP_DIR}/${NODE_TAR}"
  fi
  if ! curl -fsSL "${OFFICIAL_BASE}/SHASUMS256.txt" -o "${TMP_DIR}/SHASUMS256.txt"; then
    curl -fsSL "${MIRROR_BASE}/SHASUMS256.txt" -o "${TMP_DIR}/SHASUMS256.txt"
  fi

  (cd "${TMP_DIR}" && grep " ${NODE_TAR}\$" SHASUMS256.txt | sha256sum -c -)
  rm -rf "/usr/local/node-v${NODE_VERSION}"
  tar -xJf "${TMP_DIR}/${NODE_TAR}" -C /usr/local
  mv "/usr/local/node-v${NODE_VERSION}-linux-x64" "/usr/local/node-v${NODE_VERSION}"
  ln -sfn "/usr/local/node-v${NODE_VERSION}/bin/node" /usr/local/bin/node
  ln -sfn "/usr/local/node-v${NODE_VERSION}/bin/npm" /usr/local/bin/npm
  ln -sfn "/usr/local/node-v${NODE_VERSION}/bin/npx" /usr/local/bin/npx
fi
echo "Node 版本：$(node -v) / npm 版本：$(npm -v)"

echo "==> [4/8] 安装 PM2"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 --registry="${NPM_REGISTRY}"
  ln -sfn "/usr/local/node-v${NODE_VERSION}/bin/pm2" /usr/local/bin/pm2 2>/dev/null || true
fi

echo "==> [5/8] 创建非 root 部署账号 ${DEPLOY_USER}（无 sudo 权限）与目录结构"
if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "${DEPLOY_USER}"
fi
DEPLOY_HOME="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"
install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh"
touch "${DEPLOY_HOME}/.ssh/authorized_keys"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${DEPLOY_HOME}/.ssh/authorized_keys"
chmod 600 "${DEPLOY_HOME}/.ssh/authorized_keys"

# /opt/bagujing 保持 755 以便 nginx worker 穿透读取 /opt/bagujing/current/frontend
install -d -m 755 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
  "${APP_DIR}" "${APP_DIR}/releases" "${APP_DIR}/logs" "${APP_DIR}/incoming" "${APP_DIR}/bin"
install -d -m 750 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" \
  "${DATA_DIR}" "${DATA_DIR}/seed" "${BACKUP_DIR}"
install -d -m 700 -o root -g root "/etc/nginx/ssl" "${SSL_DIR}"

ENV_FILE="${DATA_DIR}/.env.production"
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "==> 生成初始环境变量模板：${ENV_FILE}（请务必替换为真实强密钥）"
  umask 077
  cat > "${ENV_FILE}" <<EOF
# DevAsk 生产环境变量（ECS 本地维护，不随发版覆盖）
# 填写完成后请确保所有 CHANGE_ME_* 占位符均已替换！
PORT=3000
ENABLE_SQLITE=true
SQLITE_DB=${DATA_DIR}/bagujing.sqlite3

# 必填：请用 openssl rand -hex 32 分别生成
JWT_SECRET=CHANGE_ME_JWT_SECRET
AI_JWT_SECRET=CHANGE_ME_AI_JWT_SECRET

# 必填：国内 ECS 请使用可直连的 OpenAI 兼容服务（如 DeepSeek）
OPENAI_API_KEY=CHANGE_ME_OPENAI_API_KEY
OPENAI_BASE_URL=https://api.deepseek.com
OPENAI_MODEL=deepseek-chat
OPENAI_CHAT_MODEL=
OPENAI_GENERATION_MODEL=

# AI 安全网关（AI_CLIENT_CREDENTIALS 中的密钥须与 GitHub Secret VITE_AI_CLIENT_SECRET 一致）
AI_GUARD_ENABLED=true
AI_REQUIRE_SIGNED_HEADERS=true
AI_DEFAULT_CLIENT_ID=web
AI_ALLOWED_ORIGINS=https://${DOMAIN}
AI_CLIENT_CREDENTIALS=web:CHANGE_ME_CLIENT_SECRET
AI_AUDIT_FILE_PATH=${DATA_DIR}/ai-audit.ndjson

# 可选：内部监控指标鉴权令牌（Nginx 已默认限制仅本机访问 /api/metrics）
AI_METRICS_TOKEN=CHANGE_ME_METRICS_TOKEN
EOF
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
else
  echo "保留已有生产配置：${ENV_FILE}"
fi

echo "==> [6/8] 安装每日 SQLite 压缩备份脚本与定时任务（凌晨 03:00，保留 7 份）"
if [[ -f "${PROJECT_ROOT}/scripts/backup-sqlite.sh" ]]; then
  cp "${PROJECT_ROOT}/scripts/backup-sqlite.sh" "${APP_DIR}/bin/backup-sqlite.sh"
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${APP_DIR}/bin/backup-sqlite.sh"
  chmod 750 "${APP_DIR}/bin/backup-sqlite.sh"
  cat > /etc/cron.d/bagujing-sqlite-backup <<EOF
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 3 * * * ${DEPLOY_USER} ${APP_DIR}/bin/backup-sqlite.sh >> ${APP_DIR}/logs/backup.log 2>&1
EOF
  chmod 644 /etc/cron.d/bagujing-sqlite-backup
  systemctl enable --now crond
fi

echo "==> [7/8] 配置 Nginx 多子域名站点（Alibaba Cloud Linux 3 /etc/nginx/conf.d/）"
if [[ -f "${PROJECT_ROOT}/deploy/nginx-default-reject.conf" && ! -f /etc/nginx/conf.d/00-default-reject.conf ]]; then
  cp "${PROJECT_ROOT}/deploy/nginx-default-reject.conf" /etc/nginx/conf.d/00-default-reject.conf
fi
if [[ -f "${PROJECT_ROOT}/deploy/nginx-ecs.conf" ]]; then
  if [[ -f "${SSL_DIR}/fullchain.pem" && -f "${SSL_DIR}/privkey.key" ]]; then
    cp "${PROJECT_ROOT}/deploy/nginx-ecs.conf" /etc/nginx/conf.d/devask.conf
    rm -f /etc/nginx/conf.d/devask.conf.pending
    echo "检测到已有 SSL 证书，已激活 /etc/nginx/conf.d/devask.conf"
  else
    cp "${PROJECT_ROOT}/deploy/nginx-ecs.conf" /etc/nginx/conf.d/devask.conf.pending
    echo "尚未上传 SSL 证书，配置已暂存为 /etc/nginx/conf.d/devask.conf.pending；执行 scripts/update-ssl-cert.sh 后将自动激活。"
  fi
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx

echo "==> [8/8] 配置 ${DEPLOY_USER} 的 PM2 日志轮转与开机自启"
su - "${DEPLOY_USER}" -c "pm2 install pm2-logrotate && pm2 set pm2-logrotate:max_size 20M && pm2 set pm2-logrotate:retain 7 && pm2 set pm2-logrotate:compress true" || true
STARTUP_CMD="$(env PATH="$PATH:/usr/local/bin" pm2 startup systemd -u "${DEPLOY_USER}" --hp "${DEPLOY_HOME}" | grep -E '^\s*(sudo\s+)?env\s+' | tail -n 1 || true)"
if [[ -n "${STARTUP_CMD}" ]]; then
  bash -c "${STARTUP_CMD}" || true
fi

if command -v getenforce >/dev/null 2>&1 && [[ "$(getenforce)" == "Enforcing" ]]; then
  echo "注意：当前 SELinux 为 Enforcing，如 Nginx 报 502/403 请执行：setsebool -P httpd_can_network_connect 1"
fi

echo
echo "================================================================="
echo "ECS 初始化完成！接下来按顺序完成 4 步即可一键发版："
echo "  1. 将 GitHub Actions 部署公钥写入：${DEPLOY_HOME}/.ssh/authorized_keys"
echo "  2. 编辑生产配置并替换全部 CHANGE_ME_*：${ENV_FILE}"
echo "  3. 手动上传初始 SQLite 题库至：${DATA_DIR}/bagujing.sqlite3（属主设为 ${DEPLOY_USER}）"
echo "  4. 备案通过后上传阿里云免费单域名证书并执行："
echo "     sudo bash scripts/update-ssl-cert.sh <cert.pem> <privkey.key> ${DOMAIN}"
echo "================================================================="
