#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: setup-dev.sh
# 脚本作用: 全栈开发环境一键初始化脚本（配置 Git Hooks、安装前后端依赖及测试浏览器）
# 使用方式: ./scripts/setup-dev.sh
# ==============================================================================

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "========================================================"
echo "🚀 [Dev Init] 开始初始化职问 AI 全栈开发环境..."
echo "========================================================"

# 1. 配置 Git Hooks
echo -n "🔧 [1/4] 配置 Git Hooks 路径与可执行权限... "
git config core.hooksPath .githooks
chmod +x "$PROJECT_ROOT/.githooks/"* 2>/dev/null || true
echo "✅ 完成 (hooksPath -> .githooks)"

# 2. 安装后端依赖
echo "📦 [2/4] 安装后端依赖 (backend)..."
(cd "$PROJECT_ROOT/backend" && npm install)
echo "✅ 后端依赖就绪"

# 3. 安装前端依赖与 Playwright 浏览器
echo "🎨 [3/4] 安装前端依赖及 Playwright 浏览器 (frontend)..."
(cd "$PROJECT_ROOT/frontend" && npm install && npx playwright install chromium)
echo "✅ 前端依赖与测试浏览器就绪"

# 4. 验证质量门禁脚本可用性
echo -n "🧪 [4/4] 验证 QA 门禁流水线脚本权限... "
chmod +x "$PROJECT_ROOT/scripts/qa-report.sh"
echo "✅ 完成"

echo "========================================================"
echo "🎉 全栈开发环境初始化完毕！"
echo "👉 启动开发服务: npm run dev (分别在 backend/frontend 运行)"
echo "👉 运行全栈测试: ./scripts/qa-report.sh"
echo "========================================================"
