#!/bin/bash
# 一键部署脚本：deploy.sh
# 请确保当前执行用户对项目目录有写权限，推荐使用非 root 用户 (如 ubuntu/ec2-user)

set -e

# 定位到项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

echo "================================================="
echo "🚀 开始基于 AWS EC2 (t3.small) 的生产环境一键部署"
echo "================================================="

# 0. 创建日志目录
mkdir -p logs

# 1. 更新代码库 (如果是首次克隆请忽略)
# if [ -d ".git" ]; then
#     echo "📦 [1/5] 正在拉取最新的 Git 代码..."
#     git pull || echo "非 Git 管理目录，跳过更新..."
# else
#     echo "📦 [1/5] 不是 Git 仓库，跳过拉取代码。"
# fi

# 2. 构建前端单页应用 (Vue/React)
echo "🏗️ [2/5] 正在安装依赖并构建前端 SPA... (这在 t3.small 上可能需要1-2分钟)"
# cd frontend
# npm install --omit=dev --legacy-peer-deps || npm install --legacy-peer-deps
# npm run build
# cd ..

# 3. 配置后端生产依赖
echo "⚙️ [3/5] 正在安装后端生产环境依赖..."
# cd backend
# npm install --omit=dev  # 仅安装生产环境依赖，加快速度
# cd ..

# 4. 配置 PM2 (守护进程及集群负载)
echo "🔄 [4/5] 准备启动/重启 PM2 集群服务..."
if ! command -v pm2 &> /dev/null; then
    echo "PM2 未全局安装，正在安装 PM2 及其日志插件..."
    sudo npm install -g pm2
    pm2 install pm2-logrotate
fi

# 确保旧的进程被杀掉，防止重复挂载和内存泄漏
echo "正在检查是否存在旧的 bagujing-be-prod 进程..."
if pm2 describe bagujing-be-prod > /dev/null 2>&1; then
    echo "发现旧的 bagujing-be-prod 进程，正在删除..."
    pm2 delete bagujing-be-prod
fi

# 然后启动新的全量实例
echo "启动新的 PM2 进程..."
if [ ! -f "ecosystem.config.cjs" ]; then
    if [ -f "ecosystem.config.example.cjs" ]; then
        echo "❌ 错误: 未找到 ecosystem.config.cjs！"
        echo "💡 请先复制并配置生产环境密钥与参数: cp ecosystem.config.example.cjs ecosystem.config.cjs"
        exit 1
    fi
fi
pm2 start ecosystem.config.cjs --env production

# 保存开机自启状态
pm2 save

echo "📦 [4.5/6] 部署静态资源与证书到规范化的安全系统目录..."
# 1. 部署前端静态文件到 Nginx 标准目录 /var/www (权限最安全，自动归属 www-data)
sudo mkdir -p /var/www/bagujing/frontend
if [ -d "frontend/dist" ]; then
    sudo rm -rf /var/www/bagujing/frontend/*
    sudo cp -r frontend/dist/* /var/www/bagujing/frontend/
    sudo chown -R www-data:www-data /var/www/bagujing/frontend
    sudo chmod -R 755 /var/www/bagujing/frontend
    echo "✅ 前端静态文件成功移交至 /var/www 标准配置"
else
    echo "⚠️ 错误: 找不到被打包好的 frontend/dist 前端资源目录！这通常是因为构建过程中内存不足中断或还未执行过 npm run build。"
fi

# 2. 部署 SSL 证书到标准安全认证目录 /etc/nginx/ssl
sudo mkdir -p /etc/nginx/ssl/bagujing
if [ -f "certs/server.pem" ]; then
    sudo cp certs/server.pem /etc/nginx/ssl/bagujing/
    sudo chown root:root /etc/nginx/ssl/bagujing/server.pem
    sudo chmod 600 /etc/nginx/ssl/bagujing/server.pem
    echo "✅ SSL 证书成功移交至核心安全区 /etc/nginx/ssl"
fi

# 5. 配置并启用 Nginx
echo "🌐 [5/6] 正在链接 Nginx 配置文件..."
if [ -f "deploy/nginx.conf" ]; then
    echo "将标准的 Nginx 配置覆盖到 /etc/nginx/sites-available/bagujing"
    sudo cp deploy/nginx.conf /etc/nginx/sites-available/bagujing
    
    echo "创建 sites-enabled 软链接..."
    sudo ln -sf /etc/nginx/sites-available/bagujing /etc/nginx/sites-enabled/bagujing
    
    echo "测试 Nginx 配置..."
    if sudo nginx -t; then
        echo "重启或启动 Nginx 代理..."
        sudo systemctl reload nginx || sudo systemctl start nginx
    else
        echo "⚠️ Nginx 配置测试失败，跳过 Nginx 重启，请手动检查：sudo nginx -t"
    fi
else
    echo "⚠️ 未找到 deploy/nginx.conf 文件，跳过 Nginx 配置。"
fi

echo "✅ [6/6] 部署完成！"
echo "================================================="
echo "💡 提示："
echo "1. 后端 PM2 集群已在后台运行运行 (端口 3000)。通过 'pm2 logs' 可以查看服务端日志。"
echo "2. 前端 Nginx 代理已经自动配置并重启。"
echo "3. 如果是首次部署，请务必执行以下配置："
echo "   - 执行 'pm2 startup' 并按照其提示命令来设置开机自启动"
echo "   - 在 AWS EC2 控制台中开放 80 / 443 安全组端口"
echo "================================================="
