import { tr, useLocale, getLocale } from '../shared/i18n';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Smartphone,
  Terminal,
  XCircle
} from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { deviceStatusLabel } from '../shared/deviceWorkflow';
import SelectMenu from './SelectMenu';

function EnvironmentCheckWizard({ devices, theme, showToast, onRefreshDevices, activeDeviceId, onActiveDeviceChange }) {
  useLocale();
  const isDark = isDarkTheme(theme);
  const [running, setRunning] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [storedResult, setResult] = useState(null);
  const [error, setError] = useState('');
  const [checkError, setCheckError] = useState(null);
  const deviceContextRef = useRef({ deviceId: activeDeviceId || '', generation: 0 });
  const checkPendingRef = useRef(null);
  const restartPendingRef = useRef(false);

  const selectedDeviceId = activeDeviceId || '';
  const result = storedResult?.deviceId === selectedDeviceId ? storedResult.value : null;
  const visibleError = error || (checkError?.deviceId === selectedDeviceId ? checkError.message : '');
  useLayoutEffect(() => {
    deviceContextRef.current = { deviceId: selectedDeviceId, generation: deviceContextRef.current.generation + 1 };
    return () => { deviceContextRef.current = { deviceId: '', generation: deviceContextRef.current.generation + 1 }; };
  }, [selectedDeviceId]);
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const panel = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200';
  const soft = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200';

  const deviceCounts = useMemo(() => ({
    online: devices.filter(device => device.status === 'device').length,
    unauthorized: devices.filter(device => device.status === 'unauthorized').length,
    offline: devices.filter(device => device.status === 'offline').length
  }), [devices]);

  const runCheck = async () => {
    if (checkPendingRef.current) return;
    if (!window.electronAPI?.envCheckRun) {
      showToast?.(tr("环境自检需要 Electron 环境"));
      return;
    }
    const context = deviceContextRef.current; const operation = {}; checkPendingRef.current = operation;
    setRunning(true);
    setError('');
    setCheckError(null);
    try {
      const res = await window.electronAPI.envCheckRun({ deviceId: selectedDeviceId });
      if (deviceContextRef.current !== context) return;
      setResult({ deviceId: selectedDeviceId, value: res });
      if (!res.ok) throw new Error(res.error || tr("环境自检失败"));
      showToast?.(tr("环境自检完成"));
    } catch (error) {
      if (deviceContextRef.current === context) {
        setCheckError({ deviceId: selectedDeviceId, message: error.message });
        showToast?.(tr("环境自检失败：{0}", { 0: error.message }));
      }
    } finally {
      if (checkPendingRef.current === operation) { checkPendingRef.current = null; setRunning(false); }
    }
  };

  const restartAdb = async () => {
    if (!window.electronAPI?.envCheckRestartAdb || restartPendingRef.current) return;
    restartPendingRef.current = true;
    setRestarting(true);
    setError('');
    setCheckError(null);
    try {
      const res = await window.electronAPI.envCheckRestartAdb();
      if (!res?.ok) throw new Error(res?.error || res?.message || tr("ADB 服务重启失败"));
      showToast?.(res.message || tr("ADB 服务已重启"));
      onRefreshDevices?.();
    } catch (error) {
      setError(error.message);
      showToast?.(tr("ADB 服务重启失败：{0}", { 0: error.message }));
    } finally {
      restartPendingRef.current = false;
      setRestarting(false);
    }
  };

  return (
    <div className="min-w-0">
      <section className={`rounded-xl border ${panel} overflow-hidden`}>
        <div className={`px-5 py-4 border-b flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div className="flex min-w-0 items-center gap-3">
            <div className="w-10 h-10 shrink-0 rounded-lg bg-cyan-500/15 flex items-center justify-center">
              <ShieldCheck size={22} className="text-cyan-400" />
            </div>
            <div className="min-w-0">
              <h3 className={`text-lg font-semibold ${text}`}>{tr("设备连接与环境自检")}</h3>
              <p className={`text-xs mt-1 ${muted}`}>{tr("检查 ADB、scrcpy、设备授权和命令通路")}</p>
            </div>
          </div>
          <button
            onClick={onRefreshDevices}
            className={`w-full sm:w-auto px-3 py-2 rounded-lg border text-sm flex items-center justify-center gap-2 ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145] text-[#E8EAED]' : 'border-slate-200 hover:bg-slate-100 text-slate-700'}`}
          >
            <RefreshCw size={15} />{tr("刷新设备")}</button>
        </div>

        <div className="grid gap-5 p-5 lg:grid-cols-[minmax(280px,390px)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-4">
            <div className="grid grid-cols-3 gap-2">
              <Stat label={tr("在线")} value={deviceCounts.online} tone="green" isDark={isDark} />
              <Stat label={tr("未授权")} value={deviceCounts.unauthorized} tone="amber" isDark={isDark} />
              <Stat label={tr("离线")} value={deviceCounts.offline} tone="red" isDark={isDark} />
            </div>

            <div>
              <FieldLabel label={tr("目标设备")} htmlFor="environment-check-device" isDark={isDark} />
              <SelectMenu
                id="environment-check-device"
                value={selectedDeviceId}
                onChange={value => onActiveDeviceChange?.(value)}
                disabled={running}
                isDark={isDark}
                accent="cyan"
                placeholder={tr("未发现设备")}
                emptyText={tr("未发现设备")}
                className="w-full"
                options={[
                  ...(!selectedDeviceId ? [{ value: '', label: tr("未发现设备") }] : []),
                  ...(selectedDeviceId && !devices.some(device => device.id === selectedDeviceId)
                    ? [{ value: selectedDeviceId, label: tr("{0} · 已断开", { 0: selectedDeviceId }) }] : []),
                  ...devices.map(device => ({ value: device.id, label: `${device.model || device.id} · ${deviceStatusLabel(device.status)}` }))
                ]}
              />
            </div>

            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <button
                type="button"
                onClick={runCheck}
                disabled={running}
                className="flex-1 px-4 py-2.5 rounded-lg bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 text-white font-medium flex items-center justify-center gap-2"
              >
                {running ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}{tr("开始自检")}</button>
              <button
                type="button"
                onClick={restartAdb}
                disabled={running || restarting}
                className={`px-4 py-2.5 rounded-lg border font-medium flex items-center justify-center gap-2 disabled:opacity-60 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
              >
                {restarting ? <Loader2 size={16} className="animate-spin" /> : <RotateCcw size={16} />}{tr("重启 ADB")}</button>
            </div>

            <div className={`rounded-lg border p-3 text-xs leading-relaxed ${soft} ${muted}`}>{tr("自检不会修改设备数据；重启 ADB 只重启电脑端 adb server。")}</div>
          </div>

          <div className="min-w-0 space-y-4">
            {visibleError && (
              <div className="rounded-lg border border-red-500/25 bg-red-500/10 text-red-400 px-4 py-3 text-sm flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{tr(visibleError)}</span>
              </div>
            )}

            {!result ? (
              <div className={`rounded-xl border ${soft} p-8 text-center`}>
                <Terminal size={30} className={`mx-auto mb-3 ${muted}`} />
                <div className={`text-sm ${muted}`}>{tr("点击开始自检查看环境状态")}</div>
              </div>
            ) : (
              <>
                <Summary result={result} isDark={isDark} text={text} muted={muted} />
                <div className="grid gap-3 min-[1180px]:grid-cols-2">
                  {(result.checks || []).map(check => (
                    <CheckCard key={check.key} check={check} isDark={isDark} text={text} muted={muted} />
                  ))}
                </div>
                {Array.isArray(result.suggestions) && result.suggestions.length > 0 && (
                  <div className={`rounded-xl border p-4 ${soft}`}>
                    <div className={`font-semibold mb-2 ${text}`}>{tr("处理建议")}</div>
                    <div className="space-y-1.5">
                      {result.suggestions.map((item, index) => (
                        <div key={`${item}-${index}`} className={`text-sm ${muted}`}>{index + 1}. {item}</div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function Summary({ result, isDark, text, muted }) {
  useLocale();
  const ok = result.status === 'pass';
  const Icon = ok ? CheckCircle2 : result.status === 'warning' ? AlertCircle : XCircle;
  const color = ok ? 'text-emerald-400 bg-emerald-500/15' : result.status === 'warning' ? 'text-amber-400 bg-amber-500/15' : 'text-red-400 bg-red-500/15';
  return (
    <div className={`min-w-0 rounded-xl border p-4 flex items-start gap-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center ${color}`}>
        <Icon size={21} />
      </div>
      <div className="min-w-0">
        <div className={`font-semibold ${text}`}>{result.title || tr("自检完成")}</div>
        <div className={`text-sm mt-1 ${muted}`}>{tr("检查时间：{0}", { 0: formatDate(result.checkedAt) })}</div>
      </div>
    </div>
  );
}

function CheckCard({ check, isDark, text, muted }) {
  useLocale();
  const state = check.level || (check.ok ? 'pass' : 'warning');
  const Icon = state === 'pass' ? CheckCircle2 : state === 'warning' ? AlertCircle : XCircle;
  const color = state === 'pass' ? 'text-emerald-400' : state === 'warning' ? 'text-amber-400' : 'text-red-400';
  return (
    <div className={`min-w-0 rounded-xl border p-4 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className="flex items-start gap-3">
        <Icon size={19} className={`${color} mt-0.5 shrink-0`} />
        <div className="min-w-0">
          <div className={`font-semibold ${text}`}>{check.label}</div>
          <div className={`text-sm mt-1 break-words [overflow-wrap:anywhere] ${muted}`}>{check.detail || '-'}</div>
          {check.action && <div className={`text-xs mt-2 font-mono break-all [overflow-wrap:anywhere] ${muted}`}>{check.action}</div>}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tone, isDark }) {
  useLocale();
  const color = tone === 'green' ? 'text-emerald-400' : tone === 'amber' ? 'text-amber-400' : 'text-red-400';
  return (
    <div className={`min-w-0 rounded-lg border p-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <div className={`truncate text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{label}</div>
      <div className={`text-xl font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}

function FieldLabel({ label, htmlFor, isDark }) {
  useLocale();
  return (
    <label htmlFor={htmlFor} className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-[#BDC1C6]' : 'text-slate-600'}`}>
      {label}
    </label>
  );
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(getLocale(), { hour12: false });
}

export default EnvironmentCheckWizard;
