import test from 'node:test';
import assert from 'node:assert/strict';
import { createSshTerminalReader, createSshTerminalWriter } from '../src/shared/sshTerminalTransport.js';

test('SSH terminal writer binds both identities and never invokes serial APIs', async () => {
  const calls = [];
  const api = { sshTerminalWrite: async args => { calls.push(args); return { success: true, bytes: new TextEncoder().encode(args.content).length }; } };
  const a = createSshTerminalWriter({ sessionId: 'host-A', terminalId: 'pty-A1', api, delayMs: 1000 });
  const b = createSshTerminalWriter({ sessionId: 'host-B', terminalId: 'pty-B1', api, delayMs: 1000 });
  a.enqueue('A\r'); b.enqueue('B\t');
  await Promise.all([a.flush(), b.flush()]);
  assert.deepEqual(calls, [{ sessionId: 'host-A', terminalId: 'pty-A1', content: 'A\r' }, { sessionId: 'host-B', terminalId: 'pty-B1', content: 'B\t' }]);
  a.dispose(); b.dispose();
});

test('SSH terminal reader rejects a different PTY even within the same SSH session', async () => {
  const errors = []; const writes = [];
  const reader = createSshTerminalReader({ sessionId: 'host-A', terminalId: 'pty-A1', api: { sshTerminalRead: async args => ({ success: true, sessionId: args.sessionId, terminalId: 'pty-A2', startOffset: 0, endOffset: 1, nextOffset: 1, hex: '41' }) }, write: data => writes.push(data), onError: message => errors.push(message) });
  reader.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1); assert.deepEqual(writes, []); reader.dispose();
});

const tick = () => new Promise(resolve => setImmediate(resolve));
const packet = (hex, extra = {}) => ({ success: true, sessionId: 's', terminalId: 't', startOffset: 0, endOffset: hex.length / 2, nextOffset: hex.length / 2, hex, ...extra });
test('SSH reader renders at exact prompt marker offsets before echo in the same packet', async () => {
  const events = []; const scheduled = [];
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', api: { sshTerminalRead: async () => packet('2420676974', { shellIntegration: { status: 'ready', phase: 'prompt', promptId: 1 }, shellMarkers: [{ id: 1, offset: 0, kind: 'prompt-start', promptId: 1 }, { id: 2, offset: 2, kind: 'prompt', promptId: 1 }] }) },
    schedule: fn => scheduled.push(fn), cancel: () => {}, write: async bytes => { events.push(Buffer.from(bytes).toString()); }, onShellMarker: marker => events.push(marker.kind), onShellIntegration: value => events.push(value.status) });
  reader.start(); await tick();
  assert.deepEqual(events, ['ready', 'prompt-start', '$ ', 'prompt', 'git']);
  assert.equal(reader.state().offset, 5); reader.dispose();
});

test('SSH reader dispatches zero-byte markers once, including repeated inclusive boundaries', async () => {
  const markers = []; const callbacks = []; let calls = 0;
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', api: { sshTerminalRead: async () => { calls++; return packet('', { shellMarkers: [{ id: 1, offset: 0, kind: 'prompt', promptId: 1 }] }); } },
    schedule: fn => callbacks.push(fn), cancel: () => {}, write: async () => assert.fail('no bytes'), onShellMarker: marker => markers.push(marker.id) });
  reader.start(); await tick(); callbacks.shift()(); await tick();
  assert.equal(calls, 2); assert.deepEqual(markers, [1]); reader.dispose();
});

test('SSH reader drops delayed pre-pause metadata and restarts readonly replay', async () => {
  const markers = []; const callbacks = []; let release; let calls = 0; const replay = [];
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', api: { sshTerminalRead: async () => { calls++; if (calls === 1) return new Promise(resolve => { release = resolve; }); return packet('61', { shellMarkers: [{ id: 2, offset: 1, kind: 'prompt', promptId: 2 }] }); } },
    schedule: fn => callbacks.push(fn), cancel: () => {}, write: async (bytes, replaying) => replay.push(replaying), onShellMarker: marker => markers.push(marker.id) });
  reader.start(); reader.pause(); reader.start(); release(packet('', { shellMarkers: [{ id: 1, offset: 0, kind: 'prompt', promptId: 1 }] })); await tick(); callbacks.shift()(); await tick();
  assert.deepEqual(markers, [2]); assert.deepEqual(replay, [true]); reader.dispose();
});

test('SSH reader does not finish a resumed replay using an older pending render', async () => {
  const callbacks = []; let release; let calls = 0; const replay = [];
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', api: { sshTerminalRead: async () => { calls++; return packet(calls === 1 ? '61' : '62', { startOffset: 0, endOffset: calls, nextOffset: calls }); } },
    schedule: fn => callbacks.push(fn), cancel: () => {}, write: async () => { if (calls === 1) await new Promise(resolve => { release = resolve; }); }, onReplayChange: value => replay.push(value) });
  reader.start(); await tick(); reader.pause(); reader.start(); release(); await tick();
  assert.deepEqual(replay, [true, true]); assert.equal(reader.state().offset, 1);
  callbacks.shift()(); await tick(); assert.deepEqual(replay, [true, true, false]); reader.dispose();
});

test('SSH paused segmented write keeps displayed offset but defers markers and remaining bytes to resumed read', async () => {
  const callbacks = []; const events = []; let release; let calls = 0;
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', api: { sshTerminalRead: async ({ offset }) => {
    calls++; return packet(offset ? '676974' : '2420676974', { endOffset: 5, nextOffset: 5, shellMarkers: [{ id: 1, offset: 2, kind: 'prompt', promptId: 1 }] });
  } }, schedule: fn => callbacks.push(fn), cancel: () => {}, write: async bytes => {
    events.push(Buffer.from(bytes).toString()); if (calls === 1) await new Promise(resolve => { release = resolve; });
  }, onShellMarker: marker => events.push(marker.kind) });
  reader.start(); await tick(); reader.pause(); reader.start(); release(); await tick();
  assert.equal(reader.state().offset, 2); assert.deepEqual(events, ['$ ']);
  callbacks.shift()(); await tick(); assert.deepEqual(events, ['$ ', 'prompt', 'git']); assert.equal(reader.state().offset, 5); reader.dispose();
});

function scheduler() {
  const jobs = new Map(); let id = 0;
  return { schedule: (fn, delay) => { jobs.set(++id, { fn, delay }); return id; }, cancel: key => jobs.delete(key),
    next: () => { const [key, job] = jobs.entries().next().value; jobs.delete(key); job.fn(); return job.delay; },
    delays: () => [...jobs.values()].map(job => job.delay), size: () => jobs.size };
}
test('SSH reader polls active output at 16ms, backs idle reads off to 100ms and resets on activity', async () => {
  const clock = scheduler(); let output = ''; const received = [];
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', ...clock,
    api: { sshTerminalRead: async ({ offset }) => packet(output.slice(offset * 2), { nextOffset: output.length / 2, endOffset: output.length / 2 }) },
    write: async bytes => received.push(Buffer.from(bytes).toString()) });
  reader.start(); await tick();
  for (const delay of [16, 32, 64, 100, 100]) { assert.deepEqual(clock.delays(), [delay]); clock.next(); await tick(); }
  output = '61'; clock.next(); await tick();
  assert.deepEqual(received, ['a']); assert.deepEqual(clock.delays(), [16]); reader.dispose();
});
test('SSH reader drains backlog immediately but never reads again before render acknowledgement', async () => {
  const clock = scheduler(); let calls = 0; let render;
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', ...clock,
    api: { sshTerminalRead: async ({ offset }) => { calls++; return packet(offset ? '62' : '61', { nextOffset: offset + 1, endOffset: 2 }); } },
    write: async () => { if (calls === 1) await new Promise(resolve => { render = resolve; }); } });
  reader.start(); await tick(); assert.equal(calls, 1); assert.equal(clock.size(), 0);
  render(); await tick(); assert.deepEqual(clock.delays(), [0]);
  clock.next(); await tick(); assert.equal(calls, 2); assert.equal(reader.state().offset, 2); assert.deepEqual(clock.delays(), [16]); reader.dispose();
});
test('SSH requestRead wakes idle polling and coalesces during read/render without restarting replay', async () => {
  const clock = scheduler(); let calls = 0; let read; let render; const replay = [];
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', ...clock,
    api: { sshTerminalRead: async ({ offset }) => { calls++; if (calls === 2) return new Promise(resolve => { read = resolve; }); return packet('', { nextOffset: offset, endOffset: offset }); } },
    write: async () => new Promise(resolve => { render = resolve; }), onReplayChange: value => replay.push(value) });
  reader.start(); await tick(); assert.deepEqual(replay, [true, false]);
  reader.requestRead(); await tick(); assert.equal(calls, 2); assert.equal(clock.size(), 0);
  reader.requestRead(); reader.requestRead(); assert.equal(calls, 2);
  read(packet('61')); await tick(); reader.requestRead(); assert.equal(calls, 2); assert.equal(clock.size(), 0);
  render(); await tick(); assert.deepEqual(clock.delays(), [0]); clock.next(); await tick();
  assert.equal(calls, 3); assert.deepEqual(replay, [true, false]);
  reader.pause(); reader.requestRead(); await tick(); assert.equal(calls, 3);
  reader.dispose(); reader.requestRead(); assert.equal(clock.size(), 0);
});
test('SSH decode preserves every byte and uppercase hex at the maximum bounded batch size', async () => {
  const bytes = Uint8Array.from({ length: 65536 }, (_, i) => i & 255); const clock = scheduler(); let received;
  const reader = createSshTerminalReader({ sessionId: 's', terminalId: 't', ...clock,
    api: { sshTerminalRead: async () => packet(Buffer.from(bytes).toString('hex').toUpperCase()) }, write: async value => { received = value; } });
  reader.start(); await tick(); assert.deepEqual(received, bytes); reader.dispose();
});
test('SSH writer has no intentional eight-millisecond delay while retaining explicit overrides', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const calls = [];
  const api = { sshTerminalWrite: async args => { calls.push(args.content); return { success: true, bytes: args.content.length }; } };
  const immediate = createSshTerminalWriter({ sessionId: 's', terminalId: 't', api });
  const delayed = createSshTerminalWriter({ sessionId: 's', terminalId: 'other', api, delayMs: 8 });
  immediate.enqueue('i'); delayed.enqueue('d'); t.mock.timers.tick(0);
  assert.deepEqual(calls, ['i']); t.mock.timers.tick(8); assert.deepEqual(calls, ['i', 'd']);
  await Promise.all([immediate.flush(), delayed.flush()]); immediate.dispose(); delayed.dispose();
});
