# Operations & Deployment Manual: v1.1.0

**Target Audience**: DevOps Engineers, SREs, and System Administrators.  
**Purpose**: Provide technical instructions for environment configuration, infrastructure maintenance, and production deployment of the Bagujing AI services.

**Project**: Bagujing
**Environment**: Production / Development

## 1. Port Mapping
- **Frontend (bagujing-fe)**: `3001` (Static Server + API Proxy)
- **Backend (bagujing-be)**: `3000` (API Service)

## 1. Infrastructure Requirements
- **Node.js**: v18+ 
- **Redis**: Required for persistent nonces and rate limiting.
- **SQLite**: Required for audit log persistence.

## 2. Environment Configuration
Ensure the following variables are set in `.env`:
```bash
# Security
AI_JWT_SECRET=your_long_random_secret
AI_CLIENT_CREDENTIALS=web:your_web_secret
AI_REQUIRE_SIGNED_HEADERS=true

# Database & State
ENABLE_SQLITE=true
REDIS_URL=redis://localhost:6379
```

## 3. Maintenance Commands
- **Initialize Audit Database**: `node scripts/init-audit-db.js`
- **Verify Audit Health**: `node scripts/verify-db.js`
- **Run Security Check**: `node scripts/qa-verify.js`

## 4. Monitoring
- **Metrics Endpoint**: `GET http://localhost:3000/metrics`
- **Log Location**: `backend/ai-audit.ndjson` (Fallback) and SQLite `ai_audit_logs`.
