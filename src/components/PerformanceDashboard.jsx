// 性能监控面板：设备指标实时采样、曲线、阈值、告警和会员导出。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Activity, AlertTriangle, Check, ChevronDown, Cpu, Database, Download, FileText, FolderOpen, Gauge, Lock, Play, RefreshCw, Save, Smartphone, Square, Thermometer, Zap } from 'lucide-react';

const METRICS = [
  { key: 'cpu', label: 'CPU', color: '#22c55e' },
  { key: 'memory', label: '内存', color: '#38bdf8' },
  { key: 'data', label: '存储空间', color: '#f59e0b' },
  { key: 'temp', label: '温度', color: '#ef4444' },
  // FPS 趋势：前台应用渲染帧率与 SurfaceFlinger 合成帧率。
  { key: 'foregroundFps', label: '前台FPS', color: '#a78bfa', max: 120 },
  { key: 'surfaceFps', label: '合成FPS', color: '#14b8a6', max: 120 }
];

const INTERVAL_OPTIONS = [
  { value: 1000, label: '1 秒', description: '高频采样' },
  { value: 3000, label: '3 秒', description: '更及时' },
  { value: 5000, label: '5 秒', description: '均衡' },
  { value: 10000, label: '10 秒', description: '低负载' }
];

function PerformanceDashboard({ devices, theme, vipStatus, performancePath, showToast, onOpenMemberCenter, onRefreshVipStatus }) {
  const t = theme;
  const isDark = t.primary === 'tech';
  const hasVipAccess = vipStatus?.activated === true;
  const isVipLoading = vipStatus?.reason === 'loading';
  const isVip = hasVipAccess || isVipLoading;
  const onlineDevices = useMemo(() => devices.filter(device => device.status === 'device'), [devices]);
  const [selectedDeviceId, setSelectedDeviceId] = useState('');
  const [running, setRunning] = useState(false);
  // 默认 3 秒采样，让面板数值变化更及时。
  const [intervalMs, setIntervalMs] = useState(3000);
  const [snapshot, setSnapshot] = useState(null);
  const [history, setHistory] = useState([]);
  const [thresholds, setThresholds] = useState({ cpu: 85, memory: 85, batteryTemp: 45, dataUsed: 90 });
  const [loading, setLoading] = useState(false);
  const [savingThresholds, setSavingThresholds] = useState(false);
  const [includeAiSummary, setIncludeAiSummary] = useState(true);
  const [lastExportPath, setLastExportPath] = useState('');
  const [lastReportPath, setLastReportPath] = useState('');
  const [lastReportAiSummary, setLastReportAiSummary] = useState(null);
  const [reportTask, setReportTask] = useState(null);
  // 记录当前视图对应的后端运行设备；停止采样只由用户显式触发。
  const runningDeviceRef = useRef('');
  const selectedDeviceIdRef = useRef('');
  const stateRequestSeqRef = useRef(0);
  const lastUiUpdateRef = useRef(0);
  const pendingUpdateRef = useRef(null);
  const uiUpdateTimerRef = useRef(null);

  const selectedDevice = onlineDevices.find(device => device.id === selectedDeviceId);
  const deviceOptions = useMemo(() => {
    if (onlineDevices.length === 0) {
      return [{ value: '', label: '暂无在线设备', description: '请先连接设备', disabled: true, icon: Smartphone }];
    }
    return onlineDevices.map(device => ({
      value: device.id,
      label: device.name || device.id,
      description: device.name && device.name !== device.id ? device.id : '在线设备',
      icon: Smartphone
    }));
  }, [onlineDevices]);
  const intervalOptions = useMemo(() => INTERVAL_OPTIONS.map(option => ({
    ...option,
    description: option.value < 5000 && !isVip ? `${option.description} · 会员` : option.description
  })), [isVip]);
  const chartPoints = useMemo(() => history.slice(-80).map(item => ({
    timestamp: item.timestamp,
    cpu: item.cpu?.usage,
    memory: item.memory?.usage,
    data: getDataDisk(item)?.usage,
    temp: getDeviceTemperature(item),
    foregroundFps: item.fps?.foreground?.fps,
    surfaceFps: item.fps?.surfaceFlinger?.fps
  })), [history]);
  const dataDisk = getDataDisk(snapshot);
  const deviceTemperature = getDeviceTemperature(snapshot);
  // 当前 FPS 指标快照。
  const foregroundFps = snapshot?.fps?.foreground;
  const surfaceFlingerFps = snapshot?.fps?.surfaceFlinger;

  const applyPerformanceSnapshot = useCallback((nextSnapshot) => {
    setSnapshot(nextSnapshot);
    setHistory(prev => [...prev, nextSnapshot].slice(-720));
  }, []);

  const applyPerformanceState = useCallback((deviceId, res, options = {}) => {
    if (!res?.ok) return;
    const nextHistory = res.history || [];
    const monitorRunning = res.monitor?.running === true;
    setRunning(monitorRunning);
    runningDeviceRef.current = monitorRunning ? deviceId : '';
    if (res.monitor?.intervalMs) setIntervalMs(res.monitor.intervalMs);
    if (options.replaceHistory !== false || nextHistory.length > 0) {
      setHistory(nextHistory);
      setSnapshot(nextHistory[nextHistory.length - 1] || null);
    }
  }, []);

  const refreshPerformanceState = useCallback(async (deviceId, options = {}) => {
    if (!deviceId || !window.electronAPI?.perfState) return;
    const requestId = ++stateRequestSeqRef.current;
    const res = await window.electronAPI.perfState({ deviceId });
    if (requestId !== stateRequestSeqRef.current || selectedDeviceIdRef.current !== deviceId) return;
    applyPerformanceState(deviceId, res, options);
  }, [applyPerformanceState]);

  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId && onlineDevices.length > 0) setSelectedDeviceId(onlineDevices[0].id);
    if (selectedDeviceId && !onlineDevices.some(device => device.id === selectedDeviceId)) {
      stateRequestSeqRef.current += 1;
      setSelectedDeviceId(onlineDevices[0]?.id || '');
      setRunning(false);
      setSnapshot(null);
      setHistory([]);
    }
  }, [onlineDevices, selectedDeviceId]);

  useEffect(() => {
    window.electronAPI?.perfGetThresholds?.().then(res => {
      if (res.ok) setThresholds(res.thresholds);
    });
  }, []);

  useEffect(() => {
    if (vipStatus?.reason === 'loading') onRefreshVipStatus?.();
  }, [onRefreshVipStatus, vipStatus?.reason]);

  useEffect(() => {
    if (!window.electronAPI?.onPerformanceUpdate) return undefined;
    return window.electronAPI.onPerformanceUpdate((event) => {
      if (event.deviceId !== selectedDeviceId || !event.ok) return;
      const now = Date.now();
      const elapsed = now - lastUiUpdateRef.current;
      if (elapsed >= 900) {
        lastUiUpdateRef.current = now;
        applyPerformanceSnapshot(event.snapshot);
        return;
      }
      pendingUpdateRef.current = event.snapshot;
      if (!uiUpdateTimerRef.current) {
        uiUpdateTimerRef.current = setTimeout(() => {
          uiUpdateTimerRef.current = null;
          if (!pendingUpdateRef.current) return;
          lastUiUpdateRef.current = Date.now();
          applyPerformanceSnapshot(pendingUpdateRef.current);
          pendingUpdateRef.current = null;
        }, 900 - elapsed);
      }
    });
  }, [applyPerformanceSnapshot, selectedDeviceId]);

  useEffect(() => {
    return () => {
      if (uiUpdateTimerRef.current) clearTimeout(uiUpdateTimerRef.current);
    };
  }, []);

  useEffect(() => {
    refreshPerformanceState(selectedDeviceId);
  }, [refreshPerformanceState, selectedDeviceId]);

  const applyReportTask = useCallback((task) => {
    if (!task || (selectedDeviceId && task.deviceId !== selectedDeviceId)) return;
    setReportTask(task);
    if (task.result?.ok) {
      setLastReportPath(task.result.path || '');
      setLastReportAiSummary(task.result.aiSummary || null);
    }
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!selectedDeviceId || !window.electronAPI?.perfReportState) return undefined;
    let alive = true;
    window.electronAPI.perfReportState({ deviceId: selectedDeviceId }).then((res) => {
      if (!alive || !res?.ok) return;
      if (res.task) applyReportTask(res.task);
    });
    return () => { alive = false; };
  }, [applyReportTask, selectedDeviceId]);

  useEffect(() => {
    if (!window.electronAPI?.onPerfReportProgress || !window.electronAPI?.onPerfReportDone) return undefined;
    const offProgress = window.electronAPI.onPerfReportProgress((task) => {
      applyReportTask(task);
    });
    const offDone = window.electronAPI.onPerfReportDone((task) => {
      applyReportTask(task);
    });
    return () => {
      offProgress?.();
      offDone?.();
    };
  }, [applyReportTask]);

  const requireVip = (featureName) => {
    if (isVip) return true;
    showToast?.(`${featureName}需要会员版`);
    onOpenMemberCenter?.();
    return false;
  };

  const startMonitor = async () => {
    const targetDeviceId = selectedDeviceId;
    if (!targetDeviceId) return;
    if (intervalMs < 5000 && !hasVipAccess) {
      if (isVipLoading) {
        showToast?.('正在加载会员状态，请稍后再试');
        onRefreshVipStatus?.();
      } else {
        requireVip('高频采样');
      }
      return;
    }
    stateRequestSeqRef.current += 1;
    setLoading(true);
    try {
      const res = await window.electronAPI.perfStart({
        deviceId: targetDeviceId,
        intervalMs,
        includeProcesses: hasVipAccess
      });
      if (res.ok) {
        flushSync(() => {
          setRunning(true);
          if (res.intervalMs) setIntervalMs(res.intervalMs);
        });
        runningDeviceRef.current = targetDeviceId;
        refreshPerformanceState(targetDeviceId, { replaceHistory: false });
        showToast?.('性能监控已启动');
      } else {
        showToast?.(`启动失败：${res.error || '未知错误'}`);
      }
    } catch (error) {
      showToast?.(`启动失败：${error.message || '未知错误'}`);
    } finally {
      setLoading(false);
    }
  };

  const stopMonitor = async () => {
    const targetDeviceId = selectedDeviceId;
    if (!targetDeviceId) return;
    stateRequestSeqRef.current += 1;
    setLoading(true);
    try {
      const res = await window.electronAPI.perfStop({ deviceId: targetDeviceId });
      if (res.ok) {
        flushSync(() => setRunning(false));
        if (runningDeviceRef.current === targetDeviceId) runningDeviceRef.current = '';
        refreshPerformanceState(targetDeviceId, { replaceHistory: false });
        showToast?.('性能监控已停止');
      } else {
        showToast?.(`停止失败：${res.error || '未知错误'}`);
        refreshPerformanceState(targetDeviceId, { replaceHistory: false });
      }
    } catch (error) {
      showToast?.(`停止失败：${error.message || '未知错误'}`);
      refreshPerformanceState(targetDeviceId, { replaceHistory: false });
    } finally {
      setLoading(false);
    }
  };

  // 切换设备只切换当前视图，已启动的采样任务继续留在后台运行。
  const switchDevice = async (nextDeviceId) => {
    stateRequestSeqRef.current += 1;
    setSelectedDeviceId(nextDeviceId);
    setSnapshot(null);
    setHistory([]);
    setRunning(false);
  };

  const takeSnapshot = async () => {
    if (!selectedDeviceId) return;
    setLoading(true);
    try {
      const res = await window.electronAPI.perfSnapshot({ deviceId: selectedDeviceId });
      if (res.ok) {
        setSnapshot(res.snapshot);
        setHistory(prev => [...prev, res.snapshot].slice(-720));
      } else {
        showToast?.(`采样失败：${res.error || '未知错误'}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const exportHistory = async () => {
    if (!requireVip('性能数据导出')) return;
    const res = await window.electronAPI.perfExport({ deviceId: selectedDeviceId, outputBaseDir: performancePath || undefined });
    if (res.ok) {
      setLastExportPath(res.path || '');
      showToast?.(`已导出：${res.path}`);
    }
    else showToast?.(`导出失败：${res.error || '未知错误'}`);
  };

  const exportReport = async () => {
    if (!requireVip('性能分析报告')) return;
    try {
      const res = await window.electronAPI.perfReport({ deviceId: selectedDeviceId, outputBaseDir: performancePath || undefined, includeAiSummary });
      if (res.ok) {
        if (res.task) setReportTask(res.task);
        showToast?.('性能报告已在后台生成');
      }
      else showToast?.(`报告生成失败：${res.error || '未知错误'}`);
    } catch (e) {
      showToast?.(`报告生成失败：${e.message || '未知错误'}`);
    }
  };

  const openPerformanceDir = async (targetPath) => {
    const folder = getFolderFromPath(targetPath) || performancePath || await getDefaultPerformanceDir();
    if (!folder) return;
    await window.electronAPI?.ensureFolder?.(folder);
    const res = await window.electronAPI?.openFolder?.(folder);
    if (res && !res.success && !res.ok) showToast?.(`打开目录失败：${res.error || '未知错误'}`);
  };

  const getDefaultPerformanceDir = async () => {
    const res = await window.electronAPI?.getUserDataPath?.();
    return res?.success ? `${res.path}/performance-monitor` : '';
  };

  const saveThresholds = async () => {
    if (!requireVip('阈值设置')) return;
    setSavingThresholds(true);
    try {
      const res = await window.electronAPI.perfSetThresholds({ thresholds });
      if (res.ok) {
        setThresholds(res.thresholds);
        showToast?.('阈值已保存');
      } else {
        showToast?.(`保存失败：${res.error || '未知错误'}`);
      }
    } finally {
      setSavingThresholds(false);
    }
  };

  const panelClass = isDark ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const reportActive = reportTask?.status === 'running';

  return (
    <div className="space-y-6">
      <div className={`p-4 lg:p-5 rounded-xl border shadow-sm ${panelClass}`}>
        <div className="space-y-4">
          <div className="flex flex-col 2xl:flex-row 2xl:items-center gap-4">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/15 text-emerald-400 flex items-center justify-center shrink-0">
                <Gauge size={20} />
              </div>
              <div className="min-w-0">
                <h3 className={`text-lg font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>性能监控</h3>
                <div className={`text-sm mt-1 truncate ${muted}`}>{selectedDevice?.name || selectedDevice?.id || '未选择设备'}</div>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(220px,1fr)_140px_auto] gap-2 w-full 2xl:w-auto 2xl:min-w-[620px]">
              <CustomSelect
                value={selectedDeviceId}
                options={deviceOptions}
                onChange={switchDevice}
                isDark={isDark}
                className="w-full"
              />
              <CustomSelect
                value={intervalMs}
                options={intervalOptions}
                onChange={(value) => {
                  if (value < 5000 && !isVip) {
                    requireVip('高频采样');
                    return;
                  }
                  setIntervalMs(value);
                }}
                isDark={isDark}
                className="w-full"
              />
              {running ? (
                <button onClick={stopMonitor} disabled={loading} className="px-4 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap">
                  {loading ? <RefreshCw size={16} className="animate-spin" /> : <Square size={16} />}
                  停止
                </button>
              ) : (
                <button onClick={startMonitor} disabled={!selectedDeviceId || loading} className="px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-2 whitespace-nowrap">
                  {loading ? <RefreshCw size={16} className="animate-spin" /> : <Play size={16} />}
                  开始
                </button>
              )}
            </div>
          </div>

          <div className={`rounded-lg border p-3 flex flex-col xl:flex-row xl:items-center gap-3 ${isDark ? 'bg-[#202124]/70 border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
            <label className={`inline-flex items-center gap-2 w-fit rounded-lg border px-3 py-2 text-xs ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'} ${muted}`}>
              <input
                type="checkbox"
                checked={includeAiSummary}
                onChange={(e) => setIncludeAiSummary(e.target.checked)}
                className="h-4 w-4 accent-emerald-500"
              />
              报告包含 AI 分析
            </label>
            <div className={`min-w-0 flex-1 truncate text-xs ${muted}`}>保存目录：{performancePath || '默认 %APPDATA%/adb-workbench/performance-monitor/'}</div>
            <div className="flex flex-wrap gap-2">
              <button onClick={takeSnapshot} disabled={!selectedDeviceId || loading} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}>
                <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
                采样
              </button>
              <button onClick={exportHistory} disabled={!selectedDeviceId || history.length === 0} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 disabled:opacity-50 ${isVip ? (isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white') : 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'}`}>
                {isVip ? <Download size={15} /> : <Lock size={15} />}
                导出
              </button>
              <button onClick={exportReport} disabled={!selectedDeviceId || history.length === 0 || reportActive} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 disabled:opacity-50 ${isVip ? (isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white') : 'border-amber-500/30 text-amber-400 hover:bg-amber-500/10'}`}>
                {isVip ? (reportActive ? <RefreshCw size={15} className="animate-spin" /> : <FileText size={15} />) : <Lock size={15} />}
                {reportActive ? '生成中' : '报告'}
              </button>
              <button onClick={() => openPerformanceDir('')} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}>
                <FolderOpen size={15} />
                打开目录
              </button>
            </div>
          </div>
        </div>
      </div>

      {onlineDevices.length === 0 ? (
        <div className={`py-20 rounded-xl border border-dashed text-center ${isDark ? 'border-[#3E4145] text-[#80868B]' : 'border-slate-300 text-slate-400'}`}>
          <Smartphone size={44} className="mx-auto mb-3 opacity-50" />
          <div>暂无在线设备</div>
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
            <MetricCard icon={<Cpu size={20} />} label="CPU" value={formatPercent(snapshot?.cpu?.usage)} sub={running ? '实时' : '最近采样'} color="emerald" theme={t} />
            <MetricCard icon={<Activity size={20} />} label="内存" value={formatPercent(snapshot?.memory?.usage)} sub={formatKb(snapshot?.memory?.usedKb, snapshot?.memory?.totalKb)} color="sky" theme={t} />
            <MetricCard icon={<Database size={20} />} label="存储空间" value={formatPercent(dataDisk?.usage)} sub={formatKb(dataDisk?.usedKb, dataDisk?.sizeKb)} color="amber" theme={t} />
            <MetricCard icon={<Thermometer size={20} />} label="温度" value={formatTemp(deviceTemperature)} sub={formatBatterySub(snapshot?.battery)} color="red" theme={t} />
            {/* 展示前台应用 FPS 与当前屏幕 SurfaceFlinger 合成 FPS。 */}
            <MetricCard icon={<Gauge size={20} />} label="前台 FPS" value={formatFps(foregroundFps?.fps)} sub={formatForegroundFpsSub(foregroundFps)} color="violet" theme={t} />
            <MetricCard icon={<Zap size={20} />} label="合成 FPS" value={formatFps(surfaceFlingerFps?.fps)} sub={formatSurfaceFpsSub(surfaceFlingerFps)} color="cyan" theme={t} />
          </div>

          {snapshot?.warnings?.length > 0 && (
            <div className={`p-4 rounded-xl border flex items-start gap-3 ${isDark ? 'bg-red-500/10 border-red-500/20 text-red-300' : 'bg-red-50 border-red-200 text-red-600'}`}>
              <AlertTriangle size={18} className="mt-0.5" />
              <div className="flex flex-wrap gap-2 text-sm">
                {snapshot.warnings.map(item => <span key={`${item.type}-${item.label}`} className="px-2 py-1 rounded bg-red-500/10">{item.label}</span>)}
              </div>
            </div>
          )}

          {(lastExportPath || lastReportPath) && (
            <div className={`p-4 rounded-xl border shadow-sm ${panelClass}`}>
              <div className="flex flex-col gap-2 text-sm">
                {lastExportPath && (
                  <PathRow label="最近导出" path={lastExportPath} isDark={isDark} onOpen={() => openPerformanceDir(lastExportPath)} />
                )}
                {lastReportPath && (
                  <PathRow label="最近报告" path={lastReportPath} isDark={isDark} onOpen={() => openPerformanceDir(lastReportPath)} />
                )}
                {lastReportAiSummary && !lastReportAiSummary.skipped && (
                  lastReportAiSummary.ok ? (
                    <div className={`rounded-lg border px-3 py-2 text-xs ${isDark ? 'bg-[#202124] border-[#3E4145] text-[#9AA0A6]' : 'bg-slate-50 border-slate-200 text-slate-500'}`}>
                      AI 分析已写入最近报告
                    </div>
                  ) : (
                    <div className="text-xs text-amber-500">AI 分析未生成：{lastReportAiSummary.error || '未知错误'}</div>
                  )
                )}
              </div>
            </div>
          )}

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className={`p-5 rounded-xl border shadow-sm ${panelClass}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-base font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>趋势</h3>
                <div className="flex items-center gap-3 text-xs">
                  {METRICS.map(metric => <span key={metric.key} className={muted}><span className="inline-block w-2 h-2 rounded-full mr-1" style={{ backgroundColor: metric.color }} />{metric.label}</span>)}
                </div>
              </div>
              <PerformanceChart points={chartPoints} isDark={isDark} />
            </div>

            <div className={`p-5 rounded-xl border shadow-sm ${panelClass}`}>
              <div className="flex items-center justify-between mb-4">
                <h3 className={`text-base font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>阈值</h3>
                {!isVip && <span className="text-xs text-amber-400 flex items-center gap-1"><Lock size={12} />会员</span>}
              </div>
              <div className="space-y-4">
                <ThresholdInput label="CPU" value={thresholds.cpu} suffix="%" onChange={(value) => setThresholds(prev => ({ ...prev, cpu: value }))} isDark={isDark} />
                <ThresholdInput label="内存" value={thresholds.memory} suffix="%" onChange={(value) => setThresholds(prev => ({ ...prev, memory: value }))} isDark={isDark} />
                <ThresholdInput label="电池温度" value={thresholds.batteryTemp} suffix="°C" onChange={(value) => setThresholds(prev => ({ ...prev, batteryTemp: value }))} isDark={isDark} />
                <ThresholdInput label="存储空间" value={thresholds.dataUsed} suffix="%" onChange={(value) => setThresholds(prev => ({ ...prev, dataUsed: value }))} isDark={isDark} />
                <button onClick={saveThresholds} disabled={savingThresholds} className="w-full px-4 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-50 flex items-center justify-center gap-2">
                  {savingThresholds ? <RefreshCw size={16} className="animate-spin" /> : <Save size={16} />}
                  保存阈值
                </button>
              </div>
            </div>
          </div>

          <div className={`rounded-xl border shadow-sm overflow-hidden ${panelClass}`}>
            <div className={`px-5 py-4 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
              <h3 className={`text-base font-semibold flex items-center gap-2 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                <Zap size={17} className="text-yellow-500" />
                进程占用
              </h3>
              {!isVip && <button onClick={() => requireVip('进程占用明细')} className="text-xs text-amber-400 flex items-center gap-1"><Lock size={12} />会员</button>}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className={isDark ? 'bg-[#2D2F33] text-[#9AA0A6]' : 'bg-slate-50 text-slate-500'}>
                  <tr>
                    <th className="text-left px-5 py-3 font-medium">PID</th>
                    <th className="text-left px-5 py-3 font-medium">进程</th>
                    <th className="text-right px-5 py-3 font-medium">CPU</th>
                    <th className="text-right px-5 py-3 font-medium">内存</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${isDark ? 'divide-[#3E4145]' : 'divide-slate-100'}`}>
                  {!isVip ? (
                    <tr><td colSpan="4" className={`px-5 py-8 text-center ${muted}`}>会员版可查看进程占用明细</td></tr>
                  ) : (snapshot?.processes || []).length === 0 ? (
                    <tr><td colSpan="4" className={`px-5 py-8 text-center ${muted}`}>暂无进程数据</td></tr>
                  ) : snapshot.processes.map(proc => (
                    <tr key={`${proc.pid}-${proc.name}`} className={isDark ? 'text-[#E8EAED]' : 'text-slate-700'}>
                      <td className="px-5 py-3 font-mono text-xs">{proc.pid}</td>
                      <td className="px-5 py-3 max-w-[520px] truncate">{proc.name}</td>
                      <td className="px-5 py-3 text-right">{proc.cpu.toFixed(1)}%</td>
                      <td className="px-5 py-3 text-right">{proc.memory.toFixed(1)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MetricCard({ icon, label, value, sub, color, theme }) {
  const isDark = theme.primary === 'tech';
  const colorClass = {
    emerald: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
    sky: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
    amber: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
    red: 'text-red-400 bg-red-500/10 border-red-500/20',
    violet: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
    cyan: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20'
  }[color];
  return (
    <div className={`p-5 rounded-xl border shadow-sm ${isDark ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className="flex items-center justify-between">
        <div className={`w-10 h-10 rounded-lg border flex items-center justify-center ${colorClass}`}>{icon}</div>
        <span className={`text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{label}</span>
      </div>
      <div className={`text-3xl font-bold mt-4 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{value}</div>
      <div title={sub} className={`text-xs mt-1 truncate ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{sub}</div>
    </div>
  );
}

function PathRow({ label, path, isDark, onOpen }) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <span className={`shrink-0 font-medium ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>{label}</span>
      <span className={`min-w-0 flex-1 truncate font-mono text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`} title={path}>{path}</span>
      <button
        type="button"
        onClick={onOpen}
        className={`shrink-0 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
      >
        打开
      </button>
    </div>
  );
}

function CustomSelect({ value, options, onChange, isDark, className = '' }) {
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex] || options[0] || { value: '', label: '-' };
  const allDisabled = options.length === 0 || options.every(option => option.disabled);
  const SelectedIcon = selected.icon || Gauge;
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 8;
      const viewportHeight = window.innerHeight || 720;
      const viewportWidth = window.innerWidth || 1024;
      const width = Math.max(rect.width, 180);
      const maxHeight = Math.min(320, viewportHeight - gap * 2);
      const openUp = rect.bottom + maxHeight + gap > viewportHeight && rect.top > maxHeight;
      const top = openUp
        ? Math.max(gap, rect.top - maxHeight - gap)
        : Math.min(viewportHeight - maxHeight - gap, rect.bottom + gap);
      const left = Math.min(viewportWidth - width - gap, Math.max(gap, rect.left));
      setMenuStyle({ top, left, width, maxHeight });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(prev => findEnabledIndex(options, prev, event.key === 'ArrowDown' ? 1 : -1));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const option = options[activeIndex];
        if (!option?.disabled) {
          onChange(option.value);
          setOpen(false);
        }
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, onChange, open, options]);

  const menu = open && menuStyle && typeof document !== 'undefined' ? createPortal(
    <div
      ref={menuRef}
      role="listbox"
      style={{
        position: 'fixed',
        top: menuStyle.top,
        left: menuStyle.left,
        width: menuStyle.width,
        maxHeight: menuStyle.maxHeight
      }}
      className={`z-[120] overflow-y-auto rounded-xl border p-1.5 shadow-2xl ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}
    >
      {options.map((option, index) => {
        const Icon = option.icon || Gauge;
        const selectedOption = option.value === value;
        const active = index === activeIndex;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="option"
            aria-selected={selectedOption}
            disabled={option.disabled}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              if (option.disabled) return;
              onChange(option.value);
              setOpen(false);
            }}
            className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors flex items-start gap-3 disabled:cursor-not-allowed disabled:opacity-60 ${active && !option.disabled ? 'bg-emerald-500/10' : isDark ? 'hover:bg-[#2D2F33]' : 'hover:bg-slate-50'}`}
          >
            <span className={`mt-0.5 h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${selectedOption ? 'bg-emerald-500 text-white' : 'bg-emerald-500/10 text-emerald-400'}`}>
              <Icon size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium truncate ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{option.label}</span>
              {option.description && <span className={`block text-xs mt-0.5 leading-snug truncate ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{option.description}</span>}
            </span>
            {selectedOption && <Check size={15} className="mt-1 text-emerald-400 shrink-0" />}
          </button>
        );
      })}
    </div>,
    document.body
  ) : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        disabled={allDisabled}
        onClick={() => setOpen(prev => !prev)}
        className={`w-full px-3 py-2 rounded-lg border text-sm transition-colors flex items-center justify-between gap-3 disabled:cursor-not-allowed disabled:opacity-60 ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <SelectedIcon size={15} className="text-emerald-400 shrink-0" />
          <span className="truncate">{selected.label}</span>
        </span>
        <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {menu}
    </div>
  );
}

function findEnabledIndex(options, currentIndex, direction) {
  if (options.length === 0) return 0;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const nextIndex = (currentIndex + direction * offset + options.length) % options.length;
    if (!options[nextIndex]?.disabled) return nextIndex;
  }
  return currentIndex;
}

function PerformanceChart({ points, isDark }) {
  const width = 720;
  const height = 260;
  const pad = 42;
  // FPS 最高按 120 归一化，避免 60/90/120Hz 设备曲线被错误压扁或截断。
  const chartMax = Math.max(100, ...METRICS.map(metric => metric.max || 100));
  const series = METRICS.map(metric => ({
    ...metric,
    path: makePath(points.map(item => item[metric.key]), width, height, pad, chartMax)
  }));
  const yTicks = [0, 30, 60, 90, 120].filter(value => value <= chartMax);
  const xTickIndexes = uniqueIndexes([0, Math.floor((points.length - 1) / 2), points.length - 1], points.length);
  return (
    <div className={`h-[300px] rounded-lg border ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      {points.length < 2 ? (
        <div className={`h-full flex items-center justify-center text-sm ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>暂无趋势数据</div>
      ) : (
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-full">
          <line x1={pad} x2={pad} y1={pad} y2={height - pad} stroke={isDark ? '#475569' : '#cbd5e1'} />
          <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} stroke={isDark ? '#475569' : '#cbd5e1'} />
          {yTicks.map(value => {
            const y = pad + (chartMax - value) / chartMax * (height - pad * 2);
            return (
              <g key={value}>
                <line x1={pad} x2={width - pad} y1={y} y2={y} stroke={isDark ? '#334155' : '#e2e8f0'} strokeDasharray="4 6" />
                <text x={pad - 8} y={y + 4} textAnchor="end" fontSize="11" fill={isDark ? '#94a3b8' : '#64748b'}>{value}</text>
              </g>
            );
          })}
          {xTickIndexes.map(index => {
            const x = pad + (index / Math.max(points.length - 1, 1)) * (width - pad * 2);
            return (
              <text key={index} x={x} y={height - 12} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} fontSize="11" fill={isDark ? '#94a3b8' : '#64748b'}>
                {formatChartTime(points[index]?.timestamp)}
              </text>
            );
          })}
          {series.map(item => <path key={item.key} d={item.path} fill="none" stroke={item.color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />)}
        </svg>
      )}
    </div>
  );
}

function ThresholdInput({ label, value, suffix, onChange, isDark }) {
  return (
    <label className="block">
      <div className={`flex items-center justify-between mb-1 text-sm ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>
        <span>{label}</span>
        <span>{value}{suffix}</span>
      </div>
      <input type="range" min="1" max="100" value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-emerald-500" />
    </label>
  );
}

function makePath(values, width, height, pad, maxValue = 100) {
  const usableW = width - pad * 2;
  const usableH = height - pad * 2;
  const clean = values.map(value => Number.isFinite(value) ? Math.max(0, Math.min(maxValue, value)) : null);
  if (clean.filter(value => value != null).length < 2) return '';
  return clean.map((value, index) => {
    const x = pad + (index / Math.max(clean.length - 1, 1)) * usableW;
    const y = pad + (maxValue - (value ?? 0)) / maxValue * usableH;
    return `${index === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
  }).join(' ');
}

function uniqueIndexes(indexes, length) {
  return Array.from(new Set(indexes.filter(index => Number.isInteger(index) && index >= 0 && index < length)));
}

function formatChartTime(timestamp) {
  if (!timestamp) return '--:--:--';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatPercent(value) {
  return value == null ? '--' : `${Number(value).toFixed(1)}%`;
}

function formatTemp(value) {
  return value == null ? '--' : `${Number(value).toFixed(1)}°C`;
}

// FPS 展示格式与辅助说明。
function formatFps(value) {
  return value == null ? '--' : `${Number(value).toFixed(1)} FPS`;
}

function formatForegroundFpsSub(fps) {
  if (!fps) return '前台应用 -';
  if (fps.packageName) return fps.packageName;
  if (fps.error) return '前台应用不可用';
  return '等待前台应用';
}

function formatSurfaceFpsSub(fps) {
  if (!fps) return 'SurfaceFlinger -';
  if (fps.layer) return `刷新率 ${formatFps(fps.refreshRate)}`;
  if (fps.refreshRate != null) return `刷新率 ${formatFps(fps.refreshRate)}`;
  if (fps.error) return '合成数据不可用';
  return '等待合成数据';
}

function formatKb(used, total) {
  if (!used || !total) return '-';
  return `${(used / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} GB`;
}

function getDataDisk(snapshot) {
  const disks = snapshot?.disk || [];
  return disks.find(item => item.mount === '/data') || disks.find(item => item.mount === '/storage/emulated') || null;
}

function getDeviceTemperature(snapshot) {
  const batteryTemp = snapshot?.battery?.temperature;
  if (batteryTemp != null && batteryTemp > 0) return batteryTemp;
  return snapshot?.thermal?.hottest ?? null;
}

function formatBatterySub(battery) {
  if (!battery) return '电量 -';
  if (battery.present === false) return '无电池设备';
  return `电量 ${battery.level ?? '-'}%`;
}

function getFolderFromPath(filePath) {
  const value = String(filePath || '').trim();
  if (!value) return '';
  const index = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  return index > 0 ? value.slice(0, index) : value;
}

export default PerformanceDashboard;
