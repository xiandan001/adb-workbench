const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiToolsProbe, probePlan } = require('../electron/lib/ai-tools-probe.cjs');
const provider = (extra = {}) => ({ id: 'fixture', name: 'fixture', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-fixture', apiKey: 'fixture-not-real-key', ...extra });
const message = { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'OK' }], usage: { input_tokens: 15, output_tokens: 6 }, stop_reason: 'end_turn' };
test('the GLM call uses its real Messages path, Bearer authentication and a fixed bounded prompt without model discovery', async () => {
  const calls = []; const probe = createAiToolsProbe({ request: async args => { calls.push(args); return { status: 200, body: JSON.stringify(message) }; } });
  const result = await probe.run(provider(), { prompt: 'must not be sent', projectFiles: ['private'] });
  assert.equal(calls.length, 1); const call = calls[0];
  assert.equal(call.url, 'https://open.bigmodel.cn/api/anthropic/v1/messages'); assert.equal(call.method, 'POST');
  assert.equal(call.headers.Authorization, 'Bearer fixture-not-real-key'); assert.equal(call.headers['x-api-key'], undefined);
  assert.deepEqual(call.body, { model: 'glm-fixture', max_tokens: 16, stream: false, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'Reply OK.' }] });
  assert.deepEqual(call.credentialOrigins, ['https://open.bigmodel.cn']);
  assert.equal(result.inferenceVerified, true); assert.equal(result.hasTextResponse, true); assert.equal(result.outputTokens, 6);
  assert.equal(JSON.stringify(result).includes('fixture-not-real-key'), false); assert.equal(Object.hasOwn(result, 'text'), false);
});
test('Claude explicit API-key mode and role aliases preserve configuration semantics', async () => {
  const calls = []; const probe = createAiToolsProbe({ request: async args => { calls.push(args); return { status: 200, body: JSON.stringify(message) }; } });
  const p = provider({ baseUrl: 'https://fixture.invalid/v1', model: 'sonnet', claudeModels: { sonnet: { model: 'custom-model[1m]' } }, cliConfig: { claude: { authField: 'ANTHROPIC_API_KEY' } } });
  await probe.run(p); assert.equal(calls[0].url, 'https://fixture.invalid/v1/messages'); assert.equal(calls[0].body.model, 'custom-model');
  assert.equal(calls[0].headers['x-api-key'], p.apiKey); assert.equal(calls[0].headers.Authorization, undefined);
});
test('Responses, Chat and Gemini use separate native payloads; no tools, streams or arbitrary extra body', async () => {
  for (const [protocol, response, suffix] of [
    ['openai-responses', { object: 'response', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }], usage: { input_tokens: 2, output_tokens: 1 } }, '/v1/responses'],
    ['openai-chat', { object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } }, '/v1/chat/completions'],
    ['gemini', { candidates: [{ content: { parts: [{ text: 'OK' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } }, '/v1beta/models/glm-fixture:generateContent'],
  ]) {
    let sent; const probe = createAiToolsProbe({ request: async args => { sent = args; return { status: 200, body: JSON.stringify(response) }; } });
    const result = await probe.run(provider({ protocol, baseUrl: 'https://fixture.invalid' }));
    assert.equal(sent.url, `https://fixture.invalid${suffix}`); assert.equal(result.inferenceVerified, true);
    assert.equal(Object.hasOwn(sent.body, 'tools'), false); assert.equal(sent.body.stream === true, false);
    if (protocol === 'openai-responses') { assert.equal(sent.body.store, false); assert.equal(sent.body.max_output_tokens, 16); }
    if (protocol === 'gemini') { assert.equal(sent.headers['x-goog-api-key'], 'fixture-not-real-key'); assert.ok(!sent.url.includes('key=')); }
  }
});
test('a bounded reasoning response can confirm acceptance without falsely claiming visible text', async () => {
  const probe = createAiToolsProbe({ request: async () => ({ status: 200, body: JSON.stringify({ object: 'response', status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' }, usage: { output_tokens: 16 } }) }) });
  const result = await probe.run(provider({ protocol: 'openai-responses', baseUrl: 'https://fixture.invalid/v1' }));
  assert.equal(result.inferenceVerified, true); assert.equal(result.hasTextResponse, false); assert.equal(result.outputLimited, true);
});
test('protocol mismatches, full operation URLs and unauthorized local routes cannot transmit credentials', async () => {
  assert.throws(() => probePlan(provider({ protocol: 'openai-responses' })), { code: 'AI_TOOLS_PROBE_PROTOCOL' });
  assert.throws(() => probePlan(provider({ baseUrl: 'https://fixture.invalid/v1/messages' })), { code: 'AI_TOOLS_PROBE_URL' });
  assert.throws(() => probePlan(provider({ baseUrl: 'http://127.0.0.1:3456/v1' })), { code: 'AI_TOOLS_PROBE_URL' });
  assert.throws(() => probePlan(provider({ baseUrl: 'https://fixture.invalid/?key=private' })), { code: 'AI_TOOLS_PROBE_URL' });
  let sent = 0; const local = createAiToolsProbe({ request: async () => { throw Error('unexpected remote'); }, requestLocal: async () => { sent++; return { status: 200, body: JSON.stringify(message) }; }, resolveLocal: () => ({ models: [] }) });
  await local.run(provider({ baseUrl: 'http://127.0.0.1:3456/v1' })); assert.equal(sent, 1);
});
test('response errors are bounded and sanitized, and no failure retries or downgrades to success', async () => {
  for (const [status, body, code] of [[401, '{}', 'AI_TOOLS_PROBE_AUTH'], [403, '<html>denied</html>', 'AI_TOOLS_PROBE_AUTH'], [429, '<html>busy</html>', 'AI_TOOLS_PROBE_RATE_LIMIT'], [429, '{}', 'AI_TOOLS_PROBE_RATE_LIMIT'], [500, 'invalid JSON', 'AI_TOOLS_PROBE_RESPONSE'], [200, '{}', 'AI_TOOLS_PROBE_RESPONSE'], [200, JSON.stringify({ error: { type: 'model_not_found', message: 'private-upstream-key' } }), 'AI_TOOLS_PROBE_MODEL']]) {
    let count = 0; const probe = createAiToolsProbe({ request: async () => { count++; return { status, body }; } });
    await assert.rejects(probe.run(provider()), error => error.code === code && !error.message.includes('private-upstream-key')); assert.equal(count, 1);
  }
});
test('cancellation and timeouts do not make a second billed request', async () => {
  let count = 0; const abort = new AbortController(); abort.abort();
  const probe = createAiToolsProbe({ request: async () => { count++; throw Object.assign(new Error('timeout'), { code: 'AI_TOOLS_NETWORK_TIMEOUT' }); } });
  await assert.rejects(probe.run(provider(), { signal: abort.signal }), { code: 'AI_TOOLS_CANCELLED' }); assert.equal(count, 0);
  await assert.rejects(probe.run(provider()), error => error.code === 'AI_TOOLS_PROBE_TIMEOUT' && error.message.includes('未自动重试')); assert.equal(count, 1);
});
test('Codex safe static request headers are used, credentials cannot be replaced by header overrides', async () => {
  let sent; const reply = { object: 'response', status: 'completed', output: [{ content: [{ type: 'output_text', text: 'OK' }] }] };
  const probe = createAiToolsProbe({ request: async args => { sent = args; return { status: 200, body: JSON.stringify(reply) }; } });
  const p = provider({ protocol: 'openai-responses', baseUrl: 'https://fixture.invalid/v1', cliConfig: { codex: { httpHeaders: { 'User-Agent': 'TestClient', 'X-Title': null } } } });
  await probe.run(p); assert.equal(sent.headers['User-Agent'], 'TestClient'); assert.equal(sent.headers.Authorization, 'Bearer fixture-not-real-key');
  assert.equal(Object.hasOwn(sent.headers, 'X-Title'), false);
  sent = null; await assert.rejects(probe.run({ ...p, cliConfig: { codex: { httpHeaders: { Authorization: 'override' } } } })); assert.equal(sent, null);
});
