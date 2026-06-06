# Investigation Report: AI Cache Collision & Frontend Infinite Loop

## 1. Issue Description

After implementing the Zero Trust Architecture and AI Guard, two major regressions were observed:
1. **AI Answer Mismatch**: Generating an answer for "Problem A" occasionally returns the answer for "Problem B".
2. **Frontend Infinite Loop**: The `ProblemItem.vue` page enters a loop of calling `/api/problems/:id`, resulting in a blank page or flashing content.

## 2. Root Cause Analysis

### A. Cache Key Collision in `ai-guard.js`
The `ai-guard.js` middleware implements a "Semantic Cache". However, the cache key generation logic is flawed:

```javascript
// backend/src/security/ai-guard.js
const bodyTextForCache = JSON.stringify(req.body ?? {});
const cacheKey = sha256Hex(bodyTextForCache);
```

- **The Problem**: For the `/api/problems/:id/answer/generate` endpoint, the unique identifier (the problem ID) is in the **URL path**, not the request body.
- **The Result**: Any two "generate" requests with an empty body (e.g., `{"force": false}`) share the exact same `cacheKey`. The system returns the first answer it ever cached for *any* problem, leading to the "answer mismatch."

### B. Database Bypass (Double Caching)
There are now two layers of caching:
1. **Application Layer**: `server-express.js` checks the SQLite database for an existing answer.
2. **Security Layer**: `ai-guard.js` checks its `semanticCache` (memory/Redis).

- **The Problem**: `ai-guard.js` intercepts the request and returns a response **before** it reaching the `server-express.js` route handler.
- **The Result**: The backend logic that saves the AI's answer to the SQLite database (`upsertProblemAnswerById`) is **never executed** when there is a cache hit in `ai-guard`.

### C. Frontend Infinite Loop in `ProblemItem.vue`
The frontend logic relies on the database being updated:

1. `ProblemItem.vue` calls `generate`.
2. `ai-guard` returns a cached answer (HIT), but **does NOT update the database**.
3. `ProblemItem.vue` then polls `getProblemById` (which reads from the DB) to see if the answer has appeared.
4. Since the DB was never updated, `getProblemById` continues to return an empty answer.
5. The frontend's `fetchProblem` logic sees the empty answer and triggers `generate` again.
6. **Cycle repeats indefinitely.**

## 3. Predicted Fix Path (Not yet implemented)

1. **Improve Cache Key**: Include `req.path` and `req.method` in the `cacheKey` generation within `ai-guard.js` to prevent collisions between different problems.
2. **Unify Caching Logic**: Ensure that even if a cache hit occurs in `ai-guard`, the result is either already in the DB or the hit triggers a DB sync. (Alternatively, disable `ai-guard` caching for `answer_generate` and rely on the existing DB cache).
3. **Response Format Sync**: Ensure `ai-guard` returns the exact same JSON structure as the real API (including `id`) to avoid frontend parsing errors.
4. **Frontend Guard**: Add a circuit breaker or better state management in `ProblemItem.vue` to prevent infinite retries if the answer remains empty.

---
**Status**: Investigation Complete. Awaiting further instructions.
