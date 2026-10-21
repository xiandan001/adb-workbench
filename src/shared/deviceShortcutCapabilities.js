export const CAPABILITY_REFRESH_MS = 30000;

// Discard late replies after device/config changes or a reconnect starts a newer check.
export function createCapabilityLoader({ load, onResult, now = Date.now }) {
  let generation = 0;
  let disposed = false;
  let pending = null;
  let checkedAt = null;
  return {
    refresh(force = false) {
      if (disposed) return Promise.resolve();
      if (!force && pending) return pending;
      if (!force && checkedAt !== null && now() - checkedAt < CAPABILITY_REFRESH_MS) return Promise.resolve();
      const request = ++generation;
      const task = Promise.resolve().then(() => load(force)).then(result => {
        if (!disposed && generation === request) {
          checkedAt = now();
          onResult(result);
        }
      }, () => {
        if (!disposed && generation === request) {
          checkedAt = now();
          onResult({ success: false, error: '暂时无法检查设备，操作前仍会校验' });
        }
      }).finally(() => { if (pending === task) pending = null; });
      pending = task;
      return task;
    },
    dispose() { disposed = true; generation++; }
  };
}
