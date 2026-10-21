import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentDeviceRecording,
  deviceRecordingSessions,
  formatMediaDuration,
  recordingButtonState,
  recordingDuration,
  savedRecordingVisible,
  watchDeviceRecordings,
} from '../src/shared/recordingWorkspace.js';
import { formatMediaBytes, recentDeviceMedia } from '../src/shared/deviceMediaWorkspace.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

test('a remounted device uses the backend active recording without confusing another device', () => {
  const sessions = [
    { id: 'other', deviceId: 'B', status: 'recording', startedAt: 30 },
    { id: 'active', deviceId: 'A', status: 'recording', startedAt: 10 },
    { id: 'later-error', deviceId: 'A', status: 'error', startedAt: 20 },
  ];
  assert.equal(currentDeviceRecording(sessions, 'A').id, 'active');
  assert.equal(currentDeviceRecording(sessions, 'B').id, 'other');
  assert.equal(currentDeviceRecording(sessions, 'missing'), null);
  assert.deepEqual(deviceRecordingSessions(sessions, 'A').map(item => item.id), ['later-error', 'active']);
  assert.equal(sessions[0].id, 'other', 'helper does not reorder its caller snapshot');
});

test('recording controls cannot duplicate pending transitions or operate before state is known', () => {
  const ready = { loaded: true, pending: false, isOnline: true };
  for (const status of ['starting', 'stopping', 'saving']) {
    assert.equal(recordingButtonState({ status }, ready).disabled, true);
  }
  assert.equal(recordingButtonState(null, { ...ready, loaded: false }).disabled, true);
  assert.equal(recordingButtonState(null, { ...ready, pending: true }).disabled, true);
  assert.equal(recordingButtonState({ status: 'recording' }, { ...ready, isOnline: false }).disabled, true);
  assert.deepEqual(recordingButtonState({ status: 'recording' }, ready), { label: '停止并保存', recording: true, busy: false, disabled: false });
  assert.equal(recordingButtonState({ status: 'saved' }, ready).label, '录屏');
});

test('recording timer keeps advancing and ended durations are stable', () => {
  assert.equal(recordingDuration({ status: 'recording', startedAt: 1000, durationMs: 0 }, 62500), 61500);
  assert.equal(recordingDuration({ status: 'saving', startedAt: 1000, endedAt: 65000 }, 90000), 64000);
  assert.equal(recordingDuration({ status: 'saved', durationMs: 132000 }, 0), 132000);
  assert.equal(formatMediaDuration(61500), '01:01');
  assert.equal(formatMediaDuration(3600000), '60:00');
  assert.equal(formatMediaDuration(-1), '00:00');
});

test('saved confirmation disappears after ten seconds without hiding pending recovery', () => {
  const session = { status: 'saved', endedAt: 1000, savedAt: 80000 };
  assert.equal(savedRecordingVisible(session, 85000), true, 'countdown begins after save, not capture stop');
  assert.equal(savedRecordingVisible(session, 89999), true);
  assert.equal(savedRecordingVisible(session, 90000), false);
  assert.equal(savedRecordingVisible({ status: 'needs-save', endedAt: 80000 }, 85000), false);
  assert.equal(savedRecordingVisible({ status: 'error', endedAt: 80000 }, 85000), false);
});

test('new backend events beat a delayed initial snapshot and listeners clean up', async () => {
  const updates = [];
  let event;
  let finishList;
  let unsubscribed = false;
  const watcher = watchDeviceRecordings({
    onRecordingState(callback) { event = callback; return () => { unsubscribed = true; }; },
    recordingSessionsList: () => new Promise(resolve => { finishList = resolve; }),
  }, 'A', value => updates.push(value));
  event({ sessions: [{ id: 'new', deviceId: 'A', status: 'recording' }, { id: 'B', deviceId: 'B' }] });
  finishList({ success: true, sessions: [{ id: 'old', deviceId: 'A', status: 'saved' }] });
  await flush();
  assert.equal(updates.length, 1);
  assert.equal(updates[0].sessions[0].id, 'new');
  watcher.dispose();
  assert.equal(unsubscribed, true);
  event({ sessions: [] });
  assert.equal(updates.length, 1);
});

test('snapshot failure disables recording until a successful retry', async () => {
  const updates = [];
  let calls = 0;
  const watcher = watchDeviceRecordings({
    recordingSessionsList: async () => ++calls === 1 ? { success: false, error: 'IPC unavailable' } : { success: true, sessions: [] },
  }, 'A', value => updates.push(value));
  await flush();
  assert.equal(updates[0].loaded, false);
  assert.equal(updates[0].error, 'IPC unavailable');
  await watcher.refresh();
  assert.deepEqual(updates[1], { loaded: true, error: '', sessions: [] });
  watcher.dispose();
});

test('snapshot completion after unmount never updates a detached device card', async () => {
  const updates = [];
  let finish;
  const watcher = watchDeviceRecordings({ recordingSessionsList: () => new Promise(resolve => { finish = resolve; }) }, 'A', value => updates.push(value));
  watcher.dispose();
  finish({ success: true, sessions: [] });
  await flush();
  assert.deepEqual(updates, []);
});

test('recent media is device-scoped, newest-first, capped at ten and retains missing file hints', () => {
  const items = Array.from({ length: 13 }, (_, index) => ({ id: String(index), deviceId: 'A', type: index % 2 ? 'video' : 'image', createdAt: index, exists: index !== 12 }));
  items.push({ id: 'other', deviceId: 'B', type: 'video', createdAt: 100 });
  items.push({ id: 'invalid', deviceId: 'A', type: 'unknown', createdAt: 101 });
  const recent = recentDeviceMedia(items, 'A');
  assert.equal(recent.length, 10);
  assert.equal(recent[0].id, '12');
  assert.equal(recent[0].exists, false);
  assert.equal(recent.at(-1).id, '3');
  assert.equal(formatMediaBytes(0), '0 B');
  assert.equal(formatMediaBytes(1024), '1.0 KB');
  assert.equal(formatMediaBytes(1048576), '1.0 MB');
  assert.equal(formatMediaBytes(undefined), '大小未知');
});
