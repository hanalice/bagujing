# DevAsk (职问AI)

> 面试题库驱动的 AI 智能问答与练习平台。包含后端 API 服务（`bagujing-be`，Node.js + Express + SQLite）与前端单页应用（`bagujing-fe`，Vue 3 + Vite + TypeScript）。

---

## 目录

- [✨ 核心特性](#-核心特性)
- [🛠️ 技术栈与环境要求](#️-技术栈与环境要求)
- [📁 项目架构与目录结构](#-项目架构与目录结构)
- [🚀 快速开始（本地开发）](#-快速开始本地开发)
- [🧪 测试与质量校验](#-测试与质量校验)
- [🌐 生产部署与运维](#-生产部署与运维)
  - [1. AWS EC2 + Nginx 一键部署](#1-aws-ec2--nginx-一键部署)
  - [2. PM2 进程集群与常用命令](#2-pm2-进程集群与常用命令)
  - [3. 前端静态服务器配置参考](#3-前端静态服务器配置参考)
- [🛡️ AI 安全防护说明](#️-ai-安全防护说明)
- [📄 开源协议与声明](#-开源协议与声明)

---

## ✨ 核心特性

- 📚 **分类题库与精准检索**：基于本地轻量化 SQLite 存储，支持按技术栈、分类、高频标签与公司维度检索面试真题。
- 🤖 **AI 助教与智能解析**：兼容 OpenAI / DeepSeek 等大模型标准接口，提供低延迟 Server-Sent Events (SSE) 流式回答与答题评估。
- 🛡️ **工业级 AI 网关防护**：内置签名鉴权（HMAC-SHA256）、时钟偏差与 Nonce 防重放校验、多维速率限制（Client/IP）、日配额熔断及请求审计日志。
- 📊 **全链路监控与可观测性**：前端集成 Sentry 运行时报错捕获、慢 API 自动告警与分布式全链路追踪（Trace Propagation）。
- 🚀 **针对低配置主机深度调优**：适配 AWS EC2 (t3.small 2C2G) 等低资源实例，采用 PM2 Cluster 负载均衡与 Nginx 动静分离。

---

## 🛠️ 技术栈与环境要求

### 前置环境要求 (Prerequisites)

- **Node.js**：`^18.18.0` 或 `>=20.0.0`（推荐 LTS 版本，需支持原生 ESM 与 `crypto`）
- **包管理器**：`npm` (`>= 9.0.0`) 或 `pnpm`
- **OpenSSL**：用于生成本地自签名 HTTPS 证书
- **Redis** *(可选)*：若启用分布式速率限制与会话缓存，需提供 Redis 6.0+

### 技术选型一览

| 模块 | 核心技术 | 说明 |
| :--- | :--- | :--- |
| **前端 (Frontend)** | Vue 3 + Vite 7 + TypeScript + Pinia | 单页应用 (SPA)，采用 UnoCSS 原子化样式 |
| **后端 (Backend)** | Node.js + Express 5 + SQLite3 + LangChain | RESTful API 服务，支持 SSE 流式传输 |
| **安全网关** | 自研 AI Guard 中间件 | HMAC 签名校验、时钟容差防重放、动态配额 |
| **进程守护** | PM2 (Cluster Mode) | 实例数动态调度、600MB/实例内存水位保护 |
| **反向代理** | Nginx + 自研静态文件服务器 | HTTPS 终止、Gzip/Brotli 预压缩、SPA 路由回退 |
| **监控上报** | Sentry (Vue & Browser Tracing) | 错误收集、慢请求告警与链路追踪 |

---

## 📁 项目架构与目录结构

```
bagujing/
├── backend/                  # 后端服务源码
│   ├── src/
│   │   ├── db/               # 数据库访问层 (DAO/Repository 代码)
│   │   ├── security/         # AI 防护网关 (签名鉴权、防重放、限流、审计)
│   │   ├── llm.js            # 大模型上游连接适配器
│   │   └── server-express.js # Express 主入口服务
│   ├── db/                   # SQLite 数据库持久化存储目录 (.gitignore 忽略)
│   ├── data/                 # 离线数据与审计日志存储
│   ├── scripts/              # 数据库迁移与 QA 联调脚本
│   ├── .env.example          # 后端全量环境变量配置模板 (带详细注释)
│   └── package.json
├── frontend/                 # 前端应用源码
│   ├── src/
│   │   ├── components/       # 通用 UI 组件
│   │   ├── views/            # 路由页面 (题库列表、AI 助教、设置等)
│   │   ├── monitoring/       # Sentry 性能与全链路追踪集成
│   │   └── utils/            # 网络请求与 HMAC 签名生成器
│   ├── .env.example          # 前端环境变量配置模板
│   └── package.json
├── scripts/                  # 部署与运维脚本
│   ├── deploy.sh             # AWS EC2 / Linux 生产环境一键部署脚本
│   ├── static-server.js      # 定制化静态文件服务器 (支持反向代理与 CSP)
│   ├── restart-services.sh   # 服务安全重启脚本
│   ├── stop-services.sh      # 优雅停机脚本
│   └── generate-certs.sh     # 本地开发自签名 SSL/TLS 证书生成
├── deploy/
│   └── nginx.conf            # Nginx 生产环境推荐配置模板
├── docs/                     # 架构与安全设计文档
│   ├── security-ai-guard.md  # AI 网关安全防护专项设计
│   └── why-custom-static-server.md # 自研静态服务器选型与设计考量
└── ecosystem.config.example.cjs  # PM2 进程集群管理模板
```

> ⚠️ **重要配置规范**：为了保证代码与私密信息安全，本项目所有包含数据密钥、API Key、环境参数的文件均采用 `.example` 模板方案（实际配置文件已被 `.gitignore` 忽略，不会提交至仓库）。**在本地运行或生产部署前，必须基于各模板 copy 一份并修改为您自己的实际配置与密钥。**

---

## 🚀 快速开始（本地开发）

### 第一步：拷贝配置文件

本项目遵循**单一数据源 (SSOT)** 设计原则：**所有业务密钥与参数统一由 `.env` 文件管理，PM2 仅维护进程生命周期与日志策略。**

```bash
# 1. PM2 进程配置 (根目录下，通常无需改动参数)
cp ecosystem.config.example.cjs ecosystem.config.cjs

# 2. 后端业务环境配置 (必须配置大模型 Key 与客户端凭证)
cp backend/.env.example backend/.env

# 3. 前端本地开发环境配置
cp frontend/.env.example frontend/.env.local
```

- **后端 `.env`**：填入大模型 API Key（`OPENAI_API_KEY`）、客户端认证凭证（`AI_CLIENT_CREDENTIALS`）等。
- **前端 `.env.local`**：填入 AI 签名密钥（`VITE_AI_CLIENT_SECRET`），需与后端的凭证保持一致。

### 第二步：生成本地 SSL 证书

本地静态服务器与安全通信需要自签名证书文件（`certs/server.pem`）：

```bash
./scripts/generate-certs.sh
```
*运行后会自动生成 `certs/server.pem`（已在 `.gitignore` 中忽略）。*

### 第三步：安装依赖与启动开发

#### 方式 A：前后端分别独立启动（推荐，支持热更新）

```bash
# 终端 1：启动后端 API 服务 (监听 3000 端口)
cd backend
npm install
npm run serve:express

# 终端 2：启动前端 Vite 开发服务器 (支持热重载，自动代理 /api 至后端)
cd frontend
npm install
npm run dev
```
打开浏览器访问控制台输出的地址（通常为 `http://localhost:5173`）。

#### 方式 B：使用 PM2 完整集群启动（模拟生产环境）

```bash
# 安装两端依赖
cd backend && npm install && cd ../frontend && npm install && cd ..

# 构建前端
cd frontend && npm run build && cd ..

# 启动 PM2 守护集群，仅仅启动后端环境
pm2 start ecosystem.config.cjs

# 启动前端static server， serve 前端产物
PM2_SERVE_PATH=./frontend/dist \
PM2_SERVE_PORT=8080 \
PM2_SERVE_SPA=true \
STATIC_API_PROXY_ENABLED=true \
STATIC_API_PROXY_TARGET=http://127.0.0.1:3000 \
node scripts/static-server.js
```

---

## 🧪 测试与质量校验

```bash
# 1. 运行后端单测
cd backend
npm run test

# 2. 运行 AI 安全防护网关自动化端到端测试 (验证签名、限流、防重放拦截)
node backend/scripts/qa-verify.js

# 3. 前端类型检查与代码规范检查
cd frontend
npm run type-check
npm run lint
```

---

## 🌐 生产部署与运维

### 1. AWS EC2 + Nginx 一键部署

#### 一键部署脚本

项目提供了开箱即用的自动化部署脚本：

```bash
./scripts/deploy.sh
```

该脚本将自动执行：
1. 检查并全局安装 PM2 及其日志轮转插件（`pm2-logrotate`）
2. 构建前端静态产物并发布至标准目录 `/var/www/bagujing/frontend`
3. 检查安全证书并分发至系统标准安全目录 `/etc/nginx/ssl/bagujing/`
4. 校验并重启 PM2 Node.js 后端集群
5. 自动配置、测试并重载 Nginx 动静反向代理

#### 生产环境配置清单

在生产部署前，请确保已创建并配置好生产环境变量文件：

```bash
# 后端生产环境配置
cp backend/.env.example backend/.env

# 前端生产构建配置
cp frontend/.env.example frontend/.env.production
```

**生产环境关键必填项（`backend/.env`）**：

| 配置项 | 说明 | 示例 |
| :--- | :--- | :--- |
| `OPENAI_API_KEY` | 大模型服务商 API Key（**必填**） | `sk-xxxxxx` |
| `OPENAI_BASE_URL` | 大模型 API Base URL | `https://api.deepseek.com` |
| `OPENAI_MODEL` | 生产大模型标识 | `deepseek-chat` |
| `AI_CLIENT_CREDENTIALS` | 客户端签名通信凭据（**必填**） | `web:strong_secret_token` |
| `AI_ALLOWED_ORIGINS` | 允许访问 AI 接口的前端域名白名单 | `https://your-domain.com:*` |
| `JWT_SECRET` | 用户身份认证 Token 密钥 | 随机强字符串 |

#### Nginx 推荐配置

Nginx 生产配置模板位于 [`deploy/nginx.conf`](deploy/nginx.conf)。一键部署脚本会自动建立软链接并测试，如需手动载入：

```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/bagujing
sudo ln -sf /etc/nginx/sites-available/bagujing /etc/nginx/sites-enabled/bagujing
sudo nginx -t && sudo systemctl reload nginx
```

---

### 2. PM2 进程集群与常用命令

```bash
# 启动生产服务
pm2 start ecosystem.config.cjs --env production

# 查看所有运行进程状态
pm2 list

# 查看实时聚合日志
pm2 logs

# 修改配置后平滑重启并更新环境变量
pm2 restart bagujing-be-prod --update-env

# 停止服务
pm2 stop ecosystem.config.cjs

# 删除 PM2 托管进程
pm2 delete ecosystem.config.cjs

# 设置开机自启（首次在服务器部署时执行）
pm2 startup
pm2 save
```

---

### 3. 前端静态服务器配置参考

`bagujing-fe` 由定制的 [`scripts/static-server.js`](scripts/static-server.js) 启动（替代默认的 `serve`，详细选型设计与必要性分析请参阅 [docs/why-custom-static-server.md](docs/why-custom-static-server.md)），支持通过环境变量精确控制：

#### 基础（兼容 pm2 serve 命名）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PM2_SERVE_PATH` | `./dist` | 静态文件根目录（通常指向 `./frontend/dist`） |
| `PM2_SERVE_PORT` | `8080` | HTTP 监听端口 |
| `PM2_SERVE_SPA` | `false` | 设为 `true` 时，未命中静态文件的路径会回退到 `index.html`（SPA 必需） |

#### API 反向代理

静态站点通常会以“同源相对路径”调用后端（例如前端直接 `fetch('/api/chat')`）。本静态服务器支持将 `STATIC_API_PROXY_PREFIX` 下的请求（默认 `/api/`）反向代理到后端服务，从而：

- 支持 `POST/PUT/PATCH/DELETE/OPTIONS` 等方法（不会再出现 `POST not allowed`）
- 支持流式响应（SSE / streaming）
- 默认对 API 响应加 `Cache-Control: no-store`（避免被缓存）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `STATIC_API_PROXY_ENABLED` | `true` | 是否启用 API 代理 |
| `STATIC_API_PROXY_PREFIX` | `/api` | 需要代理的路径前缀 |
| `STATIC_API_PROXY_TARGET` | `http://127.0.0.1:3000` | 代理目标（通常为 `bagujing-be` 的地址） |

#### Cache-Control（缓存策略）

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `STATIC_CACHE_HTML` | `no-cache` | HTML 的缓存策略（推荐保持 `no-cache`，确保发布后立即生效） |
| `STATIC_CACHE_ASSETS` | `public, max-age=31536000, immutable` | “带 hash 的构建产物”（如 `assets/index-xxxx.js`）缓存策略 |
| `STATIC_CACHE_DEFAULT` | `public, max-age=3600` | 非 hash 的静态资源（如未带 hash 的 js/css/图片/字体）的默认缓存策略；非这些类型默认 `no-store` |

> 说明：脚本会识别 Vite 构建的 hash 文件名（例如 `index-CNYEdtba.js`、`index-BB6N4ja_.css`），命中后自动使用 `STATIC_CACHE_ASSETS`。

#### Security headers / CSP

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `STATIC_SECURITY_HEADERS` | `true` | 是否添加基础安全响应头（如 `X-Content-Type-Options` 等） |
| `STATIC_CSP` | *(自动生成)* | 覆盖完整 CSP 字符串；设为 `off`/`false`/`0` 可禁用 CSP |
| `STATIC_CSP_CONNECT_SRC` | *(空)* | 追加 `connect-src` 白名单（空格或逗号分隔），用于允许 SPA 调用后端 API |
| `STATIC_CSP_REPORT_ONLY` | `false` | 设为 `true` 会输出 `Content-Security-Policy-Report-Only`（仅上报不拦截） |

**CSP 拦截排查示例**：若出现 `connect-src 'self'` 阻止后端请求，可配置：

```bash
STATIC_CSP_CONNECT_SRC="https://your-domain.com"
```

#### 预压缩 / 隐藏文件

| 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `STATIC_PRECOMPRESSED` | `true` | 设为 `true` 时，若存在同名 `.br` / `.gz` 文件，优先返回预压缩文件 |
| `STATIC_DOTFILES` | `deny` | `deny` 时禁止访问 `.*` 隐藏文件；改为 `allow` 才允许 |

---

## 🛡️ AI 安全防护说明

项目已实现面向大模型调用成本与滥用风险的多层防御体系（P0 + P1）。

### 设计背景与目标

AI 接口属于高成本、易被刷写和滥用的计算资源。防护体系旨在实现：
- **每次 AI 调用可识别、可限制、可追踪**
- **在无完整前置登录体系前，确保 Token 消耗成本上限可控**
- **通过多层防御策略抵抗自动化恶意请求**

### 防护实现（P0 + P1）

1. **请求签名鉴权**：`X-Client-Id` + `X-Client-Token` + `X-Signature`（HMAC-SHA256）
2. **时间戳 + Nonce 防重放**：拒绝过期请求与重放请求
3. **多维限流**：按 Client / IP 维度控制分钟与小时速率
4. **并发限制**：限制单 Client 同时并发请求数量
5. **配额管理**：支持按角色继承与用户维度的日 Token 上限
6. **成本控制**：输入字符数上限、输出 Token 上限、上游超时、SSE 空闲超时
7. **审计追踪**：allow/reject 决策连同 clientId、userId 写入数据库审计日志

*详细架构与实现设计请参阅：[docs/security-ai-guard.md](docs/security-ai-guard.md)*

---

## 📄 开源协议与声明

- **代码许可**：本项目程序源码遵循 [MIT License](LICENSE) 开源协议。
- **数据声明**：题库与题目详情数据属于私有财产，不随开源代码一同发布与分发。