import { useMemo, useSyncExternalStore } from 'react';
import { getApplicationLogCapture } from './applicationLogCapture.js';

export default function useApplicationLogCapture(api = globalThis.window?.electronAPI) {
  const store = useMemo(() => getApplicationLogCapture(api), [api]);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { view, model: store.model };
}
