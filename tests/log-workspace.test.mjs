import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOG_PRESETS_KEY, captureLogEvidence, deleteLogPreset, findEvidenceReferences,
  fingerprintLogLines, logEvidenceScopeKey, nearbyHiddenLogEvidence, normalizeLogFilter, readLogPresets, resolveLogEvidenceRow, saveLogPreset
} from '../src/shared/logWorkspace.js';
import { PERFORMANCE_METRICS, buildPerformanceTimeline, makePerformancePath, nearestPerformanceSample, performanceAxisMax, performanceLogPositions, performanceSampleIndex, performanceTimelinePositions } from '../src/shared/performanceChart.js';

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('filter presets round-trip all supported fields and buffers, without extra state', () => {
  const storage = memoryStorage();
  const filter = { text: '错误', excludeText: 'noise', pkg: 'com.demo', tag: 'TAG', minLevel: 'W', regex: 'crash|ANR', regexFlags: 'i', pid: 42, secret: 'not-persisted' };
  const presets = saveLogPreset(storage, [], { name: '常用排查', filter, buffers: ['main', 'crash'] }, 'fixture');
  assert.deepEqual(readLogPresets(storage), presets);
  assert.equal(presets[0].filter.secret, undefined);
  assert.deepEqual(presets[0].filter, normalizeLogFilter(filter));
  assert.deepEqual(deleteLogPreset(storage, presets, 'fixture'), []);
  assert.equal(storage.getItem(LOG_PRESETS_KEY), '[]');
});

test('preset validation does not silently overwrite or truncate', () => {
  const storage = memoryStorage();
  assert.throws(() => saveLogPreset(storage, [], { name: ' ', filter: {} }, 'empty'), /1–40/);
  assert.throws(() => saveLogPreset(storage, Array(20).fill({}), { name: '21', filter: {} }, 'full'), /20/);
  storage.setItem(LOG_PRESETS_KEY, '{broken');
  assert.throws(() => readLogPresets(storage));
});

test('evidence stays linked to frozen raw logs across filtering and source mutation', () => {
  const first = { id: 'a', raw: 'first original', ts: 1000 };
  const second = { id: 'b', raw: 'second original', ts: 2000 };
  const capture = captureLogEvidence([first, second], [], 'device-a');
  first.raw = 'changed in current view';
  assert.equal(capture.evidence[0].raw, 'first original');
  const filtered = captureLogEvidence([second], capture.evidence, 'device-a');
  assert.equal(filtered.references.get('b'), 'L2');
  assert.equal(filtered.evidence.length, 2);
  const changed = captureLogEvidence([first], filtered.evidence, 'device-a');
  assert.equal(changed.references.get('a'), 'L3');
  assert.equal(changed.evidence[0].raw, 'first original');
});

test('invented and unsupplied references never resolve to a clickable source', () => {
  const { evidence } = captureLogEvidence([{ id: 'a', raw: 'A' }, { id: 'b', raw: 'B' }]);
  const refs = findEvidenceReferences('事实 [L1]，未发送 [L2]，幻觉 [L999]，重复 [L1]', ['L1'], evidence);
  assert.deepEqual(refs.map(item => item.ref), ['L1', 'L2', 'L999']);
  assert.equal(refs[0].entry.raw, 'A');
  assert.equal(refs[1].entry, undefined);
  assert.equal(refs[2].entry, undefined);
});

test('identical IDs and text on different devices or sources get independent evidence', () => {
  const entry = { id: 'reused', raw: 'same text', source: 'realtime' };
  const deviceA = captureLogEvidence([entry], [], 'device-a');
  const deviceB = captureLogEvidence([entry], deviceA.evidence, 'device-b');
  assert.equal(deviceB.references.get('reused'), 'L2');
  assert.equal(deviceB.evidence[0].deviceId, 'device-a');
  assert.equal(deviceB.evidence[1].deviceId, 'device-b');
  const file = captureLogEvidence([{ ...entry, source: 'file' }], deviceB.evidence, 'device-b');
  assert.equal(file.references.get('reused'), 'L3');
});

test('exact evidence navigation distinguishes reused capture data from hidden and evicted rows', () => {
  const wanted = { id: 'reused', raw: 'an exact line', ts: 2, receivedAt: 10, source: 'realtime' };
  const older = { ...wanted, ts: 1 }, differentText = { ...wanted, raw: 'changed after analysis' };
  const sameDevice = 'device-a';
  const scopeKey = logEvidenceScopeKey('document-a', 'source-a');
  const otherDocument = logEvidenceScopeKey('document-b', 'source-a');
  const { evidence: [frozen], evidence } = captureLogEvidence([wanted], [], sameDevice, scopeKey);
  assert.equal(captureLogEvidence([wanted], evidence, sameDevice, scopeKey).references.get(wanted.id), frozen.ref);
  assert.equal(captureLogEvidence([wanted], evidence, sameDevice, otherDocument).references.get(wanted.id), 'L2');
  assert.deepEqual(resolveLogEvidenceRow(frozen, { scopeKey, deviceId: sameDevice, filtered: [older, wanted] }),
    { status: 'visible', index: 1, row: wanted });
  assert.deepEqual(resolveLogEvidenceRow(frozen, { scopeKey, deviceId: sameDevice, filtered: [wanted, { ...wanted }] }),
    { status: 'unsupported' });
  const context = { scopeKey, deviceId: sameDevice, filtered: [older, differentText], entries: [wanted] };
  assert.deepEqual(resolveLogEvidenceRow(frozen, context), { status: 'hidden' });
  assert.deepEqual(resolveLogEvidenceRow(frozen, { ...context, entries: [] }), { status: 'evicted' });
  assert.deepEqual(resolveLogEvidenceRow(frozen, { ...context, queryBlocked: true }), { status: 'not-ready' });
  assert.deepEqual(resolveLogEvidenceRow(frozen, { ...context, scopeKey: otherDocument }), { status: 'source-changed' });
  assert.deepEqual(resolveLogEvidenceRow({ ...frozen, evidenceScopeKey: '' }, context), { status: 'unsupported' });
  assert.deepEqual(resolveLogEvidenceRow({ ...frozen, source: 'diagnostic-snapshot' }, context), { status: 'unsupported' });
});

test('temporary evidence preserves the filter and only reads neighbors from the matching device/source', () => {
  const scopeKey = logEvidenceScopeKey('document-a', 'source-a');
  const entry = { id: 'a', raw: 'an exact line', source: 'realtime', deviceId: 'device-a' };
  const neighbor = { ...entry, id: 'another' };
  const otherDevice = { ...entry, id: 'other', deviceId: 'device-b' };
  const otherSource = { ...entry, id: 'file', source: 'file' };
  const { evidence: [evidence] } = captureLogEvidence([entry], [], entry.deviceId, scopeKey);
  const doc = { scopeKey, deviceId: entry.deviceId, entries: [neighbor, otherDevice, entry, otherSource], filter: { text: 'keep' } };
  const original = structuredClone(doc);
  assert.deepEqual(nearbyHiddenLogEvidence(evidence, doc), { entry, context: [neighbor, entry] });
  assert.deepEqual(doc, original);
  assert.equal(nearbyHiddenLogEvidence(evidence, { ...doc, scopeKey: 'another source' }), null);
  assert.equal(nearbyHiddenLogEvidence(evidence, { ...doc, entries: [entry, { ...entry }] }), null);
});

test('incident timeline keeps real spacing, deduplicates samples, and marks actual warnings and local deltas', () => {
  const samples = buildPerformanceTimeline([
    { timestamp: 30_500, cpu: 98, surfaceFps: 5 }, // gap too long for a new drop/spike
    { timestamp: 1_000, cpu: 20, foregroundFps: 60, surfaceFps: 60 },
    { timestamp: Number.NaN, cpu: 99 },
    { timestamp: 2_000, cpu: 12, foregroundFps: 62 },
    { timestamp: 2_000, cpu: 90, foregroundFps: 20, warnings: [{ label: 'CPU 90%' }] },
  ]);
  const positions = performanceTimelinePositions(samples);
  assert.deepEqual(samples.map(sample => sample.timestamp), [1_000, 2_000, 30_500]);
  assert.deepEqual(positions, [0, 1000 / 29500, 1]);
  assert.equal(nearestPerformanceSample(.2, positions), 1);
  assert.equal(nearestPerformanceSample(.9, positions), 2);
  assert.deepEqual(samples[1].notices.map(item => item.kind), ['warning', 'cpu-spike', 'foregroundFps']);
  assert.deepEqual(samples[2].notices, []);
  assert.match(makePerformancePath(samples.map(sample => sample.cpu), 100, 100, 0, 100, positions), /L 3\.4 10\.0/);
  assert.match(makePerformancePath(samples.map(sample => sample.cpu), 100, 100, 0, 100, positions, samples.map(sample => sample.timestamp)), /M 100\.0 2\.0$/);
  assert.deepEqual(performanceLogPositions(samples, [1_000, 10_000, 10_000, 30_500, 30_501, '2000']), [0, 9000 / 29500, 1]);
});

test('same length log changes do not reuse a stale conversation fingerprint', () => {
  assert.notEqual(fingerprintLogLines(['[L1] AAA']), fingerprintLogLines(['[L1] BBB']));
  assert.equal(fingerprintLogLines(['x', 'y']), fingerprintLogLines(['x', 'y']));
});

test('evidence maximum is a rejection without modifying prior evidence', () => {
  const previous = Array.from({ length: 100000 }, (_, index) => ({ id: String(index), raw: '', ref: `L${index + 1}` }));
  assert.throws(() => captureLogEvidence([{ id: 'new', raw: 'new' }], previous), /100,000/);
  assert.equal(previous.length, 100000);
});

test('performance axes never mix units or clip high refresh rates', () => {
  const fps = PERFORMANCE_METRICS.filter(metric => metric.group === 'fps');
  assert.equal(performanceAxisMax('percent', [{ cpu: 98 }], PERFORMANCE_METRICS), 100);
  assert.equal(performanceAxisMax('fps', [{ foregroundFps: 240 }], fps), 240);
  assert.equal(performanceAxisMax('temperature', [{ temp: 75 }], PERFORMANCE_METRICS.filter(metric => metric.group === 'temperature')), 80);
  for (const group of ['percent', 'temperature', 'fps']) {
    assert.equal(new Set(PERFORMANCE_METRICS.filter(metric => metric.group === group).map(metric => metric.unit)).size, 1);
  }
});

test('missing chart values break paths rather than fabricating zero samples', () => {
  const path = makePerformancePath([10, 20, null, 40, 50], 200, 100, 10, 100);
  assert.equal((path.match(/M /g) || []).length, 2);
  assert.equal((path.match(/L /g) || []).length, 2);
  assert.equal(performanceSampleIndex(-1, 80), 0);
  assert.equal(performanceSampleIndex(2, 80), 79);
  assert.equal(performanceSampleIndex(0.5, 0), -1);
});
