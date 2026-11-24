#!/usr/bin/env bash
# 阿里云免费单域名 SSL 证书更新脚本（每 3 个月手动换证时由 root 执行）。
# 职责：
#   1. 严格校验域名格式、证书与私钥配对关系，避免不匹配导致 Nginx 启动失败；
#   2. 自动备份旧证书并安装新证书至 /etc/nginx/ssl/<domain>/{fullchain.pem,privkey.key}；
#   3. 首次换证时自动将 /etc/nginx/conf.d/devask.conf.pending 激活为 devask.conf；
#   4. 执行 nginx -t，失败自动回滚旧证书；通过后平滑 reload 并打印新证书到期时间。
#
# 用法：
#   sudo bash scripts/update-ssl-cert.sh <cert.pem> <privkey.key> [domain]
# 示例：
#   sudo bash scripts/update-ssl-cert.sh ./devask.hanalice.net.pem ./devask.hanalice.net.key
#   sudo bash scripts/update-ssl-cert.sh ./app2.pem ./app2.key app2.hanalice.net

set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "请使用 root 权限执行：sudo bash $0 <cert.pem> <privkey.key> [domain]" >&2
  exit 1
fi

if [[ $# -lt 2 || $# -gt 3 ]]; then
  echo "用法：sudo bash $0 <cert.pem> <privkey.key> [domain]" >&2
  exit 1
fi

CERT_SRC="$1"
KEY_SRC="$2"
DOMAIN="${3:-devask.hanalice.net}"

if [[ ! "${DOMAIN}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "错误：域名格式非法：${DOMAIN}" >&2
  exit 1
fi

if [[ ! -f "${CERT_SRC}" || ! -f "${KEY_SRC}" ]]; then
  echo "错误：证书或私钥文件不存在。" >&2
  exit 1
fi

echo "==> [1/4] 校验 SSL 证书与私钥合法性及配对关系"
openssl x509 -in "${CERT_SRC}" -noout >/dev/null
openssl pkey -in "${KEY_SRC}" -noout >/dev/null

CERT_PUB_HASH="$(openssl x509 -in "${CERT_SRC}" -pubkey -noout | openssl pkey -pubin -outform pem | openssl sha256)"
KEY_PUB_HASH="$(openssl pkey -in "${KEY_SRC}" -pubout -outform pem | openssl sha256)"
if [[ "${CERT_PUB_HASH}" != "${KEY_PUB_HASH}" ]]; then
  echo "错误：证书与私钥不匹配，已中止更新。" >&2
  exit 1
fi

SSL_DIR="/etc/nginx/ssl/${DOMAIN}"
CERT_DST="${SSL_DIR}/fullchain.pem"
KEY_DST="${SSL_DIR}/privkey.key"
BACKUP_DIR=""

mkdir -p "${SSL_DIR}"
chmod 700 "${SSL_DIR}"

if [[ -f "${CERT_DST}" && -f "${KEY_DST}" ]]; then
  BACKUP_DIR="${SSL_DIR}/backup-$(date -u +%Y%m%d%H%M%S)"
  echo "==> [2/4] 备份当前证书至 ${BACKUP_DIR}"
  mkdir -p "${BACKUP_DIR}"
  chmod 700 "${BACKUP_DIR}"
  cp -a "${CERT_DST}" "${KEY_DST}" "${BACKUP_DIR}/"
else
  echo "==> [2/4] 首次安装 ${DOMAIN} 证书"
fi

echo "==> [3/4] 写入新证书并设置最小权限"
install -m 644 -o root -g root "${CERT_SRC}" "${CERT_DST}"
install -m 600 -o root -g root "${KEY_SRC}" "${KEY_DST}"

ACTIVATED_PENDING=0
if [[ "${DOMAIN}" == "devask.hanalice.net" && -f /etc/nginx/conf.d/devask.conf.pending && ! -f /etc/nginx/conf.d/devask.conf ]]; then
  mv /etc/nginx/conf.d/devask.conf.pending /etc/nginx/conf.d/devask.conf
  ACTIVATED_PENDING=1
fi

echo "==> [4/4] 校验并热重载 Nginx"
if ! nginx -t; then
  echo "错误：nginx -t 校验失败，正在回滚！" >&2
  if [[ -n "${BACKUP_DIR}" ]]; then
    cp -a "${BACKUP_DIR}/fullchain.pem" "${CERT_DST}"
    cp -a "${BACKUP_DIR}/privkey.key" "${KEY_DST}"
  fi
  if [[ "${ACTIVATED_PENDING}" -eq 1 ]]; then
    mv /etc/nginx/conf.d/devask.conf /etc/nginx/conf.d/devask.conf.pending
  fi
  exit 1
fi

systemctl reload nginx || systemctl start nginx

echo
echo "证书更新成功！新证书信息如下（建议在日历设置 80 天后续期提醒）："
openssl x509 -in "${CERT_DST}" -noout -subject -issuer -dates
