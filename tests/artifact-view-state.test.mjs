import test from 'node:test';
import assert from 'node:assert/strict';
import { ARTIFACT_VIEW_KEY, defaultArtifactView, normalizeArtifactViewState, readArtifactView, saveArtifactView } from '../src/shared/artifactViewState.js';

function storage() {
  const values = new Map();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
test('artifact views restore per-device filters and loaded position without restoring destructive selections', () => {
  const s = storage();
  assert.deepEqual(readArtifactView('A', s), defaultArtifactView());
  saveArtifactView('A', { query: 'report', typeFilter: 'task', sortOrder: 'size', visibleCount: 90 }, s);
  saveArtifactView('B', { query: 'second', typeFilter: 'all', sortOrder: 'oldest', visibleCount: 30 }, s);
  assert.equal(readArtifactView('A', s).query, 'report'); assert.equal(readArtifactView('A', s).visibleCount, 90);
  assert.equal(readArtifactView('B', s).query, 'second'); assert.deepEqual(readArtifactView('C', s), defaultArtifactView());
  const data = JSON.parse(s.getItem(ARTIFACT_VIEW_KEY));
  assert.equal(data.entries.length, 2); assert.ok(!JSON.stringify(data).includes('selected'));
  assert.throws(() => normalizeArtifactViewState({ ...data, selectedIds: ['unsafe'] }));
  assert.throws(() => normalizeArtifactViewState({ version: 1, entries: [{ ...data.entries[0], selectedIds: ['unsafe'] }] }));
});
test('corrupt or incompatible metadata is preserved on read and attempted write', () => {
  for (const raw of ['{broken', '{"version":2,"entries":[]}', '{"version":1,"entries":[{"deviceId":"A"}]}']) {
    const s = storage(); s.setItem(ARTIFACT_VIEW_KEY, raw);
    assert.throws(() => readArtifactView('A', s));
    assert.throws(() => saveArtifactView('A', defaultArtifactView(), s));
    assert.equal(s.getItem(ARTIFACT_VIEW_KEY), raw);
  }
});
test('metadata is bounded, copied, deduplicated and cannot carry paths or operation state', () => {
  const s = storage();
  for (let i = 0; i < 25; i++) saveArtifactView('device-' + i, defaultArtifactView(), s);
  const data = normalizeArtifactViewState(JSON.parse(s.getItem(ARTIFACT_VIEW_KEY)));
  assert.equal(data.entries.length, 20); assert.equal(data.entries[0].deviceId, 'device-5');
  assert.throws(() => saveArtifactView('A\nB', defaultArtifactView(), s));
  assert.throws(() => saveArtifactView('A', { ...defaultArtifactView(), query: 'x'.repeat(301) }, s));
  assert.throws(() => saveArtifactView('A', { ...defaultArtifactView(), typeFilter: 'unknown' }, s));
  assert.throws(() => saveArtifactView('A', { ...defaultArtifactView(), selectedIds: [] }, s));
  assert.throws(() => normalizeArtifactViewState({ version: 1, entries: [data.entries[0], data.entries[0]] }));
  saveArtifactView('A', { ...defaultArtifactView(), visibleCount: 6000 }, s);
  assert.equal(readArtifactView('A', s).visibleCount, 3000, 'Restoring a view cannot mount an unbounded number of cards');
});
test('a failed storage write does not mutate the caller snapshot or previous stored bytes', () => {
  const s = storage(); saveArtifactView('A', defaultArtifactView(), s); const before = s.getItem(ARTIFACT_VIEW_KEY);
  const draft = { query: 'unsaved', typeFilter: 'all', sortOrder: 'newest', visibleCount: 30 };
  assert.throws(() => saveArtifactView('A', draft, { getItem: s.getItem, setItem() { throw new Error('read only'); } }), /read only/);
  assert.equal(draft.query, 'unsaved'); assert.equal(s.getItem(ARTIFACT_VIEW_KEY), before);
});
