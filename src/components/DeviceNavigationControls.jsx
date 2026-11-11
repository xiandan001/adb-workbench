import { tr, useLocale } from '../shared/i18n';
import { useEffect, useId, useRef, useState } from 'react';
import { Home, PanelRightOpen, Settings, Presentation, Unlock, Volume2, Volume1, Loader2, ArrowLeft, PanelsTopLeft, Bell, AppWindow, Terminal, Pencil, CircleHelp, Power } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { BUILTIN_SHORTCUTS, SHORTCUTS_KEY, HARMONY_SHORTCUTS_KEY, DEVICE_SHORTCUTS_KEY, SHORTCUTS_CHANGED, defaultDeviceShortcuts, readDeviceShortcuts, saveDeviceShortcuts, saveDeviceShortcutsForDevice, restoreSharedDeviceShortcuts, createShortcutExecutor, getDeviceShortcutCheck } from '../shared/deviceNavigationShortcuts';
import DeviceShortcutEditor from './DeviceShortcutEditor';
import DeviceShortcutConfirm from './DeviceShortcutConfirm';
import useDeviceShortcutCapabilities from '../shared/useDeviceShortcutCapabilities';

const icons = { home: Home, sidebar: PanelRightOpen, settings: Settings, childLockUnlock: Unlock, volumeUp: Volume2, volumeDown: Volume1, whiteboard: Presentation, back: ArrowLeft, recents: PanelsTopLeft, notifications: Bell, power: Power, apps: AppWindow };

function deviceShortcutDisplayLabel(action) {
  const builtin = action.type === 'builtin' && BUILTIN_SHORTCUTS.find(item => item.id === action.action);
  return builtin && action.label === builtin.label ? tr(builtin.label) : action.label;
}

export default function DeviceNavigationControls({ deviceId, isOnline, showToast, theme, onOpenApps }) {
  useLocale();
  const [stored, setSaved] = useState(() => readDeviceShortcuts(globalThis.localStorage, deviceId));
  const saved = stored.deviceId === deviceId ? stored : readDeviceShortcuts(globalThis.localStorage, deviceId);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [editor, setEditor] = useState(null);
  const editing = editor?.deviceId === deviceId;
  const [confirmation, setConfirmation] = useState(null);
  const confirmationRef = useRef(null);
  const executor = useRef(createShortcutExecutor());
  const busyRef = useRef(false);
  const isDark = isDarkTheme(theme);
  const descriptionId = useId();
  const sourceDescription = saved.source === 'device' ? tr('当前使用设备独立配置，优先于同平台共用配置。')
    : saved.source === 'shared' ? tr('当前使用同平台共用配置。') : saved.source === 'default' ? tr('当前使用出厂默认配置。') : '';
  const checks = useDeviceShortcutCapabilities(deviceId, isOnline, saved.config);
  const unavailable = (saved.config || defaultDeviceShortcuts(deviceId)).slots
    .map(action => getDeviceShortcutCheck(deviceId, action, checks)).filter(check => check?.status === 'unsupported');

  useEffect(() => {
    let alive = true;
    const refresh = (event = {}) => { if (alive && (!event.key || [SHORTCUTS_KEY, HARMONY_SHORTCUTS_KEY, DEVICE_SHORTCUTS_KEY].includes(event.key))) setSaved(readDeviceShortcuts(globalThis.localStorage, deviceId)); };
    Promise.resolve().then(() => {
      if (!alive) return;
      refresh();
      setEditor(current => current?.deviceId === deviceId ? current : null);
    });
    window.addEventListener(SHORTCUTS_CHANGED, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      alive = false;
      confirmationRef.current?.resolve(false);
      window.removeEventListener(SHORTCUTS_CHANGED, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, [deviceId]);

  const confirmShell = details => new Promise(resolve => {
    const request = { ...details, resolve: value => { confirmationRef.current = null; setConfirmation(null); resolve(value); } };
    confirmationRef.current = request;
    setConfirmation(request);
  });
  const runAction = async action => {
    if (!isOnline || busyRef.current) return;
    busyRef.current = true;
    setError('');
    setPending(action.id);
    try {
      const result = await executor.current({ api: window.electronAPI, deviceId, shortcut: action, confirmShell, onOpenApps });
      if (result.ok && !result.local) showToast?.(action.type === 'builtin' && action.action === 'childLockUnlock'
        ? tr('已发送童锁解锁按键，请确认触摸是否恢复。')
        : tr("已发送{0}指令（{1}）", { 0: deviceShortcutDisplayLabel(action), 1: deviceId }));
    } catch (error) {
      const message = tr("{0}失败：{1}", { 0: deviceShortcutDisplayLabel(action), 1: error.message });
      setError(message);
      showToast?.(message);
      if (editing) throw error;
    } finally { busyRef.current = false; setPending(''); }
  };
  const openEditor = () => { if (saved.config) setEditor({ deviceId, config: saved.config }); };
  const finishSave = message => {
    setSaved(readDeviceShortcuts(globalThis.localStorage, deviceId));
    setEditor(null);
    setError('');
    showToast?.(message);
  };
  const saveCurrent = config => {
    saveDeviceShortcutsForDevice(config, globalThis.localStorage, undefined, deviceId);
    finishSave(tr('已保存当前设备的快捷操作'));
  };
  const saveShared = config => {
    saveDeviceShortcuts(config, globalThis.localStorage, undefined, deviceId);
    const current = readDeviceShortcuts(globalThis.localStorage, deviceId);
    finishSave(current.hasOverride ? tr('已保存共用配置，当前设备仍使用独立配置')
      : tr('已保存同平台共用的快捷操作'));
  };
  const restoreShared = () => {
    const removed = restoreSharedDeviceShortcuts(globalThis.localStorage, undefined, deviceId);
    const current = readDeviceShortcuts(globalThis.localStorage, deviceId);
    setSaved(current);
    setEditor(null);
    setError('');
    if (removed && !current.error) showToast?.(tr('已恢复当前设备的共用配置'));
  };
  const resetBroken = () => {
    try { saveShared(defaultDeviceShortcuts(deviceId)); } catch (error) { setError(error.message); }
  };

  return <>
    <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
      <span className="min-w-0 flex flex-wrap items-center gap-2"><span className="opacity-60">{tr("快捷操作")}</span>{saved.hasOverride && <span title={sourceDescription} className="rounded border border-emerald-500/30 px-1.5 py-0.5 text-[10px] text-emerald-500">{tr('独立配置')}</span>}</span><button type="button" onClick={openEditor} disabled={!saved.config || Boolean(pending)} className="flex items-center gap-1 rounded px-1 py-1 opacity-70 hover:opacity-100 disabled:opacity-30" aria-label={tr("编辑快捷操作")}><Pencil size={12} />{tr("编辑")}</button>
    </div>
    <div className="device-navigation-grid" role="group" aria-label={tr("设备快捷操作")}>
      {(saved.config || defaultDeviceShortcuts(deviceId)).slots.map(action => {
        const Icon = action.type === 'app' ? AppWindow : action.type === 'shell' ? Terminal : icons[action.action];
        const check = getDeviceShortcutCheck(deviceId, action, checks);
        const unsupported = check?.status === 'unsupported';
        const displayLabel = deviceShortcutDisplayLabel(action);
        const reason = !isOnline ? tr("设备离线，请先连接设备") : check?.reason ? tr(check.reason) : (action.type === 'shell' ? deviceId.startsWith('hdc:') ? tr('自定义 HDC shell 命令，每次执行前均需确认') : tr("自定义 ADB 命令，每次执行前均需确认") : tr("正在检查支持情况，操作时仍会校验"));
        return <span key={action.id} className="min-w-0" title={`${displayLabel} · ${reason}`}>
          <button type="button" className="device-navigation-button h-full w-full" onClick={() => runAction(action)}
          disabled={!saved.config || !isOnline || Boolean(pending) || unsupported} aria-busy={pending === action.id} aria-label={displayLabel} aria-describedby={`${descriptionId}-${action.id}`}>
          <span className="device-navigation-icon" aria-hidden="true">{pending === action.id ? <Loader2 size={19} className="animate-spin" /> : <Icon size={19} />}</span>
          <span className="device-navigation-label"><span className="device-navigation-label-text">{pending === action.id ? tr("执行中…") : displayLabel}</span>{unsupported && <span className="line-clamp-2 break-words text-[10px] font-normal leading-3">{reason}</span>}</span>
          {check?.status === 'unknown' && <CircleHelp size={12} className="shrink-0 text-amber-500" aria-hidden="true" />}
          </button><span id={`${descriptionId}-${action.id}`} className="sr-only">{reason}</span>
        </span>;
      })}
    </div>
    {unavailable.length > 0 && <p className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-600"><span className="min-w-0">{tr("{0} 个按钮在此设备不可用", { 0: unavailable.length })}</span><button type="button" onClick={openEditor} disabled={Boolean(pending)} className="shrink-0 underline underline-offset-2 disabled:opacity-40">{tr("编辑替换")}</button></p>}
    {saved.error && <div role="alert" className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">{tr(saved.error)}{saved.errorSource === 'shared' && <button type="button" onClick={resetBroken} className="ml-2 underline">{tr('重置当前平台共用配置')}</button>}</div>}
    {error && <div role="alert" className="mt-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">{tr(error)}</div>}
    {editing && <DeviceShortcutEditor key={deviceId} config={editor.config} deviceId={deviceId} sourceDescription={sourceDescription} hasOverride={saved.hasOverride} isOnline={isOnline} isDark={isDark} pending={pending} onTest={runAction} onSave={saveCurrent} onSaveShared={saveShared} onRestoreShared={restoreShared} onClose={() => setEditor(null)} />}
    {confirmation?.deviceId === deviceId && <DeviceShortcutConfirm request={confirmation} isDark={isDark} />}
  </>;
}
