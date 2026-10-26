const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { createReportHistory, reportText, atomicWrite } = require('../electron/lib/ai-workspace-history.cjs');
const { freezeEntry } = require('../electron/lib/ai-workspace-evidence.cjs');
const limits = require('../electron/lib/ai-workspace-limits.cjs');
function fixture(t, io = fs) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-history-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('awb-ai-history-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, history: createReportHistory({ directory, io }), reload: () => createReportHistory({ directory, io }) };
}
function turn(text = 'synthetic log') {
  const entry = freezeEntry({ kind: 'text', label: 'fixture', text }, 0, 1000);
  return { id: randomUUID(), kind: 'analysis', createdAt: new Date(1000).toISOString(), preview: { id: randomUUID(), question: 'Synthetic fixture?', entries: [entry] },
    result: { summary: 'Fixture only', findings: [{ title: 'Fact', detail: 'Fixture detail', evidenceIds: ['E1'], citations: [{ evidenceId: 'E1', startLine: 1, endLine: 1 }] }], hypotheses: [], nextSteps: [], limitations: [] }, usage: null };
}

test('manual history writes one UUID report atomically, lists only metadata, and loads after restart without activation', t => {
  const reads = [];
  const io = { ...fs, readFileSync(file, ...args) { reads.push(file); return fs.readFileSync(file, ...args); } };
  const h = fixture(t, io); const original = turn();
  assert.deepEqual(h.history.list(), []);
  const item = h.history.save(original, 'My synthetic report');
  assert.notEqual(item.id, original.id); assert.equal(item.name, 'My synthetic report');
  reads.length = 0; assert.deepEqual(h.history.list(), [item]);
  assert.deepEqual(reads.map(file => path.basename(file)), ['index.json']);
  const report = h.reload().load(item.id);
  assert.deepEqual(report.preview, original.preview); assert.equal(report.turnId, original.id);
  assert.equal(Object.hasOwn(report, 'consent'), false);
  assert.deepEqual(fs.readdirSync(h.directory).sort(), [`${item.id}.json`, 'index.json'].sort());
});

for (const operation of ['writeFileSync', 'fsyncSync', 'renameSync']) {
  test(`history ${operation} failure preserves existing index and reports; export preserves existing destination`, t => {
    const h = fixture(t); const item = h.history.save(turn(), 'keep');
    const indexBefore = fs.readFileSync(path.join(h.directory, 'index.json'));
    const reportBefore = fs.readFileSync(path.join(h.directory, `${item.id}.json`));
    let fail = true;
    const io = { ...fs, [operation](...args) { if (fail) throw Object.assign(new Error('fixture I/O failure'), { code: 'EIO' }); return fs[operation](...args); } };
    const broken = createReportHistory({ directory: h.directory, io });
    assert.throws(() => broken.save(turn(), 'fail'), { code: 'EIO' });
    assert.deepEqual(fs.readFileSync(path.join(h.directory, 'index.json')), indexBefore);
    assert.deepEqual(fs.readFileSync(path.join(h.directory, `${item.id}.json`)), reportBefore);
    const destination = path.join(h.directory, 'report.md'); fs.writeFileSync(destination, 'existing destination');
    assert.throws(() => atomicWrite(destination, 'replacement', io), { code: 'EIO' });
    assert.equal(fs.readFileSync(destination, 'utf8'), 'existing destination');
    assert.equal(fs.readdirSync(h.directory).filter(file => file.endsWith('.tmp')).length, 0);
    fail = false; atomicWrite(destination, 'replacement', io); assert.equal(fs.readFileSync(destination, 'utf8'), 'replacement');
  });
}

test('index commit failure rolls back only the newly saved report and deletion can roll back its temporary rename', t => {
  const h = fixture(t); const item = h.history.save(turn(), 'keep');
  const filenames = fs.readdirSync(h.directory);
  const io = { ...fs, renameSync(from, to) { if (path.basename(to) === 'index.json') throw Object.assign(new Error('fixture'), { code: 'EIO' }); fs.renameSync(from, to); } };
  const broken = createReportHistory({ directory: h.directory, io });
  assert.throws(() => broken.save(turn(), 'fail'), { code: 'EIO' }); assert.deepEqual(fs.readdirSync(h.directory), filenames);
  assert.throws(() => broken.delete(item.id), { code: 'EIO' }); assert.deepEqual(fs.readdirSync(h.directory), filenames);
  assert.equal(h.history.load(item.id).name, 'keep');
  h.history.delete(item.id); assert.deepEqual(h.history.list(), []);
});

test('history rejects traversal, corrupted/oversized files, invented line ranges and symlink roots without touching sentinel', t => {
  const h = fixture(t); const item = h.history.save(turn(), 'fixture');
  for (const id of ['../outside', '..\\outside', 'index', '', null]) assert.throws(() => h.history.load(id), { code: 'AI_REPORT' });
  const file = path.join(h.directory, `${item.id}.json`), content = fs.readFileSync(file);
  for (const corrupt of ['{', 'x'.repeat(limits.reportBytes + 1), JSON.stringify({ ...JSON.parse(content), result: { ...turn().result, findings: [{ title: 'x', detail: 'x', evidenceIds: ['E99'] }] } })]) {
    fs.writeFileSync(file, corrupt); assert.throws(() => h.history.load(item.id), { code: 'AI_REPORT' });
  }
  fs.writeFileSync(file, content);
  const real = path.join(h.directory, 'real'), link = path.join(h.directory, 'link'); fs.mkdirSync(real); fs.writeFileSync(path.join(real, 'sentinel'), 'untouched');
  fs.symlinkSync(real, link, 'junction');
  assert.throws(() => createReportHistory({ directory: link }).save(turn(), 'no'), { code: 'AI_REPORT' });
  assert.equal(fs.readFileSync(path.join(real, 'sentinel'), 'utf8'), 'untouched'); assert.deepEqual(fs.readdirSync(real), ['sentinel']);
});

test('history capacity is bounded and saving never silently deletes an older report', t => {
  const h = fixture(t); const items = [];
  for (let i = 0; i < limits.reports; i++) items.push(h.history.save(turn(), `report ${i}`));
  assert.throws(() => h.history.save(turn(), 'one too many'), { code: 'AI_REPORT' });
  assert.equal(h.history.list().length, limits.reports); assert.equal(h.history.load(items[0].id).name, 'report 0');
});

test('Markdown export fences all untrusted text, preserves one numbering layer and tolerates many scattered backticks', () => {
  const report = turn('```\n<script>remote()</script> ![x](https://fixture.invalid/image)\n````');
  const exported = reportText(report);
  assert.match(exported, /`````text/); assert.match(exported, /\[L2\] <script>/); assert.doesNotMatch(exported, /1 \| \[L1\]/);
  const repeated = turn('a`'.repeat(220000));
  const large = reportText(repeated); assert.ok(large.length > 400000); assert.match(large, /```text/);
});

test('history rejects object-valued display metadata instead of allowing invalid React children', t => {
  const h = fixture(t), item = h.history.save(turn(), 'fixture'), filename = path.join(h.directory, `${item.id}.json`);
  const pristine = fs.readFileSync(filename, 'utf8');
  const mutations = [
    report => { report.preview.entries[0].label = {}; },
    report => { report.preview.entries[0].timeBasis = {}; },
    report => { report.preview.entries[0].selectionWarning = {}; },
    report => { report.preview.entries[0].timeWarning = []; },
    report => { report.preview.entries[0].windowInfo = { originalRecords: {}, retainedRecords: 1, byteLimit: 1024 }; },
    report => { report.preview.context = { question: {}, summary: 'fixture' }; },
    report => { report.preview.entries[0].events = [{ line: 1, timestamp: {}, clockBasis: 'unknown' }]; },
    report => { report.name = {}; },
  ];
  for (const mutate of mutations) {
    const report = JSON.parse(pristine); mutate(report); fs.writeFileSync(filename, JSON.stringify(report));
    assert.throws(() => h.history.load(item.id), { code: 'AI_REPORT' });
  }
});

test('renaming a report does not remove its original question, filters, paired groups or bounded-window caveats from export', () => {
  const report = turn(); report.name = 'Renamed report';
  report.preview.selection = { keywords: 'fixture', from: '', to: '', contextLines: 3, maxLines: 2000 };
  report.preview.entries[0].selectionWarning = 'fixture bounded window';
  report.preview.entries[0].windowInfo = { originalRecords: 50000, retainedRecords: 500, byteLimit: 2 * 1024 * 1024 };
  const exported = reportText(report);
  assert.match(exported, /Renamed report/); assert.match(exported, /Synthetic fixture\?/);
  assert.match(exported, /"keywords": "fixture"/); assert.match(exported, /fixture bounded window/); assert.match(exported, /"originalRecords": 50000/);
});
