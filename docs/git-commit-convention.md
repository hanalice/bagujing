# Git 协作工作流规范 (Git Workflow & Commit Convention)

> 本文档定义了 DevAsk 项目的 Git 分支管理策略、提交信息规范与质量门禁要求。所有代码变动（包括人工开发与 AI Agent 自动化执行）均需遵循此标准。

---

## 1. 分支管理策略 (Branching Strategy)

项目采用基于主干的轻量化特性分支模型（Trunk-based Feature Branching），并对自动化修复流程做严格分支隔离。

```text
                 ┌─── feat/<feature-name> ───────┐
                 │                               │
[main] ──────────┼─── fix/<scope-or-issue> ──────┼───> (PR / Squash Merge)
(主分支/唯一基线)  │                               │
                 ├─── auto-fix/<id>-<date> ──────┤ (自动化沙盒专用，隔离验证)
                 │                               │
                 └─── docs/ or chore/<task> ─────┘
```

### 1.1 分支类型与命名规则

| 分支类型 | 命名格式 | 基线分支 | 生命周期与职责说明 |
|---|---|---|---|
| **主干分支** | `main` | - | 唯一长期稳定分支，Production-Ready，禁止直接在该分支提交大功能 |
| **特性分支** | `feat/<feature-name>` | `main` | 新功能/架构改动专用，如 `feat/git-commit-convention`，合并后删除 |
| **缺陷修复** | `fix/<scope-or-issue>` | `main` | 手工 Bug 修复专用，如 `fix/ai-guard-cache`，合并后删除 |
| **自动化修复** | `auto-fix/<id>-<YYYYMMDD>` | `main` | `scripts/automation/daily-fix.sh` 专属沙盒分支，如 `auto-fix/a4-20260821` |
| **文档与维护** | `docs/<topic>`, `chore/<task>` | `main` | 文档、依赖升级或工程配置维护 |

### 1.2 分支隔离原则

1. **一事一分支 (One Task, One Branch)**：严禁在特性分支中夹带无关缺陷修复，严禁在 Bug 修复分支中夹带新功能开发。
2. **自动化沙盒隔离**：`auto-fix/*` 分支仅用于目标缺陷的自动化改动与有限次返修验证，**严禁在此类分支上提交任何基础设施或非当次缺陷相关的代码**。
3. **切换前保持干净**：切换分支前必须保证工作区干净（使用 `git stash` 或提交 WIP commit）。

---

## 2. 提交规范概览

本项目采用 **Conventional Commits** 结合**结构化正文**的提交风格：

- **语言**：全部使用中文表达（英文术语/代码标识除外）。
- **Header**：`<type>(<scope>): <subject>`，简明扼要，不超过 50 字。
- **Body**：根据 `type` 的不同，采用不同的结构化段落，要求清楚交代“为什么改”、“改了什么”、“如何验证”。
- **防剥离健壮格式**：正文小节标题统一采用 `【小节名】` 标识（避免使用 `#` 开头的 Markdown 语法，防止在 Git Rebase、Cherry-pick 或交互式编辑器中被 Git 默认的 `commentChar` 机制误剥离）。

---

## 3. Header 格式与 Type 清单

```text
<type>(<scope>): [可选任务编号] <subject>
```

| Type | 说明 | 正文要求 |
|---|---|---|
| `feat` | 新增功能与特性 | 需说明**业务背景**、**技术设计**、**变更清单**与**测试兼容性** |
| `fix` | 缺陷修复 | 需包含**问题现象**、**根因分析**与**解决方案**三段式 |
| `refactor` | 代码重构 | 需包含**重构动机**、**变更内容**与**行为一致性验证** |
| `docs` | 文档新增或更新 | 简明说明文档范围与更新要点 |
| `chore` | 构建/工具链/依赖维护 | 简要说明维护事项 |
| `test` | 测试用例编写与测试架构 | 简要说明测试覆盖内容 |
| `perf` | 性能优化 | 简要说明优化点及性能前后对比数据（如有） |
| `ci` | 持续集成与部署配置 | 简要说明 CI 脚本调整 |

---

## 4. 标准正文模板 (健壮免剥离格式)

### 4.1 缺陷修复 (`fix`) —— 三段式

```text
fix(ai-guard): [P0-3][A3] 移除 Guard 精确哈希内存短接，避免 chat SSE 被 JSON 短路

【问题现象 (Symptoms)】
- 相同 body 再次请求 POST /api/chat 时，Guard 用进程内缓存命中后直接 res.json；
- 前端按 SSE 解析事件流，出现协议错乱。

【根因分析 (Root Cause)】
- semanticCache 并非语义相似缓存，key 实为精确哈希；
- 中间件未区分 chat（必须 SSE）与 answer/generate（JSON），finalize 成功后还会把 chat 回复写入该 Map。

【解决方案 (Solution)】
1. 后端：
   - 删除 security/ai-guard.js 中 semanticCache 的读写，chat 一律 next()、禁止中间件 res.json；
   - 解析缓存仅保留 SQLite details.answer。
2. 自动化测试与验证：
   - 新增 UT 用例覆盖，单测全部通过 (29/29 pass)。
```

### 4.2 功能特性 (`feat`) —— 结构化四段式

```text
feat(test): 集成 Playwright E2E、Vitest 单测体系与 Git Hooks 自动化质量门禁

【背景 (Background)】
- 项目缺乏端到端及核心单测自动化门禁，手工回归成本高且容易遗漏边缘缺陷。

【设计概述 (Design)】
- 采用 Playwright 驱动关键用户流程 E2E；
- 采用 Vitest 负责后端服务与安全中间件单测；
- 通过 pre-commit hook 自动串联 qa-report.sh 与质量报告生成。

【变更内容 (Changes)】
- 新增 `tests/e2e/` 目录与端到端用例脚本；
- 新增 `.githooks/pre-commit` 拦截门禁；
- 完善 `scripts/qa-report.sh` 汇总判定逻辑。

【测试与兼容性 (Testing & Compatibility)】
- 本地全栈门禁验证通过，无破坏性改动。
```

### 4.3 重构 (`refactor`)

```text
refactor(backend): 清理后端遗留代码，完善专属说明文档

【动机 (Motivation)】
- 早期快速迭代遗留无用接口及废弃配置，增加后续维护心智负担。

【变更内容 (Changes)】
- 移除已废弃的 serve:koa 入口及冗余路由；
- 为保留脚本补充标准化设计意图注释。

【验证 (Verification)】
- 运行全量单元测试与 E2E 测试确保行为未降级。
```

---

## 5. 自动化校验与工具支持

1. **Git Hooks 兜底校验**：仓库配置了 `.githooks/commit-msg`，在执行 `git commit` 时会自动校验 Header 规范性，并针对较大改动的 `fix`/`feat` 检查关键段落完整性，同时自动清理第三方 IDE 的水印标记。`.githooks/pre-commit` 会跑 `scripts/qa-report.sh` 作为全栈门禁；生成的 `docs/qa_report.md` 仅留在本地，不再暂存入库。
2. **GitHub Actions**：`.github/workflows/qa.yml` 在 push/PR 上跑同一套门禁（CI 跳过本机 sqlite 诊断），报告写入 Job Summary 并作为 Artifact 上传。
3. **AI Agent Skill 赋能**：在 `.agents/skills/commit-message/SKILL.md` 中固化了本规范与分支自检动作，AI Agent 在执行提交任务时会自动加载并对齐标准。
