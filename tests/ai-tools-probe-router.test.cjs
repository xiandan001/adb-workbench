const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createAiToolsRouter } = require('../electron/lib/ai-tools-router.cjs');
const { createAiToolsProbe } = require('../electron/lib/ai-tools-probe.cjs');
const { createAiToolsNetwork } = require('../electron/lib/ai-tools-network.cjs');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-probe-router-'));
  const observed = [];
  const upstream = http.createServer((request, response) => {
    let body = ''; request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      observed.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'message', content: [{ type: 'text', text: 'fixture OK' }], usage: { input_tokens: 2, output_tokens: 1 } }));
    });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const providers = [0, 1].map(index => ({ id: randomUUID(), protocol: 'anthropic', model: `fixture-${index}`, apiKey: `fixture-key-${index}`, baseUrl: `http://127.0.0.1:${upstream.address().port}/v1` }));
  const router = createAiToolsRouter({ directory, canEncrypt: () => true, encrypt: value => Buffer.from(value).map(byte => byte ^ 63), decrypt: value => value.map(byte => byte ^ 63).toString(),
    getProvider: id => providers.find(row => row.id === id), getMembership: async () => ({ activated: true, scope: 'vip' }), saveProvider: value => value,
  });
  t.after(async () => { await router.dispose(); await new Promise(resolve => upstream.close(resolve)); fs.rmSync(directory, { recursive: true, force: true }); });
  const failover = router.save({ name: 'Retry forbidden for probes', protocol: 'anthropic', providerIds: providers.map(row => row.id), failover: true });
  const single = router.save({ name: 'Single upstream', protocol: 'anthropic', providerIds: [providers[0].id], failover: false });
  const reservation = http.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve)); await router.start(port);
  const requestLocal = createAiToolsNetwork({ transport: http.request, allowLoopback: true, timeoutMs: 5000 }).requestJson;
  const probe = createAiToolsProbe({ request: async () => { throw Error('No external network is allowed in this fixture'); }, requestLocal, resolveLocal: value => router.localProbe(value) });
  const profile = route => ({ id: randomUUID(), name: 'Local fixture', protocol: 'anthropic', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: router.getKey(), model: `awb-${route.id}` });
  return { router, probe, observed, profile, failover, single };
}

test('failover-enabled local probes are refused before any upstream request while model discovery remains available', async t => {
  const h = await fixture(t); const profile = h.profile(h.failover);
  await assert.rejects(h.probe.run(profile), { code: 'AI_TOOLS_PROBE_FAILOVER' });
  assert.equal(h.observed.length, 0);
  assert.ok(h.router.localModels(profile).models.some(row => row.id === profile.model));
});

test('local probe validation uses the final Claude alias and 1M-stripped body model', async t => {
  const h = await fixture(t);
  const alias = { ...h.profile(h.single), model: 'sonnet', claudeModels: { sonnet: { model: `awb-${h.failover.id}[1m]` } } };
  await assert.rejects(h.probe.run(alias), { code: 'AI_TOOLS_PROBE_FAILOVER' });
  assert.equal(h.observed.length, 0);
  const missing = { ...h.profile(h.single), model: 'haiku', claudeModels: { haiku: { model: `awb-${randomUUID()}` } } };
  await assert.rejects(h.probe.run(missing), { code: 'AI_TOOLS_PROBE_LOCAL_ROUTE' });
  assert.equal(h.observed.length, 0);
  const safe = { ...h.profile(h.single), model: 'sonnet', claudeModels: { sonnet: { model: `awb-${h.single.id}[1m]` } } };
  const result = await h.probe.run(safe);
  assert.equal(result.inferenceVerified, true); assert.equal(h.observed.length, 1);
  assert.equal(h.observed[0].body.max_tokens, 16); assert.equal(h.observed[0].body.messages[0].content, 'Reply OK.');
});

test('wrong local credentials and a stopped router cannot be used as an authorized local probe', async t => {
  const h = await fixture(t); const profile = h.profile(h.single);
  await assert.rejects(h.probe.run({ ...profile, apiKey: 'wrong-fixture-key' }), { code: 'AI_TOOLS_PROBE_URL' });
  await h.router.stop();
  await assert.rejects(h.probe.run(profile), { code: 'AI_TOOLS_PROBE_URL' });
  assert.equal(h.observed.length, 0);
});
