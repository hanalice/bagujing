# DevAsk (职问AI) 文档体系与维护规范 (Documentation Guidelines)

> 本目录用于存放项目的**对外公开技术文档**与**内部研发过程档案**。为了保证开源交付的整洁性与内部敏感信息的安全性，项目采用**「动静分层、内部隔离」**的文档管理规范。

---

## 1. 文档分层与存放规范

```
docs/
├── README.md                    # 本规范说明文件（公开）
├── security-ai-guard.md         # 核心技术白皮书（公开）
├── why-custom-static-server.md  # 架构决策记录 ADR（公开）
│
└── internal/                    # 🔴 内部研发档案目录（已被 .gitignore 忽略）
    ├── v0.1.0/                  # 版本敏捷交付全套产物 (PRD/QA/GA)
    ├── v0.2.0/                  # 版本迭代过程记录与 Walkthrough
    ├── fixes/                   # 线上故障排查与 Hotfix 复盘记录
    └── HLD-*.md                 # 未发布的特性概要设计草案
```

---

## 2. 哪些文档存放在 `docs/`（公开 / Git 追踪）？

`docs/` 根目录下的文件随代码库一同发布与开源，面向外部开发者、协作人员与系统集成方。

### 适用文档类型：
1. **核心架构与技术白皮书 (Technical Whitepapers)**：
   - 描述已落地的核心系统设计、安全机制、数据流向。
   - *示例*：[`security-ai-guard.md`](security-ai-guard.md)（AI 防护网关设计与防护基线）。
2. **架构决策记录 (ADR / Architecture Decision Records)**：
   - 记录重大技术选型的背景、对比、演进历程与最终决策。
   - *示例*：[`why-custom-static-server.md`](why-custom-static-server.md)（静态服务器自研选型与三层分工）。
3. **公共 API 接口规范与集成文档 (API Specs)**：
   - 面向客户端或第三方的公开 REST / SSE 协议说明。
4. **公共运维部署手册 (Deployment Guides)**：
   - 面向开源使用者的标准环境部署与配置参考。

---

## 3. 哪些文档存放在 `docs/internal/`（内部 / Git 忽略）？

`docs/internal/` 目录已被 [`.gitignore`](../.gitignore) 忽略，仅保存在开发者的本地环境，用于记录团队内部研发过程资产。

### 适用文档类型：
1. **版本敏捷交付全套过程产物 (Sprint / Release Artifacts)**：
   - 每个迭代阶段的 PRD 需求稿、评审记录、架构初稿。
   - *目录范例*：`docs/internal/v0.1.0/`（含 `1-PRD.md`、`2-design-doc.md`、`4-ga-review-report.md`）。
2. **测试验收与质量报告 (QA Test Reports)**：
   - 内部测试用例明细、缺陷追踪、自动化测试覆盖率报告、回归验证计划。
   - *文件范例*：`docs/internal/v0.1.0/3-qa-report.md`、`verification-plan.md`。
3. **开发执行记录与代码演进日志 (Walkthroughs)**：
   - 阶段性开发的步骤记录、草稿和过程复盘。
   - *文件范例*：`docs/internal/v0.2.0/walkthrough.md`。
4. **线上故障与专项修复复盘 (Post-mortems / Incident Reviews)**：
   - 记录特定线上 Bug、缓存冲突或安全漏洞的排查过程与修复方案。
   - *目录范例*：`docs/internal/fixes/ai-cache-collision-v1.1.0.md`。
5. **未发布的业务规划与特性草案 (Internal Drafts / HLD)**：
   - 尚未正式发布或正在评估中的功能设计稿。
   - *文件范例*：`docs/internal/HLD-settings-page.md`。

---

## 4. 日常维护指引 (FAQ)

### Q1: 新写了一篇文档，应该放哪里？
- **自检问题**：“这篇文档是给**使用/部署这个开源项目的外部开发者**看的，还是团队**内部开发迭代的过程记录**？”
  - 给外部开发者看 ➔ 放在 `docs/` 根目录，并在 [README.md](../README.md) 中建立引用。
  - 团队内部过程 ➔ 放在 `docs/internal/` 对应的版本或分类子目录中。

### Q2: 内部特性设计完成后如何公开？
- 特性在 `docs/internal/` 完成开发、评审和上线后，提取其**稳定架构结论与对外使用说明**，整理为简洁规范的文档发布至 `docs/`（如 `docs/feature-name.md`），原始 PRD 与 QA 报告继续保留在 `docs/internal/` 归档。
