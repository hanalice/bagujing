#!/usr/bin/env bash
# ==============================================================================
# 脚本名称: qa-report.sh
# 脚本作用: 全栈测试一键聚合执行并生成固定格式的 docs/qa_report.md 质量报告
# 使用方式: ./scripts/qa-report.sh
# ==============================================================================

set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

TEMP_DIR="$(mktemp -d /tmp/qa-report-XXXXXX)"
TEMP_JSON="$TEMP_DIR/results.json"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

echo "========================================================"
echo "🧪 [QA Automation] 开始执行全栈测试套件与质量校验..."
echo "========================================================"

# 1. 运行后端核心单测
echo -n "⚙️ [1/3] 正在运行后端单元测试 (backend npm test)... "
BE_OUT_FILE="$TEMP_DIR/be_out.txt"
set +e
(cd "$PROJECT_ROOT/backend" && npm test) > "$BE_OUT_FILE" 2>&1
BE_CODE=$?
set -e

if [ $BE_CODE -eq 0 ]; then
  echo "✅ PASS"
else
  echo "❌ FAIL (退出码: $BE_CODE)"
fi

# 2. 运行前端单元测试
echo -n "🎨 [2/3] 正在运行前端单元测试 (frontend npm test)... "
FE_OUT_FILE="$TEMP_DIR/fe_out.txt"
set +e
(cd "$PROJECT_ROOT/frontend" && npm test) > "$FE_OUT_FILE" 2>&1
FE_CODE=$?
set -e

if [ $FE_CODE -eq 0 ]; then
  echo "✅ PASS"
else
  # 如果仅是因为 vitest 未安装，给出友好提示
  if grep -q "vitest: not found" "$FE_OUT_FILE"; then
    echo "⚪ SKIPPED (Vitest 未安装)"
  else
    echo "❌ FAIL (退出码: $FE_CODE)"
  fi
fi

# 3. 运行数据库完整性校验
echo -n "🗄️ [3/3] 正在运行 SQLite 数据库完整性排查... "
DB_OUT_FILE="$TEMP_DIR/db_out.txt"
set +e
(cd "$PROJECT_ROOT/backend" && node scripts/verify-db.js) > "$DB_OUT_FILE" 2>&1
DB_CODE=$?
set -e

if [ $DB_CODE -eq 0 ]; then
  echo "✅ PASS"
else
  echo "❌ FAIL (退出码: $DB_CODE)"
fi

# 4. 组装临时 JSON 数据并调用生成器
node -e "
const fs = require('fs');
const payload = {
  backendCode: $BE_CODE,
  backendOutput: fs.readFileSync('$BE_OUT_FILE', 'utf8'),
  frontendCode: $FE_CODE,
  frontendOutput: fs.readFileSync('$FE_OUT_FILE', 'utf8'),
  dbCode: $DB_CODE,
  dbOutput: fs.readFileSync('$DB_OUT_FILE', 'utf8'),
};
fs.writeFileSync('$TEMP_JSON', JSON.stringify(payload));
"

# 5. 调用格式化解析器生成 docs/qa_report.md
node "$PROJECT_ROOT/scripts/format-qa-report.js" "$TEMP_JSON"

echo "========================================================"
echo "🎉 全栈 QA 测试流程执行完毕！"
echo "========================================================"
