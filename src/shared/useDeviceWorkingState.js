import { useCallback, useSyncExternalStore } from 'react';
import { deviceWorkingStore } from './deviceWorkingState.js';

export default function useDeviceWorkingState(deviceId) {
  const store = deviceWorkingStore();
  const subscribe = useCallback(listener => store.subscribe(deviceId, listener), [store, deviceId]);
  const getSnapshot = useCallback(() => store.getSnapshot(deviceId), [store, deviceId]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = useCallback((key, value, options) => store.update(deviceId,
    current => ({ [key]: typeof value === 'function' ? value(current[key]) : value }), options), [store, deviceId]);
  return { state, set, beginExecution: () => store.beginExecution(deviceId), retrySave: () => store.flush() };
}
