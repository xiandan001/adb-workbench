'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Worker } = require('node:worker_threads');
const https = require('node:https');

// Only the separate synthetic fixture is ever loaded. These tests never see
// the production addon or make a real network request.
const fixturePath = path.resolve(__dirname, '../.superpowers/builtin-ai-fixture/veylo-builtin-ai.node');
const fixtureOptions = { skip: !existsSync(fixturePath) };
const payload = '{"stream":true}';
const options = signal => ({
  protocol: 'https:', hostname: 'apihub.agnes-ai.com', path: '/v1/chat/completions', port: '443', method: 'POST',
  signal, timeout: 8000, rejectUnauthorized: false, socketPath: 'untrusted override',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload),
    Accept: 'text/event-stream', 'X-Unapproved': 'not forwarded' },
});

test('fixture native transport captures its own HTTPS entry and forwards only safe facade events', fixtureOptions, async t => {
  const original = https.request;
  let calls = 0, captured = {}, respond;
  const request = new EventEmitter();
  const rawHeaders = { 'content-type': 'text/event-stream', 'content-length': '16', authorization: 'fixture-response-private' };
  const response = new EventEmitter();
  Object.assign(response, {
    statusCode: 200, headers: rawHeaders, complete: false, req: request,
    resume() { this.resumed = true; return this; },
    destroy() { this.destroyed = true; return this; },
  });
  Object.assign(request, {
    end(body) { this.body = body; return this; },
    setTimeout(timeout) { this.timeout = timeout; return this; },
    destroy(error) { this.error = error; return this; },
    getHeader() { return 'fixture-private-request'; },
  });
  https.request = (_options, callback) => {
    calls++;
    captured = {
      protocol: _options.protocol, hostname: _options.hostname, port: _options.port,
      path: _options.path, method: _options.method, signal: _options.signal, timeout: _options.timeout,
      rejectUnauthorized: _options.rejectUnauthorized, socketPath: _options.socketPath,
      length: _options.headers['Content-Length'], contentType: _options.headers['Content-Type'], accept: _options.headers.Accept,
      authorizationMatchesFixture: _options.headers.Authorization === 'Bearer veylo-native-test-only-credential-41',
      unapprovedPresent: Object.hasOwn(_options.headers, 'X-Unapproved'),
    };
    respond = callback;
    return request;
  };
  t.after(() => { https.request = original; });
  const addon = require(fixturePath);
  https.request = () => { throw Error('HTTPS must be captured at initialization'); };
  assert.equal(addon.url, 'https://apihub.agnes-ai.com/v1/chat/completions');
  assert.equal(addon.model, 'agnes-3.0-flash');
  assert.ok(addon.keyCount >= 1);
  const initial = addon.initialSlot();
  assert.ok(initial >= 0 && initial < addon.keyCount);
  assert.equal(addon.currentSlot(), initial);
  assert.equal(addon.nextSlot(), (initial + 1) % addon.keyCount);
  assert.equal(addon.initialSlot(), initial);
  assert.throws(() => { addon.url = 'https://invalid.example'; }, TypeError);
  assert.throws(() => addon.dispatch(-1, options(), () => {}), { code: 'AI_BUILTIN_INVALID' });
  for (const override of [{ hostname: 'invalid.example' }, { path: '/v1/chat/completions?extra=1' },
    { protocol: 'http:' }, { port: 444 }, { method: 'GET' }, { timeout: 120001 },
    { headers: { ...options().headers, Accept: 'not a supported MIME type' } }]) {
    assert.throws(() => addon.dispatch(0, { ...options(), ...override }, () => {}), { code: 'AI_BUILTIN_INVALID' });
  }
  assert.equal(calls, 0);

  const controller = new AbortController();
  let incoming, callbackReceiver, observedError, observedChunk, dataReceiver, endCount = 0;
  const facade = addon.dispatch(0, options(controller.signal), function (view) {
    incoming = view; callbackReceiver = this;
    view.on('data', function (chunk) { observedChunk = chunk; dataReceiver = this; });
    view.once('end', () => { endCount++; });
  });
  assert.equal(calls, 1);
  assert.deepEqual(captured, {
    protocol: 'https:', hostname: 'apihub.agnes-ai.com', port: 443, path: '/v1/chat/completions', method: 'POST',
    signal: controller.signal, timeout: 8000, rejectUnauthorized: true, socketPath: undefined,
    length: Buffer.byteLength(payload), contentType: 'application/json', accept: 'text/event-stream',
    authorizationMatchesFixture: true, unapprovedPresent: false,
  });
  assert.equal(facade.getHeader, undefined);
  assert.equal(facade._header, undefined);
  assert.throws(() => facade.on('response', () => {}), { code: 'AI_BUILTIN_INVALID' });
  assert.equal(facade.setTimeout(25).end(payload), facade);
  assert.equal(request.timeout, 25);
  assert.equal(request.body, payload);
  facade.once('error', function (error) { assert.equal(this, undefined); observedError = error; });

  respond.call(request, response);
  assert.equal(callbackReceiver, undefined);
  assert.equal(incoming.req, undefined);
  assert.equal(incoming.headers.authorization, undefined);
  assert.equal(incoming.statusCode, 200);
  assert.equal(incoming.headers['content-type'], 'text/event-stream');
  assert.equal(incoming.complete, false);
  const chunk = Buffer.from('data: {}\r\n');
  response.emit('data', chunk);
  response.complete = true;
  response.emit('end');
  response.emit('end');
  assert.equal(observedChunk, chunk);
  assert.equal(dataReceiver, undefined);
  assert.equal(endCount, 1);
  assert.equal(incoming.complete, true);
  assert.equal(incoming.resume().destroy(), incoming);
  assert.equal(response.resumed, true);
  assert.equal(response.destroyed, true);

  const rawError = Object.assign(new Error('private transport metadata'), { name: 'AbortError', code: 'ABORT_ERR', request });
  assert.equal(facade.destroy(rawError), facade);
  request.emit('error', rawError);
  assert.equal(request.error, rawError);
  assert.equal(observedError.name, 'AbortError');
  assert.equal(observedError.code, 'ABORT_ERR');
  assert.equal(observedError.request, undefined);
  assert.doesNotMatch(observedError.message, /private transport metadata/);
});

test('native fixture loads independently in Node workers without dispatching', fixtureOptions, async () => {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const addon = require(workerData);
    parentPort.postMessage({ start: addon.currentSlot(), initial: addon.initialSlot(), count: addon.keyCount });
  `, { eval: true, workerData: fixturePath });
  const value = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  assert.equal(value.initial, value.start);
  assert.ok(value.start >= 0 && value.start < value.count);
  assert.ok(value.count >= 1);
});
