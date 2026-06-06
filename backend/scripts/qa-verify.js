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
