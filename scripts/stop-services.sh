#!/bin/bash
set -euo pipefail

APP_NAME="bagujing-be-prod"

echo "🛑 Stopping nginx..."
sudo systemctl stop nginx

echo "🛑 Stopping PM2 app: ${APP_NAME}"
if command -v pm2 >/dev/null 2>&1; then
  pm2 stop "${APP_NAME}" || true
  pm2 delete "${APP_NAME}" || true
  pm2 save || true
else
  echo "⚠️ pm2 not found, skipped"
fi

echo "✅ Stop completed"
