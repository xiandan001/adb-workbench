const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { createAiToolsRouter } = require('../electron/lib/ai-tools-router.cjs');

async function server(t, handler) { const value = http.createServer(handler); await new Promise(resolve => value.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => value.close(resolve))); return value.address().port; }
async function freePort() { const value = http.createServer(); await new Promise(resolve => value.listen(0, '127.0.0.1', resolve)); const port = value.address().port; await new Promise(resolve => value.close(resolve)); return port; }
function fixture(t, providers) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-router-test-')); let member = true;
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const savedProfiles = []; const options = { directory, canEncrypt: () => true, encrypt: text => Buffer.from(text).map(byte => byte ^ 0x78), decrypt: bytes => bytes.map(byte => byte ^ 0x78).toString(), getProvider: id => { const row = providers.find(row => row.id === id); if (!row) throw new Error('missing fixture provider'); return row; }, getMembership: async () => ({ activated: member, scope: 'vip' }), saveProvider: input => { savedProfiles.push(input); return { id: randomUUID(), hasCredential: true }; } };
  const router = createAiToolsRouter(options); t.after(() => router.dispose());
  return { router, directory, member: value => { member = value; }, savedProfiles, options };
}
test('router stores encrypted data, checks route protocol, and does not start implicitly', async t => {
  const provider = { id: randomUUID(), protocol: 'openai-chat', model: 'fixture-model', apiKey: 'fixture-secret', baseUrl: 'https://example.invalid/v1' }; const h = fixture(t, [provider]);
  assert.equal(h.router.snapshot().running, false);
  assert.throws(() => h.router.save({ name: 'bad', protocol: 'anthropic', providerIds: [provider.id], failover: false }), { code: 'AI_TOOLS_ROUTE_PROVIDER' });
  h.router.save({ name: 'private route', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  const disk = fs.readFileSync(path.join(h.directory, 'router.v1.json'), 'utf8'); assert.ok(!disk.includes('private route')); assert.ok(!JSON.stringify(h.router.snapshot()).includes(h.router.getKey()));
  assert.equal(createAiToolsRouter(h.options).snapshot().routes.length, 1);
});
test('same-protocol streaming, explicit overload failover, server auth and membership are enforced', async t => {
  const observed = [];
  const first = await server(t, (req, res) => { observed.push({ id: 'first', key: req.headers.authorization }); res.writeHead(503); res.end('must not leak this'); });
  const second = await server(t, (req, res) => { let body = ''; req.on('data', data => { body += data; }); req.on('end', () => { observed.push({ id: 'second', key: req.headers.authorization, body: JSON.parse(body) }); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"ok":true}\n\n'); res.end('data: [DONE]\n\n'); }); });
  const providers = [first, second].map((port, index) => ({ id: randomUUID(), protocol: 'openai-chat', model: `fixture-${index}`, apiKey: `fixture-upstream-${index}`, baseUrl: `http://127.0.0.1:${port}/v1` })); const h = fixture(t, providers);
  const route = h.router.save({ name: 'fallback', protocol: 'openai-chat', providerIds: providers.map(row => row.id), failover: true });
  const status = await h.router.start(await freePort());
  const headers = { authorization: `Bearer ${h.router.getKey()}`, 'content-type': 'application/json' };
  assert.equal((await fetch(`${status.url}/v1/models`)).status, 401); assert.equal(observed.length, 0);
  const result = await fetch(`${status.url}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: `awb-${route.id}`, messages: [{ role: 'user', content: 'fixture only' }], stream: true }) });
  assert.equal(result.status, 200); assert.match(await result.text(), /\[DONE\]/); assert.equal(observed.length, 2); assert.equal(observed[1].body.model, 'fixture-1'); assert.equal(observed[1].key, 'Bearer fixture-upstream-1');
  assert.equal((await fetch(`${status.url}/v1/models`, { headers: { ...headers, origin: 'https://untrusted.invalid' } })).status, 401);
  h.member(false); assert.equal((await fetch(`${status.url}/v1/models`, { headers })).status, 403); assert.equal(observed.length, 2);
  assert.throws(() => h.router.remove(route.id), { code: 'AI_TOOLS_ROUTER_RUNNING' });
  await h.router.stop(); assert.equal(h.router.snapshot().running, false);
});
test('failover is off by default choice, redirects/errors sanitized, and profile creation does not apply CLI', async t => {
  let calls = 0; const upstream = await server(t, (_req, res) => { calls++; res.writeHead(429); res.end('fixture-secret-must-not-leak'); });
  const provider = { id: randomUUID(), protocol: 'anthropic', model: 'fixture-anthropic', apiKey: 'fixture-provider-key', baseUrl: `http://127.0.0.1:${upstream}/v1` }; const h = fixture(t, [provider]);
  const route = h.router.save({ name: 'one', protocol: provider.protocol, providerIds: [provider.id], failover: false }); const status = await h.router.start(await freePort());
  const result = await fetch(`${status.url}/v1/messages`, { method: 'POST', headers: { 'x-api-key': h.router.getKey(), 'content-type': 'application/json' }, body: JSON.stringify({ model: `awb-${route.id}`, messages: [], max_tokens: 10 }) });
  assert.equal(result.status, 429); assert.equal(calls, 1); assert.ok(!(await result.text()).includes('fixture-secret'));
  h.router.profile({ routeId: route.id, targetApps: ['claude'] }); assert.equal(h.savedProfiles.length, 1); assert.equal(h.savedProfiles[0].apiKey, h.router.getKey());
  assert.ok(!JSON.stringify(h.router.snapshot()).includes('fixture-provider-key')); await h.router.stop();
});

test('pipelined requests are bounded before membership lookups and body parsing', async t => {
  const provider = { id: randomUUID(), protocol: 'openai-chat', model: 'fixture', apiKey: 'fixture', baseUrl: 'https://example.invalid' };
  const h = fixture(t, [provider]); let authCount = 0; const resolvers = [];
  const router = createAiToolsRouter({ ...h.options, getMembership: () => { authCount++; return new Promise(resolve => resolvers.push(resolve)); } }); t.after(() => router.dispose());
  router.save({ name: 'bounded', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  const port = await freePort(); await router.start(port);
  const socket = net.connect(port, '127.0.0.1'); socket.on('error', () => {}); socket.resume();
  await new Promise(resolve => socket.once('connect', resolve));
  const closed = new Promise(resolve => socket.once('close', resolve));
  socket.write(`GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${router.getKey()}\r\n\r\n`.repeat(200));
  await closed; assert.ok(authCount <= 8, `authorization requests must remain bounded, got ${authCount}`);
  for (const resolve of resolvers) resolve({ activated: true, scope: 'vip' }); await router.stop();
});
