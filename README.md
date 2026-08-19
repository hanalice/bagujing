# DevAsk (职问AI)

> **DevAsk (职问AI)** 是一个面试题库驱动的 AI 智能问答与练习平台。面向开发者提供高频面试题库检索、基于大语言模型（LLM）的智能助教实时解析与模拟面试，并内置了面向生产环境的工业级 AI 安全防护网关。

---

## 📑 目录

- [核心特性](#-核心特性)
- [技术栈与环境要求](#️-技术栈与环境要求)
- [项目架构与目录结构](#-项目架构与目录结构)
- [快速开始（本地开发）](#-快速开始本地开发)
- [测试与质量校验](#-测试与质量校验)
- [生产部署概览](#-生产部署概览)
- [架构文档与技术白皮书](#-架构文档与技术白皮书)
- [开源协议与声明](#-开源协议与声明)

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
├── backend/                  # 后端服务源码 (Node.js + Express + SQLite)
├── frontend/                 # 前端应用源码 (Vue 3 + Vite + UnoCSS)
├── scripts/                  # 部署与运维脚本
│   ├── deploy.sh             # AWS EC2 / Linux 生产环境一键部署脚本
│   ├── static-server.js      # 定制化静态文件服务器 (支持反向代理与 CSP)
│   ├── restart-services.sh   # 服务安全重启脚本
│   ├── stop-services.sh      # 优雅停机脚本
│   └── generate-certs.sh     # 本地开发自签名 SSL/TLS 证书生成
├── deploy/
│   └── nginx.conf            # Nginx 生产环境推荐配置模板
├── docs/                     # 架构设计与技术白皮书
│   ├── security-ai-guard.md  # AI 网关安全防护专项设计白皮书
│   ├── deployment-and-operations.md # 生产部署与运维工程白皮书
│   └── why-custom-static-server.md  # 自研静态服务器选型与设计考量 ADR
└── ecosystem.config.example.cjs  # PM2 进程集群管理模板
```

> ⚠️ **重要配置规范**：为了保证代码与私密信息安全，本项目所有包含数据密钥、API Key、环境参数的文件均采用 `.example` 模板方案。**在本地运行或生产部署前，必须基于模板复制一份并填入您的配置。**

---

## 🚀 快速开始（本地开发）

### 第一步：拷贝配置文件

本项目遵循**单一数据源 (SSOT)** 设计原则：所有业务密钥与参数统一由 `.env` 文件管理。

```bash
# 1. PM2 进程配置 (根目录下)
cp ecosystem.config.example.cjs ecosystem.config.cjs

# 2. 后端业务环境配置 (配置大模型 Key 与客户端凭证)
cp backend/.env.example backend/.env

# 3. 前端本地开发环境配置
cp frontend/.env.example frontend/.env.local
```

### 第二步：生成本地 SSL 证书

本地静态服务器与安全通信需要自签名证书文件：

```bash
./scripts/generate-certs.sh
```
*运行后会自动生成 `certs/server.pem`（已在 `.gitignore` 中忽略）。*

### 第三步：安装依赖与启动服务

#### 方式 A：前后端独立启动（推荐，支持源码热更新）

```bash
# 终端 1：启动后端 API 服务 (监听 3000 端口)
cd backend
npm install
npm run start

# 终端 2：启动前端 Vite 开发服务器 (支持热重载，自动代理 /api 至后端)
cd frontend
npm install
npm run dev
```
打开浏览器访问控制台输出的地址（通常为 `https://localhost:5173`）。

#### 方式 B：本地模拟生产环境（验证编译产物与 CSP 拦截）

```bash
# 安装依赖并构建前端
cd backend && npm install && cd ../frontend && npm install && npm run build && cd ..

# 启动 PM2 后端集群
pm2 start ecosystem.config.cjs

# 启动静态服务器托管前端 dist 并代理 API
PM2_SERVE_PATH=./frontend/dist \
PM2_SERVE_PORT=8080 \
PM2_SERVE_SPA=true \
STATIC_API_PROXY_ENABLED=true \
STATIC_API_PROXY_TARGET=http://127.0.0.1:3000 \
node scripts/static-server.js
```
打开浏览器访问 `https://localhost:8080` 验证生产打包产物。

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

## 🌐 生产部署概览

生产环境推荐采用 **AWS EC2 + Nginx 动静分离 + PM2 集群** 方案：

```bash
# 执行自动化一键部署
./scripts/deploy.sh
```

> 📖 **完整部署指南**：关于生产环境配置清单、Nginx 动静分离配置、PM2 内存水位调度策略与静态服务器全量环境变量字典，请参阅：
> 👉 **[生产部署与运维工程白皮书 (docs/deployment-and-operations.md)](docs/deployment-and-operations.md)**

---

## 📚 架构文档与技术白皮书

为了让系统架构设计可溯源，项目在 [`docs/`](docs/) 目录下提供了详尽的技术白皮书与架构决策记录（ADR）：

| 文档名称 | 类型 | 核心内容 |
| :--- | :---: | :--- |
| 🛡️ **[AI 安全防护网关设计白皮书](docs/security-ai-guard.md)** | 技术白皮书 | HMAC-SHA256 签名鉴权、防重放、分布式速率限制、Token 配额管控与审计日志设计 |
| 🌐 **[生产部署与运维工程白皮书](docs/deployment-and-operations.md)** | 工程指南 | AWS EC2 一键部署、Nginx 动静分离配置、PM2 集群调优与环境变量全量参数字典 |
| 📦 **[静态托管架构演进与 ADR](docs/why-custom-static-server.md)** | 架构决策 | 记录从 `pm2 serve` 到自研 `static-server.js` 的痛点演进与三层服务分工 |
| 📋 **[文档维护规范与体系说明](docs/README.md)** | 规范指南 | 研发内部档案与公开技术文档的动静分层隔离规范 |

---

## 📄 开源协议与声明

- **代码许可**：本项目程序源码遵循 [MIT License](LICENSE) 开源协议。
- **数据声明**：题库与题目详情数据属于私有财产，不随开源代码一同发布与分发。