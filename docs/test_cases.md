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
| UT-AUDIT-02 | 缓存命中安全记账且不计配额 | 命中已有缓存答案；调用 `finalize({ status: 'ok', reason: 'cached_answer', completionText: 长 HTML, upstreamStatus: null, upstreamReached: false })`（对齐 A7 / P0-8，测试文件可同目录扩展或见 `ai-guard-quota.test.js`）。 | 1. 不抛异常；2. 审计/结算 `promptTokens`、`completionTokens`、`totalTokens` 均为 `0`（不得按 `estimate(answer)` 扣配额）；3. 与 A4「上游未触达即不计费」判据一致。 |

### 2.7 Guard 响应缓存策略 (`backend/src/tests/ai-guard-cache.test.js`)

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-CACHE-01 | chat 禁止 JSON 短接, 禁止缓存 | 相同 body 连续两次 `POST /api/chat`，第一次 `finalize` 成功。 | 两次都 `next()`；中间件从不 `res.json`。 |
| UT-CACHE-02 | generate 不走 Guard 内存短接 | 相同 body 连续两次 `POST /api/problems/:id/answer/generate`。 | 两次都进入 handler；JSON 缓存由 SQLite `cached_answer` 负责。 |

### 2.8 Chat SSE 早退错误协议 (`backend/src/tests/chat-sse-error.test.js`)

对应 **A5 / P2-5**：缺 Key 或空消息时，禁止「未设 SSE 头就 `res.end()`」（客户端将收不到任何错误事件）；必须先设 SSE 头 → 再发一条 `type:error` → 最后 `end`，以便前端解析并展示 `message`。须经 `app.handle` 走完整中间件链（鉴权 → Guard → 处理器），禁止在测试里复刻一份 `sendSSE`。空消息判定：`sanitizeUserText` 之后 `message.trim()` 长度为 0（含省略/`null`/`undefined` 等非字符串、`""`、仅空白）。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-CHAT-SSE-01 | 缺 Key：SSE 头后发 type:error 再 end | 前置：未设置 `OPENAI_API_KEY`；已登录且具备 `chat_ai`；`POST /api/chat`，JSON body `{ "message": "hello" }`（非空）。探针记录 `setHeader` / `write` / `end` 调用序。 | 1. 不走 `res.status(400).json(...)`（对比 generate 缺 Key 的 JSON 路径）；<br>2. 依次写入头且均早于首次 `write`：`Content-Type: text/event-stream; charset=utf-8`、`Cache-Control: no-cache, no-transform`、`Connection: keep-alive`；<br>3. 恰好一次 `write`，线格式为 `data: {"type":"error","message":"OPENAI_API_KEY is required"}\n\n`；<br>4. 随后 `res.end()`（`end` 下标 > `write`）；无 `context` / `delta` / `done` 帧。 |
| UT-CHAT-SSE-02 | 空白消息：SSE 头后发 type:error 再 end | 前置：已配置有效 `OPENAI_API_KEY`；已登录；`POST /api/chat`，body `{ "message": "   " }`（仅空白）。 | 头与时序同 UT-CHAT-SSE-01；恰好一次 `write`，线格式为 `data: {"type":"error","message":"Empty message"}\n\n`；再 `res.end()`；不发起上游 LLM 调用。 |
| UT-CHAT-SSE-03 | 空串或缺 message：同 Empty message 协议 | 前置：已配置 Key；已登录；分别覆盖 body `{ "message": "" }` 与省略 `message` 字段（经 sanitize 得 `''`）。 | 与 UT-CHAT-SSE-02 相同契约：SSE 三头 → 唯一 `type:error`/`Empty message` 帧 → `end`；禁止静默关连接、禁止 JSON 错误体。 |

### 2.9 Guard 调试日志降级 (`backend/src/tests/ai-guard-debug.test.js`)

对应 **A6 / P2-3**：`backend/src/security/ai-guard.js` 中间件内带前缀 `[ai-guard-debug]` 的调试输出（当前为无条件 `console.log`，含 `requestId` / `route` / `clientId` / `hasUser` / `forceSig`）在生产默认路径下不得进入标准日志，避免 token/header 身份噪音刷屏。完成标准：生产关闭该调试行，或降为仅 debug 级别；**默认**（未显式开启调试）捕获 `console.log` / `console.debug` / `console.info` 时，零条消息包含子串 `[ai-guard-debug]`。测试通过 stub `console.*` + 直接调用 `createAiGuard(...).middleware`（参考 `ai-guard-cache.test.js` 的 `mockHttp`），命中 AI 路由（如 `POST /api/chat`），`AI_REQUIRE_SIGNED_HEADERS=false` 且 `req.user.clientId` 已设以便 `next()`。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-GUARD-DEBUG-01 | 生产默认：无 `[ai-guard-debug]` 输出 | 前置：`NODE_ENV=production`；未设置任何显式开启 Guard 调试的开关（若实现使用 `AI_GUARD_DEBUG` 等，则保持未设或 `false`）；stub `console.log`/`console.debug`/`console.info`；`createAiGuard` 后对 `POST /api/chat` 走一次 middleware（合法 `clientId`，可 `next()`）。 | 1. middleware 调用 `next()`（不因关日志而拒请求）；<br>2. 上述三个 console 方法的全部参数拼接串中，**零次**出现子串 `[ai-guard-debug]`；<br>3. 请求仍可正常进入后续 handler（本用例不断言业务响应体）。 |
| UT-GUARD-DEBUG-02 | 显式开启调试：允许一条 `[ai-guard-debug]` | 前置：按实现约定开启调试（例如 `AI_GUARD_DEBUG=true`，或文档约定的非生产 + debug 级别）；同样 stub console；对 `POST /api/chat` 走 middleware，请求头带 `x-request-id: req-debug-1`。 | 1. `console.log` 或 `console.debug`（不得用默认生产 info 通道刷屏）**至少一次**参数含 `[ai-guard-debug]`；<br>2. 该条须同时能观察到 `route` 与 chat 路由标识（如 `chat` / `/api/chat` 的 routeKey）以及 `requestId`/`req-debug-1` 相关字段；<br>3. middleware 仍 `next()`，行为与关日志时一致。 |
| UT-GUARD-DEBUG-03 | 调试开启时正文不含签名/Token 原文 | 前置：调试已开启（同 UT-GUARD-DEBUG-02）；`req.header` 可返回非空的 `x-client-token`、`x-signature`、`authorization`（或 `Authorization`）伪造敏感值（如 `secret-token-value`、`sig-leak-probe`、`Bearer leak-jwt`）；走 `POST /api/chat` middleware。 | 1. 所有含 `[ai-guard-debug]` 的 console 调用参数拼接后，**均不包含**上述敏感原文子串（`secret-token-value` / `sig-leak-probe` / `leak-jwt` / 完整 `Bearer ...`）；<br>2. 允许出现布尔或枚举型元数据（如 `hasUser`、`forceSig`），但禁止把签名头或 client token 原文写入日志。 |

### 2.10 `cached_answer` 命中不计配额 (`backend/src/tests/ai-guard-quota.test.js` / handler 契约)

对应 **A7 / P0-8**：`POST /api/problems/:id/answer/generate` 在题详情已有非空 `details.answer` 且未 `force` 时走 SQLite 业务缓存早退，**未触达上游模型**。须沿用 A4 判据，由 handler 显式 `finalize({ status: 'ok', reason: 'cached_answer', upstreamReached: false, ... })`（可附 `upstreamStatus: null`、`completionText` 为库内原文）。Guard 在 `upstreamReached === false` 时：`billedPromptTokens`/`completionTokens`/`totalTokens` 记 `0`，并对准入预扣全额回补（`refund: true`）；审计行仍写入 `reason: 'cached_answer'`，以便统计命中次数。完成标准：连续命中缓存不再消耗日配额；审计仍可统计命中次数。配额/审计结算优先落在 `backend/src/tests/ai-guard-quota.test.js`（复用 A4 的 `mockHttp` + 审计 NDJSON）；handler 传参契约可落在 `backend/src/tests/llm.test.js` 或同主题新测文件。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-QUOTA-CACHE-01 | cached_answer + upstreamReached:false 记零并回补预扣 | 前置：`AI_REQUIRE_SIGNED_HEADERS=false`；无 dbPool 走内存日配额；`AI_GLOBAL_DAILY_TOKEN_LIMIT` 仅够约 1 次保守预扣（同 A4 失败回补手法）；对 `POST /api/problems/1/answer/generate` 走 `createAiGuard().middleware` 准入后，调用 `finalize({ status: 'ok', reason: 'cached_answer', completionText: 很长的 HTML（≥1KB）, upstreamReached: false })`；再发第二次同路由 middleware。 | 1. 审计 NDJSON 存在 `reason === 'cached_answer'` 的行，且 `promptTokens === 0`、`completionTokens === 0`、`totalTokens === 0`（长 `completionText` 不得按 `ceil(len/4)` 结算）；2. 第二次 `next()` 被调用、HTTP 状态保持可准入（非 429）；3. 证明「上游未触达」路径全额回补预扣。 |
| UT-QUOTA-CACHE-02 | 连续缓存命中不消耗日配额 | 前置：日 token 上限约等于 1～2 次保守预扣；同一 `clientId` 连续 ≥3 次：middleware 准入 `answer/generate` → `finalize({ status: 'ok', reason: 'cached_answer', completionText: 长 HTML, upstreamReached: false })`。 | 1. ≥3 次全部 `next()`，无一次 `statusCode === 429` / `client_daily_token_limit`；2. 审计中 `reason === 'cached_answer'` 的条数等于请求次数（可统计命中）；3. 每条上述审计的 `totalTokens === 0`。 |
| UT-QUOTA-CACHE-03 | generate handler 缓存早退必须传 upstreamReached:false | 前置：SQLite 题详情已有非空 `answer`；请求 body 未设 `force`（或 `force !== true`）；spy/stub `model.invoke`（或 `getLlmModel`）与 `req.aiGuard.finalize`；经 handler（或等价抽取路径）处理 `POST /api/problems/:id/answer/generate`。 | 1. **零次**上游 `invoke`/`stream`；2. `finalize` 恰好一次，payload 含 `status: 'ok'`、`reason: 'cached_answer'`、`upstreamReached: false`（`upstreamStatus` 为 `null` 或不计费语义）；3. 响应 HTTP 200，JSON：`code === 0`、`data.cached === true`、`data.answer` 等于库内原文。 |
| UT-QUOTA-CACHE-04 | 对照：真实生成仍按上游触达计费 | 前置：题无可用缓存答案，或 body `{ "force": true }`；mock `invoke` 返回非空短 HTML；成功路径 `finalize` 走 `reason: 'generated_answer'`（`upstreamReached` 默认 `true` 或显式 `true`，可带 `upstreamStatus: 200`）。 | 1. 审计 `reason === 'generated_answer'`（或成功生成等价 reason）；2. `totalTokens > 0`（至少含 prompt 估算，不得因 A7 误把生成路径也记零）；3. 响应 `data.cached === false`。 |
| UT-QUOTA-CACHE-05 | 仅 reason=cached_answer 但未传 upstreamReached 仍计费 | 前置：同 UT-QUOTA-CACHE-01 的 Guard 环境；`finalize({ status: 'ok', reason: 'cached_answer', completionText: 长 HTML })`，**故意省略** `upstreamReached`（依赖 Guard 默认 `upstreamReached = true`）。 | 1. 审计该行 `totalTokens > 0` 且 `completionTokens === estimateTokensByText(completionText)`；2. 说明不计费**不**由 `reason` 字符串单独决定，必须由调用方显式传 `upstreamReached: false`（护栏：防止只改 reason 文案却漏传判据）。 |

### 2.11 CORS 跨域预检与允许请求头契约 (`backend/src/tests/ai-guard-cors.test.js`)

对应 **B4 / P2-1**：`backend/src/security/ai-guard.js` 中的 `corsOptions.allowedHeaders` 必须显式包含 `'Authorization'`（当前仅配置了 `Content-Type`, `Accept`, `X-*` 等自定义签名头）。当客户端在跨域直连场景（如 Vite 前端独立端口直连后端服务，请求头携带 `Authorization: Bearer <jwt>`）触发浏览器 `OPTIONS` 预检请求时，若 `allowedHeaders` 未显式允许 `Authorization`，浏览器将拦截跨域通信导致请求失败。完成标准：CORS `allowedHeaders` 显式补齐 `'Authorization'`；跨域 `OPTIONS` 预检返回 HTTP 204/200 且响应头 `Access-Control-Allow-Headers` 包含 `Authorization`；白名单 Origin 与非法 Origin 规则正常生效。测试通过断言 `corsOptions` 配置对象及通过 `cors(corsOptions)` 中间件模拟 `OPTIONS` 预检报文进行验证。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-CORS-01 | corsOptions 配置显式包含 Authorization | 直接读取 `createAiGuard().corsOptions.allowedHeaders` 数组。 | 1. 数组包含 `'Authorization'`（精确字符串匹配）；<br>2. 保留原有的全部必要头：`Content-Type`、`Accept`、`X-Request-Id`、`X-Client-Id`、`X-Client-Token`、`X-Ts`、`X-Nonce`、`X-Signature`、`X-Body-Sha256`、`X-Maf-Mission-Id`；<br>3. `methods` 包含 `GET`, `POST`, `OPTIONS`。 |
| UT-CORS-02 | 白名单 Origin 预检 Authorization 放行 | 前置：设置允许的 Origin（如 `http://localhost` 或 `*`）；使用 `cors(corsOptions)` 处理 `OPTIONS /api/chat` 预检请求；请求头携带 `Origin: http://localhost`、`Access-Control-Request-Method: POST`、`Access-Control-Request-Headers: authorization, content-type`。 | 1. 响应状态码为 HTTP 204 或 200；<br>2. 响应头 `Access-Control-Allow-Origin: http://localhost`；<br>3. 响应头 `Access-Control-Allow-Headers` 包含 `authorization`（不区分大小写匹配）；<br>4. 响应头 `Access-Control-Allow-Methods` 包含 `POST`。 |
| UT-CORS-03 | 混合签名头与 Authorization 预检联合放行 | 前置：同 UT-CORS-02；发送 OPTIONS 预检，`Access-Control-Request-Headers: authorization, x-signature, x-client-id, x-ts, x-nonce, content-type`。 | 1. 响应状态码为 HTTP 204 或 200；<br>2. 响应头 `Access-Control-Allow-Headers` 允许列表中包含全部所请求的头部字段；<br>3. 中间件不抛出 CORS 拦截异常。 |
| UT-CORS-04 | 非法 Origin 跨域预检拦截 | 前置：Origin 配置为具体白名单规则（如 `http://localhost`）；客户端携带未授权源 `Origin: http://unauthorized-domain.com` 发送 OPTIONS 预检请求（含 `Access-Control-Request-Headers: authorization`）。 | 1. 触发 `origin` 校验失败，中间件回调返回 `Error('Not allowed by CORS')`；<br>2. 响应头中**不包含** `Access-Control-Allow-Origin: http://unauthorized-domain.com`。 |

### 2.12 C1 Prompt 预算构建与裁剪 (`backend/src/tests/prompt-budget.test.js` -> `prompt-budget.js`，由 `server-express.js` 调用)

对应 **C1 / P1-3**：`/api/chat` 与 `/api/problems/:id/answer/generate` 的模型请求不得把 RAG snippet 以 pretty-print JSON 原样塞入 prompt。被测 Prompt builder 必须暴露或注入同一份预算配置（至少含 `maxDescChars`、`maxChars`），测试不得另写一套阈值；字符数按最终发往模型的各消息 `content` 的 JavaScript `String.length` 累加。描述/要点超限统一保留前缀并以一个 `…` 结尾。

**合法预算**（默认 `maxChars`，或注入值仍 `>=` system + 题面 + 固定标签预留长度）：全部 message 字符和 `<= maxChars`；system 与题面完整；context 按稳定优先级（当前：`problem` > `category` > `other`，同级保持原顺序）输出短 bullet；超总预算时从队尾丢掉整条低优先级 context，禁止截断高优先级当前条，禁止截断 system/题面。检索打分 / rerank 不在 C1 范围。

**非法预算**（`maxChars` 小于预留长度）：builder 必须设置 `budgetError === reserved_exceeds_max_chars`，**不得**截断 system/题面去凑上限；路由不得再调用上游模型。该场景与合法硬上限分列用例，禁止用 `maxChars=10` 去否证 UT-03。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| UT-PROMPT-BUDGET-01 | snippet 使用紧凑 bullet 而非 pretty JSON | 前置：构造 1 个 category snippet（含短 `name`、`groupName`、`groupDesc`、`count`）和 1 个 problem snippet（含 `brief_name`、2 个 `keyPoints`）；调用 Prompt builder，捕获传给模型的 `[SystemMessage, HumanMessage]`。 | 1. 调用顺序固定为 system → human，用户题面原文仍在 HumanMessage；<br>2. 每个 snippet 占一条 `- ` 开头的紧凑 bullet，分类/题目名称、短描述/要点和必要标识可读；<br>3. HumanMessage 不出现 `"groupDesc"`、`"keyPoints"` 等 JSON 字段名，不出现 `{\n` / `[\n` 形式的 pretty-print JSON，且不存在重复序列化同一 snippet。 |
| UT-PROMPT-BUDGET-02 | 超长 `group_desc` 按字段预算截断 | 前置：category 的 `groupDesc` 为 `前缀` + 超过 `maxDescChars` 的重复字符 + `尾部_SENTINEL`，其它 snippet 字段为短值；捕获分类 bullet。 | 1. 描述值等于 `groupDesc.slice(0, maxDescChars - 1) + '…'`（输入超过上限时），长度不超过 `maxDescChars`；<br>2. `尾部_SENTINEL` 不进入 prompt，分类名、分组名、题数等非描述字段仍保留；<br>3. 输入恰好不超过 `maxDescChars` 时不添加 `…`、不丢失最后一个字符。 |
| UT-PROMPT-BUDGET-03 | 合法预算下所有模型消息受总字符硬上限保护 | 前置：使用默认/`>=` 预留长度的 `maxChars`；注入 6 个包含超长 `groupDesc`、超长 `keyPoints` 和换行/引号/emoji 的 snippets，用户题面为正常短文本；捕获 builder 返回的 system/human。 | 1. `system.length + human.length <= promptBudget.maxChars`，不得以片段数量上限代替字符上限；<br>2. system 指令和用户题面完整保留，至少第一条 `problem` bullet（题目 id/名称）保留，过长要点按 `maxDescChars` 截断；<br>3. 被淘汰的 context 不产生半个 JSON 对象、孤立转义符或超出 `maxChars` 的尾部；builder 不抛异常、无 `budgetError`。 |
| UT-PROMPT-BUDGET-04 | 总预算边界只丢低优先级整条 | 前置：使用足够大的合法 `maxChars`。A) 单条高优先级 context 分别使总长为 `maxChars - 1`、`maxChars`；B) 同时注入一条高优先级 `problem` 与一条更长的低优先级 `category`，使两者合计比 `maxChars` 超出至少 1 字符。内容混合中文、emoji、换行和 `"}]`。 | 1. A 两组长度分别准确为 `maxChars - 1`、`maxChars`，高优先级名称完整保留；<br>2. B 组总长 `<= maxChars`，高优先级题名仍在，低优先级分类名不在 human 中（整条丢弃，禁止截断高优先级当前条）；<br>3. 各组均不产生未配对代理项，可直接作为 HumanMessage。 |
| UT-PROMPT-BUDGET-05 | 非法极小 maxChars 不得截断题面 | 前置：注入 `maxChars` 小于 system+题面+标签预留长度（如 `1`），snippets 可有可无。 | 1. 返回的 system 含完整系统指令，human 含完整用户题面；<br>2. `budgetError === reserved_exceeds_max_chars`（或导出常量 `PROMPT_BUDGET_ERROR_RESERVED`）；<br>3. 总长可以大于注入的 `maxChars`；不得把 system/题面截成 `…` 去满足硬上限。 |

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

### 3.3 `cached_answer` 配额与审计集成（A7 / P0-8）

对应完成标准「连续命中缓存不再消耗日配额；审计仍可统计命中次数」。可在 `backend/src/tests/ai-guard-quota.test.js` 用 middleware+finalize 闭环验证，或经 `app.handle` 打真实 `answer/generate`（题已有长解析、无 `force`）。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| IT-QUOTA-CACHE-01 | 连续 POST generate 命中缓存不 429 | 前置：同一 `clientId`；日 token 配额仅够约 1～2 次保守预扣；目标题 `details.answer` 已是长非空 HTML；已登录且具备 `study`；连续 ≥3 次 `POST /api/problems/:id/answer/generate`（body 无 `force` 或 `force: false`）；上游 LLM 可用 stub 断言未被调用。 | 1. 每次 HTTP 200，body `code === 0` 且 `data.cached === true`；2. 全程无 HTTP 429 / `Quota exceeded`；3. 审计中可数出 ≥3 条 `reason === 'cached_answer'`，且每条 `totalTokens === 0`。 |

### 3.4 CORS 跨域直连与反代配置验证（B4 / P2-1）

对应 **B4 / P2-1** 完成标准「跨域预检 200；确认 Nginx 反代不丢签名头」。在集成测试环境（`backend/src/tests/ai-guard-cors.test.js`）及反代配置（`deploy/nginx.conf`）层级验证端到端跨域请求放行与反向代理请求头透传契约。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| IT-CORS-01 | 跨域 OPTIONS 预检后发起携带 Authorization 的 POST 请求 | 前置：集成挂载 `cors(aiGuard.corsOptions)` 的 Express 应用；模拟前端跨域客户端：<br>Step 1: 发送 `OPTIONS /api/chat`（带 `Origin: http://localhost`，`Access-Control-Request-Headers: authorization, content-type`，`Access-Control-Request-Method: POST`）；<br>Step 2: 紧接着发送 `POST /api/chat`（带 `Origin: http://localhost`，`Authorization: Bearer <token>`，`Content-Type: application/json`）。 | 1. Step 1 预检响应 HTTP 204/200，且含合规 `Access-Control-Allow-Headers` 与 `Access-Control-Allow-Origin`；<br>2. Step 2 POST 请求响应头包含 `Access-Control-Allow-Origin: http://localhost`，请求正常进入下游鉴权处理，无 CORS 拦截报错。 |
| IT-CORS-02 | Nginx 反代配置签名头与 Authorization 透传合规性 | 审查 `deploy/nginx.conf` 中 `/api/` 代理段配置。 | 1. `proxy_pass` 正常转发至本地 Node.js 集群；<br>2. 不存在显式清空或覆盖 `Authorization`、`X-Signature`、`X-Client-Id`、`X-Ts`、`X-Nonce`、`X-Body-Sha256` 等请求头的指令；<br>3. 确保跨域直连与反代路径均保留完整认证与签名头。 |

### 3.5 C1 Prompt 预算与模型调用/审计集成 (`backend/src/tests/prompt-budget-integration.test.js`)

对应 **C1 / P1-3** 完成标准「同等题目 prompt tokens 下降可测（审计对比）」。测试必须经 `app.handle` 或真实路由 handler 走完整鉴权 → Guard → RAG → 模型调用链，不得只测试独立字符串函数；模型 stub 负责捕获最终 messages，审计读取对应 NDJSON 行。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| IT-PROMPT-BUDGET-01 | `/api/chat` 预算 prompt 保持 SSE 协议并降低可审计 token | 前置：默认合法 `AI_PROMPT_MAX_CHARS`；SQLite fixture 固定同一用户问题、category 与 problem，`group_desc` 足够长以使旧 pretty JSON 明显膨胀；以合法登录/`chat_ai` 权限发送 `POST /api/chat`，stub `model.stream` 捕获 messages 并依次产出一个 delta 后结束；同时保存旧 pretty JSON 序列化长度作为对照。 | 1. HTTP `200`，`Content-Type: text/event-stream; charset=utf-8`；SSE 顺序为 `context` → `delta` → `done`，不因预算裁剪改变协议；<br>2. 捕获的 `system + human` 总字符数 `budgetedChars <= promptBudget.maxChars` 且严格小于同 fixture 的 `JSON.stringify(snippets, null, 2)` 对照长度；<br>3. 审计 NDJSON **恰好 1 行**（`finalize` 恰好一次），`reason === 'stream_done'`，`promptTokens` 按同一 `budgetedChars` 估算并小于旧对照 token 数，`totalTokens === promptTokens + completionTokens`。 |
| IT-PROMPT-BUDGET-02 | `/answer/generate` 同样应用 snippet 裁剪和总预算 | 前置：SQLite 题目详情无缓存答案；category 的 `group_desc` 与 problem 的 `key_points` 均超过各自预算；请求 `POST /api/problems/42/answer/generate` body `{ "force": true }`，已登录且具备 `study`，stub `model.invoke` 捕获一次调用并返回非空 HTML。 | 1. 仅在 RAG 构建完成后调用一次 `model.invoke([SystemMessage, HumanMessage])`，HumanMessage 为 bullet 文本而非 pretty JSON；<br>2. 最终所有 message content 字符总和 `<= promptBudget.maxChars`，长描述尾部 sentinel 不在请求中；<br>3. HTTP `200` JSON `code === 0`、`data.cached === false`，审计 `reason === 'generated_answer'` 且 `promptTokens > 0`；预算裁剪不得让生成路径退化为 4xx/5xx。 |

### 3.6 C1 超大内部 snippet 的资源边界防护 (`backend/src/tests/prompt-budget-security.test.js`)

Prompt 内容来自数据库，不能只依赖客户端 `AI_MAX_INPUT_CHARS` 防止体积膨胀；本用例从安全测试角度验证恶意/污染题库记录不会把内部模型请求推成无界 payload。`it()` 标题须包含下表 ID。

| ID | 用例标题 | 场景描述 | 预期结果 |
| :--- | :--- | :--- | :--- |
| SEC-PROMPT-BUDGET-01 | 数据库超大描述与要点无法突破模型 prompt 上限 | 前置：**默认合法** `AI_PROMPT_MAX_CHARS`（禁止用极小值）；在隔离 SQLite fixture 写入 1MB `group_desc`、包含数千项的 `key_points_json` 及含换行/引号/emoji 的边界文本；客户端仅发送合法短消息（不触发 `message_too_long`），以合法认证请求分别覆盖 `/api/chat` 与 `/api/problems/42/answer/generate`，stub 上游并记录最终 messages。 | 1. 两条路由发往上游的所有 message content 总字符数始终 `<= promptBudget.maxChars`，不因 JSON 转义、重复 snippet 或多字节内容绕过上限；<br>2. `/api/chat` 返回 HTTP `200` 并按 `context` → `delta` → `done` 结束，`answer/generate` 返回 HTTP `200` 且 JSON `code === 0`；<br>3. 不出现 `RangeError`、请求体过大或 5xx，模型调用最多各 1 次；审计行可记录对应成功 reason。极小 `maxChars` 属 UT-05，不在本用例。 |

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
| `E2E-CHAT-01` | chat 早退 type:error 时界面展示原因 | 已登录进入 `/assistant`；用户发送任意非空提问（A5 完成标准：前端能展示原因） | `page.route` 拦截 `POST /api/chat`：status 200，`Content-Type: text/event-stream`，body **仅** `data: {"type":"error","message":"OPENAI_API_KEY is required"}\n\n` 后结束（模拟缺 Key 早退） | 1. 页面错误提示区（`errorText` / 可见错误条）文案等于 `OPENAI_API_KEY is required`；<br>2. 该文案不作为助手正常回复气泡内容；<br>3. 流式加载态结束，可再次发送。 |

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
