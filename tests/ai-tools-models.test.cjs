const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiToolsModels } = require('../electron/lib/ai-tools-models.cjs');

test('model checks query only the provider models endpoint and never perform inference', async () => {
  const calls = [];
  const models = createAiToolsModels({ request: async args => { calls.push(args); return { status: 200, body: JSON.stringify({ data: [{ id: 'a' }, { id: 'a' }, { id: 'b' }] }) }; } });
  const provider = { id: 'p', baseUrl: 'https://example.com/v1', protocol: 'openai-responses', apiKey: 'fixture-only' };
  assert.deepEqual((await models.list(provider)).models.map(item => item.id), ['a', 'b']);
  assert.equal(calls[0].url, 'https://example.com/v1/models');
  assert.equal(calls[0].method, 'GET'); assert.equal(calls[0].body, undefined);
  assert.deepEqual(calls[0].credentialOrigins, ['https://example.com']);
  assert.ok(!(JSON.stringify(await models.test(provider))).includes('fixture-only'));
});

test('native Anthropic and Gemini model responses use dedicated headers without query secrets', async () => {
  const calls = [];
  const models = createAiToolsModels({ request: async args => { calls.push(args); return { status: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-test', displayName: 'Test' }], data: [{ id: 'claude-test' }] }) }; } });
  await models.list({ baseUrl: 'https://anthropic.example', protocol: 'anthropic', apiKey: 'secret' });
  assert.equal(calls[0].url, 'https://anthropic.example/v1/models'); assert.equal(calls[0].headers['x-api-key'], 'secret');
  const result = await models.list({ baseUrl: 'https://gemini.example/v1beta', protocol: 'gemini', apiKey: 'secret' });
  assert.equal(calls[1].url, 'https://gemini.example/v1beta/models'); assert.equal(calls[1].headers['x-goog-api-key'], 'secret');
  assert.deepEqual(result.models, [{ id: 'gemini-test', name: 'Test' }]);
});

test('missing credentials and unknown protocols never send requests; auth failures are sanitized', async () => {
  let called = 0;
  const models = createAiToolsModels({ request: async () => { called++; return { status: 401, body: 'private server token' }; } });
  await assert.rejects(models.list({ baseUrl: 'https://example.com', protocol: 'openai-chat' }), /密钥/);
  await assert.rejects(models.list({ baseUrl: 'https://example.com', protocol: 'unknown', apiKey: 'x' }), /协议/);
  assert.equal(called, 0);
  await assert.rejects(models.list({ baseUrl: 'https://example.com', protocol: 'openai-chat', apiKey: 'x' }), error => error.code === 'AI_TOOLS_PROVIDER_AUTH' && !error.message.includes('private'));
});

const fixtureProvider = { baseUrl: 'https://fixture.invalid/api/anthropic', protocol: 'anthropic', apiKey: 'fixture-private-key' };
function responding(status, body) {
  let clock = 100;
  return createAiToolsModels({ now: () => clock += 5, request: async args => {
    assert.equal(args.method, 'GET'); assert.equal(args.body, undefined);
    assert.equal(args.url, 'https://fixture.invalid/api/anthropic/models');
    return { status, body: typeof body === 'string' ? body : JSON.stringify(body) };
  } });
}

test('connection tests report verified model discovery with explicit capability and authentication fields', async () => {
  const result = await responding(200, { data: [{ id: 'manual-model' }] }).test(fixtureProvider);
  assert.equal(result.reachable, true); assert.equal(result.status, 'verified');
  assert.equal(result.modelsSupported, true); assert.equal(result.authentication, 'unverified');
  assert.equal(result.message, '模型列表读取成功，未验证付费模型调用/密钥权限');
  assert.equal(result.modelCount, 1); assert.ok(result.checkedAt >= 100); assert.ok(result.latencyMs >= 0);
  assert.ok(!JSON.stringify(result).includes(fixtureProvider.apiKey));
});

test('unsupported HTTP routes or absent model-list schemas are partial without authenticating the key', async () => {
  for (const [status, body] of [[404, '<html>missing route</html>'], [405, { error: { type: 'method_not_allowed' } }], [501, {}],
    [200, {}], [200, { message: 'Please configure a model manually' }], [200, { data: { available: false } }],
    [200, { error: { code: 'models_not_supported', message: 'Models list is not supported' } }]]) {
    const service = responding(status, body);
    await assert.rejects(service.list(fixtureProvider), { code: 'AI_TOOLS_MODELS_UNSUPPORTED' });
    const result = await service.test(fixtureProvider);
    assert.equal(result.status, 'partial'); assert.equal(result.reachable, true);
    assert.equal(result.modelsSupported, false); assert.equal(result.authentication, 'unverified');
    assert.match(result.message, /尚未验证密钥\/模型调用/); assert.equal(result.modelCount, undefined);
    assert.ok(result.checkedAt >= 100); assert.ok(result.latencyMs >= 0);
  }
});

test('HTTP failures and error envelopes never become a partial or verified connection', async () => {
  const cases = [
    [401, {}, 'AI_TOOLS_PROVIDER_AUTH'], [403, {}, 'AI_TOOLS_PROVIDER_AUTH'],
    [429, {}, 'AI_TOOLS_PROVIDER_RATE_LIMIT'], [500, {}, 'AI_TOOLS_PROVIDER_HTTP'], [503, {}, 'AI_TOOLS_PROVIDER_HTTP'],
    [200, { error: { type: 'authentication_error', message: 'fixture-private-key' } }, 'AI_TOOLS_PROVIDER_AUTH'],
    [200, { error: { code: 401, message: 'fixture-private-key' } }, 'AI_TOOLS_PROVIDER_AUTH'],
    [404, { error: { type: 'invalid_api_key', message: 'fixture-private-key' } }, 'AI_TOOLS_PROVIDER_AUTH'],
    [501, { error: { code: 429 } }, 'AI_TOOLS_PROVIDER_RATE_LIMIT'],
    [200, { success: false, code: 1001, message: 'fixture-private-key' }, 'AI_TOOLS_PROVIDER_RESPONSE'],
    [200, { code: 'bad_request', data: [{ id: 'misleading' }] }, 'AI_TOOLS_PROVIDER_RESPONSE'],
    [200, { errors: [{ code: 'permission_denied' }], data: [] }, 'AI_TOOLS_PROVIDER_AUTH'],
    [200, { status: 'failed', message: 'fixture-private-key' }, 'AI_TOOLS_PROVIDER_RESPONSE'],
    [200, { error: { type: 'rate_limit_error' } }, 'AI_TOOLS_PROVIDER_RATE_LIMIT'],
    [200, { message: 'Invalid API key: fixture-private-key' }, 'AI_TOOLS_PROVIDER_AUTH'],
    [200, { data: { error: { type: 'authentication_error' } } }, 'AI_TOOLS_PROVIDER_AUTH'],
    [404, { data: { error: { code: 403 } } }, 'AI_TOOLS_PROVIDER_AUTH'],
    [200, { data: { success: false, message: 'fixture-private-key' } }, 'AI_TOOLS_PROVIDER_RESPONSE'],
    [200, { errors: [{ message: 'fixture-private-key' }] }, 'AI_TOOLS_PROVIDER_RESPONSE'],
    [200, { error: { code: 'model_not_found', message: 'Model unavailable' } }, 'AI_TOOLS_PROVIDER_RESPONSE'],
  ];
  for (const [status, body, code] of cases) {
    const service = responding(status, body);
    for (const action of ['list', 'test']) await assert.rejects(service[action](fixtureProvider), error =>
      error.code === code && !JSON.stringify({ ...error, message: error.message }).includes(fixtureProvider.apiKey));
  }
});

test('malformed JSON and invalid list rows are response errors; empty supported lists remain valid', async () => {
  for (const body of ['not json', 'null', '[]', '42', { data: [{ invalid: true }, { id: '\n' }] }]) {
    await assert.rejects(responding(200, body).test(fixtureProvider), { code: 'AI_TOOLS_PROVIDER_RESPONSE' });
  }
  const result = await responding(200, { success: true, code: 0, data: [] }).test(fixtureProvider);
  assert.equal(result.status, 'verified'); assert.equal(result.modelCount, 0);
});

test('cancelled operations never issue a request or downgrade a late response to partial', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const service = createAiToolsModels({ request: async () => { calls++; return { status: 404, body: '{}' }; } });
  await assert.rejects(service.test(fixtureProvider, { signal: controller.signal }), { code: 'AI_TOOLS_CANCELLED' });
  assert.equal(calls, 0);
  const late = new AbortController();
  const lateService = createAiToolsModels({ request: async () => { late.abort(); return { status: 404, body: '{}' }; } });
  await assert.rejects(lateService.test(fixtureProvider, { signal: late.signal }), { code: 'AI_TOOLS_CANCELLED' });
});

test('network, timeout and cancellation errors are preserved instead of being swallowed', async () => {
  for (const code of ['AI_TOOLS_NETWORK_TIMEOUT', 'AI_TOOLS_NETWORK_FAILED', 'AI_TOOLS_CANCELLED']) {
    const failure = Object.assign(new Error('sanitized network failure'), { code });
    const service = createAiToolsModels({ request: async () => { throw failure; } });
    await assert.rejects(service.test(fixtureProvider), error => error === failure);
  }
});

test('locally resolved models retain the existing no-network path', async () => {
  const service = createAiToolsModels({ resolveLocal: () => ({ models: [{ id: 'local-model' }], checkedAt: 123, latencyMs: 0 }), request: async () => { throw Error('must not request'); } });
  assert.equal((await service.list(fixtureProvider)).models[0].id, 'local-model');
  assert.deepEqual(await service.test(fixtureProvider), { reachable: true, status: 'verified', modelsSupported: true,
    authentication: 'unverified', message: '模型列表读取成功，未验证付费模型调用/密钥权限', latencyMs: 0, modelCount: 1, checkedAt: 123 });
});

test('a public models endpoint cannot verify a supplied API key or paid-inference permission', async () => {
  const service = createAiToolsModels({ request: async () => ({ status: 200, body: '{"data":[{"id":"public-model"}]}' }) });
  for (const apiKey of ['fixture-invalid-key', 'fixture-expired-key']) {
    const result = await service.test({ ...fixtureProvider, apiKey });
    assert.equal(result.status, 'verified'); assert.equal(result.modelsSupported, true);
    assert.equal(result.authentication, 'unverified');
    assert.match(result.message, /未验证付费模型调用\/密钥权限/);
  }
});

test('real network wrapper timeout and abort remain errors without any paid or real network request', async () => {
  const { EventEmitter } = require('node:events');
  const { createAiToolsNetwork } = require('../electron/lib/ai-tools-network.cjs');
  const requests = [];
  const network = createAiToolsNetwork({ timeoutMs: 10, transport: (_url, options) => {
    const request = new EventEmitter(); request.end = () => {}; request.destroy = () => { request.destroyed = true; };
    assert.equal(options.method, 'GET'); requests.push(request); return request;
  } });
  const service = createAiToolsModels({ request: network.requestJson });
  await assert.rejects(service.test(fixtureProvider), { code: 'AI_TOOLS_NETWORK_TIMEOUT' });
  assert.equal(requests[0].destroyed, true);
  const abort = new AbortController();
  const pending = service.test(fixtureProvider, { signal: abort.signal }); abort.abort();
  await assert.rejects(pending, { code: 'AI_TOOLS_CANCELLED' });
  assert.equal(requests[1].destroyed, true);
});
