import { useEffect, useState, useSyncExternalStore } from 'react';
import { createLogViewController } from './logViewClient.js';

export default function useLogViewEngine({ entries, filter, timeRange, rules, paused = false, scopeKey = '', timeoutMs = 1200 }) {
  const [controller] = useState(() => createLogViewController({ timeoutMs }));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  useEffect(() => { controller.update({ entries, filter, timeRange, rules, paused, scopeKey }); }, [controller, entries, filter, timeRange, rules, paused, scopeKey]);
  // Block scope/filter changes already during render, before the effect dispatches their query.
  const selectionPending = snapshot.selectionPending || !controller.isSelectionCurrent({ filter, timeRange, rules, scopeKey });
  return { ...snapshot, selectionPending, cancel: controller.cancel, retry: controller.retry };
}
