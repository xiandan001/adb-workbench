import { tr, useLocale } from '../shared/i18n';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { defaultUiMotionPreferences, readUiMotionPreferences, saveUiMotionPreferences, UI_MOTION_CHANGED, UI_MOTION_PREFS_KEY } from '../shared/uiMotionPreferences';

function initialMotionState() {
  try { return { value: readUiMotionPreferences(), error: '' }; }
  catch (failure) { return { value: defaultUiMotionPreferences(), error: failure.message || tr("无法读取动效偏好，当前显示默认值；重新选择可保存修复。") }; }
}
function startupSettingsResult(response) {
  if (!response?.success) throw new Error(response?.error?.message || tr("开机自启设置操作失败，请重试"));
  const result = response.result;
  if (!result || typeof result.enabled !== 'boolean' || !['packaged', 'development', 'unsupported'].includes(result.mode)
    || result.registered !== null && typeof result.registered !== 'boolean' || result.message !== undefined && typeof result.message !== 'string') throw new Error(tr("启动设置返回格式无效，请重试读取"));
  return { ...result };
}
function startupDescription(state) {
  if (!state) return tr("读取当前电脑的启动设置后可修改。");
  if (state.mode === 'development') return tr(state.message) || tr("开发/验证模式仅保存选择，不修改系统启动项。");
  if (state.mode === 'unsupported') return tr(state.message) || tr("当前平台不支持系统启动项，仅保留本机偏好。");
  return tr(state.message) || (state.enabled ? tr("已启用当前用户登录系统后启动卓控台。") : tr("已关闭当前用户登录系统后启动卓控台。"));
}
function PreferenceSwitch({ title, description, checked, disabled, busy, onChange, isDark }) {
  useLocale();
  const id = useId();
  return <div className="flex items-center justify-between gap-4 py-3"><div className="min-w-0"><label htmlFor={id} className="cursor-pointer text-sm font-medium">{title}</label><p id={`${id}-description`} className={`mt-1 text-xs leading-5 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>{description}</p></div><div className="flex shrink-0 items-center gap-2">{busy && <Loader2 size={13} aria-label={tr("正在处理启动设置")} className="animate-spin text-emerald-500" />}<label className={`relative inline-flex ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}><input id={id} role="switch" type="checkbox" aria-describedby={`${id}-description`} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} className="peer sr-only" /><span aria-hidden="true" className={`relative h-6 w-11 rounded-full transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-emerald-500 ${checked ? 'bg-emerald-500' : isDark ? 'bg-slate-600' : 'bg-slate-300'}`}><span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : ''}`} /></span></label></div></div>;
}

export default function StartupPreferences({ theme, isDark }) {
  useLocale();
  const api = window.electronAPI;
  const [motion, setMotion] = useState(initialMotionState); const [motionNotice, setMotionNotice] = useState(''); const motionSaving = useRef(false);
  const [startup, setStartup] = useState(null); const [startupLoading, setStartupLoading] = useState(true); const [startupSaving, setStartupSaving] = useState(false); const [startupError, setStartupError] = useState('');
  const mounted = useRef(false); const operation = useRef({ generation: 0, busy: false });
  const loadStartup = useCallback(async () => {
    if (operation.current.busy) return;
    const generation = ++operation.current.generation; operation.current.busy = true; setStartupLoading(true); setStartupError('');
    try {
      if (typeof api?.startupSettingsGet !== 'function') throw new Error(tr("当前环境暂不提供开机自启设置，请在桌面应用中使用。"));
      const result = startupSettingsResult(await api.startupSettingsGet());
      if (mounted.current && operation.current.generation === generation) setStartup(result);
    } catch (failure) { if (mounted.current && operation.current.generation === generation) setStartupError(failure.message || tr("无法读取开机自启设置")); }
    finally { if (operation.current.generation === generation) { operation.current.busy = false; if (mounted.current) setStartupLoading(false); } }
  }, [api]);
  useEffect(() => {
    const scope = operation.current;
    mounted.current = true; void loadStartup();
    return () => { mounted.current = false; scope.generation++; scope.busy = false; };
  }, [loadStartup]);
  useEffect(() => {
    const update = () => {
      try { setMotion({ value: readUiMotionPreferences(), error: '' }); }
      catch (failure) { setMotion(previous => ({ ...previous, error: failure.message || tr("动效偏好读取失败") })); }
    };
    const storageChanged = event => { if (event.key === UI_MOTION_PREFS_KEY || event.key === null) update(); };
    window.addEventListener(UI_MOTION_CHANGED, update); window.addEventListener('storage', storageChanged);
    return () => { window.removeEventListener(UI_MOTION_CHANGED, update); window.removeEventListener('storage', storageChanged); };
  }, []);
  const saveMotion = (key, enabled) => {
    if (motionSaving.current || !['reducedMotion', 'startupAnimation'].includes(key) || typeof enabled !== 'boolean') return;
    motionSaving.current = true; setMotionNotice('');
    try {
      let current = motion.value; try { current = readUiMotionPreferences(); } catch { /* An explicit valid choice may repair corrupt local preferences. */ }
      const next = saveUiMotionPreferences({ ...current, [key]: enabled }); setMotion({ value: next, error: '' });
      setMotionNotice(key === 'startupAnimation' ? tr("启动动画设置已保存，下次启动生效。") : enabled ? tr("已开启减少动态效果，立即生效。") : tr("已恢复应用默认动效；系统减少动态效果设置仍然优先。"));
    } catch (failure) { setMotion(previous => ({ ...previous, error: failure.message || tr("动效偏好保存失败，原选择未改变") })); }
    finally { motionSaving.current = false; }
  };
  const saveStartup = async enabled => {
    if (operation.current.busy || !startup || typeof enabled !== 'boolean') return;
    const generation = ++operation.current.generation; operation.current.busy = true; setStartupSaving(true); setStartupError('');
    try {
      if (typeof api?.startupSettingsSet !== 'function') throw new Error(tr("当前环境暂不支持修改开机自启。"));
      const result = startupSettingsResult(await api.startupSettingsSet({ enabled }));
      if (mounted.current && operation.current.generation === generation) setStartup(result);
    } catch (failure) { if (mounted.current && operation.current.generation === generation) setStartupError(failure.message || tr("开机自启保存失败")); }
    finally { if (operation.current.generation === generation) { operation.current.busy = false; if (mounted.current) setStartupSaving(false); } }
  };
  return <div aria-label={tr("启动与动效设置")} className={`mb-2 border-b pb-4 ${isDark ? 'border-slate-600/60' : 'border-slate-200'} ${theme.text}`}>
    <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Sparkles size={16} className="text-emerald-500" />{tr("启动与动效")}</h3>
    <div className={`divide-y ${isDark ? 'divide-slate-600/40' : 'divide-slate-100'}`}>
      <PreferenceSwitch title={tr("减少动态效果")} description={tr("立即减少动画和过渡；系统的“减少动态效果”设置始终优先。")} checked={motion.value.reducedMotion} onChange={enabled => saveMotion('reducedMotion', enabled)} isDark={isDark} />
      <PreferenceSwitch title={tr("启动动画")} description={tr("下次启动生效；播放约 4.4 秒的透明粒子动画。关闭或启用减少动态效果后直接进入，不影响数据恢复检查。")} checked={motion.value.startupAnimation} onChange={enabled => saveMotion('startupAnimation', enabled)} isDark={isDark} />
      <PreferenceSwitch title={tr("开机自启")} description={startupLoading ? tr("正在读取当前电脑的启动设置…") : startupDescription(startup)} checked={startup?.enabled ?? true} disabled={startupLoading || startupSaving || !startup || typeof api?.startupSettingsSet !== 'function'} busy={startupLoading || startupSaving} onChange={saveStartup} isDark={isDark} />
    </div>
    {motion.error && <p role="alert" className="mt-2 text-xs leading-5 text-red-500">{tr(motion.error)}</p>}
    {motionNotice && <p role="status" className="mt-2 text-xs leading-5 text-emerald-500">{tr(motionNotice)}</p>}
    {startupError && <div className="mt-2 flex flex-wrap items-center gap-2"><p role="alert" className="min-w-0 flex-1 text-xs leading-5 text-red-500">{tr(startupError)} {startup ? tr("开关仍显示上次确认的状态，请重新读取核对。") : tr("启动状态尚未确认，请重试读取。")}</p><button type="button" onClick={loadStartup} disabled={startupLoading || startupSaving} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`}><RefreshCw size={12} />{tr("重试读取")}</button></div>}
  </div>;
}
