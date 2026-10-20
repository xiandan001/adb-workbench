import { useEffect, useMemo, useState } from 'react';
import { isDarkTheme } from '../shared/theme';
import { getMatchingBaseline, getAcceptanceErrors, qualityErrorMessage, getTaskStatusLabel } from '../shared/taskCenterWorkspace';
import TaskCenterResultDrawer from './TaskCenterResultDrawer';
import {
  AlertCircle,
  CheckCircle2,
  ClipboardList,
  Database,
  FileDiff,
  FileText,
  FolderOpen,
  Loader2,
  Play,
  Package,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2
} from 'lucide-react';

function QualityCenter({ devices, deviceLoading, onRefreshDevices, theme, showToast, activeDeviceId, onActiveDeviceChange }) {
  const isDark = isDarkTheme(theme);
  const onlineDevices = useMemo(() => devices.filter(device => device.status === 'device'), [devices]);
  const [deviceId, setDeviceId] = useState('');
  const [baselines, setBaselines] = useState([]);
  const [selectedBaselinePath, setSelectedBaselinePath] = useState('');
  const [baselineName, setBaselineName] = useState('');
  const [reportName, setReportName] = useState('');
  const [includePerformance, setIncludePerformance] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [lastResult, setLastResult] = useState(null);
  const [suites, setSuites] = useState([]);
  const [suiteId, setSuiteId] = useState('smoke');
  const [apkPath, setApkPath] = useState('');
  const [packageName, setPackageName] = useState('');
  const [baselineImagePath, setBaselineImagePath] = useState('');
  const [rounds, setRounds] = useState(5);
  const [launchWaitMs, setLaunchWaitMs] = useState(5000);
  const [threshold, setThreshold] = useState(98);
  const [lastAcceptanceTask, setLastAcceptanceTask] = useState(null);
  const [guardIntervalMs, setGuardIntervalMs] = useState(15000);
  const [guardState, setGuardState] = useState({ activeGuards: [], history: [] });
  const [lastStoppedGuard, setLastStoppedGuard] = useState(null);
  const [qualityTab, setQualityTab] = useState('regression');
  const [showTaskDetails, setShowTaskDetails] = useState(false);

  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const panel = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200';
  const soft = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const input = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700';
  const primary = `${theme.button.primary.split(' ')[0]} ${theme.button.primary.split(' ')[1] || ''}`;

  useEffect(() => {
    if (!window.electronAPI?.onTaskCenterUpdate || !lastAcceptanceTask?.id) return undefined;
    return window.electronAPI.onTaskCenterUpdate((event) => {
      const task = event?.task?.id === lastAcceptanceTask.id
        ? event.task
        : (event?.activeTasks || []).find(item => item.id === lastAcceptanceTask.id);
      if (task) setLastAcceptanceTask(task);
    });
  }, [lastAcceptanceTask?.id]);

  useEffect(() => {
    if (!window.electronAPI?.onDeviceGuardUpdate) return undefined;
    return window.electronAPI.onDeviceGuardUpdate((event) => {
      setGuardState({
        activeGuards: event?.activeGuards || [],
        history: event?.history || []
      });
      if (event?.guard?.reportPath) setLastStoppedGuard(event.guard);
    });
  }, []);

  const selectedDeviceId = activeDeviceId || deviceId || onlineDevices[0]?.id || '';
  const selectedDevice = onlineDevices.find(device => device.id === selectedDeviceId);
  const selectedBaseline = getMatchingBaseline(baselines, selectedDeviceId, selectedBaselinePath);
  const effectiveBaselinePath = selectedBaseline?.path || '';
  const activeGuard = guardState.activeGuards.find(item => item.deviceId === selectedDeviceId);
  const matchingBaselines = useMemo(() => baselines.filter(item => item.deviceId === selectedDeviceId), [baselines, selectedDeviceId]);
  const acceptanceErrors = getAcceptanceErrors({ suiteId, apkPath, packageName, baselineImagePath, rounds, launchWaitMs, threshold });

  async function loadBaselines() {
    setLoading(true);
    setError('');
    const res = await window.electronAPI?.regressionListBaselines?.();
    if (res?.ok) {
      setBaselines(res.baselines || []);
    } else {
      setError(res?.error || '基线列表加载失败');
    }
    setLoading(false);
  }

  async function refreshQualityCenter() {
    await Promise.all([
      loadBaselines(),
      onRefreshDevices?.()
    ]);
  }

  async function loadSuites() {
    const res = await window.electronAPI?.acceptanceListSuites?.();
    if (res?.ok) setSuites(res.suites || []);
  }

  async function loadGuardState() {
    const res = await window.electronAPI?.deviceGuardState?.();
    if (res?.ok) {
      setGuardState({ activeGuards: res.activeGuards || [], history: res.history || [] });
      setLastStoppedGuard((res.history || [])[0] || null);
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      loadBaselines();
      loadSuites();
      loadGuardState();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  async function captureBaseline() {
    if (!selectedDevice) {
      showToast?.('请先选择在线设备');
      return;
    }
    setBusy('capture');
    setError('');
    const res = await window.electronAPI?.regressionCaptureBaseline?.({
      deviceId: selectedDeviceId,
      name: baselineName,
      includePerformance
    });
    if (res?.ok) {
      setBaselineName('');
      setBaselines(prev => [res.baseline, ...prev.filter(item => item.path !== res.baseline.path)]);
      setSelectedBaselinePath(res.baseline.path);
      showToast?.('回归基线已采集');
    } else {
      setError(res?.error || '回归基线采集失败');
    }
    setBusy('');
  }

  async function runRegression() {
    if (!selectedDevice) {
      showToast?.('请先选择在线设备');
      return;
    }
    if (!effectiveBaselinePath) {
      showToast?.('请先选择回归基线');
      return;
    }
    setBusy('run');
    setError('');
    const res = await window.electronAPI?.regressionRun?.({
      deviceId: selectedDeviceId,
      baselinePath: effectiveBaselinePath,
      name: reportName,
      includePerformance
    });
    if (res?.ok) {
      setReportName('');
      setLastResult(res.result);
      showToast?.('回归差异报告已生成');
    } else {
      setError(res?.error || '回归差异报告生成失败');
    }
    setBusy('');
  }

  async function deleteBaseline(path) {
    if (!path) return;
    setBusy(`delete:${path}`);
    setError('');
    const res = await window.electronAPI?.regressionDeleteBaseline?.({ baselinePath: path });
    if (res?.ok) {
      setBaselines(res.baselines || []);
      showToast?.('回归基线已删除');
    } else {
      setError(res?.error || '回归基线删除失败');
    }
    setBusy('');
  }

  async function openPath(targetPath) {
    if (!targetPath) return;
    const res = await window.electronAPI?.artifactOpenPath?.(targetPath);
    if (res && !res.ok) showToast?.(`打开失败：${res.error || '未知错误'}`);
  }

  async function pickFile(kind) {
    const dialog = await window.electronAPI?.showOpenDialog?.({
      title: kind === 'apk' ? '选择 APK 文件' : '选择截图基线',
      properties: ['openFile'],
      filters: kind === 'apk'
        ? [{ name: 'APK 文件', extensions: ['apk'] }, { name: '所有文件', extensions: ['*'] }]
        : [{ name: '图片文件', extensions: ['png'] }, { name: '所有文件', extensions: ['*'] }]
    });
    const filePath = dialog?.filePaths?.[0];
    if (!filePath) return;
    if (kind === 'apk') setApkPath(filePath);
    else setBaselineImagePath(filePath);
  }

  async function runAcceptance() {
    if (!selectedDevice) {
      showToast?.('请先选择在线设备');
      return;
    }
    if (Object.keys(acceptanceErrors).length) {
      setError(Object.values(acceptanceErrors).join('；'));
      return;
    }
    setBusy('acceptance');
    setError('');
    const res = await window.electronAPI?.acceptanceRun?.({
      suiteId,
      deviceIds: [selectedDeviceId],
      apkPath,
      packageName,
      baselinePath: baselineImagePath,
      rounds,
      launchWaitMs,
      threshold
    });
    if (res?.ok) {
      setLastAcceptanceTask(res.task);
      showToast?.('验收套餐已提交到任务中心');
    } else {
      setError(qualityErrorMessage(res?.error || '验收套餐启动失败'));
    }
    setBusy('');
  }

  async function startGuard() {
    if (!selectedDevice) {
      showToast?.('请先选择在线设备');
      return;
    }
    setBusy('guard');
    setError('');
    const res = await window.electronAPI?.deviceGuardStart?.({
      deviceId: selectedDeviceId,
      intervalMs: guardIntervalMs
    });
    if (res?.ok) {
      setGuardState(prev => ({ ...prev, activeGuards: res.activeGuards || prev.activeGuards }));
      showToast?.('设备守护已启动');
    } else {
      setError(res?.error || '设备守护启动失败');
    }
    setBusy('');
  }

  async function stopGuard() {
    const guard = activeGuard;
    if (!guard) return;
    setBusy('guard');
    setError('');
    const res = await window.electronAPI?.deviceGuardStop?.({ guardId: guard.id });
    if (res?.ok) {
      setGuardState({ activeGuards: res.activeGuards || [], history: res.history || [] });
      setLastStoppedGuard(res.guard);
      showToast?.('设备守护报告已生成');
    } else {
      setError(res?.error || '设备守护停止失败');
    }
    setBusy('');
  }

  return (
    <div className="space-y-5">
      <section className={`rounded-xl border ${panel} overflow-hidden`}>
        <div className={`px-5 py-4 border-b flex flex-col lg:flex-row lg:items-center justify-between gap-4 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div>
            <h3 className={`text-lg font-semibold flex items-center gap-2 ${text}`}>
              <FileDiff size={20} className="text-emerald-400" />
              质量中心
            </h3>
            <p className={`text-xs mt-1 ${muted}`}>回归差异报告、验收套餐和设备守护统一入口</p>
          </div>
          <div className={`flex items-center gap-2 text-xs ${muted}`}>
            <span>{onlineDevices.length} 台在线设备</span>
            <button
              onClick={refreshQualityCenter}
              disabled={loading || deviceLoading}
              className={outlineButton(isDark)}
            >
              <RefreshCw size={14} className={loading || deviceLoading ? 'animate-spin' : ''} />
              刷新基线/设备
            </button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          <nav className="flex flex-wrap gap-2" aria-label="质量中心功能">
            {[['regression', '回归对比'], ['acceptance', '一键验收'], ['guard', '设备守护']].map(([id, label]) => (
              <button key={id} type="button" aria-pressed={qualityTab === id} onClick={() => setQualityTab(id)} className={`rounded-lg border px-4 py-2 text-sm ${qualityTab === id ? 'border-emerald-500 bg-emerald-500/10 text-emerald-500' : isDark ? 'border-[#3E4145] text-[#BDC1C6]' : 'border-slate-200 text-slate-600'}`}>{label}</button>
            ))}
          </nav>
          {selectedDeviceId && !selectedDevice && (
            <div role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-600">目标设备 {selectedDeviceId} 已离线或未授权；请重新连接或主动选择另一台设备。</div>
          )}
          {error && (
            <div className="rounded-lg border border-red-500/25 bg-red-500/10 text-red-400 px-4 py-3 text-sm flex items-start gap-2">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              <span>{qualityErrorMessage(error)}</span>
            </div>
          )}

          <div className={`grid gap-4 ${qualityTab === 'regression' ? 'xl:grid-cols-[280px_1fr]' : ''}`}>
            <div className={`rounded-lg border p-4 ${soft}`}>
              <div className={`text-sm font-semibold mb-3 ${text}`}>目标设备</div>
              {onlineDevices.length === 0 ? (
                <EmptyState icon={Smartphone} text="暂无在线设备" muted={muted} />
              ) : (
                <div className="space-y-2">
                  {onlineDevices.map(device => (
                    <button
                      key={device.id}
                      onClick={() => { setDeviceId(device.id); onActiveDeviceChange?.(device.id); }}
                      className={`w-full text-left rounded-lg border px-3 py-2 transition-colors ${
                        selectedDeviceId === device.id
                          ? 'border-emerald-500 bg-emerald-500/10'
                          : isDark ? 'border-[#3E4145] hover:bg-[#2D2F33]' : 'border-slate-200 hover:bg-white'
                      }`}
                    >
                      <div className={`text-sm font-medium truncate ${text}`}>{device.name || device.model || device.id}</div>
                      <div className={`text-[11px] font-mono truncate ${muted}`}>{device.id}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {qualityTab === 'regression' && <div className="grid lg:grid-cols-2 gap-4">
              <div className={`rounded-lg border p-4 ${soft}`}>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className={`text-sm font-semibold flex items-center gap-2 ${text}`}>
                    <Database size={16} className="text-cyan-400" />
                    采集基线
                  </div>
                  <Toggle checked={includePerformance} onChange={setIncludePerformance} label="包含性能快照" isDark={isDark} />
                </div>
                <input
                  value={baselineName}
                  onChange={(event) => setBaselineName(event.target.value)}
                  placeholder={selectedDevice ? `${selectedDevice.model || selectedDevice.id} 基线` : '基线名称'}
                  className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                />
                <button
                  onClick={captureBaseline}
                  disabled={!selectedDevice || Boolean(busy)}
                  className={`mt-3 w-full px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 ${primary}`}
                >
                  {busy === 'capture' ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
                  采集当前设备为基线
                </button>
              </div>

              <div className={`rounded-lg border p-4 ${soft}`}>
                <div className={`text-sm font-semibold mb-3 flex items-center gap-2 ${text}`}>
                  <FileDiff size={16} className="text-emerald-400" />
                  生成差异报告
                </div>
                <input
                  value={reportName}
                  onChange={(event) => setReportName(event.target.value)}
                  placeholder="报告名称，可留空"
                  className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                />
                <button
                  onClick={runRegression}
                  disabled={!selectedDevice || !effectiveBaselinePath || Boolean(busy)}
                  className={`mt-3 w-full px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 ${primary}`}
                >
                  {busy === 'run' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  对比并生成报告
                </button>
              </div>
            </div>}
          </div>

          {qualityTab === 'regression' && <>
          <div className={`rounded-lg border ${soft} overflow-hidden`}>
            <div className={`px-4 py-3 border-b flex items-center justify-between gap-3 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
              <div>
                <div className={`text-sm font-semibold ${text}`}>回归基线</div>
                <div className={`text-xs mt-0.5 ${muted}`}>{selectedBaseline ? `已选择：${selectedBaseline.name}` : '选择一个基线用于差异对比'}</div>
              </div>
              <span className={`text-xs ${muted}`}>{baselines.length} 条</span>
            </div>

            {loading ? (
              <div className={`py-10 flex items-center justify-center gap-2 ${muted}`}>
                <Loader2 size={18} className="animate-spin" />
                <span className="text-sm">正在加载基线...</span>
              </div>
            ) : matchingBaselines.length === 0 ? (
              <div className="py-10">
                <EmptyState icon={Database} text="当前设备暂无基线，请先采集；不会自动使用其他设备的基线" muted={muted} />
              </div>
            ) : (
              <div className="divide-y divide-slate-200/10">
                {matchingBaselines.map(item => (
                  <BaselineRow
                    key={item.path}
                    item={item}
                    selected={item.path === effectiveBaselinePath}
                    isDark={isDark}
                    text={text}
                    muted={muted}
                    busy={busy === `delete:${item.path}`}
                    onSelect={() => setSelectedBaselinePath(item.path)}
                    onDelete={() => deleteBaseline(item.path)}
                  />
                ))}
              </div>
            )}
          </div>

          {lastResult && (
            <div className={`rounded-lg border p-4 ${soft}`}>
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className={`text-sm font-semibold flex items-center gap-2 ${text}`}>
                    {lastResult.status === 'passed' ? <CheckCircle2 size={17} className="text-emerald-400" /> : <AlertCircle size={17} className="text-amber-400" />}
                    {lastResult.name || '回归差异报告'}
                  </div>
                  <div className={`text-xs mt-1 ${muted}`}>{lastResult.diff?.summary || lastResult.status}</div>
                  <div className={`text-[11px] mt-2 font-mono truncate ${muted}`}>{lastResult.outputDir}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => openPath(lastResult.reportPath)} className={outlineButton(isDark)}>
                    <FileText size={14} />
                    打开报告
                  </button>
                  <button onClick={() => openPath(lastResult.outputDir)} className={outlineButton(isDark)}>
                    <FolderOpen size={14} />
                    打开目录
                  </button>
                </div>
              </div>
            </div>
          )}
          </>}

          {qualityTab === 'acceptance' && (
          <div className={`rounded-lg border ${soft} overflow-hidden`}>
            <div className={`px-4 py-3 border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
              <div className={`text-sm font-semibold flex items-center gap-2 ${text}`}>
                <ClipboardList size={16} className="text-amber-400" />
                一键验收套餐
              </div>
              <div className={`text-xs mt-1 ${muted}`}>选择常用验收流，自动提交到任务中心生成执行报告和证据目录</div>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid lg:grid-cols-4 gap-2">
                {(suites.length ? suites : [{ id: 'smoke', name: '基础冒烟验收' }]).map(item => (
                  <button
                    key={item.id}
                    onClick={() => setSuiteId(item.id)}
                    className={`text-left rounded-lg border px-3 py-3 transition-colors ${
                      suiteId === item.id
                        ? 'border-emerald-500 bg-emerald-500/10'
                        : isDark ? 'border-[#3E4145] hover:bg-[#2D2F33]' : 'border-slate-200 hover:bg-white'
                    }`}
                  >
                    <div className={`text-sm font-medium ${text}`}>{item.name}</div>
                    <div className={`text-[11px] mt-1 line-clamp-2 ${muted}`}>{item.description || '快速验收套餐'}</div>
                  </button>
                ))}
              </div>

              <div className="grid lg:grid-cols-2 gap-3">
                {(suiteId === 'install-launch' || suiteId === 'launch-stability') && (
                  <label className="space-y-1">
                    <span className={`text-xs ${muted}`}>应用包名</span>
                    <input
                      value={packageName}
                      onChange={(event) => setPackageName(event.target.value)}
                      placeholder="com.example.app"
                      className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                    />
                    <FieldError message={acceptanceErrors.packageName} />
                  </label>
                )}

                {suiteId === 'install-launch' && (
                  <label className="space-y-1">
                    <span className={`text-xs ${muted}`}>APK 文件</span>
                    <div className="flex gap-2">
                      <input
                        value={apkPath}
                        onChange={(event) => setApkPath(event.target.value)}
                        placeholder="选择或粘贴 APK 路径"
                        className={`min-w-0 flex-1 px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                      />
                      <button onClick={() => pickFile('apk')} className={outlineButton(isDark)} type="button">
                        <Package size={14} />
                        选择
                      </button>
                    </div>
                    <FieldError message={acceptanceErrors.apkPath} />
                  </label>
                )}

                {suiteId === 'visual-compare' && (
                  <label className="space-y-1">
                    <span className={`text-xs ${muted}`}>截图基线 PNG</span>
                    <div className="flex gap-2">
                      <input
                        value={baselineImagePath}
                        onChange={(event) => setBaselineImagePath(event.target.value)}
                        placeholder="选择或粘贴 PNG 路径"
                        className={`min-w-0 flex-1 px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                      />
                      <button onClick={() => pickFile('image')} className={outlineButton(isDark)} type="button">
                        <FileText size={14} />
                        选择
                      </button>
                    </div>
                    <FieldError message={acceptanceErrors.baselineImagePath} />
                  </label>
                )}

                {(suiteId === 'install-launch' || suiteId === 'launch-stability') && (
                  <label className="space-y-1">
                    <span className={`text-xs ${muted}`}>首屏等待 ms</span>
                    <input
                      type="number"
                      min="1000"
                      max="60000"
                      step="500"
                      value={launchWaitMs}
                      onChange={(event) => setLaunchWaitMs(Number(event.target.value))}
                      className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                    />
                    <FieldError message={acceptanceErrors.launchWaitMs} />
                  </label>
                )}

                {suiteId === 'launch-stability' && (
                  <label className="space-y-1">
                    <span className={`text-xs ${muted}`}>启动轮次</span>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={rounds}
                      onChange={(event) => setRounds(Number(event.target.value))}
                      className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                    />
                    <FieldError message={acceptanceErrors.rounds} />
                  </label>
                )}

                {suiteId === 'visual-compare' && (
                  <label className="space-y-1">
                    <span className={`text-xs ${muted}`}>相似度阈值 %</span>
                    <input
                      type="number"
                      min="1"
                      max="100"
                      value={threshold}
                      onChange={(event) => setThreshold(Number(event.target.value))}
                      className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                    />
                    <FieldError message={acceptanceErrors.threshold} />
                  </label>
                )}
              </div>

              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
                <div className={`text-xs ${muted}`}>
                  {lastAcceptanceTask ? (
                    <button type="button" onClick={() => setShowTaskDetails(true)} className="text-left text-emerald-500 hover:underline">最近任务：{lastAcceptanceTask.scriptName || lastAcceptanceTask.id} · {getTaskStatusLabel(lastAcceptanceTask.status)} · 查看详情</button>
                  ) : '验收结果会进入任务中心和产物中心'}
                  {Object.keys(acceptanceErrors).length > 0 && <p className="mt-2 text-amber-600">请先补齐上方标出的参数</p>}
                </div>
                <button
                  onClick={runAcceptance}
                  disabled={!selectedDevice || Boolean(busy) || Object.keys(acceptanceErrors).length > 0}
                  className={`px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 ${primary}`}
                >
                  {busy === 'acceptance' ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  运行验收套餐
                </button>
              </div>
            </div>
          </div>
          )}

          {qualityTab === 'guard' && (
          <div className={`rounded-lg border ${soft} overflow-hidden`}>
            <div className={`px-4 py-3 border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
              <div className={`text-sm font-semibold flex items-center gap-2 ${text}`}>
                <ShieldCheck size={16} className="text-teal-400" />
                设备守护
              </div>
              <div className={`text-xs mt-1 ${muted}`}>后台周期采样在线状态、性能快照和异常日志，停止后生成守护报告</div>
            </div>

            <div className="p-4 space-y-4">
              <div className="grid lg:grid-cols-[1fr_auto] gap-3">
                <label className="space-y-1">
                  <span className={`text-xs ${muted}`}>采样间隔 ms</span>
                  <input
                    type="number"
                    min="5000"
                    max="300000"
                    step="1000"
                    value={guardIntervalMs}
                    onChange={(event) => setGuardIntervalMs(Number(event.target.value))}
                    className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                  />
                </label>
                <div className="flex items-end gap-2">
                  {activeGuard ? (
                    <button
                      onClick={stopGuard}
                      disabled={busy === 'guard'}
                      className="px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 bg-red-600 text-white hover:bg-red-700"
                    >
                      {busy === 'guard' ? <Loader2 size={16} className="animate-spin" /> : <Square size={16} />}
                      停止并生成报告
                    </button>
                  ) : (
                    <button
                      onClick={startGuard}
                      disabled={!selectedDevice || Boolean(busy)}
                      className={`px-4 py-2.5 rounded-lg text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-60 ${primary}`}
                    >
                      {busy === 'guard' ? <Loader2 size={16} className="animate-spin" /> : <ShieldCheck size={16} />}
                      启动设备守护
                    </button>
                  )}
                </div>
              </div>

              <div className="grid lg:grid-cols-3 gap-3">
                <GuardStat label="运行中守护" value={guardState.activeGuards.length} isDark={isDark} />
                <GuardStat label="当前设备采样" value={activeGuard?.tickCount || 0} isDark={isDark} />
                <GuardStat label="当前设备事件" value={activeGuard?.eventCount || 0} isDark={isDark} />
              </div>

              {activeGuard && (
                <div className={`rounded-lg border p-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
                  <div className={`text-sm font-medium ${text}`}>{activeGuard.name}</div>
                  <div className={`text-xs mt-1 ${muted}`}>
                    状态：{activeGuard.busy ? '采样中' : '等待下次采样'} · 最近采样：{formatDate(activeGuard.lastSample?.at)}
                  </div>
                  {activeGuard.events?.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {activeGuard.events.slice(-3).map((event, index) => (
                        <div key={`${event.at}-${index}`} className={`text-xs rounded-lg px-3 py-2 ${event.severity === 'high' ? 'bg-red-500/10 text-red-400' : 'bg-amber-500/10 text-amber-400'}`}>
                          {event.label}：{event.detail || '-'}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {lastStoppedGuard?.reportPath && (
                <div className={`rounded-lg border p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
                  <div className="min-w-0">
                    <div className={`text-sm font-medium ${text}`}>{lastStoppedGuard.name || '设备守护报告'}</div>
                    <div className={`text-xs mt-1 font-mono truncate ${muted}`}>{lastStoppedGuard.outputDir}</div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button onClick={() => openPath(lastStoppedGuard.reportPath)} className={outlineButton(isDark)}>
                      <FileText size={14} />
                      打开报告
                    </button>
                    <button onClick={() => openPath(lastStoppedGuard.outputDir)} className={outlineButton(isDark)}>
                      <FolderOpen size={14} />
                      打开目录
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
          )}
        </div>
      </section>
      {showTaskDetails && lastAcceptanceTask && (
        <TaskCenterResultDrawer
          task={lastAcceptanceTask}
          theme={theme}
          onClose={() => setShowTaskDetails(false)}
          onOpenPath={openPath}
          onCancel={async (taskId) => {
            const res = await window.electronAPI?.taskCancel?.({ taskId });
            if (!res?.ok) showToast?.(`取消失败：${res?.error || '未知错误'}`);
          }}
        />
      )}
    </div>
  );
}

function FieldError({ message }) {
  return message ? <span className="block text-xs text-amber-600">{message}</span> : null;
}

function BaselineRow({ item, selected, isDark, text, muted, busy, onSelect, onDelete }) {
  return (
    <div className={`px-4 py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3 ${selected ? 'bg-emerald-500/10' : ''}`}>
      <button onClick={onSelect} className="min-w-0 flex-1 text-left">
        <div className={`text-sm font-medium truncate ${text}`}>{item.name}</div>
        <div className={`text-xs mt-1 ${muted}`}>
          {item.model || item.deviceId || '未记录设备'} · Android {item.android || '-'} · {item.packageCount || 0} 个应用
        </div>
        <div className={`text-[11px] mt-1 font-mono truncate ${muted}`}>{item.path}</div>
      </button>
      <div className="flex items-center gap-2 shrink-0">
        <span className={`text-xs ${muted}`}>{formatDate(item.capturedAt)}</span>
        <button
          onClick={onDelete}
          disabled={busy}
          className={`p-2 rounded-lg border disabled:opacity-60 ${
            isDark ? 'border-[#5F6368] text-[#BDC1C6] hover:bg-red-500/15 hover:text-red-300' : 'border-slate-200 text-slate-500 hover:bg-red-50 hover:text-red-600'
          }`}
          title="删除基线"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
        </button>
      </div>
    </div>
  );
}

function GuardStat({ label, value, isDark }) {
  return (
    <div className={`rounded-lg border p-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className={`text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{label}</div>
      <div className={`text-xl font-semibold mt-1 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{value}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label, isDark }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`flex items-center gap-2 text-xs ${isDark ? 'text-[#BDC1C6]' : 'text-slate-600'}`}
    >
      <span className={`w-9 h-5 rounded-full p-0.5 transition-colors ${checked ? 'bg-emerald-500' : isDark ? 'bg-[#5F6368]' : 'bg-slate-300'}`}>
        <span className={`block w-4 h-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : ''}`} />
      </span>
      {label}
    </button>
  );
}

function EmptyState({ icon, text, muted }) {
  const EmptyIcon = icon;
  return (
    <div className={`text-center ${muted}`}>
      <EmptyIcon size={28} className="mx-auto mb-2 opacity-60" />
      <div className="text-sm">{text}</div>
    </div>
  );
}

function outlineButton(isDark) {
  return `px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 disabled:opacity-60 ${
    isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'
  }`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export default QualityCenter;
