const test = require('node:test');
const assert = require('node:assert/strict');
const { createUpdatePoller, INITIAL_UPDATE_DELAY_MS, AUTO_UPDATE_INTERVAL_MS } = require('../electron/lib/update-poller.cjs');
const flush = async () => { for (let index = 0; index < 12; index++) await Promise.resolve(); };
function clock() {
  let now = 1000, id = 0;
  const timers = new Map();
  return { now: () => now, timers,
    schedule(callback, delay) { const token = id++; timers.set(token, { callback, at: now + delay }); return token; },
    cancel(token) { timers.delete(token); },
    jump(delay) { now += delay; },
    async advance(delay) {
      const end = now + delay;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
        if (!next) break;
        now = next[1].at; timers.delete(next[0]); next[1].callback(); await flush();
      }
      now = end; await flush();
    },
  };
}
function fixture(options = {}) {
  const time = clock(), calls = [];
  const poller = createUpdatePoller({ ...time, run: async isCurrent => { calls.push({ at: time.now(), isCurrent }); }, ...options });
  return { time, calls, poller };
}

test('startup checks after three seconds and then once per exact two-hour period', async () => {
  assert.equal(INITIAL_UPDATE_DELAY_MS, 3000); assert.equal(AUTO_UPDATE_INTERVAL_MS, 7200000);
  const { time, calls, poller } = fixture(); poller.setEnabled(true);
  await time.advance(2999); assert.equal(calls.length, 0);
  await time.advance(1); assert.equal(calls.length, 1);
  await time.advance(AUTO_UPDATE_INTERVAL_MS - 1); assert.equal(calls.length, 1);
  await time.advance(1); assert.equal(calls.length, 2);
  await time.advance(AUTO_UPDATE_INTERVAL_MS); assert.equal(calls.length, 3);
  assert.equal(time.timers.size, 1); poller.dispose(); assert.equal(time.timers.size, 0);
});

test('duplicate enable notifications do not reset deadlines or create additional timers', async () => {
  const { time, calls, poller } = fixture(); poller.setEnabled(true);
  await time.advance(2000); const due = poller.snapshot().nextDueAt;
  poller.setEnabled(true); poller.setEnabled(true);
  assert.equal(poller.snapshot().nextDueAt, due); assert.equal(time.timers.size, 1);
  await time.advance(1000); assert.equal(calls.length, 1);
  poller.setEnabled(true); await time.advance(AUTO_UPDATE_INTERVAL_MS); assert.equal(calls.length, 2);
  poller.dispose();
});

test('disabled polling has no timers and cannot run a stale scheduled callback', async () => {
  const { time, calls, poller } = fixture(); poller.setEnabled(true);
  const stale = [...time.timers.values()][0].callback;
  poller.setEnabled(false); assert.equal(time.timers.size, 0); assert.equal(poller.snapshot().nextDueAt, null);
  stale(); await time.advance(AUTO_UPDATE_INTERVAL_MS * 2); poller.wake(); await flush(); assert.equal(calls.length, 0);
  poller.setEnabled(true); await time.advance(3000); assert.equal(calls.length, 1); poller.dispose();
});

test('disable and re-enable invalidate an older in-flight automatic download permission', async () => {
  let release; let oldPermission;
  const { time, poller } = fixture({ run: isCurrent => { oldPermission = isCurrent; return new Promise(resolve => { release = resolve; }); } });
  poller.setEnabled(true); await time.advance(3000); assert.equal(oldPermission(), true);
  poller.setEnabled(false); assert.equal(oldPermission(), false);
  poller.setEnabled(true); assert.equal(oldPermission(), false);
  release(); await flush(); poller.dispose();
});

test('long-running checks never overlap, and download/ready guards skip periodic work', async () => {
  let release; let attempts = 0; let allowed = true;
  const { time, poller } = fixture({ canRun: () => allowed, run: () => { attempts++; return new Promise(resolve => { release = resolve; }); } });
  poller.setEnabled(true); await time.advance(3000);
  await time.advance(AUTO_UPDATE_INTERVAL_MS * 2); assert.equal(attempts, 1);
  release(); await flush(); allowed = false;
  await time.advance(AUTO_UPDATE_INTERVAL_MS); assert.equal(attempts, 1);
  allowed = true; await time.advance(AUTO_UPDATE_INTERVAL_MS); assert.equal(attempts, 2);
  poller.dispose(); release(); await flush();
});

test('re-enabled polling catches up after an older in-flight check crosses the new startup deadline', async () => {
  let release; const permissions = [];
  const { time, poller } = fixture({ run: isCurrent => {
    permissions.push(isCurrent);
    if (permissions.length === 1) return new Promise(resolve => { release = resolve; });
  } });
  poller.setEnabled(true); await time.advance(3000);
  poller.setEnabled(false); poller.setEnabled(true); await time.advance(3000);
  assert.equal(permissions.length, 1); assert.equal(permissions[0](), false);
  release(); await flush();
  assert.equal(permissions.length, 2); assert.equal(permissions[0](), false); assert.equal(permissions[1](), true);
  assert.equal(time.timers.size, 1); assert.equal(poller.snapshot().nextDueAt, time.now() + AUTO_UPDATE_INTERVAL_MS);
  poller.dispose();
});

test('disabling or disposing again cancels an overdue replacement generation', async () => {
  for (const action of ['disable', 'dispose']) {
    let release; let attempts = 0;
    const { time, poller } = fixture({ run: () => { attempts++; return new Promise(resolve => { release = resolve; }); } });
    poller.setEnabled(true); await time.advance(3000);
    poller.setEnabled(false); poller.setEnabled(true); await time.advance(3000);
    if (action === 'disable') poller.setEnabled(false); else poller.dispose();
    release(); await flush(); assert.equal(attempts, 1); assert.equal(time.timers.size, 0);
    poller.dispose();
  }
});

test('multiple off/on changes retain only the newest generation deadline', async () => {
  let release; let attempts = 0;
  const { time, poller } = fixture({ run: () => { attempts++; if (attempts === 1) return new Promise(resolve => { release = resolve; }); } });
  poller.setEnabled(true); await time.advance(3000);
  poller.setEnabled(false); poller.setEnabled(true); await time.advance(3000);
  poller.setEnabled(false); poller.setEnabled(true); await time.advance(1000);
  release(); await flush(); assert.equal(attempts, 1);
  await time.advance(1999); assert.equal(attempts, 1);
  await time.advance(1); assert.equal(attempts, 2); assert.equal(time.timers.size, 1);
  poller.dispose();
});

test('failed work keeps the regular interval without a busy retry loop', async () => {
  let attempts = 0;
  const { time, poller } = fixture({ run: async () => { attempts++; throw new Error('network unavailable'); } });
  poller.setEnabled(true); await time.advance(3000); assert.equal(attempts, 1);
  await time.advance(AUTO_UPDATE_INTERVAL_MS); assert.equal(attempts, 2);
  assert.equal(time.timers.size, 1); poller.dispose();
});

test('sleeping through several intervals catches up only once after resume', async () => {
  const { time, calls, poller } = fixture(); poller.setEnabled(true);
  poller.wake(); await flush(); assert.equal(calls.length, 0);
  await time.advance(3000); time.jump(AUTO_UPDATE_INTERVAL_MS * 5);
  poller.wake(); poller.wake(); poller.wake(); await flush(); assert.equal(calls.length, 2);
  assert.equal(poller.snapshot().nextDueAt, time.now() + AUTO_UPDATE_INTERVAL_MS);
  assert.equal(time.timers.size, 1); poller.dispose();
});

test('dispose invalidates in-flight permissions permanently and rejects invalid switches', async () => {
  let permission; let release;
  const { time, poller } = fixture({ run: isCurrent => { permission = isCurrent; return new Promise(resolve => { release = resolve; }); } });
  assert.throws(() => poller.setEnabled('true'));
  poller.setEnabled(true); await time.advance(3000); poller.dispose();
  assert.equal(permission(), false); assert.equal(time.timers.size, 0);
  poller.setEnabled(true); poller.wake(); assert.equal(time.timers.size, 0);
  release(); await flush(); assert.equal(poller.snapshot().running, false);
});
