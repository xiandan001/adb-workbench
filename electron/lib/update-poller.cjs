const INITIAL_UPDATE_DELAY_MS = 3000;
const AUTO_UPDATE_INTERVAL_MS = 2 * 60 * 60 * 1000;

function createUpdatePoller({ run, canRun = () => true, now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
  let enabled = false;
  let disposed = false;
  let running = false;
  let runningGeneration = 0;
  let pendingGeneration = null;
  let generation = 0;
  let timer = null;
  let nextDueAt = null;

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }
  function arm(delay) {
    clearTimer();
    const scheduledGeneration = generation;
    const handle = schedule(() => {
      if (disposed || !enabled || generation !== scheduledGeneration || timer !== handle) return;
      timer = null;
      tick();
    }, Math.max(0, delay));
    timer = handle;
    timer?.unref?.();
  }
  function tick() {
    if (disposed || !enabled) return;
    if (now() < nextDueAt) { arm(nextDueAt - now()); return; }
    if (running && runningGeneration !== generation) {
      pendingGeneration = generation;
      return;
    }
    nextDueAt = now() + AUTO_UPDATE_INTERVAL_MS;
    arm(AUTO_UPDATE_INTERVAL_MS);
    if (running || !canRun()) return;
    running = true;
    runningGeneration = generation;
    const runGeneration = generation;
    const isCurrent = () => enabled && !disposed && generation === runGeneration;
    Promise.resolve().then(() => { if (isCurrent()) return run(isCurrent); })
      .catch(() => { /* The updater owns error reporting; keep the next regular deadline. */ })
      .finally(() => {
        running = false;
        if (!disposed && enabled && pendingGeneration === generation) {
          pendingGeneration = null;
          tick();
        }
      });
  }
  function setEnabled(value) {
    if (typeof value !== 'boolean') throw new TypeError('UPDATER_POLLER_ENABLED_INVALID');
    if (disposed || value === enabled) return;
    enabled = value;
    generation++;
    pendingGeneration = null;
    clearTimer();
    nextDueAt = enabled ? now() + INITIAL_UPDATE_DELAY_MS : null;
    if (enabled) arm(INITIAL_UPDATE_DELAY_MS);
  }
  function wake() {
    if (!disposed && enabled && now() >= nextDueAt) { clearTimer(); tick(); }
  }
  function dispose() {
    if (disposed) return;
    disposed = true; enabled = false; generation++; pendingGeneration = null; nextDueAt = null; clearTimer();
  }
  return { setEnabled, wake, dispose, snapshot: () => ({ enabled, running, nextDueAt, disposed }) };
}

module.exports = { createUpdatePoller, INITIAL_UPDATE_DELAY_MS, AUTO_UPDATE_INTERVAL_MS };
