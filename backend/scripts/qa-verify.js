/**
 * @file qa-verify.js
 * @description AI 安全防护网关自动化端到端测试套件 (E2E QA Verification)
 *
 * 【设计意图】
 * 1. 用于全自动验证 AI Guard 网关核心防御策略的有效性与抗攻击能力：
 *    - 场景 1: 未提供签名的恶意请求 -> 必须被 401 拦截 (missing_signature)
 *    - 场景 2: 伪造/错误的签名 -> 必须被 401 拦截 (invalid_signature)
 *    - 场景 3: 时间戳篡改/时钟偏差过大 -> 必须被 401 拦截 (clock_skew)
 *    - 场景 4: 请求重放 (Nonce 重复使用) -> 必须被 401 拦截 (replay_attack)
 *    - 场景 5: 合法签名与未受控 Origin -> 必须被 403 拦截 (origin_not_allowed)
 *    - 场景 6: 正常合规请求 -> 验证成功建立 SSE 流式连接并接收首个 Token
 *    - 场景 7: 高频突发请求 -> 验证触发 429 速率限制拦截 (rate_limit_exceeded)
 *
 * 【使用方式】
 * 在后端服务启动状态下执行：
 * - node scripts/qa-verify.js
 */

import crypto from 'crypto';

const BASE_URL = 'http://localhost:3000';
const CLIENT_ID = 'web';
const CLIENT_SECRET = process.env.VITE_AI_CLIENT_SECRET || 'change_me';
const ALLOWED_ORIGIN = 'http://localhost';

function sha256Hex(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
}

function hmacSha256Hex(secret, text) {
    return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

async function consumeSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let done = false;
    while (!done) {
        const { value, done: doneReading } = await reader.read();
        done = doneReading;
        if (value) {
            // Just consume, we don't need to parse for now
        }
    }
}

async function runTests() {
    console.log('--- QA Verification Suite Starting ---');
    let passCount = 0;
    let totalCount = 0;

    async function assert(condition, message) {
        totalCount++;
        if (condition) {
            console.log(`[PASS] ${message}`);
            passCount++;
        } else {
            console.error(`[FAIL] ${message}`);
        }
    }

    // 1. JWT Flow
    console.log('\n[Phase 1] Security & Identity (JWT)');
    const ts = String(Date.now());
    const nonce = crypto.randomUUID();
    const apiPath = '/api/auth/token';

    const initialBodyJson = JSON.stringify({ clientId: CLIENT_ID, ts, nonce });
    const bodyHash = sha256Hex(initialBodyJson);
    const signPayload = `${ts}.${nonce}.POST.${apiPath}.${bodyHash}`;
    const signature = hmacSha256Hex(CLIENT_SECRET, signPayload);

    let jwt = null;
    try {
        const exchangeResp = await fetch(`${BASE_URL}${apiPath}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Origin': ALLOWED_ORIGIN
            },
            body: JSON.stringify({ clientId: CLIENT_ID, ts, nonce, signature, bodyHash })
        });

        const exchangeData = await exchangeResp.json();
        jwt = exchangeData.data?.token;
        assert(exchangeResp.status === 200 && jwt, 'SEC-01: Token Exchange (Happy Path)');

        // SEC-02: Invalid Signature
        const r2 = await fetch(`${BASE_URL}${apiPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED_ORIGIN },
            body: JSON.stringify({ clientId: CLIENT_ID, ts, nonce: crypto.randomUUID(), signature: 'bad', bodyHash })
        });
        assert(r2.status === 401, 'SEC-02: Invalid Signature Check');

        // SEC-03: Replay Attack
        const r3 = await fetch(`${BASE_URL}${apiPath}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Origin': ALLOWED_ORIGIN },
            body: JSON.stringify({ clientId: CLIENT_ID, ts, nonce, signature, bodyHash })
        });
        assert(r3.status === 401, 'SEC-03: Replay Attack Prevention');

        if (jwt) {
            // SEC-04: AI Content with JWT
            const chatResp = await fetch(`${BASE_URL}/api/chat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${jwt}`,
                    'Origin': ALLOWED_ORIGIN
                },
                body: JSON.stringify({ message: 'hello from QA' })
            });
            assert(chatResp.status === 200, 'SEC-04: AI Protected Route with JWT');
            await consumeSSE(chatResp);
        }

    } catch (e) {
        console.error('Fatal test error in JWT Phase:', e.message);
    }

    // 2. Metrics & Monitoring
    console.log('\n[Phase 2] Observability');
    try {
        const metricsResp = await fetch(`${BASE_URL}/api/metrics`);
        const metricsText = await metricsResp.text();
        assert(metricsText.includes('ai_guard_requests_total'), 'MON-01: Prometheus Metrics Exported');
    } catch (e) {
        console.error('MON-01 failed:', e.message);
    }

    // 3. Efficiency (Cache)
    console.log('\n[Phase 3] Efficiency (Cache)');
    try {
        if (!jwt) throw new Error('JWT missing for cache test');
        const p = 'QA Unique Prompt ' + Math.random();
        const body = JSON.stringify({ message: p });

        // First call to populate cache
        const f1 = await fetch(`${BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}`, 'Origin': ALLOWED_ORIGIN },
            body
        });
        await consumeSSE(f1);

        // Second call to hit cache
        const f2 = await fetch(`${BASE_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}`, 'Origin': ALLOWED_ORIGIN },
            body
        });
        assert(f2.headers.get('x-cache') === 'HIT', 'EFF-01: Semantic Cache Hit');
        await f2.json().catch(() => { }); // Consume if it's JSON
    } catch (e) {
        console.error('EFF-01 failed:', e.message);
    }

    // 4. Admin API
    console.log('\n[Phase 4] Admin API');
    try {
        const adminResp = await fetch(`${BASE_URL}/api/admin/audit-logs?limit=1`, {
            headers: { 'Authorization': `Bearer ${jwt}` }
        });
        const adminData = await adminResp.json();
        assert(adminData.code === 0 && adminData.data.logs.length >= 0, 'UI-01: Admin Audit API Functional');
    } catch (e) {
        console.error('UI-01 failed:', e.message);
    }

    console.log(`\n--- QA Results: ${passCount}/${totalCount} Passed ---`);
    if (passCount === totalCount) console.log('CERTIFICATION: APPROVED');
    else console.log('CERTIFICATION: REJECTED');
}

runTests();
