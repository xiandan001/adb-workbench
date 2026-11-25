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
  assert.equal(f.status().code, undefined);
  assert.equal(f.status().percent, 100);
});

test('MTK elevated success finishes promptly without ADB and releases the staged firmware', async () => {
  let end, bootChecks = 0, released = 0;
  const f = fixture({ options: {
    prepare: async () => ({ ok: true, elevatedMtk: true, profile: { product: 'fixture' } }),
    stage: async () => ({ firmware: {}, release: async () => { released++; } }),
    armVendor: async (_plan, _anchor, _staged, context) => {
      assert.equal(context.beforeDispatch(), true);
      context.onReady({ timeoutMs: 50 });
      context.onProgress(80);
      return new Promise(resolve => { end = resolve; });
    },
    verify: async () => { bootChecks++; return false; },
  } });
  f.configure([], a);
  await f.arm();
  assert.equal(f.status().phase, 'writing');
  assert.equal(f.flow.isProtected(), true);
  end({ transferCompleted: true, code: 'mtk-tool-reported-success' });
  await flush();
  assert.equal(f.status().phase, 'written');
  assert.equal(f.status().percent, 100);
  assert.equal(f.status().code, undefined);
  assert.equal(bootChecks, 0);
  assert.equal(released, 1);
  assert.equal(f.flow.active(), false);
  assert.equal(f.flow.isProtected(), false);
});

test('MTK progress alone cannot be mistaken for successful writing', async () => {
  let bootChecks = 0;
  const f = fixture({ options: {
    prepare: async () => ({ ok: true, elevatedMtk: true, profile: { product: 'fixture' } }),
    armVendor: async (_plan, _anchor, _staged, context) => {
      context.onReady({ timeoutMs: 50 });
      context.onProgress(100);
      return { transferCompleted: false, code: 'mtk-target-mismatch' };
    },
    verify: async () => { bootChecks++; return false; },
  } });
  f.configure([], a);
  await f.arm();
  assert.equal(f.status().phase, 'failed');
  assert.equal(f.status().code, 'flash-plan-changed');
  assert.equal(bootChecks, 0);
});

test('vendor partition, stage and overall progress stay separate throughout a write', async () => {
  let report, end;
  const f = fixture({ options: {
    prepare: async () => ({ ok: true, elevatedMtk: true, profile: { product: 'fixture' } }),
    armVendor: async (_plan, _anchor, _staged, context) => {
      context.onReady({ timeoutMs: 50 });
      report = context.onProgress;
      return new Promise(resolve => { end = resolve; });
    },
  } });
  f.configure([], a);
  await f.arm();
  report(null, { stage: 'formatting', stagePercent: 68 });
  assert.equal(f.status().phase, 'writing');
  assert.equal(f.status().percent, null);
  assert.equal(f.status().stagePercent, 68);
  report(null, { stage: 'writing', part: 23, total: 24, partPercent: 30 });
  assert.equal(f.status().stagePercent, undefined);
  assert.equal(f.status().part, 23);
  assert.equal(f.status().total, 24);
  assert.equal(f.status().partPercent, 30);
  assert.equal(f.status().percent, null);
  report(71, { stage: 'writing' });
  report(5, { stage: 'writing', part: 23, total: 24, partPercent: 4 });
  assert.equal(f.status().percent, 71);
  assert.equal(f.status().partPercent, 30);
  report(null, { stage: 'finalizing' });
  assert.equal(f.status().partPercent, undefined);
  assert.equal(f.status().percent, 71);
  end({ transferCompleted: true });
  await flush();
  assert.equal(f.status().percent, 100);
  assert.equal(f.status().phase, 'written');
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
  assert.equal(exact.status('rk').code, 'flash-boot-unverified');

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

test('RK retries one unavailable snapshot at each write gate and launches only one write', async () => {
  let scans = 0, attempts = 0;
  const f = fixture({ options: {
    scan: async () => ({ ok: ![2, 4].includes(++scans), candidates: [a] }),
    write: async (_plan, device, _staged, context) => {
      if (!await context.beforeDispatch()) return { transferCompleted: false, code: 'flash-plan-changed' };
      assert.equal(device, a);
      attempts++;
      return { transferCompleted: true };
    },
  } });
  await f.arm('rk');
  assert.equal(scans, 5);
  assert.equal(attempts, 1);
  assert.equal(f.status('rk').phase, 'written');
});

test('RK does not retry a well-formed changed target at any write gate', async () => {
  for (const changedAt of [2, 3]) {
    let scans = 0;
    const f = fixture({ options: {
      scan: async () => ({ ok: true, candidates: [++scans === changedAt ? { ...a, selector: 'changed' } : a] }),
    } });
    await f.arm('rk');
    assert.equal(scans, changedAt);
    assert.deepEqual(f.writes, []);
    assert.equal(f.status('rk').code, 'flash-plan-changed');
  }
});

test('failed RK gate scans stay bounded, including when the owner or deadline changes', async () => {
  for (const [platform, losesGuard, expectedScans] of [['rk', '', 3], ['rk', 'owner', 2], ['rk', 'deadline', 2], ['mtk', '', 2]]) {
    let scans = 0, ownsFrame = true, now = 0;
    const f = fixture({
      settings: { now: () => now },
      options: {
        canStart: () => ownsFrame,
        scan: async () => {
          if (++scans === 1) return { ok: true, candidates: [a] };
          if (losesGuard === 'owner') ownsFrame = false;
          if (losesGuard === 'deadline') now = 50;
          return { ok: false };
        },
      },
    });
    await f.arm(platform);
    assert.equal(scans, expectedScans);
    assert.deepEqual(f.writes, []);
    assert.equal(f.status(platform).code, losesGuard === 'deadline' ? 'flash-wait-expired' : 'flash-plan-changed');
  }
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
  await second.arm('rk');
  assert.equal(second.flow.isProtected(), true);
  assert.equal(second.flow.cancel('rk', second.status('rk').id, owner).ok, false);
  assert.equal((await second.arm('mtk')).code, 'flash-busy');
  end({ transferCompleted: true });
  await flush();
  assert.equal(second.status('rk').phase, 'verified');
  assert.equal(second.flow.isProtected(), false);
});
