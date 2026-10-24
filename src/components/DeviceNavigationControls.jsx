import { tr, useLocale } from '../shared/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Home, PanelRightOpen, Settings, Presentation, Loader2, ArrowLeft, PanelsTopLeft, Bell, AppWindow, Terminal, Pencil, CircleHelp } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { BUILTIN_SHORTCUTS, SHORTCUTS_KEY, SHORTCUTS_CHANGED, defaultDeviceShortcuts, readDeviceShortcuts, saveDeviceShortcuts, createShortcutExecutor } from '../shared/deviceNavigationShortcuts';
import DeviceShortcutEditor from './DeviceShortcutEditor';
import DeviceShortcutConfirm from './DeviceShortcutConfirm';
import useDeviceShortcutCapabilities from '../shared/useDeviceShortcutCapabilities';

const icons = { home: Home, sidebar: PanelRightOpen, settings: Settings, whiteboard: Presentation, back: ArrowLeft, recents: PanelsTopLeft, notifications: Bell };

function deviceShortcutDisplayLabel(action) {
  const builtin = action.type === 'builtin' && BUILTIN_SHORTCUTS.find(item => item.id === action.action);
  return builtin && action.label === builtin.label ? tr(builtin.label) : action.label;
}

export default function DeviceNavigationControls({ deviceId, isOnline, showToast, theme }) {
  useLocale();
  const [saved, setSaved] = useState(() => readDeviceShortcuts());
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [editing, setEditing] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const executor = useRef(createShortcutExecutor());
  const busyRef = useRef(false);
  const isDark = isDarkTheme(theme);
  const descriptionId = useId();
  const checks = useDeviceShortcutCapabilities(deviceId, isOnline, saved.config);
  const unavailable = checks.filter(check => check.status === 'unsupported');

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
      if (result.ok) showToast?.(tr("已发送{0}指令（{1}）", { 0: deviceShortcutDisplayLabel(action), 1: deviceId }));
    } catch (error) {
      const message = tr("{0}失败：{1}", { 0: deviceShortcutDisplayLabel(action), 1: error.message });
      setError(message);
      showToast?.(message);
      if (editing) throw error;
    } finally { busyRef.current = false; setPending(''); }
  };
  const save = config => {
    saveDeviceShortcuts(config);
    setEditing(false);
    setError('');
    showToast?.(tr("已保存所有设备共用的快捷操作"));
  };
  const resetBroken = () => {
    try { save(defaultDeviceShortcuts()); } catch (error) { setError(error.message); }
  };

  return <>
    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
      <span className="opacity-60">{tr("快捷操作")}</span><button type="button" onClick={() => setEditing(true)} disabled={!saved.config || Boolean(pending)} className="flex items-center gap-1 rounded px-1 py-1 opacity-70 hover:opacity-100 disabled:opacity-30" aria-label={tr("编辑快捷操作")}><Pencil size={12} />{tr("编辑")}</button>
    </div>
    <div className="device-navigation-grid" role="group" aria-label={tr("设备快捷操作")}>
      {(saved.config || defaultDeviceShortcuts()).slots.map(action => {
        const Icon = action.type === 'app' ? AppWindow : action.type === 'shell' ? Terminal : icons[action.action];
        const check = checks.find(item => item.id === action.id);
        const unsupported = check?.status === 'unsupported';
        const displayLabel = deviceShortcutDisplayLabel(action);
        const reason = !isOnline ? tr("设备离线，请先连接设备") : check?.reason ? tr(check.reason) : (action.type === 'shell' ? tr("自定义 ADB 命令，每次执行前均需确认") : tr("正在检查支持情况，操作时仍会校验"));
        return <span key={action.id} className="min-w-0" title={`${displayLabel} · ${reason}`}>
          <button type="button" className="device-navigation-button h-full w-full" onClick={() => runAction(action)}
          disabled={!saved.config || !isOnline || Boolean(pending) || unsupported} aria-busy={pending === action.id} aria-label={displayLabel} aria-describedby={`${descriptionId}-${action.id}`}>
          <span className="device-navigation-icon" aria-hidden="true">{pending === action.id ? <Loader2 size={19} className="animate-spin" /> : <Icon size={19} />}</span>
          <span className="min-w-0"><span className="block truncate">{pending === action.id ? tr("执行中…") : displayLabel}</span>{unsupported && <span className="line-clamp-2 break-words text-[10px] font-normal leading-3">{reason}</span>}</span>
          {check?.status === 'unknown' && <CircleHelp size={12} className="shrink-0 text-amber-500" aria-hidden="true" />}
          </button><span id={`${descriptionId}-${action.id}`} className="sr-only">{reason}</span>
        </span>;
      })}
    </div>
    {unavailable.length > 0 && <p className="mt-1.5 flex items-center justify-between gap-2 text-xs text-amber-600"><span>{tr("{0} 个按钮在此设备不可用", { 0: unavailable.length })}</span><button type="button" onClick={() => setEditing(true)} disabled={Boolean(pending)} className="underline underline-offset-2 disabled:opacity-40">{tr("编辑替换")}</button></p>}
    {saved.error && <div role="alert" className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">{tr(saved.error)}<button type="button" onClick={resetBroken} className="ml-2 underline">{tr("重置为默认配置")}</button></div>}
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">{tr(error)}</div>}
    {editing && saved.config && <DeviceShortcutEditor config={saved.config} deviceId={deviceId} isOnline={isOnline} isDark={isDark} pending={pending} onTest={runAction} onSave={save} onClose={() => setEditing(false)} />}
    {confirmation && <DeviceShortcutConfirm request={confirmation} isDark={isDark} />}
  </>;
}
