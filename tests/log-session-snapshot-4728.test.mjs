import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeLogSessionSnapshot, logDocumentKey } from '../src/shared/logSessionSnapshot.js';
test('snapshot detaches mutable AI/marker containers while preserving exact raw lines and current scope', () => {
  const value = { documentId: 'doc', name: 'Example', source: 'file', sourceLabel: 'original.log', entries: [{ id: '1', raw: 'HiLog raw' }],
    deviceId: '', filter: {}, buffers: ['app'], timeRange: { kind: 'all' }, evidence: [], markers: [], aiTurns: [{ header: 'Q', content: 'A', evidenceRefs: [] }], truncated: false };
  const key = logDocumentKey(value), frozen = freezeLogSessionSnapshot(value, { uiRevision: key });
  value.aiTurns[0].content = 'new stream'; value.entries.push({ id: '2', raw: 'later' });
  assert.equal(frozen.aiTurns[0].content, 'A'); assert.equal(frozen.entries.length, 1); assert.equal(frozen.entries[0].raw, 'HiLog raw');
  assert.equal(frozen.uiRevision, key); assert.notEqual(logDocumentKey(value), key);
});
