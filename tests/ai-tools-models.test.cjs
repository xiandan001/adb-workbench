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
