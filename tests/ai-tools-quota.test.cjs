const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createAiToolsNetwork, requestJson } = require('../electron/lib/ai-tools-network.cjs');
const { createAiToolsQuota, normalizeQuotaConfig } = require('../electron/lib/ai-tools-quota.cjs');

const provider = (adapter, baseUrl, extra = {}) => ({ id: adapter, name: adapter, protocol: 'openai-chat', baseUrl, apiKey: 'fixture-only-key', quota: { adapter }, ...extra });
const response = (body, status = 200, headers = {}) => ({ status, headers, body: JSON.stringify(body) });
const fixtures = [
  ['deepseek', 'https://api.deepseek.com/v1', { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '12.50' }] }, { remaining: 12.5, unit: 'CNY' }, '/user/balance'],
  ['openrouter', 'https://openrouter.ai/api/v1', { data: { total_credits: 20, total_usage: 23 } }, { remaining: -3, used: 23, total: 20, unit: 'USD' }, '/api/v1/credits'],
  ['siliconflow', 'https://api.siliconflow.cn/v1', { code: 20000, data: { totalBalance: '9.25' } }, { remaining: 9.25, unit: 'CNY' }, '/v1/user/info'],
  ['stepfun', 'https://api.stepfun.com/v1', { balance: '7.1' }, { remaining: 7.1, unit: 'CNY' }, '/v1/accounts'],
  ['novita', 'https://api.novita.ai/v3/openai', { availableBalance: 12345 }, { remaining: 1.2345, unit: 'USD' }, '/v3/user/balance'],
  ['kimi', 'https://api.kimi.com/coding/v1', { limits: [{ detail: { limit: 100, remaining: 40, resetTime: '2030-01-01T00:00:00Z' } }], usage: { limit: 200, remaining: 100 } }, { remaining: 40, used: 60, total: 100, unit: '%' }, '/coding/v1/usages'],
  ['zhipu', 'https://open.bigmodel.cn/api/paas/v4', { success: true, data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 35, nextResetTime: 1893456000000 }] } }, { remaining: 65, used: 35, total: 100, unit: '%' }, '/api/monitor/usage/quota/limit'],
  ['minimax', 'https://api.minimaxi.com/anthropic', { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'general', current_interval_remaining_percent: 80, current_weekly_status: 3, current_weekly_remaining_percent: 100, end_time: 1893456000000 }] }, { remaining: 80, used: 20, total: 100, unit: '%' }, '/v1/api/openplatform/coding_plan/remains'],
];

for (const [adapter, baseUrl, body, expected, pathname] of fixtures) test(`real ${adapter} response shape parses actual values and correct units`, async () => {
  const calls = []; const service = createAiToolsQuota({ request: async options => { calls.push(options); return response(body); }, now: () => 1000 });
  const result = await service.query(provider(adapter, baseUrl)); assert.equal(result.status, 'fresh', result.reason); assert.equal(result.observedAt, 1000);
  for (const [key, value] of Object.entries(expected)) assert.equal(result.metrics[0][key], value, key);
  assert.equal(new URL(calls[0].url).pathname, pathname); assert.equal(calls[0].headers.Authorization, adapter === 'zhipu' ? 'fixture-only-key' : 'Bearer fixture-only-key');
  assert.equal(JSON.stringify(result).includes('fixture-only-key'), false);
});

test('missing credentials and unsupported/OAuth adapters are unavailable with zero requests', async () => {
  let calls = 0; const service = createAiToolsQuota({ request: async () => { calls++; return response({}); } });
  assert.deepEqual(service.list(), []); assert.equal(service.peek('missing'), null);
  for (const input of [provider('deepseek', 'https://api.deepseek.com', { apiKey: '' }), provider('codex-oauth', 'https://chatgpt.com'), provider('unknown', 'https://example.test')]) {
    const result = await service.query(input); assert.equal(result.status, 'unavailable'); assert.deepEqual(result.metrics, []); assert.equal(result.observedAt, null);
  }
  assert.equal(calls, 0);
});

test('malformed/missing numeric fields never become a fabricated zero or unlimited quota', async () => {
  for (const [adapter, baseUrl] of fixtures) {
    const service = createAiToolsQuota({ request: async () => response({ data: {}, balance: '', balance_infos: [], model_remains: [] }) });
    const result = await service.query(provider(adapter, baseUrl)); assert.equal(result.status, 'error', adapter); assert.deepEqual(result.metrics, []);
  }
});

test('official adapters never forward a third-party inference key to an unrelated origin', async () => {
  const calls = []; const service = createAiToolsQuota({ request: async options => { calls.push(options); return response(fixtures[0][2]); } });
  const input = provider('deepseek', 'https://unrelated.example/v1');
  assert.equal((await service.query(input)).status, 'unavailable'); assert.equal(calls.length, 0);
  input.quota.credentialOrigin = 'https://api.deepseek.com';
  assert.equal((await service.query(input)).status, 'unavailable'); assert.equal(calls.length, 0);
  input.quotaKey = 'quota-only-fixture'; assert.equal((await service.query(input)).status, 'fresh');
  assert.equal(calls[0].headers.Authorization, 'Bearer quota-only-fixture'); assert.deepEqual(calls[0].credentialOrigins, ['https://api.deepseek.com']);
});

test('cache and in-flight requests isolate providers and invalidate changed credentials', async () => {
  let now = 1000; let calls = 0; let release;
  const service = createAiToolsQuota({ now: () => now, request: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const input = provider('deepseek', 'https://api.deepseek.com'); const first = service.query(input); const second = service.query(input);
  await Promise.resolve(); release(response(fixtures[0][2])); assert.deepEqual(await first, await second); assert.equal(calls, 1);
  assert.equal((await service.query(input)).status, 'fresh'); assert.equal(calls, 1);
  now += 60001; assert.equal(service.peek(input.id).status, 'stale');
  const changed = service.query({ ...input, apiKey: 'different-fixture' }); await Promise.resolve(); release(response({ balance_infos: [{ currency: 'CNY', total_balance: 2 }] }));
  assert.equal((await changed).metrics[0].remaining, 2); assert.equal(calls, 2); assert.equal(service.peek('other'), null);
});

test('cancelled and superseded responses cannot resurrect old provider quotas', async () => {
  const pending = []; const service = createAiToolsQuota({ request: () => new Promise(resolve => pending.push(resolve)) });
  const input = provider('deepseek', 'https://api.deepseek.com'); const old = service.query(input); old.catch(() => {});
  await Promise.resolve(); const fresh = service.query({ ...input, apiKey: 'new-fixture' }); await Promise.resolve();
  pending[1](response({ balance_infos: [{ currency: 'CNY', total_balance: 9 }] })); assert.equal((await fresh).metrics[0].remaining, 9);
  pending[0](response({ balance_infos: [{ currency: 'CNY', total_balance: 1 }] })); await assert.rejects(old, { code: 'AI_TOOLS_CANCELLED' });
  assert.equal(service.peek(input.id).metrics[0].remaining, 9);
  const next = service.query(input, { force: true }); next.catch(() => {}); await Promise.resolve(); service.cancel(input.id);
  await assert.rejects(next, { code: 'AI_TOOLS_CANCELLED' });
});

test('401/403 invalidate previous values while transient errors retain explicitly stale data', async () => {
  let next = response(fixtures[0][2]); let now = 1000;
  const service = createAiToolsQuota({ request: async () => { if (next instanceof Error) throw next; return next; }, now: () => now });
  const input = provider('deepseek', 'https://api.deepseek.com'); await service.query(input);
  next = new Error('do not expose private details'); now += 100;
  const stale = await service.query(input, { force: true }); assert.equal(stale.status, 'stale'); assert.equal(stale.observedAt, 1000); assert.equal(stale.metrics[0].remaining, 12.5);
  next = response({ error: 'fixture-only-key' }, 401); assert.equal((await service.query(input, { force: true })).status, 'error'); assert.deepEqual(service.peek(input.id).metrics, []);
  next = new Error('private'); assert.equal((await service.query(input, { force: true })).status, 'error');
  next = response({}, 403); assert.deepEqual((await service.query(input, { force: true })).metrics, []);
});

test('429 honors Retry-After even when force is requested', async () => {
  let now = 1000; let calls = 0;
  const service = createAiToolsQuota({ now: () => now, request: async () => { calls++; return response({}, 429, { 'retry-after': '60' }); } });
  const input = provider('deepseek', 'https://api.deepseek.com'); const result = await service.query(input);
  assert.equal(result.retryAt, 61000); assert.equal(result.status, 'error'); await service.query(input, { force: true }); assert.equal(calls, 1);
  now = 61001; await service.query(input, { force: true }); assert.equal(calls, 2);
});

test('custom queries are declarative same-origin JSON extraction with no executable code or auth headers', async () => {
  const quota = { adapter: 'custom', kind: 'balance', request: { path: '/read-only/balance', method: 'POST', headers: { 'New-Api-User': '42' }, body: { view: 'quota' } }, extract: { metrics: [{ label: '余额', unit: 'USD', remaining: 'data.wallets[0].balance' }] } };
  const normalized = normalizeQuotaConfig(quota); assert.deepEqual(normalized, quota); assert.equal(Object.isFrozen(normalized), true);
  const calls = []; const service = createAiToolsQuota({ request: async options => { calls.push(options); return response({ data: { wallets: [{ balance: '3.5' }] } }); } });
  const result = await service.query(provider('custom', 'https://private.example/v1', { quota })); assert.equal(result.metrics[0].remaining, 3.5); assert.equal(result.status, 'fresh');
  assert.equal(calls[0].url, 'https://private.example/read-only/balance'); assert.equal(calls[0].headers['New-Api-User'], '42');
  for (const bad of [{ ...quota, code: 'eval(secret)' }, { ...quota, request: { ...quota.request, path: '//other.example/steal' } },
    { ...quota, request: { ...quota.request, headers: { Authorization: 'raw secret' } } }, { ...quota, extract: { metrics: [{ label: 'x', unit: 'USD', remaining: 'constructor.prototype.secret' }] } }]) assert.throws(() => normalizeQuotaConfig(bad));
});

test('response bodies remain bounded even for an injected request implementation', async () => {
  const service = createAiToolsQuota({ request: async () => ({ status: 200, headers: {}, body: 'x'.repeat(1024 * 1024 + 1) }) });
  const result = await service.query(provider('deepseek', 'https://api.deepseek.com')); assert.equal(result.status, 'error'); assert.deepEqual(result.metrics, []);
});

test('network denies insecure/userinfo/cross-origin credential URLs before invoking transport', async () => {
  let calls = 0; const network = createAiToolsNetwork({ transport: () => { calls++; throw Error('must not run'); } });
  for (const url of ['http://example.test', 'http://localhost', 'https://user:pass@example.test', 'https://localhost']) await assert.rejects(network.requestJson({ url }));
  await assert.rejects(network.requestJson({ url: 'https://one.example', headers: { Authorization: 'fixture-secret' }, credentialOrigins: ['https://two.example'] }), { code: 'AI_TOOLS_NETWORK_ORIGIN' });
  assert.equal(calls, 0); assert.equal(typeof requestJson, 'function');
});

test('real loopback transport enforces redirects, byte limit, timeout and cancellation without credentials', async t => {
  const server = http.createServer((request, reply) => {
    if (request.url === '/redirect') { reply.writeHead(302, { location: 'https://elsewhere.example' }); reply.end(); }
    else if (request.url === '/large') reply.end('x'.repeat(200));
    else if (request.url === '/invalid-utf8') reply.end(Buffer.from([0xff, 0xfe]));
    else if (request.url === '/wait') { /* Closed by request deadline. */ }
    else reply.end(JSON.stringify({ okay: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  // Successful loopback I/O is not a 50 ms performance benchmark under CI load.
  const network = createAiToolsNetwork({ transport: http.request, allowLoopback: true, maxBytes: 100, timeoutMs: 1000 });
  assert.deepEqual(JSON.parse((await network.requestJson({ url: base })).body), { okay: true });
  await assert.rejects(network.requestJson({ url: base + '/redirect' }), { code: 'AI_TOOLS_NETWORK_REDIRECT' });
  await assert.rejects(network.requestJson({ url: base + '/large' }), { code: 'AI_TOOLS_NETWORK_TOO_LARGE' });
  await assert.rejects(network.requestJson({ url: base + '/invalid-utf8' }), { code: 'AI_TOOLS_NETWORK_RESPONSE' });
  const shortDeadline = createAiToolsNetwork({ transport: http.request, allowLoopback: true, maxBytes: 100, timeoutMs: 50 });
  await assert.rejects(shortDeadline.requestJson({ url: base + '/wait' }), { code: 'AI_TOOLS_NETWORK_TIMEOUT' });
  const controller = new AbortController(); const waiting = network.requestJson({ url: base + '/wait', signal: controller.signal }); controller.abort();
  await assert.rejects(waiting, { code: 'AI_TOOLS_CANCELLED' });
});

test('caller AbortSignal does not poison future refreshes, and disposed service cannot restart network', async () => {
  let calls = 0; const pending = [];
  const service = createAiToolsQuota({ request: async () => { calls++; return new Promise(resolve => pending.push(resolve)); } });
  const input = provider('deepseek', 'https://api.deepseek.com'); const controller = new AbortController();
  const first = service.query(input, { signal: controller.signal }); first.catch(() => {}); await Promise.resolve(); controller.abort();
  await assert.rejects(first, { code: 'AI_TOOLS_CANCELLED' });
  const second = service.query(input); await Promise.resolve(); pending[1](response(fixtures[0][2]));
  assert.equal((await second).status, 'fresh'); assert.equal(calls, 2);
  pending[0](response({ balance_infos: [{ currency: 'CNY', total_balance: 99 }] })); await Promise.resolve(); assert.equal(service.peek(input.id).metrics[0].remaining, 12.5);
  service.dispose(); assert.deepEqual(service.list(), []); await assert.rejects(service.query(input), { code: 'AI_TOOLS_DISPOSED' }); assert.equal(calls, 2);
});

test('expired stale data is unavailable and a long valid Retry-After is not silently shortened', async () => {
  let now = 1000; let next = response(fixtures[0][2]); let calls = 0;
  const service = createAiToolsQuota({ now: () => now, request: async () => { calls++; return next; } }); const input = provider('deepseek', 'https://api.deepseek.com');
  await service.query(input); now += 600001; assert.equal(service.peek(input.id).status, 'unavailable'); assert.deepEqual(service.peek(input.id).metrics, []);
  next = response({}, 429, { 'retry-after': '7200' }); const limited = await service.query(input, { force: true });
  assert.equal(limited.retryAt, now + 7200000); now += 3600001; await service.query(input, { force: true }); assert.equal(calls, 2);
});

test('metadata rejects credentials in query parameters, body and nominally public headers', () => {
  const config = { adapter: 'custom', request: { path: '/quota', method: 'POST' }, extract: { metrics: [{ label: 'balance', unit: 'USD', remaining: 'balance' }] } };
  for (const parameter of ['token', 'api_key', 'apiKey', 'access_token', 'auth', 'cookie', 'password', 'key']) assert.throws(() => normalizeQuotaConfig({ ...config, request: { ...config.request, path: `/quota?${parameter}=private` } }));
  assert.throws(() => normalizeQuotaConfig({ ...config, request: { ...config.request, body: { nested: { password: 'private' } } } }));
  assert.throws(() => normalizeQuotaConfig({ ...config, request: { ...config.request, headers: { Accept: 'Bearer private' } } }));
  assert.throws(() => normalizeQuotaConfig({ ...config, request: { ...config.request, headers: { 'New-Api-User': 'not-a-user-id' } } }));
});

test('MiniMax legacy domestic endpoint and StepFun alias require explicit independent query-key origin', async () => {
  const calls = []; const service = createAiToolsQuota({ request: async options => { calls.push(options); return response(options.url.includes('minimaxi') ? fixtures[7][2] : fixtures[3][2]); } });
  const minimax = provider('minimax', 'https://api.minimax.cn/anthropic'); const stepfun = provider('stepfun', 'https://api.stepfun.ai/v1');
  assert.equal((await service.query(minimax)).status, 'unavailable'); assert.equal((await service.query(stepfun)).status, 'unavailable'); assert.equal(calls.length, 0);
  for (const [input, origin] of [[minimax, 'https://api.minimaxi.com'], [stepfun, 'https://api.stepfun.com']]) assert.equal((await service.query({ ...input, quotaKey: 'independent-fixture', quota: { adapter: input.id, credentialOrigin: origin } })).status, 'fresh');
  assert.equal(calls.length, 2); assert.equal(calls.every(call => call.headers.Authorization === 'Bearer independent-fixture'), true);
});
