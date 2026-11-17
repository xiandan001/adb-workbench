import { createApplicationLogUi } from './applicationLogUi.js';

export function createSharedApplicationLogCapture(api, clock = globalThis) {
  const listeners = new Set();
  let snapshot, active = false;
  const deactivateIfUnused = () => { if (active && !listeners.size && !snapshot.busy) { active = false; model.deactivate(); } };
  const model = createApplicationLogUi({ api, clock, onChange(value) {
    snapshot = value;
    for (const listener of listeners) listener();
    deactivateIfUnused();
  } });
  snapshot = model.snapshot();
  return {
    model,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      const notify = () => listener(); listeners.add(notify);
      if (!active) { active = true; model.activate(); }
      return () => { listeners.delete(notify); deactivateIfUnused(); };
    },
  };
}

const stores = new WeakMap(), unavailableApi = {};
export function getApplicationLogCapture(api = globalThis.window?.electronAPI) {
  const key = api && ['object', 'function'].includes(typeof api) ? api : unavailableApi;
  if (!stores.has(key)) stores.set(key, createSharedApplicationLogCapture(api));
  return stores.get(key);
}
