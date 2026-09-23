# 工程待办队列（调度源）

> **本文件进 git**，是 `scripts/automation/daily-fix.sh` 与 `weekly-scan.sh` 的唯一调度源。  
> 内部设计理由与威胁细节仍只写在 gitignore 的 `docs/internal/HLD-*.md`，公开表只写**要改什么**和**完成标准**，不写利用方式。  
> GitHub Issues 不是真相源，避免和本表双写。

**日修只执行 `auto` + `todo`。** `assist` / `manual` 必须先拆成子项、写明契约三行（做 / 不做 / residual），把子项改成 `auto` 后才能被脚本选中。父项状态改为 `split`，cron 不会选它们。

**分级**

- `auto`：契约已冻、单测能锁死，可 `--yes` 无人值守。
- `assist`：还没冻契约；禁止直接做，先拆。
- `manual`：运维开关、真集群、数据批量迁移；禁止自动提交。可拆出代码切片后把切片改成 `auto`，运维壳留 `manual`。

**状态**：`todo` 可被选中（仅当分级为 auto） / `done` 已合入 / `split` 父项索引。

**类型**：`fix` 走缺陷三段式提交；`feat` 走特性四段式。分支分别为 `auto-fix/<id>-<日期>` 与 `auto-feat/<id>-<日期>`。

ID 规则：`[A-Z][0-9]+`（如 `A81`、`C41`、周扫描新号 `S1`）。周扫描单次最多追加 3 条 `auto`。

---

## 待决

> 日修**不读**本节。只有产品分叉、破坏性默认值、角色意见冲突、或公开表措辞需要人看时才写入。  
> 最多 3 条。提出日满 7 天仍未回复，下一周扫描按「推荐」落盘并删行。无行 = 本周不必叫人。


| ID  | 提出日 | 角色 | 问题 | 推荐 |
| --- | --- | --- | --- | --- |

---

## 队列表


| ID  | 类型 | 来源  | 分级   | 状态  | 任务 |
| --- | -- | --- | ---- | --- | -- |
| A1  | fix | P0-2 | auto | done | 修复 `answer/generate` 记账中 `upstream.status` 未定义 |
| A2  | fix | P0-1 | auto | done | chat 循环接入 SSE 空闲超时与并发释放 |
| A3  | fix | P0-3 | auto | done | 移除 Guard 精确哈希内存短接，chat 不再被 `res.json` |
| A4  | fix | P0-4 | auto | done | 配额预扣改保守上限；失败/abort 回补预扣 token |
| A5  | fix | P2-5 | auto | done | 缺 Key 或空消息时，chat 先发 `type:error` 事件再 end |
| A6  | fix | P2-3 | auto | done | `ai-guard-debug` 调试日志降级，生产默认不输出 |
| A7  | fix | P0-8 | auto | done | `cached_answer` 命中不计配额 |
| A8  | fix | P2-6 | assist | split | 已拆为 A81 / A82 |
| A81 | fix | P2-6 | auto | done | 后端 ESLint flat config，当前树 0 error |
| A82 | fix | P2-6 | auto | done | `qa-report.sh` 纳入 backend lint，error 拦截 |
| B1  | fix | P0-6 | auto | done | Prompt 分槽：3 条 message；只测结构不测模型听话 |
| B2  | fix | P0-7 | assist | split | 已拆为 B21 / B22 |
| B21 | fix | P0-7 | auto | done | 解析入库前服务端 HTML 白名单消毒 |
| B22 | feat | P0-7 | auto | done | 助教 system 不再要求仅 HTML 输出 |
| B3  | fix | P0-5 | manual | split | 已拆为 B31；生产开签名仍为 B32 |
| B31 | fix | P0-5 | auto | done | 签名开关打开时，有会话也验签 |
| B32 | fix | P0-5 | manual | todo | 生产打开签名开关（运维，禁止改代码默认值） |
| B4  | fix | P2-1 | auto | done | CORS `allowedHeaders` 补 `Authorization` |
| B5  | feat | P1-7 | manual | split | 已拆为 B51 / B52 |
| B51 | feat | P1-7 | auto | done | 有 Redis 时限流走 Redis，否则内存 Map |
| B52 | feat | P1-7 | auto | done | 有 Redis 时并发计数走 Redis，否则内存 Map |
| C1  | feat | P1-3 | auto | done | Prompt 预算：合法 maxChars 硬上限；非法配置不截题面 |
| C2  | feat | P1-2 | manual | split | 已拆为 C21 / C22 |
| C21 | feat | P1-2 | auto | done | LIKE 召回后规则打分，指定 id 置顶 |
| C22 | feat | P1-2 | auto | done | FTS5 虚表查询，失败回退 LIKE |
| C3  | feat | P1-1 | assist | split | 已拆为 C31 |
| C31 | feat | P1-1 | auto | todo | chat 接收最近 6 轮 messages，绑定当前题面 |
| C4  | feat | P1-4 | manual | split | 已拆为 C41 / C42 |
| C41 | feat | P1-4 | auto | todo | 解析生成返回 JSON 三字段，失败不入库 |
| C42 | feat | P1-4 | auto | todo | 前端按三字段渲染，不再整篇模型 HTML |
| C5  | fix | P1-6 | assist | split | 已拆为 C51 |
| C51 | fix | P1-6 | auto | todo | 有上游 usage 则回写审计，否则标记估算 |
| C6  | feat | P1-8 | auto | done | 模型分层：chat 与解析可分别配置模型 |
| C61 | fix | P1-8 | auto | done | chat 路由选模补齐 OPENAI_MODEL 向下兼容回退 |
| D1  | feat | P1-5 | assist | split | 已拆为 D11 / D12 |
| D11 | feat | P1-5 | auto | todo | 同步生成路径对 429/5xx 有限重试 |
| D12 | feat | P1-5 | auto | todo | 进程内连续失败熔断 |
| D2  | feat | P1-5 | manual | split | 已拆为 D21 |
| D21 | feat | P1-5 | auto | todo | 主 URL 在发出首字节前失败则切备用 URL |
| D3  | feat | P1-2 | manual | todo | 向量检索与 FTS 混合 rerank（需先拆契约） |
| D4  | feat | P1-2 | manual | todo | 非个性化解析的近似缓存（需先拆契约） |
| D5  | fix | P2-2 | manual | split | 已拆为 D51 |
| D51 | fix | P2-2 | auto | todo | 新注册 bcryptjs；登录懒迁移旧哈希 |
| S1  | fix | scan | auto | todo | 机调换票 JWT 与登录票权限面隔离 |
| S2  | fix | scan | auto | todo | Guard 非 debug 路径去掉常开 console.log |
| S3  | feat | scan | auto | todo | 助教前端回传最近 6 轮 messages（对齐 C31） |
| S4  | feat | scan | assist | split | 已判定助教 Markdown；实现见 S6 |
| S5  | fix | scan | assist | todo | 对齐 security-ai-guard.md 与签名默认/会话跳过验签的实现 |
| S6  | feat | scan | auto | todo | 助教助手气泡 Markdown + DOMPurify，用户气泡纯文本 |
| E1  | feat | gate | assist | todo | CI/安全/质量基线（契约未冻，禁止周扫描拆成 auto）：依赖漏洞每月出报告、不挡合并；口令与密钥硬编码单独拦截提交；新增代码覆盖率 ≥80%，前后端历史各 ≥60%；文档与实现一致要能拦住；提交说明按公约覆盖全部 type |


---

## 契约冻结

日修审核对照对应 `### ID` 小节。未出现「做 / 不做 / residual」三行的 `auto` 项视为未冻，脚本拒绝执行。

### A81

- **做**：新增 `backend/eslint.config.js`（flat config），使 `cd backend && npm run lint` 能跑完；规则集为 ESLint 9 recommended，**不**新开会把当前树打红的 error 规则；当前代码 0 error（存量可用文件级/行级 disable）。
- **不做**：前端 lint、大规模格式化重写、顺手升级其它依赖。
- **residual**：更严规则另开条目，不塞进本项。

### A82

- **做**：`scripts/qa-report.sh` 跑 backend `npm run lint`；仅 error 级失败则非 0 退出（与现有「按测试结果返回退出码」一致）。
- **不做**：把 warning 当失败；改前端 lint 门禁。
- **residual**：无。

### B21

- **做**：`answer/generate` 写入 SQLite 前做 HTML 白名单消毒；单测喂恶意标签后库内无 `script` 标签、无 `javascript:` URL。
- **不做**：改题目页已有的 DOMPurify；改助教前端组件。
- **residual**：其它消费方仍应自行消毒；助教 Prompt 见 B22。

### B22

- **做**：助教 system 文案不再要求「仅 body 内 HTML」；单测锁 Prompt 字符串。
- **不做**：用真实模型输出形态判 PASS；改 `AiAssistant.vue` 渲染方式。
- **residual**：前端可继续文本插值，直到 S6。本项禁止改 `AiAssistant.vue` 渲染。

### B31

- **做**：当 `AI_REQUIRE_SIGNED_HEADERS=true` 时，有登录会话也必须验签；缺签名头返回 401。默认值仍为 `false`。
- **不做**：把仓库默认改成 `true`；改 Nginx / 部署配置。
- **residual**：生产打开开关见 B32（manual）。

### B51

- **做**：存在 Redis 客户端时，分钟/小时限流用 Redis INCR+TTL；否则保持进程内 Map。单测注入 mock Redis。
- **不做**：真集群压测、改默认限流数字。
- **residual**：无 Redis 时文档已有「单进程有效」。

### B52

- **做**：存在 Redis 客户端时，client 并发计数走 Redis；否则保持进程内 Map。单测注入 mock。
- **不做**：真集群压测。
- **residual**：同 B51。

### C21

- **做**：chat 无 id 的 `LIKE` 召回后规则打分（标题命中 > 要点命中 > 同分类 boost；指定 `problemId` 置顶）。C1 预算器只按已排序列表从队尾丢条。
- **不做**：FTS5、向量、用主聊天模型打分或摘要。
- **residual**：FTS 见 C22。

### C22

- **做**：新增 FTS5 虚表，启动时从 `problems` 重建；查询走 FTS，失败则回退 `LIKE`。不删除旧列。
- **不做**：向量检索、删除 LIKE 回退。
- **residual**：混合 rerank 见 D3。

### C31

- **做**：`POST /api/chat` 接收 `messages[]`（`role` + `content`），只取最近 **N=6**（写死）；每条截断到 `AI_MAX_INPUT_CHARS`；当前 `problemId` 题面仍走固定槽；B1 三槽顺序不变；用户攻击句只出现在 user 槽。
- **不做**：滚动摘要、改前端是否回传历史（前端另条）。
- **residual**：无前端改动时后端契约仍可先落地；只回传最后一句时行为与现在一致。

### C41

- **做**：解析生成路径产出 JSON `{ summary, keyPoints, nextStep }`（`keyPoints` 为字符串数组）；校验失败返回 502，不把脏 HTML 写入 `answer`。
- **不做**：本项改前端渲染（见 C42）；继续要求模型吐整篇 HTML。
- **residual**：旧 `answer` HTML 如何展示由 C42 处理。

### C42

- **做**：前端按 `summary` / `keyPoints` / `nextStep` 渲染解析，不再对整篇模型 HTML 使用 `v-html`。
- **不做**：改生成协议字段名（已冻为上述三字段）。
- **residual**：题目页其它字段的 DOMPurify 保持不动。宜在 C41 之后做。

### C51

- **做**：`finalize` 若上游对象含 `usage.prompt_tokens` 与 `usage.completion_tokens` 则写入审计，`token_source=upstream`；否则沿用估算并标 `token_source=estimate`。mock 两条路径。
- **不做**：供应商账单对账报表、按用户月结。
- **residual**：网关不返回 usage 时保持估算。

### C61

- **做**：`backend/src/llm.js` 在 `role === 'chat'` 且 `OPENAI_CHAT_MODEL` 未设置或为空白时，回退到 `OPENAI_MODEL`，再回退到 `'gpt-4o-mini'`；同步更新 `backend/.env.example` 与 `backend/README.md` 中关于 `OPENAI_MODEL` 的说明；在 `docs/test_cases.md` 和 `backend/src/tests/model-layer.test.js` 补齐单测，断言未配置 `OPENAI_CHAT_MODEL` 但配置了 `OPENAI_MODEL` 时，`chat` 实际采用 `OPENAI_MODEL`。
- **不做**：移除 `OPENAI_CHAT_MODEL` 或 `OPENAI_GENERATION_MODEL`；修改前端任何代码；修改非模型配置。
- **residual**：显式配置 `OPENAI_CHAT_MODEL` 时其优先级仍高于 `OPENAI_MODEL`。

### D11

- **做**：仅同步 `answer/generate` 的 `invoke`：对 429/5xx 最多 2 次重试，jitter 序列固定以便单测。SSE chat **不重试**。
- **不做**：chat 流式重试、改上游超时默认值。
- **residual**：跨进程熔断见 B5 家族。

### D12

- **做**：进程内熔断（连续失败达到阈值后打开一段时间窗口），单测可驱动；不依赖 Redis。
- **不做**：跨 worker 共享熔断状态。
- **residual**：cluster 下每进程一份，文档写明。

### D21

- **做**：若配置了备用 Base URL，则在**发出第一个上游请求之前**主 URL 失败时改用备用；已经开始向客户端推 SSE `delta` 后不再切换。未配置备用时行为不变。
- **不做**：跨请求会话级 failover、对用户伪装成一条已中断的流续传。
- **residual**：无。

### D51

- **做**：新注册使用 `bcryptjs`；登录先按 bcrypt 校验，失败再回退旧 sha256；命中旧哈希则写回 bcrypt（懒迁移）。无批量 SQL 扫表。
- **不做**：argon2、离线翻写全表、强制失效已有会话。
- **residual**：从未再登录的存量用户仍为旧哈希，直到其下次登录。

### S1

- **做**：`POST /api/auth/token` 签发的 JWT 与登录用户票权限面隔离；该票不得通过管理面鉴权（`requireAdmin`）；claims 仅保留 AI 调用所需声明（如 `op=ai_access` 与 AI 路由权限名）。单测解码 payload 断言。
- **不做**：改用户登录签发路径；改 `AI_REQUIRE_SIGNED_HEADERS` 默认值；改 Nginx / 部署。
- **residual**：客户端凭证轮换与前端是否继续走换票另条。

### S2

- **做**：`ai-guard.js` 在非 `AI_GUARD_DEBUG` 路径下，去掉模块加载标记、SQL 审计成功、换票验签失败等常开 `console.log`；需要时仅走已有 debug 开关。单测：默认环境下上述前缀/文案不出现在 stub 的 `console.log`/`info`。
- **不做**：改审计落库逻辑；扩展新的日志平台。
- **residual**：A6 已覆盖 `[ai-guard-debug]` 前缀通道，本项只收常开噪音。

### S3

- **做**：`AiAssistant.vue` 调用 `POST /api/chat` 时附带 `messages[]`（`role` + `content`），只回传最近 **N=6**（与 C31 一致）；每条内容按前端已有输入上限截断；仍发送当前 `message` 与 `context`。
- **不做**：改后端裁剪规则（属 C31）；改气泡渲染形态（见 S6）；滚动摘要。
- **residual**：后端未识别 `messages` 时行为与现在一致；宜在 C31 之后或并行，以前端契约单测/请求快照锁字段。

### S6

- **做**：`AiAssistant.vue` 助手气泡把**已累积全文**当 Markdown 解析为 HTML，再经 DOMPurify 渲染；每个 SSE `delta` 对完整缓冲区重解析，不要按单 chunk 解析。用户气泡仍用文本插值。单测/组件测锁：`**x**` 出加粗；围栏代码块出 `pre`/`code`；含 `<script>` 或 `javascript:` 的输入消毒后不进 DOM。可对齐 `E2E-MAIN-04`。
- **不做**：改 B22 的 Prompt；改题目解析页；把模型原文当 HTML 直接 `v-html`；用户消息走 Markdown。
- **residual**：LaTeX / mermaid 不做。B22 可先合入（其间前端仍纯文本）。

### E1

登记用，契约未冻。禁止周扫描把本项改成 `auto` 或拆子项；由人拆。

- **依赖漏洞**：每月 OSV-Scanner 出报告，任意等级都记录，不阻断合并。严重与高危列入后续 milestone，排期看当时计划。见 `docs/dependency-vulnerability-scanning.md`。扫描器不写本队列。
- **口令与密钥**：单独检查，不并进漏洞扫描。命中硬编码的密码、token、私钥或连接串则拒绝提交，输出必须带位置和建议改法。
- **质量**：现有测试失败与后端 ESLint error 为 0 的门禁保持。另加覆盖率：本次新增代码 ≥80%，前端历史与后端历史各 ≥60%。行、分支或语句的统计口径在拆分时再定。
- **文档**：与实现一致，且不一致时要能拦住提交或 CI。对照哪些文件在拆分时再定。
- **提交说明**：`.githooks/commit-msg` 与 PR 检查对齐 `docs/git-commit-convention.md` 和 `.agents/skills/commit-message/SKILL.md`。`feat` 四段、`fix` 三段、`refactor` 为动机 / 变更 / 验证；`docs` / `chore` / `test` / `perf` / `ci` 为简要要点。轻量 type 不要写成 `feat` 长模板。

---

## 修订记录


| 日期         | 说明 |
| ---------- | -- |
| 2026-09-16 | 调度源从内部 HLD 第 6 节迁到本文件；父项标 split；assist/manual 切片冻约为 auto 子项（C4 三字段 `summary`/`keyPoints`/`nextStep`，D51 用 bcryptjs） |
| 2026-09-16 | 周扫描增加「待决」：角色定级；仅产品分叉/破坏性默认/角色冲突/措辞才叫人；7 天未回复采用推荐 |
| 2026-09-16 | 周扫描：新增 auto S1/S2/S3（换票权限面、Guard 常开日志、前端 6 轮）；待决 S4（助教渲染）；assist S5（security-ai-guard 文档漂移）；无逾期待决 |
| 2026-09-17 | S4 待决关闭：助教定为 Markdown；实现另开 S6（不塞进 B22）。推荐「先纯文本」作废 |
| 2026-09-17 | A81 完成：后端 ESLint flat config，当前树 0 error |
| 2026-09-17 | A82 完成：qa-report.sh 纳入 backend lint，error 拦截 |
| 2026-09-17 | B21 完成：解析入库前服务端 HTML 白名单消毒 |
| 2026-09-18 | B22 完成：助教 system 不再要求仅 HTML 输出 |
| 2026-09-19 | B31 完成：签名开关打开时，有会话也验签 |
| 2026-09-19 | C61 完成：chat 路由选模补齐 OPENAI_MODEL 向下兼容回退 |
| 2026-09-20 | B51 完成：有 Redis 时限流走 Redis，否则内存 Map |
| 2026-09-21 | B52 完成：有 Redis 时并发计数走 Redis，否则内存 Map |
| 2026-09-22 | C21 完成：LIKE 召回后规则打分，指定 id 置顶 |
| 2026-09-23 | 登记 assist E1：CI/安全/质量基线（未冻契约，禁止周扫描拆条） |
| 2026-09-23 | E1 依赖漏洞改为每月报告、不挡合并；高危按后续 milestone 排期 |
| 2026-09-23 | C22 完成：FTS5 虚表查询，失败回退 LIKE |
