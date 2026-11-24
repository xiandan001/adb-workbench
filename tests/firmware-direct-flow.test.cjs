const test = require('node:test');
const assert = require('node:assert/strict');
const { setImmediate: flush } = require('node:timers/promises');
const { createFirmwareDirectFlow } = require('../electron/lib/firmware-direct-flow.cjs');

const target = (id, location, selector = id) => ({ id, identity: id, location, selector, label: id });
const a = target('a', 'usb-a');
const b = target('b', 'usb-b');
const owner = {};
function fixture({ options = {}, settings = {} } = {}) {
  let currentTime = 0, timer, candidates = [], anchor, available = true;
  const writes = [], confirms = [];
  const services = {
    canStart: () => true,
    prepare: async () => ({ ok: true }),
    scan: async () => ({ ok: available, candidates, anchor }),
    matchesAnchor: (origin, device) => origin.id === device.id && origin.location === device.location,
    confirm: async (_plan, device) => { confirms.push(device?.id); return true; },
    stage: async () => ({ firmware: {}, release: async () => {} }),
    validate: async () => true,
    write: async (_plan, device, _staged, context) => {
      if (!await context.beforeDispatch()) return { transferCompleted: false, code: 'flash-plan-changed' };
      writes.push(device.id);
      context.onProgress(50);
      return { transferCompleted: true };
    },
    verify: async () => false,
    ...options,
  };
  const flow = createFirmwareDirectFlow({
    services, waitMs: 50, now: () => currentTime, scanMs: 5,
    setTimer: callback => { timer = callback; return 1; }, clearTimer: () => { timer = undefined; }, ...settings,
  });
  return {
    flow, writes, confirms, configure(data = [], source = undefined, ok = true) { candidates = data; anchor = source; available = ok; },
    async arm(platform = 'mtk', targetHint = '') { const result = await flow.arm({ platform, targetHint }, owner); await flush(); return result; },
    async tick(ms = 5) { currentTime += ms; timer?.(); await flush(); },
    status: (platform = 'mtk') => flow.status(platform).job,
  };
}

test('only the verified preselected target starts after manual arrival; no second click or reboot command', async () => {
  const f = fixture();
  f.configure([], a);
  await f.arm('mtk', 'adb-a');
  assert.equal(f.status().phase, 'waiting');
  assert.deepEqual(f.writes, []);
  f.configure([b]);
  await f.tick();
  assert.deepEqual(f.writes, []);
  f.configure([b, a]);
  await f.tick();
  assert.deepEqual(f.writes, ['a']);
  assert.deepEqual(f.confirms, ['a']);
  assert.equal(f.status().phase, 'written');
  assert.equal(f.status().code, 'flash-boot-unverified');
});

test('unknown candidate never writes until explicitly chosen; only exact platform, owner, job and target match', async () => {
  const f = fixture();
  await f.arm();
  f.configure([a, b]);
  await f.tick();
  const job = f.status();
  assert.equal(job.phase, 'choice-required');
  assert.deepEqual(job.candidates.map(item => item.id), ['a', 'b']);
  assert.equal((await f.flow.choose('rk', job.id, a.id, owner)).ok, false);
  assert.equal((await f.flow.choose('mtk', job.id, a.id, {})).ok, false);
  assert.equal((await f.flow.choose('mtk', job.id, 'missing', owner)).ok, false);
  assert.deepEqual(f.writes, []);
  assert.equal((await f.flow.choose('mtk', job.id, a.id, owner)).ok, true);
  await flush();
  assert.deepEqual(f.writes, ['a']);
  assert.deepEqual(f.confirms, [undefined, 'a']);
});

test('pre-existing singleton is named in confirmation; swap, expiry and failed baseline never write', async () => {
  const exact = fixture();
  exact.configure([a]);
  await exact.arm('rk');
  assert.deepEqual(exact.confirms, ['a']);
  assert.deepEqual(exact.writes, ['a']);
  assert.equal(exact.status('rk').phase, 'written');

  let swap;
  const moved = fixture({ options: { validate: async () => { swap.configure([{ ...a, selector: 'reused' }, b]); return true; } } });
  swap = moved;
  moved.configure([a]);
  await moved.arm();
  assert.deepEqual(moved.writes, []);
  assert.equal(moved.status().code, 'flash-plan-changed');

  const expired = fixture();
  expired.configure([], a);
  await expired.arm('mtk', 'adb-a');
  expired.configure([a]);
  await expired.tick(51);
  assert.deepEqual(expired.writes, []);
  assert.equal(expired.status().code, 'flash-wait-expired');

  const incomplete = fixture();
  incomplete.configure([a], undefined, false);
  await incomplete.arm();
  assert.equal(incomplete.status().code, 'flash-usb-unavailable');
  assert.deepEqual(incomplete.writes, []);
});

test('cancel fencing discards a late scan and prevents cancellation or concurrent arm during writing', async () => {
  let scans = 0, resume;
  const first = fixture({ options: { scan: async () => {
    scans++;
    if (scans === 1) return { ok: true, candidates: [], anchor: a };
    return new Promise(resolve => { resume = resolve; });
  } } });
  await first.arm('mtk', 'adb-a');
  const job = first.status();
  assert.equal(first.flow.cancel('mtk', job.id, owner).ok, true);
  resume({ ok: true, candidates: [a] });
  await flush();
  assert.equal(first.status().phase, 'cancelled');
  assert.deepEqual(first.writes, []);

  let end;
  const second = fixture({ options: {
    write: async () => new Promise(resolve => { end = resolve; }),
    verify: async () => true,
  } });
  second.configure([a]);
  await second.arm();
  assert.equal(second.flow.isProtected(), true);
  assert.equal(second.flow.cancel('mtk', second.status().id, owner).ok, false);
  assert.equal((await second.arm('rk')).code, 'flash-busy');
  end({ transferCompleted: true });
  await flush();
  assert.equal(second.status().phase, 'verified');
  assert.equal(second.flow.isProtected(), false);
});
