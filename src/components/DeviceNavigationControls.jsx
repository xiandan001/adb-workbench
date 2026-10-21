import { useEffect, useRef, useState } from 'react';
import { Home, PanelRightOpen, Settings, Presentation, Loader2, ArrowLeft, PanelsTopLeft, Bell, AppWindow, Terminal, Pencil } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { SHORTCUTS_KEY, SHORTCUTS_CHANGED, defaultDeviceShortcuts, readDeviceShortcuts, saveDeviceShortcuts, createShortcutExecutor } from '../shared/deviceNavigationShortcuts';
import DeviceShortcutEditor from './DeviceShortcutEditor';
import DeviceShortcutConfirm from './DeviceShortcutConfirm';

const icons = { home: Home, sidebar: PanelRightOpen, settings: Settings, whiteboard: Presentation, back: ArrowLeft, recents: PanelsTopLeft, notifications: Bell };

export default function DeviceNavigationControls({ deviceId, isOnline, showToast, theme }) {
  const [saved, setSaved] = useState(() => readDeviceShortcuts());
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const executor = useRef(createShortcutExecutor());
  const busyRef = useRef(false);
  const isDark = isDarkTheme(theme);

  useEffect(() => {
    const refresh = event => { if (!event.key || event.key === SHORTCUTS_KEY) setSaved(readDeviceShortcuts()); };
    window.addEventListener(SHORTCUTS_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => { window.removeEventListener(SHORTCUTS_CHANGED, refresh); window.removeEventListener('storage', refresh); };
  }, []);

  const confirmShell = details => new Promise(resolve => {
    setConfirmation({ ...details, resolve: value => { setConfirmation(null); resolve(value); } });
  });
  const runAction = async action => {
    if (!isOnline || busyRef.current) return;
    busyRef.current = true;
    setError('');
    setPending(action.id);
    try {
      const result = await executor.current({ api: window.electronAPI, deviceId, shortcut: action, confirmShell });
      if (result.ok) showToast?.(`已发送${action.label}指令（${deviceId}）`);
    } catch (error) {
      const message = `${action.label}失败：${error.message}`;
      setError(message);
      showToast?.(message);
      if (editing) throw error;
    } finally { busyRef.current = false; setPending(''); }
  };
  const save = config => {
    saveDeviceShortcuts(config);
    setEditing(false);
    setError('');
    showToast?.('已保存所有设备共用的快捷操作');
  };
  const resetBroken = () => {
    try { save(defaultDeviceShortcuts()); } catch (error) { setError(error.message); }
  };

  return <>
    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
      <span className="opacity-60">快捷操作</span><button type="button" onClick={() => setEditing(true)} disabled={!saved.config || Boolean(pending)} className="flex items-center gap-1 rounded px-1 py-1 opacity-70 hover:opacity-100 disabled:opacity-30" aria-label="编辑快捷操作"><Pencil size={12} />编辑</button>
    </div>
    <div className="device-navigation-grid" role="group" aria-label="设备快捷操作">
      {(saved.config || defaultDeviceShortcuts()).slots.map(action => {
        const Icon = action.type === 'app' ? AppWindow : action.type === 'shell' ? Terminal : icons[action.action];
        return <button key={action.id} type="button" className="device-navigation-button" onClick={() => runAction(action)}
          disabled={!saved.config || !isOnline || Boolean(pending)} aria-busy={pending === action.id} aria-label={action.label} title={`${action.label}${action.type === 'shell' ? ' · 自定义 ADB 命令，执行前需确认' : ''}`}>
          <span className="device-navigation-icon" aria-hidden="true">{pending === action.id ? <Loader2 size={19} className="animate-spin" /> : <Icon size={19} />}</span>
          <span className="min-w-0 truncate">{pending === action.id ? '执行中…' : action.label}</span>
        </button>;
      })}
    </div>
    {saved.error && <div role="alert" className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">{saved.error}<button type="button" onClick={resetBroken} className="ml-2 underline">重置为默认配置</button></div>}
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">{error}</div>}
    {editing && saved.config && <DeviceShortcutEditor config={saved.config} deviceId={deviceId} isOnline={isOnline} isDark={isDark} pending={pending} onTest={runAction} onSave={save} onClose={() => setEditing(false)} />}
    {confirmation && <DeviceShortcutConfirm request={confirmation} isDark={isDark} />}
  </>;
}
