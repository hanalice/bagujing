/**
 * D21 / P1-5：主备 Base URL failover（单元）。
 * 契约名 OPENAI_BASE_URL_FALLBACK；解析见 resolveUpstreamBaseUrls / buildLlmConfig.fallbackBaseURL。
 * 用例 ID 对齐 docs/test_cases.md §2.29。
 */
import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmConfig, resolveUpstreamBaseUrls } from '../llm.js';
import {
  invokeWithBaseUrlFailover,
  streamWithBaseUrlFailover,
  withBaseUrlFailover,
} from '../upstream-failover.js';
import {
  invokeWithRetry,
  resetUpstreamRetryForTests,
  setUpstreamRetryForTests,
} from '../upstream-retry.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_BASE_URL_FALLBACK', 'OPENAI_MODEL'];

function saveEnv() {
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  return saved;
}

function restoreEnv(saved) {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

function makeConnRefused() {
  const err = new Error('connect ECONNREFUSED');
  err.code = 'ECONNREFUSED';
  return err;
}

function makeUpstreamError(status, message = `upstream ${status}`) {
  const err = new Error(message);
  err.status = status;
  return err;
}

const OK_CONTENT = {
  content: '{"summary":"ok","keyPoints":["k"],"nextStep":"n"}',
};

describe('D21 / P1-5: 主备 Base URL failover', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = saveEnv();
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.OPENAI_API_KEY = 'sk-failover-ut';
    resetUpstreamRetryForTests();
  });

  afterEach(() => {
    resetUpstreamRetryForTests();
    restoreEnv(savedEnv);
  });

  it('UT-FAILOVER-01: 未配置备用：主失败不切备、行为不变', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.invalid/v1';
    delete process.env.OPENAI_BASE_URL_FALLBACK;

    const resolved = resolveUpstreamBaseUrls();
    assert.equal(resolved.fallback, null);
    assert.equal(buildLlmConfig({}).fallbackBaseURL, null);

    const baseUrls = [];
    await assert.rejects(
      () => invokeWithBaseUrlFailover(async (baseURL) => {
        baseUrls.push(baseURL);
        throw makeConnRefused();
      }),
      (err) => err.code === 'ECONNREFUSED',
    );
    assert.deepEqual(baseUrls, ['http://primary.invalid/v1']);
    assert.equal(baseUrls.filter((u) => u.includes('backup')).length, 0);

    // 空白备用亦等同未配置
    process.env.OPENAI_BASE_URL_FALLBACK = '';
    assert.equal(resolveUpstreamBaseUrls().fallback, null);
  });

  it('UT-FAILOVER-02: 配置解析：主备 URL 同时可读', () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    const resolved = resolveUpstreamBaseUrls();
    assert.equal(resolved.primary, 'http://primary.test/v1');
    assert.equal(resolved.fallback, 'http://backup.test/v1');

    const cfg = buildLlmConfig({});
    assert.equal(cfg.configuration.baseURL, 'http://primary.test/v1');
    assert.equal(cfg.fallbackBaseURL, 'http://backup.test/v1');
    assert.notEqual(cfg.configuration.baseURL, cfg.fallbackBaseURL);
  });

  it('UT-FAILOVER-03: 主在首字节前失败：切备用且仅备成功一次', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    const callOrder = [];
    const result = await withBaseUrlFailover(async (baseURL) => {
      callOrder.push(baseURL);
      if (baseURL.includes('primary')) throw makeConnRefused();
      return OK_CONTENT;
    });

    assert.deepEqual(callOrder, [
      'http://primary.test/v1',
      'http://backup.test/v1',
    ]);
    assert.equal(callOrder.length, 2);
    assert.equal(result, OK_CONTENT);
  });

  it('UT-FAILOVER-04: 主首次即成功：零次备用调用', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    let backupCalls = 0;
    const result = await invokeWithBaseUrlFailover(async (baseURL) => {
      if (baseURL.includes('backup')) {
        backupCalls += 1;
        throw new Error('backup should not be called');
      }
      return { content: 'from-primary' };
    });

    assert.equal(backupCalls, 0);
    assert.equal(result.content, 'from-primary');
  });

  it('UT-FAILOVER-05: chat：已写过 delta 后主失败不得切备', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    let firstDeltaSent = false;
    let backupCalls = 0;
    const events = [];

    await assert.rejects(
      () => streamWithBaseUrlFailover(async (baseURL) => {
        if (baseURL.includes('backup')) {
          backupCalls += 1;
          events.push({ type: 'delta', text: 'FROM-BACKUP' });
          return;
        }
        // 主流：先产出可映射为 delta 的 chunk，再 throw
        events.push({ type: 'delta', text: 'HELLO' });
        firstDeltaSent = true;
        throw new Error('mid-stream fail');
      }, { getHasSentDelta: () => firstDeltaSent }),
      (err) => err.message === 'mid-stream fail',
    );

    assert.equal(firstDeltaSent, true);
    assert.equal(backupCalls, 0);
    assert.ok(events.some((e) => e.type === 'delta' && e.text === 'HELLO'));
    assert.ok(!events.some((e) => e.text === 'FROM-BACKUP'));
  });

  it('UT-FAILOVER-06: chat：首 delta 前失败则切备，对用户仍一条流', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    let firstDeltaSent = false;
    const events = [];
    const baseUrls = [];

    await streamWithBaseUrlFailover(async (baseURL) => {
      baseUrls.push(baseURL);
      if (baseURL.includes('primary')) {
        // 零 chunk 即 reject
        throw makeConnRefused();
      }
      events.push({ type: 'delta', text: 'chunk-A' });
      firstDeltaSent = true;
      events.push({ type: 'done' });
    }, { getHasSentDelta: () => firstDeltaSent });

    assert.deepEqual(baseUrls, [
      'http://primary.test/v1',
      'http://backup.test/v1',
    ]);
    assert.deepEqual(events.map((e) => e.type), ['delta', 'done']);
    assert.equal(events[0].text, 'chunk-A');
    // 同一事件通道累计，无第二条响应语义
    assert.equal(events.filter((e) => e.type === 'done').length, 1);
  });

  it('UT-FAILOVER-07: 不做：跨请求会话级 failover', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    // 请求 A：主败备成
    await invokeWithBaseUrlFailover(async (baseURL) => {
      if (baseURL.includes('primary')) throw makeConnRefused();
      return OK_CONTENT;
    });

    // 请求 B：新一次封装，主首次即成功
    let backupCalls = 0;
    const order = [];
    const result = await invokeWithBaseUrlFailover(async (baseURL) => {
      order.push(baseURL);
      if (baseURL.includes('backup')) {
        backupCalls += 1;
        throw new Error('should not backup');
      }
      return { content: 'req-b-primary' };
    });

    assert.equal(order[0], 'http://primary.test/v1');
    assert.equal(backupCalls, 0);
    assert.equal(result.content, 'req-b-primary');
  });

  it('UT-FAILOVER-08: 不做：已中断流不得伪装续传', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';

    let firstDeltaSent = false;
    let backupCalls = 0;
    const clientText = [];

    await assert.rejects(
      () => streamWithBaseUrlFailover(async (baseURL) => {
        if (baseURL.includes('backup')) {
          backupCalls += 1;
          clientText.push('WORLD');
          return;
        }
        clientText.push('HELLO');
        firstDeltaSent = true;
        throw new Error('stream interrupted');
      }, { getHasSentDelta: () => firstDeltaSent }),
      (err) => err.message === 'stream interrupted',
    );

    assert.equal(backupCalls, 0);
    assert.deepEqual(clientText, ['HELLO']);
    assert.ok(!clientText.includes('WORLD'));
  });

  it('UT-FAILOVER-09: generate：主 invoke 失败后备用成功', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.test/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = 'http://backup.test/v1';
    // 降噪：同 URL 不重试，使 primary 仅 1 次（failover 包装在单次 attempt 外）
    setUpstreamRetryForTests({ jitterMs: [0], sleep: async () => {} });

    const callOrder = [];
    const backupContent = {
      content: '{"summary":"backup","keyPoints":["bk"],"nextStep":"bn"}',
    };

    const result = await invokeWithBaseUrlFailover(async (baseURL) => {
      return invokeWithRetry(async () => {
        callOrder.push(baseURL);
        if (baseURL.includes('primary')) throw makeUpstreamError(503);
        return backupContent;
      }, { maxRetries: 0 });
    });

    assert.deepEqual(callOrder, [
      'http://primary.test/v1',
      'http://backup.test/v1',
    ]);
    assert.equal(result, backupContent);
    assert.ok(!callOrder.slice(2).some((u) => u.includes('primary')));
  });

  it('UT-FAILOVER-10: 空白备用等同未配置', async () => {
    process.env.OPENAI_BASE_URL = 'http://primary.invalid/v1';
    process.env.OPENAI_BASE_URL_FALLBACK = '  ';

    const resolved = resolveUpstreamBaseUrls();
    assert.equal(resolved.fallback, null);
    assert.equal(buildLlmConfig({}).fallbackBaseURL, null);

    process.env.OPENAI_BASE_URL_FALLBACK = '\t';
    assert.equal(resolveUpstreamBaseUrls().fallback, null);

    let backupCreates = 0;
    await assert.rejects(
      () => invokeWithBaseUrlFailover(async (baseURL) => {
        if (baseURL.trim() === '' || /\s/.test(baseURL) === false && baseURL.includes('backup')) {
          backupCreates += 1;
        }
        // 若误把空白当 URL 传入也会落在这里计数
        if (!baseURL || !baseURL.trim()) backupCreates += 1;
        throw makeConnRefused();
      }),
      (err) => err.code === 'ECONNREFUSED',
    );
    assert.equal(backupCreates, 0);
  });
});
