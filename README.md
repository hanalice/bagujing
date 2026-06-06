# Bagujing

## 快速开始 / Getting Started

本项目包含后端服务 `bagujing-be` 和前端单页应用 `bagujing-fe`。本地开发与部署前，请按照以下步骤配置：

### 1. 配置环境文件 (Environment Files)
分别进入前端与后端目录，基于各自的 `.env.example` 创建本地配置文件：
- **后端**：
  ```bash
  cp backend/.env.example backend/.env
  ```
  然后编辑 `backend/.env`，配置 `OPENAI_API_KEY`（大模型 API 密钥）以及 `AI_CLIENT_CREDENTIALS` 等所需配置。
- **前端**：
  ```bash
  cp frontend/.env.example frontend/.env.local
  ```
  配置前端访问的后端 API 接口地址与 AI 认证凭据。

### 2. 生成本地 SSL/TLS 证书 (Local Certificates)
本地 HTTPS 静态服务器启动需要证书文件（由 `pm2.config.js` 指向 `certs/server.pem`）。项目已附带一键生成脚本：
```bash
./scripts/generate-certs.sh
```
运行该脚本后，会在本地自动创建 `certs/server.pem` 自签名证书文件（已被 Git 忽略，不会提交至仓库）。

### 3. 安装依赖与启动服务 (Installation & Launch)
在根目录下运行 PM2 启动所有服务：
```bash
# 安装依赖
cd backend && npm install
cd ../frontend && npm install
cd ..

# 启动服务
pm2 start pm2.config.js
```

---

# using nginx to deploy bagujing projects to AWS
一键部署脚本：deploy.sh

# using pm2 to deploy bagujing projects to remote server
- bagujing-be is the backend project that is a express project
- bagujing-fe is a vue-based project that serve as a static SPA project

## bagujing-fe env（静态服务器环境变量说明）

`bagujing-fe` 由 `./scripts/static-server.js` 启动（替代默认 `serve`），支持通过环境变量精确控制：

- 监听端口与根目录
- SPA 路由回退（History 模式）
- 静态资源缓存策略（Cache-Control）
- 基础安全头 + CSP（可配置 connect-src 白名单）
- 预压缩资源（.br/.gz）优先返回

### 基础（兼容 pm2 serve 命名）

| env | 默认值 | 说明 |
| --- | --- | --- |
| `PM2_SERVE_PATH` | `./dist` | 静态文件根目录（通常指向 `./frontend/dist`） |
| `PM2_SERVE_PORT` | `8080` | HTTP 监听端口 |
| `PM2_SERVE_SPA` | `false` | 设为 `true` 时，未命中静态文件的路径会回退到 `index.html`（SPA 必需） |

### API 反向代理（解决 POST not allowed / 同源调用后端）

静态站点通常会以“同源相对路径”调用后端（例如前端直接 `fetch('/api/chat')`）。
本静态服务器支持把 `STATIC_API_PROXY_PREFIX` 下的请求（默认 `/api/`）反向代理到后端服务，从而：

- 支持 `POST/PUT/PATCH/DELETE/OPTIONS` 等方法（不会再出现 `POST not allowed`）
- 支持流式响应（SSE / streaming）
- 默认对 API 响应加 `Cache-Control: no-store`（避免被缓存）

| env | 默认值 | 说明 |
| --- | --- | --- |
| `STATIC_API_PROXY_ENABLED` | `true` | 是否启用 API 代理 |
| `STATIC_API_PROXY_PREFIX` | `/api` | 需要代理的路径前缀 |
| `STATIC_API_PROXY_TARGET` | `http://127.0.0.1:3000` | 代理目标（通常就是 `bagujing-be` 的地址） |

### Cache-Control（缓存策略）

| env | 默认值 | 说明 |
| --- | --- | --- |
| `STATIC_CACHE_HTML` | `no-cache` | HTML 的缓存策略（推荐保持 `no-cache`，确保发布后立即生效） |
| `STATIC_CACHE_ASSETS` | `public, max-age=31536000, immutable` | “带 hash 的构建产物”（如 `assets/index-xxxx.js`）缓存策略 |
| `STATIC_CACHE_DEFAULT` | `public, max-age=3600` | 非 hash 的静态资源（如未带 hash 的 js/css/图片/字体）的默认缓存策略；非这些类型默认 `no-store` |

> 说明：脚本会识别 Vite 构建的 hash 文件名（例如 `index-CNYEdtba.js`、`index-BB6N4ja_.css`），命中后自动使用 `STATIC_CACHE_ASSETS`。

### 预压缩 / dotfiles

| env | 默认值 | 说明 |
| --- | --- | --- |
| `STATIC_PRECOMPRESSED` | `true` | 设为 `true` 时，如果存在同名 `.br` / `.gz` 文件，会按 `Accept-Encoding` 优先返回（`br` > `gzip`） |
| `STATIC_DOTFILES` | `deny` | `deny` 时禁止访问 `.*` 隐藏文件；改为 `allow` 才允许 |

### Security headers / CSP

| env | 默认值 | 说明 |
| --- | --- | --- |
| `STATIC_SECURITY_HEADERS` | `true` | 是否添加基础安全头（如 `X-Content-Type-Options` 等） |
| `STATIC_CSP` | *(自动生成)* | 覆盖完整 CSP 字符串；设为 `off`/`false`/`0` 可禁用 CSP |
| `STATIC_CSP_CONNECT_SRC` | *(空)* | 追加 `connect-src` 白名单（空格或逗号分隔），用于允许 SPA 调用后端 API |
| `STATIC_CSP_REPORT_ONLY` | `false` | 设为 `true` 会输出 `Content-Security-Policy-Report-Only`（仅上报不拦截） |

#### 示例：允许前端请求后端 API

如果你看到类似错误：

> `connect-src 'self'` 导致请求 `http://10.240.207.15:3000/...` 被 CSP 拦截

可以配置：

```bash
STATIC_CSP_CONNECT_SRC="http://10.240.207.15:3000"
```

## start projects
`$pm2 start pm2.config.js`

## AI 安全说明（已落地）

项目已完成一版面向大模型调用成本与滥用风险的防护体系（P0 + P1）。

### 设计背景

由于项目早期没有完整账号认证能力，而 AI 接口属于高成本资源，存在以下现实风险：

- 未授权调用导致 token 成本失控
- 高频刷接口拖垮服务
- 请求重放绕过简单校验
- 缺乏审计导致事后不可追踪

### 设计目标

- 让每次 AI 调用可识别、可限制、可追踪
- 在无完整登录体系前，先保证成本上限可控
- 通过多层策略而非单点策略抵抗滥用

### 实现方式（P0 + P1）

1. 请求签名鉴权：`X-Client-Id` + `X-Client-Token` + `X-Signature`
2. 时间戳与 nonce 防重放：拒绝过期和重复请求
3. 多维限流：按 client/ip/route 控制分钟与小时速率
4. 并发限制：限制单 client 并发请求数量
5. 配额管理：支持按角色继承与用户维度的日 Token 上限
6. 成本控制：输入长度、输出 token、上游超时、SSE 空闲超时
7. 审计追踪：allow/reject 决策及其关联用户 ID 写入数据库审计日志

### 详细文档

- 详细设计与实现说明：[docs/security-ai-guard.md](docs/security-ai-guard.md)
- P2 后续规划（同文档第 10 节）：[docs/security-ai-guard.md](docs/security-ai-guard.md)

## list projects
`$ pm2 list`
┌────┬───────────────────┬─────────────┬─────────┬─────────┬──────────┬────────┬──────┬───────────┬──────────┬──────────┬──────────┬──────────┐
│ id │ name              │ namespace   │ version │ mode    │ pid      │ uptime │ ?    │ status    │ cpu      │ mem      │ user     │ watching │
├────┼───────────────────┼─────────────┼─────────┼─────────┼──────────┼────────┼──────┼───────────┼──────────┼──────────┼──────────┼──────────┤
│ 12 │ bagujing-be       │ default     │ 0.1.0   │ fork    │ 2044127  │ 0s     │ 0    │ online    │ 0%       │ 24.1mb   │ alice    │ disabled │
│ 13 │ bagujing-fe       │ default     │ 5.4.3   │ fork    │ 2044128  │ 0s     │ 0    │ online    │ 0%       │ 16.1mb   │ alice    │ disabled │
└────┴───────────────────┴─────────────┴─────────┴─────────┴──────────┴────────┴──────┴───────────┴──────────┴──────────┴──────────┴──────────┘

## stop projects
`$pm2 stop pm2.config.js`

## delete projects
`$pm2 delete pm2.config.js`