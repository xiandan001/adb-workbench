const test = require('node:test');
const assert = require('node:assert/strict');
const { createMirrorSessionState } = require('../electron/lib/mirror-session-state.cjs');
const { deviceComparisonIdentity } = require('../electron/lib/task-run-manifest.cjs');
const { profileIdentityKey, safeMirrorSettings } = require('../electron/lib/mirror-profile-store.cjs');
const { normalizeMirrorProfiles } = require('../electron/lib/mirror-profile-store.cjs');

test('mirror state separates a running texture process from verified decoded or user-confirmed pixels and keeps its late exit', () => {
  const changes = []; let time = 10;
  const state = createMirrorSessionState({ now: () => ++time, id: () => 'session-1', notify: value => changes.push(value) });
  const ticket = state.begin({ deviceId: 'A', transport: 'adb', generation: 2 }).ticket;
  state.observe(ticket, { source: 'mirror', transport: 'adb', event: 'ready', attemptNumber: 1, readiness: 'texture' });
  assert.equal(state.get('A').phase, 'running'); assert.equal(state.get('A').pictureConfirmed, false);
  assert.equal(state.confirm(ticket), true); assert.equal(state.get('A').pictureConfirmed, true);
  state.observe(ticket, { source: 'mirror', transport: 'adb', event: 'exit', attemptNumber: 1, exitCode: 1, reason: 'TRANSPORT' });
  assert.equal(state.get('A').phase, 'exited'); assert.equal(state.get('A').exitCode, 1); assert.ok(changes.length >= 4);
});

test('strict stored profile values do not depend on JSON property order', () => {
  const identity = deviceComparisonIdentity({ androidId: 'aabbccdd11223344' });
  const item = { id: profileIdentityKey(identity), identity, settings: { audioMode: 'disabled', maxSize: '0', bitrate: '8 Mbps' },
    globalSettings: { maxSize: '0', bitrate: '8 Mbps' }, verifiedAt: 1, verification: 'user-confirmed', toolVersion: '5.0.1' };
  assert.equal(normalizeMirrorProfiles({ version: 1, profiles: [item] }).profiles[0].settings.audioMode, 'disabled');
});

test('probe exits and old fallback attempts cannot terminate the current session; a replaced generation is fenced', () => {
  let sequence = 0; const state = createMirrorSessionState({ id: () => 'session-' + ++sequence });
  const first = state.begin({ deviceId: 'A', transport: 'adb', generation: 1 }).ticket;
  assert.equal(state.begin({ deviceId: 'A', transport: 'adb', generation: 1 }).alreadyActive, true);
  state.observe(first, { source: 'mirror', transport: 'adb', event: 'exit', attemptNumber: 0, phase: 'ended' });
  assert.equal(state.get('A').phase, 'starting');
  state.observe(first, { source: 'mirror', transport: 'adb', event: 'opening', attemptNumber: 2 });
  state.observe(first, { source: 'mirror', transport: 'adb', event: 'exit', attemptNumber: 1, exitCode: 1 });
  assert.equal(state.get('A').phase, 'starting');
  const replacement = state.begin({ deviceId: 'A', transport: 'adb', generation: 2 }).ticket;
  state.observe(first, { source: 'mirror', transport: 'adb', event: 'failure', attemptNumber: 2 });
  assert.equal(state.get('A').id, replacement.id); assert.equal(state.get('A').phase, 'starting');
  state.observe(replacement, { source: 'mirror', transport: 'adb', event: 'startup-unconfirmed', attemptNumber: 1 });
  assert.equal(state.get('A').phase, 'unconfirmed'); assert.equal(state.get('A').pictureConfirmed, false);
  assert.equal(state.confirm(replacement), true); assert.equal(state.get('A').phase, 'running');
});

test('only trusted comparison identity can bind a profile and only safe actual options survive', () => {
  assert.equal(profileIdentityKey({ ip: '192.0.2.1', model: 'board' }), null);
  assert.equal(profileIdentityKey(deviceComparisonIdentity({ roSerialno: '0123456789ABCDEF' })), null);
  const identity = deviceComparisonIdentity({ androidId: 'aabbccdd11223344' });
  assert.match(profileIdentityKey(identity), /^[a-f0-9]{64}$/);
  assert.notEqual(profileIdentityKey(identity), profileIdentityKey(deviceComparisonIdentity({ androidId: 'aabbccdd11223345' })));
  assert.deepEqual(safeMirrorSettings({ bitrate: '8 Mbps', maxSize: '1280', audioMode: 'disabled', screenOff: true, stayAwake: true, args: ['secret'] }),
    { bitrate: '8 Mbps', maxSize: '1280', audioMode: 'disabled' });
});

test('audio handoff is only a current starting ADB attempt1 reservation, never an ended-session reopening', () => {
  const state = createMirrorSessionState();
  const observe = (ticket, event, attemptNumber = 1) => state.observe(ticket, { source: 'mirror', transport: 'adb', event, attemptNumber });
  const first = state.begin({ deviceId: 'A', transport: 'adb', generation: 1 }).ticket;
  assert.equal(state.beginAudioFallback(first, 1), false, 'The first process must have opened');
  observe(first, 'opening'); assert.equal(state.beginAudioFallback(first, 2), false);
  assert.equal(state.beginAudioFallback(first, 1), true); assert.equal(state.beginAudioFallback(first, 1), false);
  observe(first, 'failure', 2); assert.equal(state.beginAudioFallback(first, 1), false);
  observe(first, 'opening', 3); assert.equal(state.get('A').phase, 'failed'); assert.equal(state.get('A').attemptNumber, 2);
  const second = state.begin({ deviceId: 'A', transport: 'adb', generation: 2 }).ticket; observe(second, 'opening');
  assert.equal(state.beginAudioFallback(first, 1), false); observe(second, 'ready'); assert.equal(state.beginAudioFallback(second, 1), false);
  const native = state.begin({ deviceId: 'H', transport: 'hdc', generation: 1 }).ticket;
  state.observe(native, { source: 'mirror', transport: 'hdc', event: 'opening', attemptNumber: 1 }); assert.equal(state.beginAudioFallback(native, 1), false);
});
