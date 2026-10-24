import { tr, useLocale } from '../shared/i18n';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Loader2, Play, RotateCcw, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { BUILTIN_SHORTCUTS, defaultDeviceShortcuts, normalizeDeviceShortcuts } from '../shared/deviceNavigationShortcuts';
import useDeviceShortcutCapabilities from '../shared/useDeviceShortcutCapabilities';

function deviceShortcutDisplayLabel(action) {
  const builtin = action.type === 'builtin' && BUILTIN_SHORTCUTS.find(item => item.id === action.action);
  return builtin && action.label === builtin.label ? tr(builtin.label) : action.label;
}

export default function DeviceShortcutEditor({ config, deviceId, isOnline, isDark, pending, onTest, onSave, onClose }) {
  useLocale();
  const dialogRef = useRef(null);
  const titleId = useId();
  const fieldId = useId();
  const [draft, setDraft] = useState(() => structuredClone(config));
  const [selected, setSelected] = useState(0);
  const [packages, setPackages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [packageError, setPackageError] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(config.slots.some(slot => slot.type === 'shell'));
  const slot = draft.slots[selected];
  const validDraft = useMemo(() => {
    try { return normalizeDeviceShortcuts(draft); } catch { return null; }
  }, [draft]);
  const checks = useDeviceShortcutCapabilities(deviceId, isOnline, validDraft);
  const selectedCheck = checks.find(check => check.id === slot.id);
  const field = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-800'}`;
  const muted = isDark ? 'text-[#BDC1C6]' : 'text-slate-500';
  const button = `rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145]' : 'border-slate-200 hover:bg-slate-50'}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => dialog.close();
  }, []);

  useEffect(() => {
    if (!isOnline) return undefined;
    let alive = true;
    Promise.resolve().then(async () => {
      if (!alive) return;
      setLoading(true);
      setPackageError('');
      if (!window.electronAPI?.packageList) throw new Error(tr("读取应用需要桌面环境"));
      const result = await window.electronAPI.packageList({ deviceId });
      if (!result?.ok) throw new Error(result?.error || tr("读取应用列表失败"));
      if (alive) setPackages(result.packages || []);
    }).catch(error => { if (alive) setPackageError(error.message); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [deviceId, isOnline]);

  const update = changes => {
    setError('');
    setDraft(current => ({ ...current, slots: current.slots.map((item, index) => index === selected ? { ...item, ...changes } : item) }));
  };
  const replace = type => {
    const next = type === 'builtin' ? { type, action: 'home', label: BUILTIN_SHORTCUTS.find(item => item.id === 'home').label }
      : type === 'app' ? { type, packageName: '', label: tr("打开应用") } : { type, command: '', label: tr("自定义命令") };
    setDraft(current => ({ ...current, slots: current.slots.map((item, index) => index === selected ? { id: item.id, ...next } : item) }));
    setQuery('');
    setError('');
  };
  const move = direction => {
    const target = selected + direction;
    if (target < 0 || target > 3) return;
    setDraft(current => {
      const slots = [...current.slots];
      [slots[selected], slots[target]] = [slots[target], slots[selected]];
      return { ...current, slots };
    });
    setSelected(target);
  };
  const submit = () => {
    try { onSave(normalizeDeviceShortcuts(draft)); } catch (error) { setError(error.message); }
  };
  const test = async () => {
    setError('');
    try { await onTest(slot); } catch (error) { setError(error.message); }
  };
  const appName = pkg => pkg?.label || (pkg?.apkName && pkg.apkName !== 'base.apk' ? pkg.apkName.replace(/\.apk$/i, '') : '');
  const options = packages.filter(pkg => `${appName(pkg)} ${pkg.packageName}`.toLowerCase().includes(query.toLowerCase()))
    .map(pkg => ({ value: pkg.packageName, label: appName(pkg) ? `${appName(pkg)} · ${pkg.packageName}` : pkg.packageName }));

  return <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); if (!pending) onClose(); }}
    className={`m-auto w-[min(700px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-2xl border p-0 shadow-2xl backdrop:bg-black/50 ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-800'}`}>
    <div className="flex items-start justify-between gap-4 border-b border-slate-400/20 px-5 py-4">
      <div><h2 id={titleId} className="font-semibold">{tr("编辑快捷操作")}</h2><p className={`mt-1 text-xs ${muted}`}>{tr("四个按钮由所有设备共用；保存不会执行操作。")}</p></div>
      <button type="button" onClick={onClose} disabled={Boolean(pending)} aria-label={tr("关闭快捷操作编辑")} className="rounded p-1 disabled:opacity-40"><X size={18} /></button>
    </div>
    <div className="space-y-4 p-5">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="group" aria-label={tr("选择要编辑的按钮")}>
        {draft.slots.map((item, index) => <button type="button" key={item.id} onClick={() => { setSelected(index); setQuery(''); setError(''); }} disabled={Boolean(pending)}
          aria-pressed={selected === index} className={`min-w-0 rounded-lg border p-2 text-left text-sm disabled:opacity-40 ${selected === index ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-400/25'}`}>
          <span className={`block text-xs ${muted}`}>{tr("位置 {0}", { 0: index + 1 })}</span><span className="block truncate" title={deviceShortcutDisplayLabel(item)}>{deviceShortcutDisplayLabel(item) || tr("未命名")}</span>
        </button>)}
      </div>
      <fieldset disabled={Boolean(pending)} className="space-y-4 disabled:opacity-60">
        <div className="flex items-center justify-between gap-2"><p className={`text-xs ${muted}`}>{tr("编辑位置 {0}", { 0: selected + 1 })}</p><div className="flex gap-2">
          <button type="button" onClick={() => move(-1)} disabled={selected === 0 || Boolean(pending)} className={`${button} flex items-center gap-1`} aria-label={tr("按钮前移")}><ArrowUp size={13} />{tr("前移")}</button>
          <button type="button" onClick={() => move(1)} disabled={selected === 3 || Boolean(pending)} className={`${button} flex items-center gap-1`} aria-label={tr("按钮后移")}><ArrowDown size={13} />{tr("后移")}</button>
        </div></div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-xs">{tr("按钮名称")}<input value={slot.label} maxLength={16} onChange={event => update({ label: event.target.value })} className={field} /></label>
          <div className="space-y-1 text-xs"><label htmlFor={`${fieldId}-type`}>{tr("操作类型")}</label><SelectMenu id={`${fieldId}-type`} isDark={isDark} value={slot.type} onChange={replace} disabled={Boolean(pending)}
            options={[{ value: 'builtin', label: tr("系统操作") }, { value: 'app', label: tr("打开应用") }, ...(advanced ? [{ value: 'shell', label: tr("ADB 命令（高级）") }] : [])]} /></div>
        </div>
        {slot.type === 'builtin' && <div className="space-y-1 text-xs"><label htmlFor={`${fieldId}-action`}>{tr("系统操作")}</label><SelectMenu id={`${fieldId}-action`} isDark={isDark} value={slot.action} disabled={Boolean(pending)}
          options={BUILTIN_SHORTCUTS.map(item => ({ value: item.id, label: tr(item.label) }))} onChange={action => update({ action, label: BUILTIN_SHORTCUTS.find(item => item.id === action).label })} /></div>}
        {slot.type === 'app' && <div className="space-y-2 text-xs">
          <label className="block space-y-1">{tr("搜索当前设备已安装的应用")}<input value={query} onChange={event => setQuery(event.target.value)} placeholder={tr("输入应用名称或包名")} className={field} /></label>
          <label htmlFor={`${fieldId}-app`}>{tr("选择应用")}</label><SelectMenu id={`${fieldId}-app`} isDark={isDark} value={slot.packageName} options={options}
            disabled={!isOnline || loading || Boolean(pending)} placeholder={loading ? tr("正在读取应用…") : tr("请选择已安装的应用")} emptyText={tr("没有匹配的应用")}
            onChange={packageName => update({ packageName, label: (appName(packages.find(item => item.packageName === packageName)) || packageName.split('.').at(-1)).slice(0, 16) })} />
          {slot.packageName && <p className={`break-all ${muted}`}>{tr("已选：{0}", { 0: slot.packageName })}</p>}
          {!isOnline && <p className="text-amber-500">{tr("请先连接当前设备再选择应用。")}</p>}
          {packageError && <p role="alert" className="text-red-500">{tr("{0}。关闭后重试。", { 0: packageError })}</p>}
        </div>}
        {slot.type === 'shell' && <label className="block space-y-2 text-xs">{tr("ADB shell 命令")}<input value={slot.command} maxLength={2000} onChange={event => update({ command: event.target.value })} placeholder={tr("例如 input keyevent KEYCODE_BACK")} className={`${field} font-mono`} />
          <span className={`block leading-5 ${muted}`}>{tr("无需填写 adb shell。仅一条命令，不支持管道、重定向或命令拼接。每次点击和测试均需确认完整命令，名称不能代替风险判断。")}</span></label>}
        {!advanced && <button type="button" onClick={() => setAdvanced(true)} className={`text-xs underline underline-offset-4 ${muted}`}>{tr("显示高级 ADB 命令")}</button>}
      </fieldset>
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-400/10 p-3">
        <p className={`min-w-0 break-all text-xs ${muted}`}>{tr("测试目标：")}{deviceId}{!isOnline ? tr("（离线）") : ''}</p>
        <button type="button" disabled={!isOnline || Boolean(pending) || !validDraft || selectedCheck?.status === 'unsupported'} onClick={test} className={`${button} flex items-center gap-1.5`}>{pending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}{tr("测试此按钮")}</button>
        {selectedCheck && <p className={`w-full break-words text-xs ${selectedCheck.status === 'supported' ? muted : 'text-amber-600'}`}>{tr(selectedCheck.reason)}</p>}
      </div>
      {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-400/20 px-5 py-4">
      <button type="button" disabled={Boolean(pending)} onClick={() => { setDraft(defaultDeviceShortcuts()); setSelected(0); setError(''); }} className={`${button} flex items-center gap-1.5`}><RotateCcw size={14} />{tr("恢复默认")}</button>
      <div className="flex gap-2"><button type="button" disabled={Boolean(pending)} onClick={onClose} className={button}>{tr("取消")}</button><button type="button" disabled={Boolean(pending)} onClick={submit} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white disabled:opacity-40">{tr("保存到所有设备")}</button></div>
    </div>
  </dialog>;
}
