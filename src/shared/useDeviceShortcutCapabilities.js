import { tr } from './i18n.js';
import { useEffect, useRef, useState } from 'react';
import { CAPABILITY_REFRESH_MS, createCapabilityLoader } from './deviceShortcutCapabilities';

export default function useDeviceShortcutCapabilities(deviceId, isOnline, config) {
  const [result, setResult] = useState(null);
  const previous = useRef({ deviceId, isOnline });
  const key = JSON.stringify([deviceId, config]);
  useEffect(() => {
    const reconnected = previous.current.deviceId === deviceId && !previous.current.isOnline && isOnline;
    previous.current = { deviceId, isOnline };
    if (!isOnline || !config) return undefined;
    let disposed = false;
    // A reconnect must not keep disabled buttons from the previous connection.
    if (reconnected) Promise.resolve().then(() => { if (!disposed) setResult(null); });
    const loader = createCapabilityLoader({
      load: force => window.electronAPI?.deviceShortcutsCheck?.({ deviceId, config, force }) || { success: false },
      onResult: value => setResult({ key, ...value })
    });
    const refreshVisible = () => { if (!document.hidden) loader.refresh(); };
    // Editing a label/package should not queue one ADB scan for every keystroke.
    const initial = window.setTimeout(() => loader.refresh(reconnected), 250);
    const timer = window.setInterval(refreshVisible, CAPABILITY_REFRESH_MS);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      disposed = true;
      loader.dispose();
      window.clearTimeout(initial);
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [deviceId, isOnline, config, key]);
  if (!isOnline || result?.key !== key) return [];
  if (result.success) return result.checks;
  return (config?.slots || []).map(slot => ({ id: slot.id, status: slot.type === 'shell' ? 'confirm' : 'unknown',
    reason: slot.type === 'shell' ? tr("自定义 ADB 命令无法预检，每次执行前均需确认") : result.error || tr("暂时无法检查设备，操作前仍会校验") }));
}
