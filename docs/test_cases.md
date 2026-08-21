# 全局测试用例设计规范 (Test Case Design)

## 1. 测试策略矩阵 (Testing Strategy)

本项目（职问AI）采用多层级防御与质量保障策略，涵盖单元测试、安全契约测试、集成测试与静态类型检查：

- **后端单元测试 (Backend UT)**：采用 Node.js 原生 `node:test` + `node:assert/strict`，聚焦核心领域逻辑（大模型适配器、配置解析器、参数优先级合并与防御性容错）。
- **AI 安全防护网关测试 (Security & E2E)**：基于专用自动化套件 `backend/scripts/qa-verify.js`，端到端验证 HMAC 请求签名、时钟防漂移、Nonce 防重放、Origin 跨域白名单及 429 速率限制。
- **数据库与数据完整性 (Data Integrity)**：验证 SQLite 数据库中初始题库数据、客户端授权表 `ai_clients` 及审计日志 `ai_audit_logs` 的持久化与一致性。
- **前端多层级质量保障体系 (Frontend QA Strategy)**：
  - **端到端测试 (Frontend E2E - Playwright)**：覆盖核心用户链路（Main Path / Happy Path），利用 `page.route` 对大模型流式 SSE 接口进行轻量 Mock，保障真实路由鉴权、题目浏览及 AI 交互界面的稳定可用。
  - **状态机与单元测试 (Frontend UT/IT - Vitest)**：针对 Pinia Store（`user`、`settings`、`breadcrumb`）及工具函数，快速验证状态迁移、本地持久化与边界容错。
  - **静态类型与代码质量 (Static Check - vue-tsc & ESLint)**：基于 `vue-tsc` 严格类型推断与 ESLint 规范，在编译期杜绝类型断言失误与样式违规。

---

## 2. 单元测试用例 (Unit Test Cases - UT)

### 2.1 后端 LLM 配置构建器 (`backend/src/llm.js` -> `buildLlmConfig`)

| ID | 用例标题 | 描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-LLM-01 | API Key: 从环境变量读取 | 环境变量中配置 `OPENAI_API_KEY`。 | `openAIApiKey` 等于环境变量中配置的值。 |
| UT-LLM-02 | API Key: 缺失时默认回退 | 环境变量中未设置 `OPENAI_API_KEY`。 | `openAIApiKey` 默认为 `null`。 |
| UT-LLM-03 | Base URL: 默认值 | 环境变量中未设置 `OPENAI_BASE_URL`。 | `configuration.baseURL` 默认为 `https://api.openai.com/v1`。 |
| UT-LLM-04 | Base URL: 自定义配置 | 环境变量中配置自定义 `OPENAI_BASE_URL`。 | `configuration.baseURL` 等于配置的自定义 URL。 |
| UT-LLM-05 | Model Name: 默认模型 | 环境变量中未设置 `OPENAI_MODEL`。 | `modelName` 默认为 `gpt-4o-mini`。 |
| UT-LLM-06 | Model Name: 自定义模型 | 环境变量中配置自定义 `OPENAI_MODEL`。 | `modelName` 等于指定的模型名称。 |
| UT-LLM-07 | Temperature: 默认温度 | 检查默认采样温度配置。 | `temperature` 固定为 `0.2`。 |
| UT-LLM-08 | Max Tokens: 防护网关优先级优先 | `guardContext` (1024) 和 `defaultConfig` (512) 同时提供 `maxCompletionTokens`。 | `maxTokens` 为 `1024`（优先采用 `guardContext`）。 |
| UT-LLM-09 | Max Tokens: 默认配置回退 | `guardContext` 为空，`defaultConfig.maxCompletionTokens` 为 512。 | `maxTokens` 为 `512`（回退采用 `defaultConfig`）。 |
| UT-LLM-10 | Timeout: 防护网关优先级优先 | `guardContext` (5000) 和 `defaultConfig` (30000) 同时提供 `upstreamTimeoutMs`。 | `timeout` 为 `5000`（优先采用 `guardContext`）。 |
| UT-LLM-11 | Timeout: 默认配置回退 | `guardContext` 为空，`defaultConfig.upstreamTimeoutMs` 为 30000。 | `timeout` 为 `30000`（回退采用 `defaultConfig`）。 |
| UT-LLM-12 | 未设置限制时的默认回退 | `guardContext` 和 `defaultConfig` 均未提供 Token 或超时限制。 | `maxTokens` 和 `timeout` 均为 `undefined`。 |
| UT-LLM-13 | 防御性空值处理 (Null / Undefined) | 无参调用 `buildLlmConfig()` 或传入 `(null, null)`。 | 不抛出 `TypeError` 异常，安全执行可选链。 |

### 2.2 后端 LLM 模型工厂 (`backend/src/llm.js` -> `createLlmModel`)

| ID | 用例标题 | 描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-LLM-20 | 模型工厂: 缺失 API Key | 未配置 `OPENAI_API_KEY` 时调用 `createLlmModel`。 | 返回 `null` 且不抛出异常。 |
| UT-LLM-21 | 模型工厂: 正常成功实例化 | 配置有效 `OPENAI_API_KEY` 及选项调用 `createLlmModel`。 | 返回激活的 `ChatOpenAI` 实例，并正确注入参数（`temperature`, `maxTokens`, `timeout`）。 |

### 2.3 LangChain 模型交互契约 (`backend/src/tests/llm.test.js`)

| ID | 用例标题 | 描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-CONTRACT-01 | 单次调用: 字符串内容契约 | 模型 `invoke` 返回包含非空字符串 `content` 的响应对象。 | 响应符合契约（`typeof content === 'string'`）。 |
| UT-CONTRACT-02 | 单次调用: 空内容安全处理 | 模型 `invoke` 返回 `content` 为空字符串的响应对象。 | 正常处理不抛出异常。 |
| UT-CONTRACT-03 | 流式调用: Chunk 内容字段契约 | 模型 `stream` 作为异步生成器产出数据块。 | 每个产出的 Chunk 均包含 `content` 属性。 |
| UT-CONTRACT-04 | 流式调用: 全文拼接还原 | 遍历非空 Chunk 内容并进行累加拼接。 | 正确重构完整回复文本，无数据丢失。 |
| UT-CONTRACT-05 | 流式调用: 单个空 Chunk 处理 | 流产出单个空 Chunk `""`。 | 累加得到空字符串 `""`，不发生崩溃。 |
| UT-CONTRACT-06 | 流式调用: 中断信号取消 | 传输中途通过 `AbortController.abort()` 发起中止。 | 流立即终止，后续产出 0 个 Chunk。 |

### 2.4 流式空闲超时辅助函数 (`backend/src/security/ai-guard.js` -> `readStreamChunkWithTimeout`)

| ID | 用例标题 | 描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-TIMEOUT-01 | Reader 正常读取 Chunk | 上游在超时阈值前产出 Chunk（调用 `reader.read()`）。 | 返回 `{ done: false, value: chunk }`。 |
| UT-TIMEOUT-02 | Iterator 兼容支持 | 传入 AsyncIterator（调用 `iterator.next()`）。 | 正确读取并返回 `{ done: false, value: chunk }`。 |
| UT-TIMEOUT-03 | 流自然结束返回 | 流读取完成。 | 返回 `{ done: true, value: undefined }`。 |
| UT-TIMEOUT-04 | 上游卡死空闲超时 | 上游无新 Chunk 产出超过配置的 `timeoutMs`。 | 抛出 `Error("SSE idle timeout")` 并安全清理内部 Timer。 |
| UT-TIMEOUT-05 | 非法 Reader 参数防护 | 传入 `null` 或无 `read`/`next` 方法的非法对象。 | 抛出 `Error("Invalid stream reader")`，不发生未捕获异常。 |

### 2.5 对话流空闲超时与资源回收 (`backend/src/tests/llm.test.js`)

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-STREAM-01 | 上游挂起触发空闲超时熔断 | 模拟大模型吐出首个 Chunk 后挂起超过 `sseIdleTimeoutMs`。 | 1. 立即中断流并结束响应 (`res.end`)；<br>2. 记录 `finalize({ status: 'error', reason: 'aborted_or_timeout' })`；<br>3. 向前端发送 `type: 'error'` SSE 事件；<br>4. 释放底层 Reader Lock。 |
| UT-STREAM-02 | 请求结束/中断并发计数回收 | 请求结束或客户端主动断开连接。 | 触发 `releaseOnce`，`clientConcurrency` 并发占用计数递减归零且具备幂等性。 |

### 2.6 解析生成调用与审计记账契约 (`backend/src/tests/llm.test.js`)

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-AUDIT-01 | 生成成功安全记账 | 同步 `invoke` 成功生成 HTML 答案并传入 `upstreamStatus: 200` 调用 `finalize`。 | 正常完成审计记录与 Token 统计，无未定义变量异常。 |
| UT-AUDIT-02 | 缓存命中安全记账 | 命中已有缓存答案并传入 `upstreamStatus: null` 调用 `finalize`。 | 正常完成 `cached_answer` 记账，无异常抛出。 |

### 2.7 Guard 响应缓存策略 (`backend/src/tests/ai-guard-cache.test.js`)

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-CACHE-01 | chat 禁止 JSON 短接, 禁止缓存 | 相同 body 连续两次 `POST /api/chat`，第一次 `finalize` 成功。 | 两次都 `next()`；中间件从不 `res.json`。 |
| UT-CACHE-02 | generate 不走 Guard 内存短接 | 相同 body 连续两次 `POST /api/problems/:id/answer/generate`。 | 两次都进入 handler；JSON 缓存由 SQLite `cached_answer` 负责。 |

---

## 3. 安全防护与集成测试用例 (Security & Integration)

### 3.1 AI 防护网关安全防御 (`backend/scripts/qa-verify.js`)

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| SEC-GUARD-01 | 缺失签名拦截 | 请求未携带 `X-Signature` 等签名请求头。 | 返回 HTTP 401，reason: `missing_signature`。 |
| SEC-GUARD-02 | 伪造篡改签名拦截 | 签名内容与 Secret/Body 不匹配。 | 返回 HTTP 401，reason: `invalid_signature`。 |
| SEC-GUARD-03 | 时钟偏移与时间戳篡改 | 时间戳超前或滞后超过允许窗口（如 > 300s）。 | 返回 HTTP 401，reason: `clock_skew`。 |
| SEC-GUARD-04 | 重放攻击防护 (Nonce) | 同一 Nonce 短时间内重复发起两次请求。 | 第二次请求被拦截，返回 HTTP 401，reason: `replay_attack`。 |
| SEC-GUARD-05 | 来源 Origin 白名单校验 | 携带合法签名但来自于未授权的 Origin 域名。 | 返回 HTTP 403，reason: `origin_not_allowed`。 |
| SEC-GUARD-06 | 合规请求建立流式连接 | 签名合规、在白名单 Origin 内发起的正常请求。 | 成功建立 SSE 流式连接并接收首个 Token 数据块。 |
| SEC-GUARD-07 | 突发高频限流 (Rate Limiting) | 瞬时并发请求速率超过配额窗口上限。 | 触发保护，返回 HTTP 429，reason: `rate_limit_exceeded`。 |

### 3.2 业务接口与认证授权 (`backend/src/server-express.js`)

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| IT-AUTH-01 | 无 Token 访问保护接口 | 未携带 `Authorization: Bearer` 访问需要登录的 API。 | 返回 HTTP 401，提示认证缺失。 |
| IT-AUTH-02 | 非 Admin 访问管理端点 | 普通用户 Token 访问 `/api/admin/*` 端点。 | 返回 HTTP 403，提示需要管理员权限。 |
| IT-CHAT-01 | 流式问答客户端断开取消 | 客户端在 SSE 传输中途关闭连接 (`req.on('close')`)。 | 触发 `AbortController.abort()`，立即终止上游 LLM 生成。 |

---

## 4. 前端测试用例规范 (Frontend Test Suites)

### 4.1 Playwright E2E 主路径测试用例 (Main Path & Mock AI)

| ID | 用例标题 | 业务场景与前置步骤 | Mock / 交互策略 | 预期结果 |
| :--- | :--- | :--- | :--- | :--- |
| `E2E-MAIN-01` | 认证与受保护路由拦截 | 匿名访问受保护路由 `/` 或 `/settings` | 拦截 `/api/auth/login` 模拟成功登录返回 | 自动拦截并重定向到 `/login`；填入账号密码提交后成功保存登录凭证并跳转回主页面 |
| `E2E-MAIN-02` | 题库浏览与技术栈分类联动 | 已登录状态下进入首页分类列表 (`/`) | 拦截 `/api/categories` 与 `/api/problems` | 页面正确渲染分类标签树；切换分类标签时即时刷新题目列表并重置分页 |
| `E2E-MAIN-03` | 题目详情浏览与解析切换 | 在列表中点击具体题目卡片 | 拦截 `/api/problems/:id` 返回题目详情 | 路由跳转至 `/problem-detail`，完整呈现题目背景、难度徽标及参考答案/解析面板 |
| `E2E-MAIN-04` | AI 面试助手流式交互主流程 | 导航至 `/assistant` 并在输入框发送提问 | 利用 Playwright `page.route` 拦截 `/api/chat/stream`，模拟返回 `text/event-stream` 分块数据 | 1. 触发发送后输入框禁用且按钮显示加载状态<br>2. 界面接收流式 Chunk 呈打字机增量渲染<br>3. 完成传输后渲染为安全 Markdown（经 DOMPurify 过滤，无 XSS 隐患） |
| `E2E-MAIN-05` | 个人设置与模型偏好持久化 | 进入 `/settings` 修改大模型供应商与参数并保存 | 操作 LocalStorage 结合表单提交 | 页面提示保存成功，刷新浏览器后配置项维持更新后的自定义状态 |

### 4.2 Vitest 状态机与核心逻辑测试用例 (Pinia Stores & Utilities)

| ID | 目标模块 | 测试场景 | 预期结果 |
| :--- | :--- | :--- | :--- |
| `UT-FE-USER-01` | `src/stores/user.ts` | 初始状态与本地凭证恢复 | 当 `localStorage` 存在合法 `token` 与 `user` 时，Store 初始化自动设置 `token` 并计算 `isAuthenticated = true`。 |
| `UT-FE-USER-02` | `src/stores/user.ts` | 登录 Action 成功与失败流转 | 登录成功时写入 `user`、`token` 并持久化；接口报错时清空敏感状态并向调用方抛出异常。 |
| `UT-FE-USER-03` | `src/stores/user.ts` | 登出 Action 与状态清理 | 调用 `logout()` 后清空 `user`、`token`，同时从 `localStorage` 中移除所有认证项。 |
| `UT-FE-SET-01` | `src/stores/settings.ts` | AI 配置参数校验与更新 | 传入合规自定义配置（如 `temperature: 0.7`）时成功更新并持久化；空值时回退默认配置。 |
| `UT-FE-CRUMB-01` | `src/stores/breadcrumb.ts` | 路由嵌套层级面包屑计算 | 触发路由跳转时根据 `route.matched` 准确生成面包屑导航标题与跳转链接数组。 |

### 4.3 前端静态检查与构建规范 (Static Verification)

| ID | 用例标题 | 描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| `FE-STATIC-01` | 全局 TypeScript 类型检查 | 执行 `npm run type-check` (`vue-tsc --build`) | 零类型推断错误 (0 errors)。 |
| `FE-STATIC-02` | ESLint 代码质量与规范 | 执行 `npm run lint` (`eslint . --cache`) | 符合工程代码规范，无语法、未定义引用或未处理的响应式解构错误。 |
