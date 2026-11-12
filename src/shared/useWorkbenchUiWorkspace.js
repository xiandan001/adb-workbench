import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { defaultUiWorkspace, readUiWorkspace, saveUiWorkspace } from './workbenchUiState.js';

export default function useWorkbenchUiWorkspace(page) {
  const [boot] = useState(() => { try { return { value: readUiWorkspace(), error: '' }; } catch (error) { return { value: defaultUiWorkspace(), error: error.message }; } });
  const [value, setValue] = useState(boot.value), [saveError, setSaveError] = useState(boot.error);
  const latest = useRef(value), positions = useRef({ ...boot.value.scrollPositions }), timer = useRef(null), mainRef = useRef(null);
  useLayoutEffect(() => { latest.current = value; }, [value]);
  const persist = useCallback(() => {
    clearTimeout(timer.current); timer.current = null;
    try { saveUiWorkspace({ ...latest.current, scrollPositions: { ...positions.current } }); setSaveError(''); }
    catch (error) { setSaveError(error.message); }
  }, []);
  const schedule = useCallback(() => { clearTimeout(timer.current); timer.current = setTimeout(persist, 350); }, [persist]);
  useEffect(() => { schedule(); }, [value, schedule]);
  useEffect(() => {
    window.addEventListener('beforeunload', persist);
    return () => { window.removeEventListener('beforeunload', persist); clearTimeout(timer.current); };
  }, [persist]);
  useLayoutEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    const offset = positions.current[page] || 0;
    let restoring = offset > 0, frame = null;
    const observer = typeof MutationObserver === 'function' ? new MutationObserver(() => {
      if (frame === null && restoring) frame = requestAnimationFrame(restore);
    }) : null;
    function restore() {
      frame = null;
      if (!restoring) return;
      const available = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.min(offset, available);
      if (available >= offset) { restoring = false; observer?.disconnect(); }
    }
    const stopRestore = () => { restoring = false; observer?.disconnect(); };
    const keyIntent = event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) stopRestore(); };
    const remember = () => { if (!restoring) { positions.current[page] = Math.min(10000000, Math.max(0, element.scrollTop)); schedule(); } };
    if (restoring) { observer?.observe(element, { childList: true, subtree: true, attributes: true }); restore(); }
    else element.scrollTop = 0;
    element.addEventListener('wheel', stopRestore, { passive: true }); element.addEventListener('touchstart', stopRestore, { passive: true });
    element.addEventListener('pointerdown', stopRestore, { passive: true }); element.addEventListener('keydown', keyIntent);
    element.addEventListener('scroll', remember, { passive: true });
    return () => { if (frame !== null) cancelAnimationFrame(frame); observer?.disconnect(); element.removeEventListener('scroll', remember);
      element.removeEventListener('wheel', stopRestore); element.removeEventListener('touchstart', stopRestore); element.removeEventListener('pointerdown', stopRestore); element.removeEventListener('keydown', keyIntent); schedule(); };
  }, [page, schedule]);
  const setField = useCallback((field, next) => setValue(previous => ({ ...previous, [field]: typeof next === 'function' ? next(previous[field]) : next })), []);
  const setDeviceQuery = useCallback(next => setField('deviceQuery', next), [setField]);
  const setDensity = useCallback(next => setField('density', next), [setField]);
  const setExpandedDeviceIds = useCallback(next => setValue(previous => {
    const current = new Set(previous.expandedDeviceIds), result = typeof next === 'function' ? next(current) : next;
    return { ...previous, expandedDeviceIds: [...result].slice(-100) };
  }), []);
  return { deviceQuery: value.deviceQuery, setDeviceQuery, density: value.density, setDensity,
    expandedDeviceIds: new Set(value.expandedDeviceIds), setExpandedDeviceIds, mainRef, saveError, retrySave: persist };
}
