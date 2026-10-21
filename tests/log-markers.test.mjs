import test from 'node:test';
import assert from 'node:assert/strict';
import { captureLogMarker, filterLogSessions, logEntryIdentity } from '../src/shared/logMarkers.js';

test('problem marker freezes raw/time/device and nearby context independently of filtering or reused IDs', () => {
  const entries = Array.from({ length: 20 }, (_, index) => ({ id: `line-${index}`, raw: `raw ${index}`, ts: index * 1000, source: 'realtime' }));
  const marker = captureLogMarker(entries[10], entries, 'DEVICE-A', '这里开始黑屏', 'marker-id', 1234);
  assert.equal(marker.entry.deviceId, 'DEVICE-A');
  assert.equal(marker.context.length, 11);
  assert.equal(marker.context[0].raw, 'raw 5');
  assert.equal(marker.context[10].raw, 'raw 15');
  assert.equal(marker.entry.ts, 10000);
  const originalIdentity = logEntryIdentity(marker.entry);
  entries[10].raw = 'replaced';
  entries[9].raw = 'changed context';
  assert.equal(marker.entry.raw, 'raw 10');
  assert.equal(marker.context[4].raw, 'raw 9');
  assert.notEqual(logEntryIdentity(entries[10], 'DEVICE-A'), originalIdentity);
  assert.notEqual(logEntryIdentity({ ...marker.entry, deviceId: 'DEVICE-B' }), originalIdentity);
  assert.notEqual(logEntryIdentity({ ...marker.entry, ts: 20000 }), originalIdentity);
});

test('markers capture only available context and prefer the original entry device', () => {
  const entry = { id: '1', raw: 'line', ts: 0, deviceId: 'ORIGINAL' };
  const marker = captureLogMarker(entry, [], 'CURRENT', '  note  ', 'id');
  assert.equal(marker.entry.deviceId, 'ORIGINAL');
  assert.equal(marker.note, 'note');
  assert.deepEqual(marker.context, [marker.entry]);
  assert.throws(() => captureLogMarker(entry, [], '', ' ', 'id'), /备注/);
  assert.throws(() => captureLogMarker(entry, [], '', 'x'.repeat(241), 'id'), /备注/);
});

test('history search combines case-insensitive name/device and date period', () => {
  const now = new Date(2026, 9, 21, 12).getTime();
  const sessions = [
    { id: '1', name: '黑屏日志', deviceId: 'DEVICE-A', savedAt: new Date(now - 1000).toISOString() },
    { id: '2', name: '旧黑屏', deviceId: 'DEVICE-B', savedAt: new Date(now - 10 * 86400000).toISOString() }
  ];
  assert.deepEqual(filterLogSessions(sessions, 'device-a', 'all', now).map(item => item.id), ['1']);
  assert.deepEqual(filterLogSessions(sessions, '黑屏', '7', now).map(item => item.id), ['1']);
  assert.equal(filterLogSessions(sessions, '', '30', now).length, 2);
  assert.equal(filterLogSessions(sessions, '', 'today', now).length, 1);
  assert.equal(filterLogSessions(sessions, 'missing', 'all', now).length, 0);
});
