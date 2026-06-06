#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_NAME="bagujing-be-prod"

cd "$PROJECT_ROOT"

echo "🔄 Restarting PM2 app: ${APP_NAME}"
if ! command -v pm2 >/dev/null 2>&1; then
  echo "❌ pm2 not found. Please install pm2 first."
  exit 1
fi

if pm2 describe "${APP_NAME}" >/dev/null 2>&1; then
  pm2 restart "${APP_NAME}" --update-env
else
  pm2 start ecosystem.config.cjs --env production
fi

pm2 save || true

echo "🌐 Restarting nginx..."
if command -v nginx >/dev/null 2>&1; then
  if sudo nginx -t; then
    sudo systemctl restart nginx
  else
    echo "❌ nginx config test failed"
    exit 1
  fi
else
  echo "❌ nginx not found"
  exit 1
fi

echo "✅ Restart completed"
