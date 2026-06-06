# Cluster Crawler

A simple Node.js website crawler using the built-in `cluster` module for parallel fetching.

## Features
- Cluster master/worker orchestration
- Configurable concurrency, timeouts, retry, delay and user-agent
- Basic HTML parsing via cheerio (extracts `<title>`)

## Setup

1. Install dependencies:

```powershell
# from project root
npm install axios cheerio p-queue winston dotenv cross-env
npm install -D nodemon eslint
```

2. Configure targets in `config/default.json`.

## Run

```powershell
npm run start
```

## Local API server (Express)

This repo also includes a small API server that serves categories/problems from `backend/data/*.ndjson`.

```powershell
cd backend
npm run serve:express
```

### AI assistant gateway (minimal viable)

The Express server exposes `POST /api/chat` as an SSE endpoint (server-sent events). It performs a simple keyword
retrieval over the local ndjson files and then proxies the request to an OpenAI-compatible API.

1) Create env file:

```powershell
copy .env.example .env
```

2) Set at least:
- `OPENAI_API_KEY`
- Optional: `OPENAI_MODEL`, `OPENAI_BASE_URL`

### AI guard (P0 + P1 baseline)

`POST /api/chat` and `POST /api/problems/:id/answer/generate` now require signed headers:

- `X-Client-Id`
- `X-Client-Token`
- `X-Ts`
- `X-Nonce`
- `X-Body-Sha256`
- `X-Signature`

Key environment variables:

- `AI_CLIENT_CREDENTIALS` (format: `clientId:token,client2:token2`)
- `AI_ALLOWED_ORIGINS` (example: `http://127.0.0.1:*,http://localhost:*`)
- `AI_RATE_LIMIT_CLIENT_PER_MINUTE`, `AI_RATE_LIMIT_CLIENT_PER_HOUR`
- `AI_MAX_CONCURRENCY_PER_CLIENT`
- `AI_DAILY_REQUEST_LIMIT_PER_CLIENT`, `AI_DAILY_TOKEN_LIMIT_PER_CLIENT`
- `AI_GLOBAL_DAILY_REQUEST_LIMIT`, `AI_GLOBAL_DAILY_TOKEN_LIMIT`
- `AI_AUDIT_FILE_PATH`

**注：当前已支持按角色（Role）和用户（User）动态下发配额，优先级高于外部环境变量。审计记录已从 NDJSON 迁移至数据库存储（`ai_audit_logs` 表）。**

Full security document:

- `../docs/security-ai-guard.md`（含 P2 规划）

For development with auto-reload:

```powershell
npm run dev
```

## Extend
- Implement queueing and deduplication
- Persist results to a database or file
- Add robots.txt respect, crawl delays, and sitemaps
