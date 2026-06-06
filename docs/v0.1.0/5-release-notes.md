# Release Notes: Zero Trust Architecture & Auditing (v1.1.0)

We have successfully overhauled the security and observability layer of the `bagujing` AI services.

## New Features
- **Zero Trust Authentication**: Switched to a JWT session-based model. Browsers no longer store or send the long-lived client secret.
- **Persistent Auditing**: Every AI request is now logged to a SQLite database (`ai_audit_logs`), including user identity, token usage, and latency.
- **Prometheus Metrics**: A new `/metrics` endpoint provides real-time data for monitoring dashboards (Grafana, etc.).
- **Semantic Caching**: AI responses are cached by prompt hash for 24 hours to reduce cost and latency.
- **Audit Management UI**: A professional dashboard at `/admin/audit` to visualize interactions, token costs, and rejections.

## Security Improvements
- **Redis State Store**: Nonce and rate limit state are now persistent and scalable across multiple server processes.
- **Adaptive Risk Control**: Clients with repeated invalid signatures are automatically flagged and blocked.
- **Hardened Handshake**: Initial token exchange requires a deterministic HMAC signature.

## Deployment Requirements
- **Redis**: A Redis instance is now required (`REDIS_URL` in `.env`).
- **Database**: Ensure the SQLite database folder is writable.
- **JWT Secret**: Set a strong `AI_JWT_SECRET` in your environment.

## Breaking Changes
- **Header Changes**: `X-Client-Token` is no longer supported on AI content routes. Use the new `/api/auth/token` exchange flow.

---
## Quality Assurance
This release has been certified by the QA Expert.
**Certification Report**: [qa_report.md](./qa-report.md)

---
*Delivered by the Zero Trust Migration Team.*
