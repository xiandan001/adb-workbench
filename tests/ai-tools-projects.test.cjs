const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createAiToolsProjects } = require('../electron/lib/ai-tools-projects.cjs');
const { buildLaunchScript } = require('../electron/lib/ai-tools-launcher.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-project-test-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'fixture project'); fs.mkdirSync(project);
  const launches = []; const opens = []; let available = true; let lookupPause = null;
  const provider = { id: randomUUID(), name: 'private', protocol: 'gemini', model: 'fixture-gemini', baseUrl: 'https://example.invalid', apiKey: 'fixture-secret', targetApps: ['agy'] };
  const service = createAiToolsProjects({ directory: path.join(root, 'data'), home: root, canEncrypt: () => true, encrypt: text => Buffer.from(text).map(byte => byte ^ 0x54), decrypt: bytes => bytes.map(byte => byte ^ 0x54).toString(), findExecutable: async cmd => { await lookupPause; return available ? `C:\\fixture\\${cmd}.cmd` : null; }, launchTerminal: async input => launches.push(input), openDirectory: async input => opens.push(input), getProvider: () => ({ ...provider }) });
  t.after(() => service.dispose()); return { root, project, service, launches, opens, provider, available: value => { available = value; }, pauseLookup: value => { lookupPause = value; } };
}
test('project selection is token-bound, encrypted and metadata-only; deleting library never deletes directory', async t => {
  const h = fixture(t); assert.deepEqual(h.service.snapshot().projects, []); assert.throws(() => h.service.offerDirectory(h.root), { code: 'AI_TOOLS_PROJECT_PATH' });
  const selection = h.service.offerDirectory(h.project); const project = h.service.save({ name: 'fixture', toolId: 'codex', pinned: true, directoryToken: selection.token });
  assert.equal(h.launches.length, 0); assert.throws(() => h.service.save({ name: 'bad', toolId: 'codex', pinned: false, path: h.project }), { code: 'AI_TOOLS_PROJECT_INVALID' });
  assert.ok(!fs.readFileSync(path.join(h.root, 'data', 'projects.v1.json'), 'utf8').includes('fixture'));
  await h.service.open(project.id); assert.deepEqual(h.opens, [h.project]); h.service.remove(project.id); assert.ok(fs.existsSync(h.project));
});
test('CLI launch is explicit, one-time and rejects changed project or unavailable CLI', async t => {
  const h = fixture(t); const project = h.service.save({ name: 'project', toolId: 'codex', pinned: false, directoryToken: h.service.offerDirectory(h.project).token });
  const preview = await h.service.previewLaunch({ projectId: project.id }); assert.equal(h.launches.length, 0);
  await h.service.launch({ token: preview.token }); assert.equal(h.launches.length, 1); assert.deepEqual(h.launches[0].env, {}); await assert.rejects(h.service.launch({ token: preview.token }), { code: 'AI_TOOLS_PREVIEW_EXPIRED' });
  const next = await h.service.previewLaunch({ projectId: project.id }); h.service.save({ id: project.id, name: 'changed', toolId: 'codex', pinned: false }); await assert.rejects(h.service.launch({ token: next.token }), { code: 'AI_TOOLS_PROJECT_CHANGED' });
  h.available(false); await assert.rejects(h.service.previewLaunch({ projectId: project.id }), { code: 'AI_TOOLS_CLI_MISSING' });
});
test('AGY uses process-only credentials and an independent model profile; no key in preview or command line', async t => {
  const h = fixture(t); const project = h.service.save({ name: 'AGY', toolId: 'agy', pinned: false, directoryToken: h.service.offerDirectory(h.project).token });
  const preview = await h.service.previewLaunch({ projectId: project.id, providerId: h.provider.id }); assert.ok(!JSON.stringify(preview).includes(h.provider.apiKey));
  await h.service.launch({ token: preview.token }); const started = h.launches[0]; assert.equal(started.env.GEMINI_API_KEY, h.provider.apiKey); assert.ok(!started.args.join(' ').includes(h.provider.apiKey));
  const modelFile = path.join(h.root, 'data', 'agy', h.provider.id, 'antigravity-cli', 'settings.json'); const content = fs.readFileSync(modelFile, 'utf8'); assert.ok(!content.includes(h.provider.apiKey)); assert.equal(JSON.parse(content).model, h.provider.model); assert.equal(JSON.parse(content).modelProvider, 'gemini');
  assert.ok(!fs.existsSync(path.join(h.root, '.gemini')));
});
test('PowerShell launch source uses only escaped literal executable/arguments, not executable interpolation', () => {
  const script = buildLaunchScript({ executable: "C:\\test' &danger\\cli.cmd", args: ["$(evil); ' & run"] });
  assert.match(script, /'C:\\test'' &danger\\cli.cmd'/); assert.match(script, /'\$\(evil\); '' & run'/);
});
test('disposing during asynchronous CLI lookup cannot launch a late terminal or transmit a credential', async t => {
  const h = fixture(t); const project = h.service.save({ name: 'test', toolId: 'agy', pinned: false, directoryToken: h.service.offerDirectory(h.project).token });
  const preview = await h.service.previewLaunch({ projectId: project.id, providerId: h.provider.id });
  let release; h.pauseLookup(new Promise(resolve => { release = resolve; }));
  const launching = h.service.launch({ token: preview.token }); const rejected = assert.rejects(launching, { code: 'AI_TOOLS_DISPOSED' });
  h.service.dispose(); release(); await rejected; assert.equal(h.launches.length, 0); assert.ok(!fs.existsSync(path.join(h.root, 'data', 'agy')));
});

test('migration cancellation rejects late previews/launches without permanently disposing projects', async t => {
  const h = fixture(t); const project = h.service.save({ name: 'test', toolId: 'codex', pinned: false, directoryToken: h.service.offerDirectory(h.project).token });
  const ready = await h.service.previewLaunch({ projectId: project.id });
  let release; h.pauseLookup(new Promise(resolve => { release = resolve; }));
  const launching = h.service.launch({ token: ready.token }); const previewing = h.service.previewLaunch({ projectId: project.id });
  const rejectedLaunch = assert.rejects(launching, { code: 'AI_TOOLS_CANCELLED' }); const rejectedPreview = assert.rejects(previewing, { code: 'AI_TOOLS_CANCELLED' });
  h.service.cancelPending(); release(); await Promise.all([rejectedLaunch, rejectedPreview]); assert.equal(h.launches.length, 0);
  h.pauseLookup(null); const retry = await h.service.previewLaunch({ projectId: project.id }); await h.service.launch({ token: retry.token }); assert.equal(h.launches.length, 1);
});
