const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createBuiltinClient, LIMITS } = require('../electron/lib/ai-workspace-client.cjs');
const { withLocale } = require('../electron/lib/localization.cjs');

const input = { systemPrompt: 'Return one synthetic result.', userContent: 'Synthetic fixture only.' };
const config = { url: 'https://fixture.invalid/v1/chat/completions?route=fixture', model: 'fixture-model', key: 'fixture-not-a-real-key' };
const responseBody = (text = '{"ok":true}', usage) => JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], ...(usage ? { usage } : {}) });

function harness({ status = 200, body = responseBody(), headers = {}, action, configOverride, synchronous = false } = {}) {
  const calls = [];
  const sockets = [];
  const client = createBuiltinClient({ getConfig: () => ({ ...config, ...configOverride }), request: (options, callback) => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.statusCode = status;
    res.headers = headers;
    res.complete = false;
    req.destroy = () => { req.destroyed = true; };
    res.destroy = () => { res.destroyed = true; };
    const call = { options, body: null };
    calls.push(call);
    sockets.push({ req, res });
    const reply = () => {
      callback(res);
      if (action) { action({ req, res }); return; }
      if (res.destroyed) return;
      res.emit('data', Buffer.from(body));
      res.complete = true;
      res.emit('end');
      res.emit('close');
    };
    req.end = sent => { call.body = sent; queueMicrotask(reply); };
    if (synchronous) reply();
    return req;
  } });
  return { client, calls, sockets };
}

test('builtin client sends one isolated bounded request using the existing configuration contract', async () => {
  const h = harness({ body: responseBody('fixture-result', { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }) });
  const result = await withLocale('ja-JP', () => h.client({ ...input, maxTokens: 32 }));
  assert.deepEqual(result, { ok: true, text: 'fixture-result', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 } });
  assert.equal(h.calls.length, 1);
  const { options, body } = h.calls[0];
  assert.equal(options.protocol, 'https:');
  assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.path, '/v1/chat/completions?route=fixture');
  assert.equal(options.headers.Authorization, `Bearer ${config.key}`);
  assert.equal(options.headers['Content-Length'], Buffer.byteLength(body));
  const payload = JSON.parse(body);
  assert.equal(payload.stream, false);
  assert.equal(payload.model, config.model);
  assert.equal(payload.max_tokens, 32);
  assert.equal(payload.messages.length, 2);
  assert.match(payload.messages[0].content, /日本語/);
  assert.equal(payload.messages[1].content, input.userContent);
  assert.equal(Object.hasOwn(payload, 'tools'), false);
  assert.equal(JSON.stringify(result).includes(config.key), false);
});

test('missing or malformed token usage is unknown rather than zero', async () => {
  for (const usage of [undefined, {}, { prompt_tokens: 5 }, { prompt_tokens: -1, completion_tokens: 2 }, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 50 }]) {
    const h = harness({ body: responseBody('ok', usage) });
    assert.equal((await h.client(input)).usage, null);
  }
  const h = harness({ body: responseBody('ok', { prompt_tokens: 2, completion_tokens: 1 }) });
  assert.deepEqual((await h.client(input)).usage, { inputTokens: 2, outputTokens: 1, totalTokens: 3 });
});

test('invalid input and configuration never perform a request or expose configuration', async () => {
  for (const args of [{ ...input, userContent: '' }, { ...input, maxTokens: 99999 }, { ...input, maxTokens: 1.5 }, { ...input, userContent: 'x'.repeat(LIMITS.inputBytes) }]) {
    const h = harness();
    assert.equal((await h.client(args)).code, 'invalid_input');
    assert.equal(h.calls.length, 0);
  }
  for (const configOverride of [{ url: 'http://fixture.invalid/' }, { url: 'https://user:secret@fixture.invalid/' }, { url: 'malformed-secret-url' }, { key: '' }, { key: 'secret\r\nInjected: value' }, { model: '' }]) {
    const h = harness({ configOverride });
    const result = await h.client(input);
    assert.equal(result.code, 'unavailable');
    assert.equal(h.calls.length, 0);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('HTTP failures and redirects are never retried, followed, or leaked', async () => {
  for (const [status, code] of [[301, 'response'], [302, 'response'], [401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'response']]) {
    const h = harness({ status, body: 'secret-upstream-body', headers: { location: 'https://other.invalid/' } });
    const result = await h.client(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(result).includes('secret'), false);
    assert.equal(h.sockets[0].req.destroyed, true);
    assert.equal(h.sockets[0].res.destroyed, true);
  }
});

test('invalid, truncated, tool-call and oversized responses cannot become usable output', async () => {
  const cases = [
    ['<html>secret</html>', 'response'], ['{}', 'response'],
    [JSON.stringify({ choices: [{ message: { content: 'partial' }, finish_reason: 'length' }] }), 'output_limit'],
    [JSON.stringify({ choices: [{ message: { content: 'ok', tool_calls: [{ function: { name: 'unsafe' } }] } }] }), 'response'],
    [responseBody('x'.repeat(LIMITS.outputBytes + 1)), 'output_limit'],
    ['x'.repeat(LIMITS.responseBytes + 1), 'output_limit']
  ];
  for (const [body, code] of cases) {
    const h = harness({ body });
    const result = await h.client(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    assert.equal(result.text, undefined);
    assert.equal(h.calls.length, 1);
  }
  const h = harness({ headers: { 'content-length': String(LIMITS.responseBytes + 1) } });
  assert.equal((await h.client(input)).code, 'output_limit');
});

test('UTF-8 split response chunks decode without corrupting content', async () => {
  const bytes = Buffer.from(responseBody('Unicode: 中文 日本語 한국어'));
  const h = harness({ action: ({ res }) => {
    for (const byte of bytes) res.emit('data', Buffer.of(byte));
    res.complete = true;
    res.emit('end');
  } });
  assert.equal((await h.client(input)).text, 'Unicode: 中文 日本語 한국어');
});

test('cancellation before request and during response is isolated and closes only its own request', async () => {
  const aborted = new AbortController();
  aborted.abort();
  const h = harness({ action: () => {} });
  assert.equal((await h.client({ ...input, signal: aborted.signal })).code, 'cancelled');
  assert.equal(h.calls.length, 0);
  const a = new AbortController();
  const b = new AbortController();
  const first = h.client({ ...input, signal: a.signal });
  const second = h.client({ ...input, signal: b.signal });
  await Promise.resolve();
  a.abort();
  assert.equal((await first).code, 'cancelled');
  assert.equal(h.sockets[0].req.destroyed, true);
  assert.equal(h.sockets[1].req.destroyed, undefined);
  h.sockets[1].res.emit('data', Buffer.from(responseBody('second')));
  h.sockets[1].res.complete = true;
  h.sockets[1].res.emit('end');
  assert.equal((await second).text, 'second');
  assert.equal(h.calls.length, 2);
});

test('absolute 90-second timeout closes the request without retrying', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness({ action: () => {} });
  const pending = h.client(input);
  await Promise.resolve();
  t.mock.timers.tick(LIMITS.timeoutMs);
  assert.equal((await pending).code, 'timeout');
  assert.equal(h.calls.length, 1);
  assert.equal(h.sockets[0].req.destroyed, true);
});

test('socket failures and synchronous failures return private safe errors once', async () => {
  for (const event of ['error', 'aborted', 'close']) {
    const h = harness({ action: ({ res }) => res.emit(event, new Error('secret')) });
    const result = await h.client(input);
    assert.equal(result.code, 'network');
    assert.equal(h.calls.length, 1);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
  const client = createBuiltinClient({ getConfig: () => config, request: () => { throw new Error('private-key'); } });
  const result = await client(input);
  assert.equal(result.code, 'network');
  assert.equal(JSON.stringify(result).includes('private-key'), false);
  const h = harness({ status: 401, synchronous: true });
  assert.equal((await h.client(input)).code, 'auth');
  assert.equal(h.sockets[0].req.destroyed, true);
});
