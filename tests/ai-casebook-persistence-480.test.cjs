const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), { randomUUID, createHash } = require('node:crypto');
const { createAiWorkspaceService } = require('../electron/lib/ai-workspace-service.cjs');
const { createEvidenceAdapter } = require('../electron/lib/ai-workspace-evidence.cjs');
const { createAsyncReportStore } = require('../electron/lib/ai-workspace-store-async.cjs');
test('quick-review fields save and reload using the unchanged atomic store; a write failure preserves the last durable case and never runs AI', async t => {
  const { casebookPrefill } = await import('../src/shared/aiCasebookPrefill.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-casebook-480-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); assert.ok(path.basename(directory).startsWith('veylo-casebook-480-')); await fs.rm(directory, { recursive: true, force: true }); });
  let modelCalls = 0, reads = 0;
  const casebook = createAsyncReportStore({ directory, casebook: true });
  const service = createAiWorkspaceService({ casebook: { ...casebook, save: (report, name, review) => casebook.save(report, name, review) }, membership: async () => ({ activated: true, scope: 'vip' }),
    evidence: createEvidenceAdapter({ runAdb: async args => { reads++; return { ok: true, stdout: args.includes('get-state') ? 'device' : 'versionName=1.2.3\nversionCode=123' }; } }),
    client: async () => { modelCalls++; return { ok: true, text: JSON.stringify({ summary: 'Observation only', findings: [{ title: 'Observed', detail: 'Version data', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 1 }] }], hypotheses: [], nextSteps: [], limitations: [] }) }; } });
  t.after(() => service.dispose()); const caseId = randomUUID();
  const collected = await service.call('collect', { caseId, mode: 'diagnose', question: 'Verify app', deviceId: 'USB-DEVICE', checks: ['app_package'], diagnostic: { packageName: 'com.fixture.app', symptom: 'crash' } });
  const analyzed = await service.call('analyze', { caseId, previewId: collected.preview.id, consent: true }); assert.equal(analyzed.ok, true);
  const prefill = casebookPrefill(analyzed.turn); assert.equal(prefill.review.version, '1.2.3'); assert.equal(prefill.review.status, 'unverified');
  const review = { ...prefill.review, solution: 'User performed the actual action', verification: 'User measured the result', status: 'verified' };
  const prior = { modelCalls, reads };
  const saved = await service.call('casebookSave', { reportRef: { caseId, turnId: analyzed.turn.id }, name: prefill.name, review }); assert.equal(saved.ok, true, `${saved.code}: ${saved.error}`);
  const fresh = createAsyncReportStore({ directory, casebook: true }), stored = await fresh.load(saved.item.id); assert.deepEqual(stored.review, review);
  const loaded = await service.call('casebookLoad', { id: saved.item.id }); assert.equal(loaded.report.review.solution, review.solution);
  assert.deepEqual({ modelCalls, reads }, prior, 'Opening and saving cases never reads a device or calls a model');
  const filename = path.join(directory, `${saved.item.id}.json`), hash = value => createHash('sha256').update(value).digest('hex'), oldBytes = hash(await fs.readFile(filename));
  const failing = createAsyncReportStore({ directory, casebook: true, io: { ...fs, open: async (file, ...args) => { if (file.endsWith('.tmp')) throw Object.assign(Error('fixture full disk'), { code: 'ENOSPC' }); return fs.open(file, ...args); } } });
  await assert.rejects(failing.update(saved.item.id, stored.revision, { ...review, solution: 'Unsaved replacement' }));
  assert.equal(hash(await fs.readFile(filename)), oldBytes); assert.equal((await fresh.load(saved.item.id)).review.solution, review.solution);
  assert.deepEqual({ modelCalls, reads }, prior);
});
