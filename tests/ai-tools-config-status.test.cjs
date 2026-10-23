const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createAiToolsConfig } = require('../electron/lib/ai-tools-config.cjs');
function fixture(t, toolId = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-config-status-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const provider = { id: randomUUID(), name: 'Fixture', protocol: 'anthropic', model: 'fixture-model', apiKey: 'private-fixture-key', baseUrl: 'https://fixture.invalid', targetApps: [toolId] };
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const backupDirectory = path.join(root, 'backups');
  const service = createAiToolsConfig({ home, backupDirectory, getProvider: id => { assert.equal(id, provider.id); return structuredClone(provider); }, canEncrypt: () => true, encrypt: text => Buffer.from(text).map(x => x ^ 63), decrypt: bytes => bytes.map(x => x ^ 63).toString() });
  t.after(() => service.dispose());
  const status = () => service.status({ toolId, providerIds: [provider.id] });
  const apply = () => service.apply({ token: service.preview({ toolId, providerId: provider.id }).token });
  return { root, home, backupDirectory, provider, service, status, apply };
}
test('native status is read-only, absent is inactive, matching is active, and external drift is detected', async t => {
  const h = fixture(t);
  assert.equal((await h.status()).providers[0].state, 'inactive');
  assert.equal(fs.existsSync(h.backupDirectory), false);
  h.apply();
  const file = path.join(h.home, '.claude', 'settings.json'); const original = fs.readFileSync(file, 'utf8');
  const matched = await h.status(); assert.equal(matched.providers[0].state, 'active');
  assert.ok(!JSON.stringify(matched).includes(h.provider.apiKey)); assert.ok(!JSON.stringify(matched).includes(h.home));
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const edited = JSON.parse(original); edited.permissions = { allow: ['Read'] }; fs.writeFileSync(file, JSON.stringify(edited));
  assert.equal((await h.status()).providers[0].state, 'active', 'unmanaged edits do not invalidate the selected provider');
  edited.env.ANTHROPIC_MODEL = 'externally-changed'; fs.writeFileSync(file, JSON.stringify(edited));
  assert.equal((await h.status()).providers[0].state, 'inactive');
  fs.writeFileSync(file, '{ invalid private-secret');
  assert.equal((await h.status()).providers[0].state, 'unknown');
  assert.ok(!JSON.stringify(await h.status()).includes('private-secret'));
});
test('model-catalog adapters report configured, never falsely claim a selected runtime default', async t => {
  const h = fixture(t, 'pi'); h.apply();
  assert.equal((await h.status()).providers[0].state, 'configured');
});
test('status distinguishes missing model or credentials and rejects untrusted tool/path/ID queries', async t => {
  const h = fixture(t); h.provider.model = '';
  assert.equal((await h.status()).providers[0].state, 'incomplete');
  h.provider.model = 'fixture'; h.provider.apiKey = '';
  assert.equal((await h.status()).providers[0].state, 'incomplete');
  await assert.rejects(h.service.status({ toolId: '../private', providerIds: [h.provider.id] }), { code: 'AI_TOOLS_CONFIG_STATUS' });
  await assert.rejects(h.service.status({ toolId: 'claude', providerIds: ['untrusted'] }), { code: 'AI_TOOLS_CONFIG_STATUS' });
  assert.deepEqual((await h.service.status({ toolId: 'claude' })).providers, []);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(h.service.status({ toolId: 'claude', providerIds: [h.provider.id], signal: abort.signal }), { code: 'AI_TOOLS_CANCELLED' });
});

test('provider changes during the yielding status check invalidate only the stale provider result', async t => {
  const h = fixture(t);
  h.apply();
  const providerRows = Array.from({ length: 5 }, () => ({ ...h.provider, id: randomUUID() }));
  let queued = false;
  const service = createAiToolsConfig({ home: h.home, backupDirectory: h.backupDirectory,
    getProvider: id => {
      if (!queued) {
        queued = true;
        setImmediate(() => { providerRows[0].apiKey = 'replacement-private-fixture'; });
      }
      return structuredClone(providerRows.find(provider => provider.id === id));
    },
  });
  t.after(() => service.dispose());
  const result = await service.status({ toolId: 'claude', providerIds: providerRows.map(row => row.id) });
  assert.equal(result.providers[0].state, 'unknown');
  assert.match(result.providers[0].message, /变化/);
  assert.ok(result.providers.slice(1).every(row => row.state === 'active'));
  assert.ok(!JSON.stringify(result).includes('replacement-private-fixture'));
  assert.ok(!JSON.stringify(result).includes(h.provider.apiKey));
});

test('a provider removed while status yields cannot retain a verified result', async t => {
  const h = fixture(t); h.apply();
  const ids = Array.from({ length: 5 }, () => randomUUID()); let removed = false;
  const service = createAiToolsConfig({ home: h.home, backupDirectory: h.backupDirectory, getProvider: id => {
    if (id === ids[0]) {
      if (removed) throw new Error('private-fixture-error');
      setImmediate(() => { removed = true; });
    }
    return { ...h.provider, id };
  } });
  t.after(() => service.dispose());
  const result = await service.status({ toolId: 'claude', providerIds: ids });
  assert.equal(result.providers[0].state, 'unknown');
  assert.ok(!JSON.stringify(result).includes('private-fixture-error'));
});

test('OpenClaw matching managed values are configured without rewriting whitespace or unrelated fields', async t => {
  const h = fixture(t, 'openclaw'); h.apply();
  const file = path.join(h.home, '.openclaw', 'openclaw.json');
  const document = require('json5').parse(fs.readFileSync(file, 'utf8'));
  document.agents = { defaults: { model: 'unrelated-runtime-model' } };
  const preserved = `// User formatting and unrelated default must remain unchanged\n${JSON.stringify(document, null, 4)}\n`;
  fs.writeFileSync(file, preserved);
  assert.equal((await h.status()).providers[0].state, 'configured');
  const preview = h.service.preview({ toolId: 'openclaw', providerId: h.provider.id });
  assert.deepEqual(preview.files[0].changes, []);
  assert.equal(fs.readFileSync(file, 'utf8'), preserved);
  h.service.apply({ token: preview.token });
  assert.equal(fs.readFileSync(file, 'utf8'), preserved);
  document.models.providers[`awb_${h.provider.id.replaceAll('-', '')}`].apiKey = 'externally-changed-fixture';
  fs.writeFileSync(file, JSON.stringify(document));
  assert.equal((await h.status()).providers[0].state, 'inactive');
});

test('mid-check cancellation rejects and configuration drift invalidates previously checked providers', async t => {
  const h = fixture(t); h.apply();
  const ids = Array.from({ length: 5 }, () => randomUUID());
  for (const cancel of [true, false]) {
    const abort = new AbortController(); let scheduled = false;
    const service = createAiToolsConfig({ home: h.home, backupDirectory: h.backupDirectory, getProvider: id => {
      if (!scheduled) {
        scheduled = true;
        setImmediate(() => {
          if (cancel) abort.abort();
          else {
            const file = path.join(h.home, '.claude', 'settings.json');
            const value = JSON.parse(fs.readFileSync(file)); value.env.ANTHROPIC_MODEL = 'changed-during-query';
            fs.writeFileSync(file, JSON.stringify(value));
          }
        });
      }
      return { ...h.provider, id };
    } });
    t.after(() => service.dispose());
    const checking = service.status({ toolId: 'claude', providerIds: ids, signal: abort.signal });
    if (cancel) await assert.rejects(checking, { code: 'AI_TOOLS_CANCELLED' });
    else assert.ok((await checking).providers.every(row => row.state === 'unknown'));
  }
});

test('a full provider library reads each fixed configuration only twice and yields between batches', async t => {
  const h = fixture(t); h.apply();
  const ids = Array.from({ length: 200 }, () => randomUUID());
  let reads = 0; let lookups = 0; let otherTaskRan = false;
  const io = Object.create(fs); io.openSync = (...args) => { reads++; return fs.openSync(...args); };
  const service = createAiToolsConfig({ home: h.home, backupDirectory: h.backupDirectory, filesystem: io,
    getProvider: id => { lookups++; return { ...h.provider, id }; },
  });
  t.after(() => service.dispose());
  setImmediate(() => { otherTaskRan = true; });
  const result = await service.status({ toolId: 'claude', providerIds: ids });
  assert.ok(result.providers.every(row => row.state === 'active'));
  assert.equal(result.providers.length, 200); assert.equal(reads, 2); assert.equal(lookups, 400);
  assert.equal(otherTaskRan, true);
  await assert.rejects(service.status({ toolId: 'claude', providerIds: [...ids, randomUUID()] }), { code: 'AI_TOOLS_CONFIG_STATUS' });
});
