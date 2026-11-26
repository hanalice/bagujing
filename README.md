# DevAsk (职问AI)

面试题库驱动的 AI 问答与练习。检索高频真题，用大模型做流式解析和模拟面试；请求先过一层签名、防重放和配额网关。

## 能做什么

- **题库检索**：SQLite 本地存储，按技术栈、分类、标签、公司找题。
- **AI 助教**：兼容 OpenAI / DeepSeek，SSE 流式解析与答题评估。
- **AI 网关**：HMAC-SHA256 签名、时钟与 Nonce 防重放、按客户端 / IP 限流、日配额、审计日志。
- **可观测**：Sentry 报错、慢 API 告警、Trace 贯穿前后端。

## 本地跑起来

需要 Node.js `^18.18.0` 或 `>=20`，npm `>=9`。密钥只放在从 `.example` 复制出来的文件里。

```bash
cp ecosystem.config.example.cjs ecosystem.config.cjs
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env.local

./scripts/setup-dev.sh
```

```bash
# 终端 1
cd backend && npm run start          # :3000

# 终端 2
cd frontend && npm run dev           # 通常 https://localhost:5173，/api 代理到后端
```

## 技术栈

| 前端 | 后端 | 运行 |
| --- | --- | --- |
| Vue 3 · Vite 7 · TypeScript · Pinia · UnoCSS | Node.js · Express 5 · SQLite · LangChain | PM2 Cluster · Nginx 或 `scripts/static-server.js` · Sentry |

Redis 6+ 可选，用于分布式限流和会话缓存。

## 测试与部署

- 质量门禁：[QA workflow](https://github.com/hanalice/bagujing/actions/workflows/qa.yml)。用例矩阵见 [docs/test_cases.md](docs/test_cases.md)。本地报告 `./scripts/qa-report.sh`（生成 `docs/qa_report.md`，不入库）。
- 阿里云 ECS：[docs/deploy-aliyun-ecs.md](docs/deploy-aliyun-ecs.md)。AWS 本机：`./scripts/deploy.sh`，参数与 Nginx / PM2 见 [docs/deployment-and-operations.md](docs/deployment-and-operations.md)。

## 协议

源码 [MIT](LICENSE)。题库与题目详情不随仓库发布。

<details>
<summary>目录、生产形态模拟、文档索引</summary>

```text
bagujing/
├── backend/          # Express + SQLite
├── frontend/         # Vue 3 + Vite
├── scripts/          # setup-dev、deploy、static-server、证书
├── deploy/nginx.conf
├── docs/
└── ecosystem.config.example.cjs
```

本地验收打包产物与 CSP（需要先 `./scripts/generate-certs.sh` 时再跑）：

```bash
cd frontend && npm run build && cd ..
pm2 start ecosystem.config.cjs
PM2_SERVE_PATH=./frontend/dist PM2_SERVE_PORT=8080 PM2_SERVE_SPA=true \
  STATIC_API_PROXY_ENABLED=true STATIC_API_PROXY_TARGET=http://127.0.0.1:3000 \
  node scripts/static-server.js
# https://localhost:8080
```

| 文档 | 内容 |
| --- | --- |
| [security-ai-guard.md](docs/security-ai-guard.md) | 签名、防重放、限流、配额、审计 |
| [vulnerability-report.md](docs/vulnerability-report.md) | 依赖漏洞月报（不阻断合并） |
| [dependency-vulnerability-scanning.md](docs/dependency-vulnerability-scanning.md) | 月扫到修复 PR 的步骤 |
| [deployment-and-operations.md](docs/deployment-and-operations.md) | AWS、Nginx、PM2、环境变量 |
| [deploy-aliyun-ecs.md](docs/deploy-aliyun-ecs.md) | 阿里云 ECS 一键发布 |
| [why-custom-static-server.md](docs/why-custom-static-server.md) | 自研静态服务器的 ADR |
| [docs/README.md](docs/README.md) | 公开文档与 `docs/internal/` 的分层 |

</details>
