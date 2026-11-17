import { useEffect, useState } from 'react';
import { defaultRs232Memory, normalizeRs232Memory, readRs232Memory, writeRs232Memory } from './rs232ProtocolMemory.js';

const CHANGED = 'rs232-protocol-memory-changed';
export default function useRs232ProtocolMemory() {
  const [boot] = useState(() => { try { return { value: readRs232Memory(), error: '' }; } catch (error) { return { value: defaultRs232Memory(), error: error.message }; } });
  const [value, setValue] = useState(boot.value), [error, setError] = useState(boot.error);
  useEffect(() => {
    const refresh = () => { try { const next = readRs232Memory(); setValue(next); setError(''); } catch (failure) { setError(failure.message); } };
    window.addEventListener(CHANGED, refresh);
    return () => window.removeEventListener(CHANGED, refresh);
  }, []);
  const update = change => {
    try {
      setValue(normalizeRs232Memory(change(value)));
      const next = writeRs232Memory(change(readRs232Memory())); setValue(next); setError('');
      window.dispatchEvent(new Event(CHANGED)); return true;
    } catch (failure) { setError(failure.message); return false; }
  };
  return { value, error, update };
}
