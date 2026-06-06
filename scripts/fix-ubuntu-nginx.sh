#!/bin/bash
# Nginx 端口冲突及状态修复脚本 (在 AWS EC2 上执行)
# 请将此脚本内容复制到 EC2 上运行，或者在 EC2 上逐行执行。

set -e

echo "=========================================="
echo "🧹 开始修复 Ubuntu Nginx 端口冲突与宕机问题"
echo "=========================================="

# 1. 检查并清理 Apache2 (Ubuntu 默认可能会预装 Apache 占用 80 端口)
echo "🔍 [1/4] 检查 Apache2 是否在运行并占用 80 端口..."
if systemctl is-active --quiet apache2; then
    echo "⚠️ 发现 apache2 正在运行，准备停止并禁用..."
    sudo systemctl stop apache2
    sudo systemctl disable apache2
    echo "✅ apache2 已彻底禁用。"
else
    echo "✅ 没有发现活动的 apache2 服务。"
fi

# 2. 强杀所有占用 80 端口的未知进程
echo "🔍 [2/4] 检查 80 端口的残留僵尸进程..."
# 获取占用 80 端口的 PID (排除可能的合法 Nginx，但在修复期我们全杀)
PORT_80_PIDS=$(sudo lsof -t -i:80 || true)
if [ ! -z "$PORT_80_PIDS" ]; then
    echo "⚠️ 发现 PID占用 80 端口: $PORT_80_PIDS ，准备强制结束..."
    sudo kill -9 $PORT_80_PIDS || true
    echo "✅ 已清理占用 80 端口的进程。"
else
    echo "✅ 80 端口当前空闲。"
fi

# 3. 强杀可能卡死的残留 Nginx 工作进程
echo "🔍 [3/4] 清理残留的 Nginx 僵尸进程..."
sudo killall -9 nginx 2>/dev/null || true

# 4. 重新启动 Nginx
echo "🚀 [4/4] 正在重新启动 Nginx..."
# 先重置处于 failed 状态的服务计数器
sudo systemctl reset-failed nginx
# 重新启动
sudo systemctl start nginx

echo "=========================================="
echo "🎯 修复完成！当前的 Nginx 状态如下："
sudo systemctl status nginx --no-pager | head -n 10
echo "=========================================="
echo "💡 如果上面显示 'Active: active (running)'，说明修复成功！"
echo "您可以再次执行项目里的 ./scripts/deploy.sh 进行部署。"
