# AI 接口安全说明（P0 + P1 + P2 部分落地，持续演进中）

## 1. 背景与问题定义

本项目包含对大模型（OpenAI 兼容 / DeepSeek 兼容网关）的调用能力，且此前不存在完整用户认证体系。

在“无认证 + 可直接调用付费模型”场景下，核心风险是：

1. **恶意刷接口导致 Token 成本失控**（账单不可预测）。
2. **请求来源不可识别**（无法追责、无法定向限流）。
3. **自动化脚本重放/高频攻击**（短时间拖垮服务或耗尽预算）。
4. **无审计闭环**（事后无法定位谁、在什么时候、以何种模式滥用）。

目前设计目标已演进为：在集成完整账号体系的基础上，实现按角色继承、按用户覆盖的精细化成本控制、调用识别、攻击阻断与日志审计。

---

## 2. 设计原则

1. **先止血后优化**：先实现 P0（硬约束）阻止成本爆炸，再实现 P1（治理能力）形成稳定运营。
2. **最小可用身份**：即便没有登录系统，也必须给调用方可识别身份（`client_id`）。
3. **多层防护而非单点防护**：鉴权、限流、配额、超时、审计同时生效，避免单策略被绕过。
4. **默认拒绝（fail closed）**（仅当 `AI_REQUIRE_SIGNED_HEADERS=true` / 强制验签开启时）：签名缺失、时间戳异常、重放请求均直接拒绝；配额超限始终拒绝。仓库代码默认 `AI_REQUIRE_SIGNED_HEADERS` 为 `false`（未设置不强制 HMAC），此时有登录会话可无签名头进入后续限流/业务，不得把「默认拒绝」理解成仓库开箱即强制验签。
5. **可观测优先**：放行与拒绝都要有审计记录，便于追踪与调优。

---

## 3. 防护范围

当前受保护的 AI 高成本接口：

- `POST /api/chat`（SSE 流式输出）
- `POST /api/problems/:id/answer/generate`（非流式生成答案）

其他普通读接口（分类、题目列表）不强制 AI 签名，仅受基础服务能力保护。

---

## 4. 威胁模型与对应策略

### 4.1 未授权调用

- **威胁**：任意客户端伪造请求直接消耗模型额度。
- **策略**：当 `AI_REQUIRE_SIGNED_HEADERS=true` 时，请求必须携带 `X-Client-Id`、`X-Client-Token`、`X-Signature` 等签名头（有登录会话也不例外，见 **B31**）。
- **结果**：开关打开后，缺头或验签失败直接 `401`（如 `Missing AI auth headers`）。

### 4.2 请求重放

- **威胁**：拦截一次合法请求后无限重放。
- **策略**：引入 `X-Ts`（时间戳）+ `X-Nonce`（一次性随机值），并设置有效窗口及 nonce TTL（在强制验签开启时生效）。
- **结果**：过期请求或 nonce 重复请求被 `401` 拒绝。

### 4.3 高频刷量 / 并发打满

- **威胁**：机器人短时间高并发请求导致预算和服务资源耗尽。
- **策略**：
  - 按 `route + client + ip` 分钟/小时限流。
  - 按 `client` 并发上限控制。
  - 有 Redis 客户端时限流键 `rl:*`、并发键 `cc:` 走 INCR + TTL（**B51** / **B52**）；无 Redis 时回退进程内 Map。
- **结果**：触发上限返回 `429` 并附 `Retry-After`。

### 4.4 长请求 / 大 token 消耗

- **威胁**：单请求通过超长输入或高输出上限持续耗费成本。
- **策略**：
  - 输入字符上限（`AI_MAX_INPUT_CHARS`）。
  - 输出 token 上限（`AI_MAX_COMPLETION_TOKENS`）。
  - 上游超时与 SSE 空闲超时。
- **结果**：超限请求提前终止，避免长尾消耗。

### 4.5 成本无上限与身份粒度不足

- **威胁**：即便有速率限制，全天累计成本仍可能失控；且无法区分究竟是哪个具体用户消耗了 Token。
- **策略**：
  - **角色级配额**：按用户角色（如 `admin`、`user`）设置默认日/月 Token 上限。
  - **用户级覆盖**：支持为特定高价值用户单独调优配额，优先级高于角色配额。
  - **全局配额回退**：若无具体配置，则回退到系统全局硬边界（`.env`）。
  - 日/月配额计数仍为进程内 Map / SQLite `dbPool`，**尚未**迁到 Redis INCR。
- **结果**：配额耗尽即拒绝，实现从“客户端”到“具体用户”的精细化管控。

### 4.6 事后不可追踪

- **威胁**：攻击发生后无法定位具体调用方和触发原因。
- **策略**：所有 allow/reject 决策写入 NDJSON 审计日志。
- **结果**：可按 requestId / clientId / reason 做复盘和告警。

---

## 5. 架构与实现位置

### 5.1 后端防护中枢

- 文件：`backend/src/security/ai-guard.js`
- 验签开关：`AI_REQUIRE_SIGNED_HEADERS`。代码默认 `false`（`String(process.env.AI_REQUIRE_SIGNED_HEADERS ?? 'false').toLowerCase() === 'true'`）；未设置或不为 `'true'` 时不强制 HMAC。
- 当开关为 `true` 时：`forceSignatureCheck` 与是否有 `req.user` / 登录会话无关（**B31**）——有登录会话也必须完整验签；缺头 → HTTP **401**，JSON `{ code: 401, message: 'Missing AI auth headers' }`，审计 `reason === 'missing_headers'`。
- 核心职责：
  1. 解析与校验签名头（由 `AI_REQUIRE_SIGNED_HEADERS` 控制；开关打开后对有会话与无会话请求同等强制）。
  2. 时间戳、nonce、防重放。
  3. Origin 校验。
  4. 限流、并发、配额控制。
  5. 审计记录写入。
  6. 向业务路由注入 `req.aiGuard` 上下文。
  - 不校验登录 JWT：人的身份由路由级 `authenticateToken` / `requirePermission` 完成；Guard 只读取 `req.user.clientId`。
  - 机调换票另走 `POST /api/auth/token`（`exchangeToken`），与上述「开关打开后会话路径也验签」并行，并不互相否定。

### 5.2 路由接入

- 文件：`backend/src/server-express.js`
- 关键接入点：
  - `app.use(cors(aiGuard.corsOptions))`
  - 两条 AI 路由：`authenticateToken` → `requirePermission` → `aiGuard.middleware` → handler
  - 在 AI 路由中读取 `req.aiGuard`，执行：
    - 上游 timeout / SSE idle timeout
    - `max_tokens` 限制
    - 成功/失败后 `finalize()` 审计闭环

### 5.3 前端签名

- 文件：`frontend/src/utils/ai-auth.ts`
- 文件：`frontend/src/utils/request.ts`
- 文件：`frontend/src/views/AiAssistant.vue`

前端有两条互补路径（换票与受保护路径 HMAC 分职；HMAC 不作用于全部前端路由）：

1. **换票 JWT（匿名 / 无用户 Bearer）**：`fetchAiSessionToken` / `ensureAiSessionToken` 对 `POST /api/auth/token` 换取短时 AI 会话票；签名基串用于换票本身，不是业务 chat/generate 的六头注入。
2. **HMAC 六头（B33 受保护路径）**：`buildAiAuthHeaders` 产出 `X-Client-Id` / `X-Client-Token` / `X-Ts` / `X-Nonce` / `X-Body-Sha256` / `X-Signature`；仅当 `isAiProtectedPath` 判定为 `POST /api/chat` 或 `POST /api/problems/:id/answer/generate` 时，由 `request.ts` 注入。算法：`bodyHash = sha256Hex(bodyText)`，基串 `` `${ts}.${nonce}.${METHOD}.${PATH}.${bodyHash}` ``，`HMAC-SHA256` → `X-Signature`。

> 说明：AI 路由仍优先校验 `Authorization: Bearer <token>`（登录票或换票票）。仅当 `AI_REQUIRE_SIGNED_HEADERS=true`（验签开关打开）时，Guard 才对已登录请求强制 HMAC，形成「身份 + 签名」双重验证；代码未设置该变量时仍回退 `false`，有会话可无 HMAC 头进入后续限流/业务（具体 200/SSE 仍依赖 Key/权限）。生产 PM2（`ecosystem.config.example.cjs` 的 `env` 与 `env_production`）将该变量设为 `true`（**B32**），本白皮书不改代码默认值。

### 5.4 回答缓存（精确哈希 vs SQLite，二选一）

Guard **不再**对 AI 路由做进程内响应短接。

| 路由 | 缓存 | 说明 |
|---|---|---|
| `POST /api/chat` | 无 | 必须是 SSE。禁止缓存命中后 `res.json`（协议会错乱）。 |
| `POST /api/problems/:id/answer/generate` | SQLite `details.answer` | 题已有非空解析且未 `force` 时 `finalize({ reason: 'cached_answer' })` 后返回 JSON。 |

已删除的 `semanticCache` **不是**语义相似缓存，key 本就是精确哈希：

```text
sha256Hex(`${method}:${path}:${JSON.stringify(body)}`)
```

同一路径下只有完全相同的 JSON body 才会命中。它与 SQLite 题解缓存并存时会双源、过期不一致，故只保留 SQLite。

---

## 6. 为什么这样设计（设计决策解释）

### 决策 A：要求 `client_id + token + signature`

- **原因**：仅靠 IP 不可靠（NAT、代理、IP 轮转），仅靠明文 token 易被重放。
- **收益**：能做身份区分 + 数据完整性校验 + 追责（在强制验签开启时）。

### 决策 B：加入 `timestamp + nonce`

- **原因**：签名正确并不等于请求“新鲜”。
- **收益**：阻断抓包重放，限制有效时间窗。

### 决策 C：多维限流（client、ip、route）

- **原因**：单一维度可绕过。
- **收益**：提高攻击成本，减少误杀正常流量。

### 决策 D：请求级与日级双层配额

- **原因**：限流控制瞬时流量，配额控制全天总成本。
- **收益**：把“速率”与“预算”同时收口。

### 决策 E：统一审计日志

- **原因**：风控系统必须可追踪、可解释。
- **收益**：支持后续告警、报表、自动化封禁策略。

---

## 7. 当前配置基线（P0 + P1）

已在 `ecosystem.config.example.cjs` 和 `backend/.env.example` 给出默认值，核心项包括：

- 鉴权开关：`AI_GUARD_ENABLED`
- 强制验签：`AI_REQUIRE_SIGNED_HEADERS`（代码默认 `false`；未设则不强制验签；为 `true` 时有登录会话也验签，见 **B31**）
- 允许来源：`AI_ALLOWED_ORIGINS`
- 客户端凭证：`AI_CLIENT_CREDENTIALS`
- **动态配额**：通过 `users` 与 `roles` 数据表实时下发（优先级：User > Role > Global Env）；计数仍进程内 / SQLite，未迁 Redis
- 输入/输出限制：`AI_MAX_INPUT_CHARS`、`AI_MAX_COMPLETION_TOKENS`
- 超时：`AI_UPSTREAM_TIMEOUT_MS`、`AI_SSE_IDLE_TIMEOUT_MS`
- 限流：`AI_RATE_LIMIT_CLIENT_PER_MINUTE`、`AI_RATE_LIMIT_CLIENT_PER_HOUR`、`AI_RATE_LIMIT_IP_PER_MINUTE`（有 Redis 时 `rl:*` INCR，**B51**）
- 并发：`AI_MAX_CONCURRENCY_PER_CLIENT`（有 Redis 时 `cc:` INCR，**B52**）
- 审计记录：同时记录 `requestId`、`clientId`、`userId` 及其关联行动标识。

---

## 8. 验收标准（已实现目标）

1. 强制验签开启时（`AI_REQUIRE_SIGNED_HEADERS=true` / 开关打开后）：未携带签名头、签名错误、时间戳过期、nonce 重复请求会被拒绝（`401`）。未设开关时有会话无签名头仍可进入后续限流/业务，与代码默认 `false` 一致。
2. 超频请求和超并发请求被拒绝（`429`）。
3. 达到日配额或全局配额后继续请求被拒绝（`429`）。
4. 上游超时/流式空闲超时可自动终止，避免长尾占用。
5. 拒绝和放行行为均可在审计日志中追踪。

---

## 9. 运行与运维说明

1. 先在后端配置真实凭证：
   - `AI_CLIENT_CREDENTIALS=web:<strong_token>`
2. 前端配置同一组客户端信息：
   - `VITE_AI_CLIENT_ID=web`
   - `VITE_AI_CLIENT_SECRET=<strong_token>`
3. 重启进程并更新环境变量：
   - `pm2 restart ecosystem.config.cjs --update-env`
4. 检查审计日志输出：
   - `backend/data/ai-audit.ndjson`

---

- [x] 前端敏感头下沉到后端签发短时票据 / 接入 JWT 统一认证
- [x] 多租户/多角色隔离策略（用户级配额、角色继承）
- [x] 持久化审计追踪（SQL 存储替代部分 NDJSON）
- [x] 有 Redis 时限流走 Redis INCR（`rl:*`，**B51**）；无 Redis 回退内存 Map
- [x] 有 Redis 时并发计数走 Redis INCR（`cc:`，**B52**）；无 Redis 回退内存 Map
- [ ] 配额迁移到 Redis / 配额完全态（日/月 Token 配额仍进程内 Map / SQLite `dbPool`）
- [ ] 接入 WAF / 网关层 Bot 防护与 IP 信誉库
- [ ] 自动封禁与冷却机制（命中风控规则后自动拉黑）
- [ ] 成本告警闭流（80% 预警，100% 熔断并通知）
- [ ] 审计可视化报表（按用户/角色成本分析）
