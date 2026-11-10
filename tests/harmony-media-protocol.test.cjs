const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createFrameParser, parseReady, parseUiTestVersion, createAgentConfig, sessionPaths } = require('../electron/lib/harmony-media-protocol.cjs');
const { createHarmonyMediaSessions, isLoopbackAddress, ownedStopCommand } = require('../electron/lib/harmony-media-session.cjs');
const ID = '12345678-1234-1234-1234-123456789abc';
const packet = (kind, data, flags = 0) => {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(20);
  header.write('AWBM'); header[4] = 1; header[5] = kind; header[6] = flags; header.writeUInt32BE(payload.length, 8);
  header.writeBigUInt64BE(1000n, 12);
  return Buffer.concat([header, payload]);
};
test('framing handles TCP splits and coalescing with strict size/kind validation', () => {
  const frames = [], parser = createFrameParser(frame => frames.push(frame));
  const input = Buffer.concat([packet(1, { state: 'started', code: 0 }), packet(2, Buffer.from([0, 0, 0, 1, 0x65]), 1)]);
  for (let offset = 0; offset < input.length; offset += 3) parser.push(input.subarray(offset, offset + 3));
  parser.end();
  assert.equal(frames[0].kind, 'state'); assert.equal(frames[1].kind, 'video'); assert.equal(frames[1].timestamp, 1000);
  assert.throws(() => createFrameParser(() => {}).push(packet(1, { state: 'started', code: 0, kind: 'video', data: 'forged' })), /状态格式/);
  const tooBig = packet(2, Buffer.alloc(1)); tooBig.writeUInt32BE(9 * 1024 * 1024, 8);
  assert.throws(() => createFrameParser(() => {}).push(tooBig), /长度/);
  const partial = createFrameParser(() => {}); partial.push(input.subarray(0, 9)); assert.throws(() => partial.end(), /不完整/);
});
test('config, readiness, UITest floor and loopback representations are validated', () => {
  const config = createAgentConfig(ID, { width: 2160, height: 3840 });
  assert.equal(config.token.length, 64); assert.ok(config.width <= 1280 && config.height <= 1280);
  assert.match(sessionPaths(ID).agent, /awb-media-.*\/agent.so$/);
  assert.throws(() => sessionPaths('../../agent'));
  assert.equal(parseUiTestVersion('5.1.1.2\n'), '5.1.1.2');
  assert.throws(() => parseUiTestVersion('4.1.4.5'), /UITest/);
  assert.throws(() => parseUiTestVersion('future-unknown'), /UITest/);
  assert.equal(parseReady(JSON.stringify({ protocol: 1, sessionId: ID, pid: 77, port: 40001, uitestVersion: '5.1.1.2' }), ID).pid, 77);
  assert.throws(() => parseReady(JSON.stringify({ protocol: 1, sessionId: 'other', pid: 77, port: 40001, uitestVersion: '5.1.1.2' }), ID));
  for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::FFFF:127.0.0.1']) assert.equal(isLoopbackAddress(ip), true);
  for (const ip of ['0.0.0.0', '::', '192.168.1.1', '::ffff:192.168.1.1', undefined]) assert.equal(isLoopbackAddress(ip), false);
});

function fixture(t, options = {}) {
  const calls = [], sent = [], states = [];
  let generation = 0, clock = 10000;
  const paths = new Map();
  const resolver = id => ({ id, transport: 'hdc', status: 'device', targetKey: id.slice(4), generation });
  const service = createHarmonyMediaSessions({
    resolve: resolver, commandPath: () => 'C:\\fixture\\hdc.exe', agentFile: () => 'C:\\fixture\\agent.so',
    screenshot: async (_id, _file, bound) => { bound.assertCurrent?.(); return { ok: true, width: 640, height: 360 }; },
    reservePort: async () => 45000, verifyForward: async () => { if (options.badForward) throw new Error('not loopback'); },
    sleep: async () => {}, now: () => ++clock, firstFrameTimeoutMs: 1000,
    invoke: async (id, args, bound) => {
      bound.assertCurrent?.(); calls.push({ id, args });
      if (args.join(' ') === 'shell uitest --version') return { ok: true, stdout: options.oldVersion ? '4.1.4.5' : '5.1.1.2' };
      if (args[1] === 'param') return { ok: true, stdout: 'arm64-v8a' };
      if (args[1] === 'mkdir') paths.set(id, args.at(-1));
      if (args[0] === 'file' && args[1] === 'send' && options.changeGeneration) generation++;
      if (args[1] === 'cat') return { ok: true, stdout: JSON.stringify({ protocol: 1, sessionId: paths.get(id).slice(-36), pid: 321, port: 40123, uitestVersion: '5.1.1.2' }) };
      return { ok: true, stdout: '' };
    },
    connect: () => {
      const socket = new EventEmitter(); socket.setNoDelay = () => {};
      socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; queueMicrotask(() => socket.emit('close')); } };
      socket.write = value => {
        sent.push(value.startsWith('AUTH ') ? 'AUTH' : value);
        if (value.startsWith('AUTH ')) queueMicrotask(() => socket.emit('data', packet(2, Buffer.from([0, 0, 0, 1, 0x65]), options.frameFlags ?? 1)));
        if (value === 'STOP\n') socket.destroy();
      };
      queueMicrotask(() => socket.emit('connect')); return socket;
    },
    onFrame: options.onFrame || (() => {}), onState: state => states.push(state)
  });
  t.after(() => service.shutdownAll());
  return { service, calls, sent, states };
}
test('concurrent start waits for one owned stream and cleanup targets only its PID/path/forward', async t => {
  const h = fixture(t);
  const [first, second] = await Promise.all([h.service.start('hdc:A'), h.service.start('hdc:A')]);
  assert.equal(first.success, true); assert.equal(first.session.id, second.session.id);
  assert.equal(h.calls.filter(call => call.args[1] === 'mkdir').length, 1);
  assert.deepEqual(h.sent, ['AUTH']);
  const result = await h.service.stop(first.session.id);
  assert.equal(result.success, true);
  const kill = h.calls.find(call => String(call.args[1]).includes('kill -TERM'));
  assert.ok(kill.args[1].includes(first.session.id));
  assert.ok(!h.calls.some(call => call.args.join(' ').includes('killall') || call.args.join(' ').includes('/data/local/tmp/agent.so')));
  assert.ok(h.calls.every(call => call.id === 'hdc:A'));
  assert.match(ownedStopCommand({ ready: { pid: 321 }, paths: sessionPaths(ID) }), /owner_mismatch/);
});

test('a combined configuration/keyframe packet is not discarded as configuration-only transport', async t => {
  const h = fixture(t, { frameFlags: 3 });
  const result = await h.service.start('hdc:A');
  assert.equal(result.success, true);
});

test('a genuinely decoded canvas frame can confirm readiness despite inaccurate configuration metadata', async t => {
  let delivered;
  const received = new Promise(resolve => { delivered = resolve; });
  const h = fixture(t, { frameFlags: 2, onFrame: () => delivered() });
  let completed = false;
  const opening = h.service.start('hdc:A').then(result => { completed = true; return result; });
  await received;
  const id = h.service.list()[0].id;
  assert.equal(completed, false, 'transport data alone must not bypass the actual first-frame gate');
  assert.equal(h.service.confirmDecoded(id), true);
  assert.equal((await opening).success, true);
  await h.service.stop(id);
  assert.equal(h.service.confirmDecoded(id), false);
});
test('old versions and generation changes never start an incompatible or replacement target agent', async t => {
  const old = fixture(t, { oldVersion: true });
  const unsupported = await old.service.start('hdc:A');
  assert.equal(unsupported.success, false); assert.equal(unsupported.code, 'UITEST_UNSUPPORTED');
  assert.equal(old.calls.length, 1);
  const changed = fixture(t, { changeGeneration: true });
  const result = await changed.service.start('hdc:A');
  assert.equal(result.success, false); assert.equal(result.code, 'DEVICE_CHANGED');
  assert.ok(!changed.calls.some(call => call.args.includes('start-daemon')));
});
test('unsafe forward never receives the token and finished history stays bounded', async t => {
  const forward = fixture(t, { badForward: true });
  assert.equal((await forward.service.start('hdc:A')).success, false);
  assert.deepEqual(forward.sent, []);
  const history = fixture(t, { oldVersion: true });
  for (let index = 0; index < 30; index++) await history.service.start('hdc:' + index);
  assert.equal(history.service.list().length, 20);
});
