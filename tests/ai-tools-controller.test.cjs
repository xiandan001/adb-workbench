const test = require('node:test');
const assert = require('node:assert/strict');
const { createAiToolsController } = require('../electron/lib/ai-tools-controller.cjs');

function fixture(t, extra = {}) {
  for (const name of ['sessions', 'projects', 'router', 'resources', 'portable', 'skills']) if (extra[name]) extra[name] = { dispose() {}, ...extra[name] };
  const calls = []; let member = true;
  const mainFrame = {}; const sender = { mainFrame }; const event = { sender, senderFrame: mainFrame };
  const store = { snapshot: () => { calls.push('snapshot'); return { providers: [{ id: 'p', hasCredential: true }], persistent: true }; },
    saveProvider: value => { calls.push(['save', value]); return { id: 'p' }; }, removeProvider: id => { calls.push(['remove', id]); }, getProvider: id => ({ id, apiKey: 'fixture-only' }) };
  const config = { preview: args => { calls.push(['preview', args]); return { token: 'apply' }; }, apply: args => { calls.push(['apply', args]); return { backupId: 'b' }; }, listBackups: () => [{ id: 'b' }], previewRestore: () => ({ token: 'restore' }) };
  const quota = { list: () => [], invalidate: id => calls.push(['invalidate', id]), query: async (provider, { signal }) => ({ providerId: provider.id, status: signal.aborted ? 'error' : 'fresh' }) };
  const controller = createAiToolsController({ store, config, quota, models: { test: () => ({ reachable: true }), list: () => ({ models: [] }) }, tools: [],
    getMembership: async () => ({ activated: member, scope: member ? 'vip' : 'free' }), getOwner: () => ({ isDestroyed: () => false, webContents: sender }), ...extra });
  t.after(() => controller.dispose());
  return { calls, event, controller, store, config, quota, member: value => { member = value; }, run: (command, args = {}) => controller.execute(event, { command, args }) };
}

test('foreign windows and frames cannot probe membership, storage or execute requests', async t => {
  const h = fixture(t);
  assert.equal((await h.controller.execute({ sender: {} }, { command: 'snapshot' })).success, false);
  assert.equal((await h.controller.execute({ sender: h.event.sender, senderFrame: {} }, { command: 'snapshot' })).success, false);
  assert.deepEqual(h.calls, []);
});
test('membership is main-process authoritative and opening a snapshot makes no external requests', async t => {
  const h = fixture(t); h.member(false);
  const result = await h.run('snapshot'); assert.equal(result.result.membership.activated, false); assert.deepEqual(result.result.providers, []); assert.deepEqual(h.calls, []);
  assert.equal((await h.run('provider_save', { provider: {}, membership: true, grants: ['all'] })).error.code, 'AI_TOOLS_MEMBERSHIP_REQUIRED');
  h.member(true); assert.equal((await h.run('snapshot')).result.providers[0].hasCredential, true);
  assert.ok(!JSON.stringify(await h.run('snapshot')).includes('fixture-only'));
});
test('configuration application uses only issued service tokens, not renderer file paths', async t => {
  const h = fixture(t);
  await h.run('config_preview', { toolId: 'codex', providerId: 'p', path: 'untrusted' });
  await h.run('config_apply', { token: 'apply', path: 'untrusted', content: 'bad' });
  assert.deepEqual(h.calls, [['preview', { toolId: 'codex', providerId: 'p' }], ['apply', { token: 'apply' }]]);
});
test('expired membership can recover prior changes but cannot apply a new provider', async t => {
  const h = fixture(t); h.member(false);
  assert.equal((await h.run('backups_list')).success, true);
  assert.equal((await h.run('config_apply', { token: 'guessed' })).success, false);
  const preview = await h.run('backup_preview_restore', { backupId: 'b' });
  assert.equal((await h.run('config_apply', { token: preview.result.token })).success, true);
  assert.equal((await h.run('config_apply', { token: preview.result.token })).success, false);
});

test('configuration status obtains provider identities only from the vault and requires current membership', async t => {
  const calls = []; const h = fixture(t);
  h.store.snapshot = () => ({ providers: [{ id: 'owned', targetApps: ['claude'] }, { id: 'other', targetApps: ['codex'] }] });
  h.config.status = args => { calls.push(args); return { toolId: args.toolId, providers: [] }; };
  assert.equal((await h.run('config_status', { toolId: 'claude', providerIds: ['injected'], path: '/private' })).success, true);
  assert.deepEqual(calls[0].providerIds, ['owned']); assert.equal(Object.hasOwn(calls[0], 'path'), false);
  assert.ok(calls[0].signal instanceof AbortSignal);
  h.member(false); assert.equal((await h.run('config_status', { toolId: 'claude' })).error.code, 'AI_TOOLS_MEMBERSHIP_REQUIRED');
  assert.equal(calls.length, 1);
});
test('unknown commands, injected authority and malformed JSON never reach domain services', async t => {
  const h = fixture(t);
  assert.equal((await h.run('eval', { script: 'anything' })).success, false);
  assert.equal((await h.controller.execute(h.event, { command: 'snapshot', grants: [] })).success, false);
  assert.equal((await h.run('provider_save', JSON.parse('{"__proto__":{"polluted":true}}'))).success, false);
  assert.deepEqual(h.calls, []);
});

test('resource and skill recovery tokens cannot authorize new application or cross domains after membership expires', async t => {
  const applied = [];
  const resources = { listBackups: () => [], previewRestore: () => ({ token: 'resource-restore' }), apply: args => applied.push(['resource', args.token]) };
  const skills = { listBackups: () => [], previewRestore: () => ({ token: 'skill-restore' }), apply: args => applied.push(['skill', args.token]) };
  const h = fixture(t, { resources, skills }); h.member(false);
  assert.equal((await h.run('resources_snapshot')).success, false); assert.equal((await h.run('skills_list')).success, false);
  await h.run('resources_backup_preview_restore', { backupId: 'r' }); await h.run('skills_backup_preview_restore', { backupId: 's' });
  assert.equal((await h.run('skills_apply', { token: 'resource-restore' })).success, false);
  assert.equal((await h.run('resources_apply', { token: 'skill-restore' })).success, false);
  assert.equal((await h.run('resources_apply', { token: 'resource-restore' })).success, true);
  assert.equal((await h.run('skills_apply', { token: 'skill-restore' })).success, true);
  assert.equal((await h.run('skills_apply', { token: 'skill-restore' })).success, false);
  assert.deepEqual(applied, [['resource', 'resource-restore'], ['skill', 'skill-restore']]);
});

test('native directory/file pickers determine import targets, not renderer paths or overwrite hashes', async t => {
  const calls = [];
  const h = fixture(t, { pickDirectory: async () => 'C:\\fixture\\selected-skill', skills: { importDirectory: args => calls.push(['skill', args]) },
    pickBackup: async saving => saving ? { path: 'C:\\fixture\\out.awbai', expectedHash: 'trusted-hash' } : { path: 'C:\\fixture\\in.awbai' },
    portable: { exportBundle: args => calls.push(['export', args]), previewImport: args => calls.push(['import', args]) } });
  await h.run('skills_import', { path: 'C:\\untrusted' });
  await h.run('portable_export', { path: 'C:\\untrusted', expectedHash: 'untrusted', password: 'fixture-password' });
  await h.run('portable_preview', { path: 'C:\\untrusted', password: 'fixture-password' });
  assert.deepEqual(calls, [['skill', { sourceDirectory: 'C:\\fixture\\selected-skill' }], ['export', { path: 'C:\\fixture\\out.awbai', expectedHash: 'trusted-hash', password: 'fixture-password' }], ['import', { path: 'C:\\fixture\\in.awbai', password: 'fixture-password' }]]);
});

test('opening the root snapshot does not scan sessions, inspect PATH, import files or start a router', async t => {
  const forbidden = () => { throw new Error('must remain lazy'); };
  const h = fixture(t, { sessions: { scan: forbidden, list: forbidden }, projects: { environment: forbidden, snapshot: forbidden }, router: { start: forbidden, snapshot: forbidden }, resources: { snapshot: forbidden }, skills: { list: forbidden } });
  assert.equal((await h.run('snapshot')).success, true); assert.deepEqual(h.calls, ['snapshot']);
});

test('router consumers prevent changing live provider credentials and expired members can stop the gateway', async t => {
  let stopped = false;
  const h = fixture(t, { router: { assertProviderMutable: () => { throw Object.assign(new Error('stop first'), { code: 'AI_TOOLS_ROUTER_RUNNING' }); }, stop: async () => { stopped = true; } } });
  assert.equal((await h.run('provider_save', { provider: { id: 'p' } })).error.code, 'AI_TOOLS_ROUTER_RUNNING'); assert.deepEqual(h.calls, []);
  h.member(false); assert.equal((await h.run('router_stop')).success, true); assert.equal(stopped, true);
});
test('a frame destroyed during membership or a native picker cannot authorize a late mutation', async t => {
  let resolveMembership;
  const h = fixture(t, { getMembership: () => new Promise(resolve => { resolveMembership = resolve; }) });
  const saving = h.run('provider_save', { provider: {} }); h.event.senderFrame = null; resolveMembership({ activated: true, scope: 'vip' });
  assert.equal((await saving).error.code, 'AI_TOOLS_OWNER_REQUIRED'); assert.deepEqual(h.calls, []);
  let resolvePicker; let imports = 0;
  const pick = fixture(t, { pickDirectory: () => new Promise(resolve => { resolvePicker = resolve; }), skills: { importDirectory: () => { imports++; } } });
  const importing = pick.run('skills_import'); await new Promise(resolve => setImmediate(resolve));
  pick.event.senderFrame = null; resolvePicker('C:\\fixture-only'); assert.equal((await importing).error.code, 'AI_TOOLS_OWNER_REQUIRED'); assert.equal(imports, 0);
});

test('migration reservation invalidates pending work, stops routing and can be released after staging failure', async t => {
  const events = [];
  const h = fixture(t, { projects: { cancelPending: () => events.push('cancel-projects') }, sessions: { cancelPending: async () => events.push('cancel-sessions') }, router: { stop: async () => events.push('stop-router') } });
  const release = await h.controller.reserveForMigration();
  assert.deepEqual(events, ['cancel-projects', 'cancel-sessions', 'stop-router']);
  assert.equal((await h.run('snapshot')).error.code, 'AI_TOOLS_MIGRATION_PENDING');
  assert.equal((await h.run('provider_save', { provider: {} })).error.code, 'AI_TOOLS_MIGRATION_PENDING');
  await assert.rejects(h.controller.reserveForMigration(), { code: 'AI_TOOLS_MIGRATION_PENDING' });
  release(); assert.equal((await h.run('snapshot')).success, true);
});

test('migration reservation waits for an existing model query to observe cancellation before yielding', async t => {
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const h = fixture(t, { models: { list: async (_provider, { signal }) => { ready(); await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); return { models: [] }; } } });
  const query = h.run('models_list', { providerId: 'p' }); await started;
  const release = await h.controller.reserveForMigration();
  assert.equal((await query).success, false); release(); assert.equal((await h.run('snapshot')).success, true);
});
