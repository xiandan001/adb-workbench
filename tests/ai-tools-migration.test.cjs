const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createAiToolsMigration, getExportSummary } = require('../electron/lib/ai-tools-migration-state.cjs');
const { createAiToolsStore } = require('../electron/lib/ai-tools-store.cjs');
const { createAiToolsResources } = require('../electron/lib/ai-tools-resources.cjs');
const { createAiToolsSkills } = require('../electron/lib/ai-tools-skills.cjs');
const { createAiToolsProjects } = require('../electron/lib/ai-tools-projects.cjs');
const { createRouterConfig } = require('../electron/lib/ai-tools-router-config.cjs');
const { createAiToolsSessions } = require('../electron/lib/ai-tools-sessions.cjs');
const { normalizeWrites, normalizeGuards } = require('../electron/lib/data-migration-ai-plan.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-migration-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'); const userData = path.join(root, 'data'); const directory = path.join(userData, 'ai-tools'); fs.mkdirSync(home);
  const key = crypto.randomBytes(32);
  const encrypted = {
    canEncrypt: () => true,
    encrypt(plain) { const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); },
    decrypt(bytes) { const cipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8'); },
  };
  const options = { directory, home, ...encrypted }; const providers = createAiToolsStore(options);
  const resources = createAiToolsResources({ ...options, backupDirectory: path.join(directory, 'resource-backups') });
  const skills = createAiToolsSkills({ ...options, directory: path.join(directory, 'skills') });
  let launched = 0;
  const projectOptions = { ...options, getProvider: providers.getProvider, findExecutable: async () => 'C:\\fixture\\cli.exe', launchTerminal: async () => { launched++; }, openDirectory: async () => { launched++; } };
  const projects = createAiToolsProjects(projectOptions);
  const router = createRouterConfig({ ...options, getProvider: providers.getProvider });
  const migration = createAiToolsMigration(options); t.after(() => migration.dispose());
  const writeHome = (name, value) => { const file = path.join(home, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); return file; };
  const apply = plan => { for (const row of plan.writes) { assert.ok(row.name.startsWith('ai-tools/')); const file = path.join(userData, ...row.name.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, row.bytes); } };
  return { root, home, userData, directory, options, encrypted, providers, resources, skills, projects, projectOptions, router, migration, writeHome, apply, launched: () => launched };
}
const providerInput = () => ({ name: 'fixture upstream', protocol: 'openai-chat', baseUrl: 'https://api.example.test/v1', model: 'fixture-model', targetApps: ['opencode'], apiKey: 'fixture-upstream-key' });

test('full AI export/import rewraps credentials, skills and metadata under different machine keys without external writes', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.providers.saveProvider(providerInput());
  source.resources.saveMcp({ name: 'fixture MCP', type: 'stdio', command: 'node', args: ['never-run.js'], env: { FIXTURE_SECRET: 'fixture-env' } });
  source.resources.savePrompt({ name: 'fixture prompt', content: '# Plain instructions\nDo not execute this text.' });
  const skillDirectory = path.join(source.root, 'sample-skill'); fs.mkdirSync(skillDirectory); fs.writeFileSync(path.join(skillDirectory, 'SKILL.md'), '---\nname: sample-skill\n---\n# Fixture');
  const sourceSkill = source.skills.importDirectory({ sourceDirectory: skillDirectory });
  const installedSkill = source.skills.previewInstall({ skillId: sourceSkill.id, toolId: 'claude' }); source.skills.apply({ token: installedSkill.token });
  const installedBytes = fs.readFileSync(path.join(installedSkill.targetPath, 'SKILL.md'));
  const projectDirectory = path.join(source.root, 'project'); fs.mkdirSync(projectDirectory);
  source.projects.save({ name: 'fixture project', toolId: 'codex', pinned: true, directoryToken: source.projects.offerDirectory(projectDirectory).token });
  source.router.save({ name: 'fixture route', protocol: provider.protocol, providerIds: [provider.id], failover: true });
  const ai = await source.migration.exportState({ includeSessions: false });
  assert.deepEqual(fs.readFileSync(path.join(installedSkill.targetPath, 'SKILL.md')), installedBytes);
  assert.equal(Object.hasOwn(ai.skills, 'installations'), false); assert.equal(Object.hasOwn(ai.skills, 'backups'), false);
  assert.equal(getExportSummary(ai).ai.skills.count, 1); assert.equal(getExportSummary(ai).includesAiSessions, false);
  const plan = await target.migration.previewImport(ai);
  assert.equal(plan.summary.providers.added, 1); assert.equal(plan.summary.skills.added, 1); assert.equal(plan.summary.projects.added, 1); assert.equal(plan.summary.routes.added, 1);
  assert.equal(fs.existsSync(target.directory), false); assert.deepEqual(fs.readdirSync(target.home), []);
  for (const row of plan.writes) { assert.equal(row.expectedHash, null); assert.equal(row.bytes.includes(Buffer.from('fixture-upstream-key')), false); }
  target.apply(plan);
  const reloaded = createAiToolsStore(target.options); assert.equal(reloaded.getProvider(provider.id).apiKey, 'fixture-upstream-key');
  const skills = createAiToolsSkills({ ...target.options, directory: path.join(target.directory, 'skills') }); assert.equal(skills.list().length, 1); assert.deepEqual(skills.list()[0].installations, []);
  assert.equal(source.launched(), 0); assert.equal(target.launched(), 0); assert.deepEqual(fs.readdirSync(target.home), []);
});

test('imported project paths are display-only until a new native directory grant is selected', async t => {
  const source = fixture(t); const target = fixture(t); const directory = path.join(source.root, 'project'); fs.mkdirSync(directory);
  source.projects.save({ name: 'move me', toolId: 'codex', pinned: false, directoryToken: source.projects.offerDirectory(directory).token });
  target.apply(await target.migration.previewImport(await source.migration.exportState({ includeSessions: false })));
  const projects = createAiToolsProjects(target.projectOptions); const row = projects.snapshot().projects[0];
  assert.equal(row.needsRelocation, true); assert.equal(row.path, ''); assert.equal(row.oldPath, directory);
  await assert.rejects(projects.open(row.id), /重新选择|重新绑定/); await assert.rejects(projects.previewLaunch({ projectId: row.id }), /重新选择|重新绑定/);
  projects.save({ id: row.id, name: 'renamed', toolId: 'codex', pinned: true });
  const nextDirectory = path.join(target.root, 'rebound'); fs.mkdirSync(nextDirectory);
  projects.save({ id: row.id, name: 'renamed', toolId: 'codex', pinned: true, directoryToken: projects.offerDirectory(nextDirectory).token });
  assert.equal(projects.snapshot().projects[0].needsRelocation, undefined); await projects.open(row.id); assert.equal(target.launched(), 1);
});

test('local router profiles export only explicit bindings and adopt destination key/port without starting routing', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const route = source.router.save({ name: 'fixture route', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  const profile = source.providers.saveProvider({ name: 'local profile', protocol: route.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${route.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  const ai = await source.migration.exportState({ includeSessions: false });
  assert.deepEqual(ai.localProfiles, [{ providerId: profile.id, routeId: route.id, protocol: route.protocol }]);
  assert.equal(ai.providers.providers.find(row => row.id === profile.id).apiKey, undefined); assert.equal(JSON.stringify(ai).includes(source.router.getKey()), false);
  target.apply(await target.migration.previewImport(ai));
  const providerStore = createAiToolsStore(target.options); const router = createRouterConfig({ ...target.options, getProvider: providerStore.getProvider });
  assert.notEqual(router.getKey(), source.router.getKey()); assert.equal(providerStore.getProvider(profile.id).apiKey, router.getKey());
  assert.equal(providerStore.getProvider(profile.id).baseUrl, `http://127.0.0.1:${router.snapshot().port}/v1`);
  assert.deepEqual(fs.readdirSync(target.home), []);
});

test('full session records migrate only into app archives, can be viewed and reexported without scanning auth', async t => {
  const source = fixture(t); const target = fixture(t);
  const raw = `${JSON.stringify({ type: 'session_meta', payload: { id: 'fixture-session', cwd: '/old/private' } })}\n${JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Fixture migration session' }] } })}\n`;
  source.writeHome('.codex/sessions/test/rollout-fixture.jsonl', raw); source.writeHome('.codex/auth.json', 'AUTH_MUST_NOT_BE_READ_OR_EXPORTED');
  const ai = await source.migration.exportState(); assert.equal(getExportSummary(ai).ai.sessions.count, 1); assert.equal(JSON.stringify(ai).includes('AUTH_MUST_NOT'), false);
  assert.equal(Buffer.from(ai.sessions.records[0].data, 'base64').toString('utf8'), raw);
  target.apply(await target.migration.previewImport(ai)); assert.deepEqual(fs.readdirSync(target.home), []);
  const sessions = createAiToolsSessions({ ...target.options }); t.after(() => sessions.dispose());
  assert.equal((await sessions.list({})).count, 0); assert.equal((await sessions.scan()).count, 1);
  const listed = await sessions.list({}); assert.equal(listed.sessions[0].archived, true);
  assert.equal((await sessions.open({ id: listed.sessions[0].id })).messages[0].text, 'Fixture migration session');
  const exportedAgain = await createAiToolsMigration(target.options).exportState(); assert.equal(exportedAgain.sessions.records[0].data, ai.sessions.records[0].data);
  const without = await createAiToolsMigration(target.options).exportState({ includeSessions: false }); assert.equal(without.sessions.included, false);
  const repeated = await target.migration.previewImport(without); assert.ok(!repeated.writes.some(row => row.name.includes('session-archives')));
});

test('malformed domain payloads and unavailable encryption produce no import writes', async t => {
  const source = fixture(t); const target = fixture(t); const ai = await source.migration.exportState({ includeSessions: false });
  await assert.rejects(createAiToolsMigration({ ...target.options, canEncrypt: () => false }).exportState(), /加密/);
  const invalid = structuredClone(ai); invalid.skills.skills = [{ id: '../escape', name: 'bad' }];
  await assert.rejects(target.migration.previewImport(invalid)); assert.equal(fs.existsSync(target.directory), false);
  const badSession = structuredClone(ai); badSession.sessions = { version: 1, included: true, records: [{ id: '0'.repeat(64), toolId: 'codex', format: 'jsonl', data: Buffer.from('not trusted').toString('base64'), sourceName: '../../auth.json' }] };
  await assert.rejects(target.migration.previewImport(badSession)); assert.equal(fs.existsSync(target.directory), false);
});

test('same-ID definitions are retained and dependent local profiles are skipped when a provider or route conflicts', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const route = source.router.save({ name: 'source route', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  target.apply(await target.migration.previewImport(await source.migration.exportState({ includeSessions: false })));
  const targetProviders = createAiToolsStore(target.options); targetProviders.saveProvider({ ...targetProviders.getProvider(provider.id), name: 'destination-owned name', apiKey: 'destination-owned-key' });
  const profile = source.providers.saveProvider({ name: 'late local profile', protocol: route.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${route.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  const plan = await target.migration.previewImport(await source.migration.exportState({ includeSessions: false }));
  assert.equal(plan.summary.providers.added, 0); assert.equal(plan.summary.providers.skipped, 2); assert.equal(plan.summary.routes.skipped, 1);
  assert.match(plan.warnings.join(' '), /冲突|不同/); target.apply(plan);
  const current = createAiToolsStore(target.options); assert.equal(current.getProvider(provider.id).apiKey, 'destination-owned-key');
  assert.throws(() => current.getProvider(profile.id), /不存在/);
});

test('a new bound local profile keeps the destination router port/key and invalid bindings cannot manufacture credential forwarding', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const route = source.router.save({ name: 'same route', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  target.apply(await target.migration.previewImport(await source.migration.exportState({ includeSessions: false })));
  const targetProviders = createAiToolsStore(target.options); const targetRouter = createRouterConfig({ ...target.options, getProvider: targetProviders.getProvider }); const targetKey = targetRouter.getKey(); targetRouter.prepare(19091);
  const profile = source.providers.saveProvider({ name: 'new local profile', protocol: route.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${route.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  const ai = await source.migration.exportState({ includeSessions: false });
  const invalid = structuredClone(ai); invalid.providers.providers.find(row => row.id === profile.id).baseUrl = 'https://unrelated.invalid';
  await assert.rejects(target.migration.previewImport(invalid), /绑定/);
  target.apply(await target.migration.previewImport(ai));
  const current = createAiToolsStore(target.options).getProvider(profile.id); assert.equal(current.apiKey, targetKey); assert.equal(current.baseUrl, 'http://127.0.0.1:19091/v1');
});

test('same-name Skills collisions preserve installed destination files and only fixed encrypted targets enter the journal plan', async t => {
  const source = fixture(t); const target = fixture(t);
  function addSkill(f, suffix) {
    const dir = path.join(f.root, 'same-skill'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: same-skill\n---\n${suffix}`);
    return f.skills.importDirectory({ sourceDirectory: dir });
  }
  addSkill(source, 'source'); const local = addSkill(target, 'destination');
  const installation = target.skills.previewInstall({ skillId: local.id, toolId: 'claude' }); target.skills.apply({ token: installation.token });
  const original = fs.readFileSync(path.join(installation.targetPath, 'SKILL.md'));
  const plan = await target.migration.previewImport(await source.migration.exportState({ includeSessions: false }));
  assert.equal(plan.summary.skills.added, 0); assert.equal(plan.summary.skills.skipped, 1);
  assert.equal(normalizeWrites(plan.writes).length, plan.writes.length); assert.equal(normalizeGuards(plan.guards).length, plan.guards.length);
  target.apply(plan); assert.deepEqual(fs.readFileSync(path.join(installation.targetPath, 'SKILL.md')), original);
  const reloaded = createAiToolsSkills({ ...target.options, directory: path.join(target.directory, 'skills') }); assert.equal(reloaded.list()[0].id, local.id); assert.equal(reloaded.list()[0].installations[0].toolId, 'claude');
});

test('export rejects self-referencing local profiles and import preview detects state changing during encryption', async t => {
  const source = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const route = source.router.save({ name: 'base', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  const local = source.providers.saveProvider({ name: 'local', protocol: route.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${route.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  source.router.save({ id: route.id, name: 'cycle', protocol: route.protocol, providerIds: [local.id], failover: false });
  await assert.rejects(source.migration.exportState({ includeSessions: false }), /循环|依赖/);
  source.router.save({ id: route.id, name: 'base', protocol: route.protocol, providerIds: [provider.id], failover: false });
  const ai = await source.migration.exportState({ includeSessions: false }); const target = fixture(t);
  const project = path.join(target.root, 'p'); fs.mkdirSync(project); target.projects.save({ name: 'local', toolId: 'codex', pinned: false, directoryToken: target.projects.offerDirectory(project).token });
  const file = path.join(target.directory, 'projects.v1.json'); let changed = false;
  const raced = createAiToolsMigration({ ...target.options, encrypt(value) { if (!changed) { changed = true; fs.appendFileSync(file, ' '); } return target.encrypted.encrypt(value); } });
  await assert.rejects(raced.previewImport(ai), /变化/); assert.equal(fs.readFileSync(file, 'utf8').endsWith(' '), true);
});

test('import preserves an independent destination route/key/non-default port while adding a source local profile', async t => {
  const source = fixture(t); const target = fixture(t);
  const sourceProvider = source.providers.saveProvider(providerInput()); const sourceRoute = source.router.save({ name: 'source route', protocol: sourceProvider.protocol, providerIds: [sourceProvider.id], failover: false });
  const profile = source.providers.saveProvider({ name: 'source bound profile', protocol: sourceRoute.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${sourceRoute.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  const localProvider = target.providers.saveProvider({ ...providerInput(), name: 'target upstream', apiKey: 'target-upstream-secret' });
  const localRoute = target.router.save({ name: 'target route', protocol: localProvider.protocol, providerIds: [localProvider.id], failover: true });
  target.router.prepare(15739); const targetKey = target.router.getKey();
  const plan = await target.migration.previewImport(await source.migration.exportState({ includeSessions: false })); assert.equal(plan.summary.routes.added, 1);
  target.apply(plan);
  const providers = createAiToolsStore(target.options); const router = createRouterConfig({ ...target.options, getProvider: providers.getProvider });
  assert.equal(router.getKey(), targetKey); assert.equal(router.snapshot().port, 15739); assert.equal(router.snapshot().routes.length, 2);
  assert.deepEqual(router.exportPortable().routes.find(row => row.id === localRoute.id), localRoute);
  assert.equal(providers.getProvider(profile.id).apiKey, targetKey); assert.equal(providers.getProvider(profile.id).baseUrl, 'http://127.0.0.1:15739/v1');
});

test('new source routes and bound profiles are skipped when same-ID destination upstream content differs', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const route = source.router.save({ name: 'new incoming route', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  const local = source.providers.saveProvider({ name: 'blocked local profile', protocol: route.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${route.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  const transaction = target.providers.preparePortableImport({ version: 1, providers: [source.providers.getProvider(provider.id)] }); transaction.commit();
  target.providers.saveProvider({ ...target.providers.getProvider(provider.id), apiKey: 'destination-private-key' });
  const plan = await target.migration.previewImport(await source.migration.exportState({ includeSessions: false }));
  assert.equal(plan.summary.routes.added, 0); assert.equal(plan.summary.routes.skipped, 1); assert.equal(plan.summary.providers.added, 0); assert.equal(plan.summary.providers.skipped, 2);
  assert.match(plan.warnings.join(' '), /冲突/); target.apply(plan);
  const current = createAiToolsStore(target.options); assert.equal(current.getProvider(provider.id).apiKey, 'destination-private-key'); assert.throws(() => current.getProvider(local.id), /不存在/);
});

test('a stale local profile cannot accidentally export the source gateway key after its route is deleted', async t => {
  const source = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const route = source.router.save({ name: 'deleted route', protocol: provider.protocol, providerIds: [provider.id], failover: false });
  source.providers.saveProvider({ name: 'orphan local profile', protocol: route.protocol, baseUrl: 'http://127.0.0.1:15721/v1', model: `awb-${route.id}`, apiKey: source.router.getKey(), targetApps: ['opencode'] });
  source.router.remove(route.id);
  await assert.rejects(source.migration.exportState({ includeSessions: false }), /路由.*不存在|路由.*已删除|本机路由.*失效/);
});

test('cancelled migration instances reject future requests without invalidating an already produced encrypted write plan', async t => {
  const source = fixture(t); const target = fixture(t); const provider = source.providers.saveProvider(providerInput());
  const ai = await source.migration.exportState({ includeSessions: false }); const plan = await target.migration.previewImport(ai);
  const bytes = plan.writes.map(row => Buffer.from(row.bytes)); target.migration.dispose();
  plan.writes.forEach((row, index) => assert.deepEqual(row.bytes, bytes[index]));
  await assert.rejects(target.migration.exportState({ includeSessions: false }), /取消/);
  await assert.rejects(target.migration.previewImport(ai), /取消/);
  target.apply(plan); assert.equal(createAiToolsStore(target.options).getProvider(provider.id).apiKey, 'fixture-upstream-key');
});
