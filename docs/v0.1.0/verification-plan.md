# Verification Plan: Zero Trust & Auditing Upgrade

This plan outlines the test cases required to certify the Zero Trust architecture, auditing, and observability features.

## 1. Security & Identity (JWT Flow)
| Test Case ID | Description | Input | Expected Result |
|--------------|-------------|-------|-----------------|
| SEC-01 | Token Exchange (Happy Path) | Valid client ID, nonce, signature | Returns 200 with JWT and 1h expiry. |
| SEC-02 | Token Exchange (Invalid Sign) | Valid ID, invalid signature | Returns 401 Unauthorized. |
| SEC-03 | Token Replay Attack | Re-use same nonce for exchange | Returns 401 Replay blocked. |
| SEC-04 | AI Content (JWT Auth) | Valid Bearer JWT in header | Returns AI response (200). |
| SEC-05 | AI Content (Missing JWT) | No Authorization header | Returns 401 Missing client id (allow fallback if configured). |

## 2. Auditing & Metering (SQL & Fallback)
| Test Case ID | Description | Action | Expected Result |
|--------------|-------------|--------|-----------------|
| AUD-01 | SQL Log Creation | Hit `/api/chat` | Row inserted in `ai_audit_logs`. |
| AUD-02 | Metadata Capture | Generate answer | `page_path` and `tokens` correctly recorded. |
| AUD-03 | Rejection Auditing | Access `/api/chat` w/o auth | Rejection logged with reason `missing_client_id`. |
| AUD-04 | NDJSON Fallback | Kill SQL pool (simulated) | Logs written to `ai-audit.ndjson`. |

## 3. Observability & Monitoring
| Test Case ID | Description | Check | Expected Result |
|--------------|-------------|-------|-----------------|
| MON-01 | Prometheus Metrics | `GET /metrics` | `ai_guard_requests_total` exists and is non-negative. |
| MON-02 | Error Tracking | Trigger 500 error | `ai_guard_errors_total` increments. |

## 4. Performance & Efficiency
| Test Case ID | Description | Action | Expected Result |
|--------------|-------------|--------|-----------------|
| EFF-01 | Semantic Cache Hit | Same prompt twice | 2nd call returns `cached: true` in <20ms. |
| EFF-02 | Quota Enforcement | Exceed daily token limit | Returns 429 Quota exceeded (SQL backed). |

## 5. Management UI (Admin API)
| Test Case ID | Description | Check | Expected Result |
|--------------|-------------|-------|-----------------|
| UI-01 | Paginated API | `GET /api/admin/audit-logs?limit=5` | Returns exactly 5 logs + total count. |
| UI-02 | Filtering | Filter by `decision=reject` | Only rejected logs returned. |
