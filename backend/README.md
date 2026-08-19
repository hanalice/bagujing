# DevAsk Backend (职问AI 后端)

> 职问AI (DevAsk) 核心后端 API 服务。基于 Node.js (ESM) + Express 5 + SQLite3 + LangChain 构建，负责面试题库检索、AI 助教流式问答、用户身份认证权限管理与工业级 AI 安全防护网关。

---

## 目录结构

```
backend/
├── src/
│   ├── db/                 # 数据访问层 (DAO / Repository)
│   │   ├── sqlite-pool.js  # SQLite 连接池与 WAL 模式管理
│   │   ├── category-repo.js# 题目分类数据仓储
│   │   ├── problem-repo.js # 题目列表与多维检索
│   │   ├── problem-detail-repo.js # 题目详情与答案解析
│   │   ├── user-repo.js    # 用户信息、角色权限与审批
│   │   └── maf-repo.js     # 对话与任务审计持久化
│   ├── security/
│   │   └── ai-guard.js     # AI 防护网关 (签名鉴权、防重放、限流、配额)
│   ├── llm.js              # 大模型上游连接适配器 (LangChain / OpenAI-Compatible)
│   └── server-express.js   # Express 服务主入口与路由编排
├── db/                     # SQLite 数据库二进制持久化目录 (.gitignore 忽略)
│   └── bagujing.dev.sqlite3
├── data/                   # 离线初始数据 (*.ndjson) 与审计日志
├── scripts/                # 数据库导入、校验与 QA 自动化验证脚本
│   ├── import-ndjson-to-sqlite.js # NDJSON 题库批量导入 SQLite
│   ├── verify-db.js        # 数据库数据完整性校验
│   └── qa-verify.js        # AI 防护网关端到端验证套件
├── .env.example            # 全量后端环境变量配置模板 (带详细说明)
└── package.json
```

---

## 核心业务能力与 API

### 1. 题库检索体系
- `GET /api/categories`：获取技术分类列表与题量统计
- `GET /api/problems`：支持按分类、技术栈、公司标签与关键词分页检索题目
- `GET /api/problems/:id`：获取题目深度解析与标准回答

### 2. AI 智能助教与问答 (SSE 流式输出)
- `POST /api/chat`：面试知识点多轮对话（Server-Sent Events 实时流式响应）
- `POST /api/problems/:id/answer/generate`：针对特定题目的 AI 答题分析与评分

### 3. 用户认证与权限工作流
- `POST /api/auth/register`：用户注册（默认进入待审批列表）
- `POST /api/auth/login`：用户登录并签发 JWT Token（携带角色与配额权限）
- `GET /api/user/profile`：获取当前登录用户画像与偏好

### 4. 管理员控制台与全量审计监控
- `GET /api/admin/pending-users`：查询待审核注册用户列表（需要 Admin 权限）
- `POST /api/admin/approve-user`：一键审批并通过新用户
- `GET /api/admin/audit-logs`：AI 调用决策、Token 消耗、耗时与 IP 脱敏审计日志

---

## 快速上手

### 1. 安装依赖

```bash
cd backend
npm install
```

> **注意**：`npm install` 执行完成后会自动触发 `postinstall` 脚本，将 `data/*.ndjson` 中的初始题库数据导入到本地 SQLite 数据库中。

### 2. 配置环境变量

从模板拷贝并填写你的大模型 API 密钥与安全凭证：

```bash
cp .env.example .env
```

编辑 `.env` 关键配置项：
- `OPENAI_API_KEY`：填入你的大模型 API Key（如 DeepSeek 或 OpenAI 密钥）
- `OPENAI_BASE_URL`：例如 `https://api.deepseek.com` 或 `https://api.openai.com/v1`
- `OPENAI_MODEL`：例如 `deepseek-chat` 或 `gpt-4o-mini`
- `AI_CLIENT_CREDENTIALS`：客户端签名凭据（如 `web:change_me`，需与前端保持一致）

*所有配置项的默认值与说明详见 [backend/.env.example](.env.example)。*

### 3. 启动开发服务

```bash
npm run serve:express
```
服务将在 `http://localhost:3000` 启动监听。

---

## 常用 NPM Scripts

| 命令 | 说明 |
| :--- | :--- |
| `npm run serve:express` | 启动 Express 后端 API 服务（监听 3000 端口） |
| `npm start` | 等同于 `npm run serve:express` |
| `npm test` | 运行后端 LLM 配置与单元测试套件 |
| `npm run import-data` | 将 `data/*.ndjson` 全量题库导入本地 SQLite 数据库 |
| `npm run lint` | 运行 ESLint 静态代码风格检查 |
| `node scripts/qa-verify.js` | 运行 AI 安全防护网关自动化端到端测试 |
| `node scripts/verify-db.js` | 检查本地 SQLite 题库与详情数据条数完整性 |

---

## 架构与安全参考

- **AI 防护网关设计**：详见 [docs/security-ai-guard.md](../docs/security-ai-guard.md)（含 HMAC 请求签名、时钟与 Nonce 防重放、动态配额与审计机制）
- **环境变量 SSOT 规范**：详见根目录 [README.md](../README.md)
