import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recordingModeSelection } from '../src/shared/recordingWorkspace.js';

test('recording mode shows the active immutable session choice rather than a changed preference', () => {
  for (const status of ['starting', 'recording', 'stopping', 'saving']) {
    assert.deepEqual(recordingModeSelection({ loaded: true, pending: false, session: { status, withLogs: true } }, false), { active: true, withLogs: true, locked: true });
    assert.equal(recordingModeSelection({ loaded: true, session: { status, withLogs: false } }, true).withLogs, false);
  }
});
test('idle default is off, stored mode is retained, and pending or unloaded controls cannot change it', () => {
  assert.deepEqual(recordingModeSelection({ loaded: true, pending: false }, false), { active: false, withLogs: false, locked: false });
  assert.equal(recordingModeSelection({ loaded: true }, true).withLogs, true);
  assert.equal(recordingModeSelection({ loaded: false }, true).locked, true);
  assert.equal(recordingModeSelection({ loaded: true, pending: true }, true).locked, true);
});
test('compact mode uses an always-present mode control and does not hide effective log collection behind more tools', () => {
  const card = fs.readFileSync(new URL('../src/components/DeviceCard.jsx', import.meta.url), 'utf8');
  assert.match(card, /<RecordingModeControl recording=\{recording\} preferredWithLogs=\{recordWithLogs\}/);
  assert.doesNotMatch(card, /showSecondaryTools && <RecordingModeControl/);
  assert.match(card, /recording\.start\(\{ withLogs: recordWithLogs \}\)/);
  const mode = fs.readFileSync(new URL('../src/components/RecordingModeControl.jsx', import.meta.url), 'utf8');
  assert.match(mode, /if \(!mode.locked\) onChange/); assert.doesNotMatch(mode, /serialConnect|recording\.start|aiWorkspace/);
});
