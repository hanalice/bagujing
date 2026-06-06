# Enhanced Zero Trust & Token Management Architecture

This revised plan addresses the need for high observability, precise metering, and effective prevention of token waste. We transition from simple HMAC to a stateful, metrics-driven Zero Trust model.

## User Review Required

> [!IMPORTANT]
> **New Dependencies**: 
> - **Redis**: Required for stateful security features and semantic caching.
> - **SQL Database**: Required for persistent, queryable audit logs and metering.
> **Breaking Change**: Transitioning to **JWT-based Session Tokens** means the frontend will no longer hold the primary HMAC secret; it will perform a "login-like" exchange to receive a short-lived token.

## Project Manager Review & Milestones

From a project management perspective, this plan successfully bridges the gap between the need for AI-powered features and the necessity of strict cost/security controls.

### Success Metrics
- **Zero Token Leakage**: No plain-text secrets in frontend network traffic.
- **100% Audit Coverage**: Every AI-related request is traced in the SQL database.
- **Cost Efficiency**: >20% reduction in redundant AI costs via Semantic Caching.

### Implementation Phases
1. **Phase 1: Foundation (Data Layer)**: Deploy Redis and initialize SQL Audit Schema.
2. **Phase 2: Security Hardening**: Implement JWT Token Exchange and updated HMAC signing (removing plain tokens).
3. **Phase 3: Observability & Efficiency**: Integrate Prometheus metrics and Semantic Caching.
4. **Phase 4: Acceptance**: Final walkthrough and handover.
5. **Phase 5: Audit Management UI**: Implement a dashboard for visualizing AI interactions.

## Proposed Changes

### 1. Observability & Precision Metering

#### [MODIFY] [ai-guard.js](../../backend/src/security/ai-guard.js)
- **Prometheus Exporter**: Add a `/metrics` endpoint (or internal collector) to expose:
  - `ai_tokens_consumed_total{client_id, route, status}`
  - `ai_requests_rejected_total{reason, client_id}`
  - `ai_cache_hits_total`
- **Precise Tokenization**: Replace character-based estimation with a more accurate tokenizer (e.g., integrating a WASM-based tiktoken or a better heuristic for OpenAI/DeepSeek models).
- **User-Journey Auditing**: Capture rich context for every AI call:
  - **Who**: `user_identifier` (based on unique fingerprints or account IDs).
  - **Where**: `page_path` and `page_title` (to identify the specific question or module).
  - **What**: `action_name` (e.g., "AI 助手对话", "生成答题解析") to distinguish feature usage.
  - **Cost**: Exact `prompt_tokens` and `completion_tokens` per session.
- **SQL-Based Metering**: Log context-rich data to the relational database. See [audit_schema.sql](file:///home/alice/.gemini/antigravity/brain/811d0b22-a025-48ca-854b-d114fcc10598/audit_schema.sql).

### 2. Token Waste Prevention (Efficiency)

#### [NEW] [semantic-cache.js](../../backend/src/security/semantic-cache.js)
- **Hash-based Exact Match**: Implement a Redis-backed cache that stores `SHA256(ClientID + Prompt)` -> `Response`.
- **TTL Support**: Cached responses expire after 24 hours (configurable) to ensure freshness.
- **Cache-Control Header**: Allow clients to bypass the cache via `Cache-Control: no-cache`.

### 3. Advanced Zero Trust Identity & Threat Mitigation

The system has transitioned from a static secret model to a dynamic identity model.

- **Identity Exchange**: Clients holding a `client_secret` must exchange it for a short-lived JWT session token at `/api/auth/token`.
- **HMAC Handshake**: The exchange is protected by a deterministic HMAC-SHA256 signature combining `ts`, `nonce`, and `bodyHash`.
- **Session Tokens**: AI routes now validate a Bearer JWT, removing the need to expose secrets in frontend requests.
- **Replay Protection**: Prevented by persistent nonce tracking in Redis (or in-memory fallback). Nonces are valid for 10 minutes.
- **Clock Skew Enforcement**: Strictly enforced at ±5 minutes to prevent stale request replay.
- **Adaptive Risk Control**: HMAC signature validation failure increments a "Risk Score". High risk scores trigger temporary client IP blocking.
- **Data Integrity (Body Hashing)**: Every protected request includes an `X-Body-Sha256` header, ensuring prompt/parameters haven't been tampered with.
- **Privacy Hashing**: IP addresses are SHA256-hashed before being stored in audit logs for compliance.
- **Hardened Handshake**: Initial token exchange requires a deterministic HMAC signature.

### 4. Adaptive Budgeting

#### [MODIFY] [ai-guard.js](../../backend/src/security/ai-guard.js)
- **Dynamic Model Downgrade**: If a client exceeds 80% of its daily token quota, automatically switch the backend to use a "cheaper" model (e.g., swapping GPT-4 for GPT-3.5) if defined.
- **Hard Circuit Breaker**: Immediate `503 Service Unavailable` for AI routes once the **Global Daily Budget** is hit.

### 5. Audit Management UI [NEW]

#### [MODIFY] [server-express.js](../../backend/src/server-express.js)
- **Admin API**: `GET /api/admin/audit-logs`
  - Returns paginated list of `ai_audit_logs`.
  - Supports filtering by `client_id`, `decision`, and `status_code`.

#### [NEW] [AuditLogs.vue](../../frontend/src/views/AuditLogs.vue)
- A professional data table showing:
  - Timestamp, Client ID, Action Type, Status, Decision, Token Usage, Latency.
- Details Modal: Show raw JSON payload and upstream reason.

#### [MODIFY] [index.ts](../../frontend/src/router/index.ts)
- Add `/admin/audit` path mapping to `AuditLogs.vue`.

### Phase 7: Governance & Workflow Standardization [NEW]
- **Document Archiving**: Move all v1.1.0 related artifacts to `docs/v1.1.0/`.
- **GA Review**: Create `ga_review_report.md` documenting the final sign-off.
- **Workflow Update**: Institutionalize the "Standard Release Package" (SRP) in `team_collaboration.md` and PM Skill.
- **SRP Requirement**: Each release must contain:
    - Release Note
    - Requirement Doc (PRD)
    - Design Doc (including Security Architecture)
    - Verification Plan & QA Report
    - GA Review Report

### Automated Tests
1. **Cache Verification**:
   - `curl` the same prompt twice; verify the second request takes `<10ms` and returns `X-Cache: HIT`.
2. **Metrics Verification**:
   - `curl /metrics` and assert that `ai_tokens_consumed_total` increments correctly.
3. **Budget Verification**:
   - Manually set a client's daily quota to `100` tokens and verify rejection after 1-2 calls.

### Manual Verification
1. **Dashboard Review**:
   - Verify that audit logs correctly capture `prompt_tokens` vs `completion_tokens` for precise billing.
2. **Security Audit**:
   - Confirm that the browser `localStorage` or `Variables` do not contain the master secret.
3. **UI Verification**:
   - Navigate to `/admin/audit` and verify real-time log ingestion.
