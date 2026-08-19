# Bagujing Frontend (bagujing-fe)

> 八股晶前端单页应用 (SPA)。基于 Vue 3 + Vite 7 + TypeScript + UnoCSS + Pinia 构建，提供分类题库浏览、AI 助教流式交互、个人设置、权限控制与管理员监控大盘。

---

## 目录结构

```
frontend/
├── src/
│   ├── views/              # 核心业务页面组件
│   │   ├── CategoryList.vue   # 题库技术分类列表 (首页)
│   │   ├── ProblemList.vue    # 分类下题目列表与分页检索
│   │   ├── ProblemDetail.vue  # 题目详情、参考答案与 AI 深度解析
│   │   ├── AiAssistant.vue    # AI 智能助教流式多轮对话
│   │   ├── AuditLogs.vue      # 管理员 AI 调用审计监控大盘
│   │   ├── SettingsView.vue   # 用户个人设置与管理员审批控制台
│   │   ├── LoginView.vue      # 登录页面
│   │   └── RegisterView.vue   # 注册页面 (含待审批流)
│   ├── layouts/            # 基础布局 (移动端 Tabbar / PC 端自适应容器)
│   ├── stores/             # Pinia 全局状态管理
│   │   ├── user.ts         # 用户登录态、角色 (Admin/User) 与配额信息
│   │   ├── settings.ts     # 深色模式与个性化偏好
│   │   └── breadcrumb.ts   # 顶部导航面包屑状态
│   ├── utils/              # 辅助工具函数库
│   │   ├── request.ts      # Axios 网络请求封装 (统一拦截、错误提示)
│   │   └── ai-auth.ts      # AI 接口 HMAC-SHA256 请求签名生成器
│   ├── monitoring/         # Sentry 运行时监控与全链路追踪 (Trace Propagation)
│   ├── router/             # Vue Router 路由配置与权限导航守卫
│   ├── assets/             # 静态样式与全局图标
│   ├── App.vue             # 顶层根组件
│   └── main.ts             # 应用主入口
├── .env.example            # 前端全量环境变量模板 (含 Sentry 与 API 配置说明)
├── uno.config.ts           # UnoCSS 原子化样式与 Carbon 图标配置
├── vite.config.ts          # Vite 构建配置与本地 /api 开发代理
└── package.json
```

---

## 技术选型一览

- **核心框架**：Vue 3 (`<script setup lang="ts">` 组合式 API)
- **构建工具**：Vite 7（极速冷启动与热重载 HMR）
- **类型系统**：TypeScript 5.9 + `vue-tsc` 严格类型检查
- **状态管理**：Pinia 3
- **样式体系**：UnoCSS（原子化 CSS + `@iconify-json/carbon` 图标库）
- **网络通信**：Axios + 原生 `fetch` SSE 流式读取
- **安全鉴权**：HMAC-SHA256 签名算法（配合 Nonce 与时间戳防刷）
- **可观测性**：`@sentry/vue`（异常捕获、慢 API 告警与分布式链路追踪）

---

## 快速上手

### 1. 安装依赖

```bash
cd frontend
npm install
```

### 2. 配置环境变量

从模板拷贝并创建本地开发环境配置：

```bash
cp .env.example .env.local
```

编辑 `.env.local`：
- `VITE_API_BASE_URL`：本地开发保持 `/api`（由 Vite 自动代理至后端 3000 端口）
- `VITE_AI_CLIENT_ID`：通常为 `web`
- `VITE_AI_CLIENT_SECRET`：填入与后端 `AI_CLIENT_CREDENTIALS` 相同的客户端密钥

*生产构建时使用 `cp .env.example .env.production`，详细说明见 [.env.example](.env.example)。*

### 3. 启动开发服务器

```bash
npm run dev
```
打开浏览器访问 `http://localhost:5173`。

---

## 常用 NPM Scripts

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动 Vite 开发服务器（支持热重载，监听 `0.0.0.0`） |
| `npm run build` | 运行类型检查并执行生产包构建（输出到 `dist/`） |
| `npm run type-check` | 使用 `vue-tsc` 对所有 `.vue` 与 `.ts` 进行全量类型检查 |
| `npm run preview` | 本地预览构建产物（`dist/`） |
| `npm run lint` | 运行 ESLint 静态代码分析并自动修复格式问题 |
| `npm run format` | 使用 Prettier 格式化所有源码文件 |

---

## 页面路由与访问权限

| 页面路径 | 路由名称 | 权限要求 | 页面功能 |
| :--- | :--- | :--- | :--- |
| `/` | `category-list` | 公开 | 面试技术栈与题目分类导航 |
| `/problem-detail` | `problem-detail` | 需登录 | 题目详情、解析与 AI 生成标准答案 |
| `/assistant` | `ai-assistant` | 需登录 | AI 助教全功能对话（SSE 流式） |
| `/settings` | `settings` | 需登录 | 个人偏好设置 / 管理员用户审批台 |
| `/admin/audit` | `admin-audit` | **需 Admin 权限** | 全局 AI 调用日志、Token 与安全决策审计大盘 |
| `/login` | `login` | 公开 | 账号密码登录 |
| `/register` | `register` | 公开 | 新用户注册（注册后进入待审核流） |

---

## 前后端通信与安全机制

1. **本地 API 代理 (Vite Proxy)**：
   在开发模式下，Vite 会自动将 `/api/*` 请求转发至后端的 `http://localhost:3000`（定义于 [`vite.config.ts`](vite.config.ts)）。
2. **AI 网关签名机制**：
   前端在调用 `/api/chat` 等高成本 AI 接口时，通过 [`src/utils/ai-auth.ts`](src/utils/ai-auth.ts) 自动计算带有时间戳、随机 Nonce 与 Body Hash 的 HMAC 签名，由请求头自动注入以通过后端网关校验。
