# Administrator & User Guide: v1.1.0

**Target Audience**: Project Administrators, Content Managers, and Support Staff.  
**Purpose**: Guide users through the functional features of the AI Audit Dashboard, log interpretation, and basic troubleshooting of AI service interactions.

**Version**: 1.1.0

## 1. Accessing the Dashboard
- **Production (PM2)**: Accessible at `http://localhost:3001/admin/audit`.
- **Development (Vite)**: Accessible at `http://localhost:5173/admin/audit`.

## 2. Key Features
- **Usage Overview**: Monitor the total daily token count and credit usage.
- **Interaction Logs**: View real-time interaction logs including Request ID, Client, and Action.
- **Decision Tracking**: Identify why requests were `rejected` (e.g., `missing_client_id`, `invalid_signature`).
- **Detailed View**: Click on any log entry to view the full prompt metadata and time-to-first-token.

## 3. Troubleshooting Rejections
- **missing_client_id**: The client failed to provide a valid JWT or identity header.
- **replay_blocked**: A nonce was re-used in a short interval.
- **invalid_signature**: The HMAC signature provided by the client did not match the backend calculation.
- **quota_exceeded**: The daily token limit for that client has been reached.
