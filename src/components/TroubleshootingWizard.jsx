import { tr, useLocale } from '../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  FileText,
  FolderOpen,
  Loader2,
  Lock,
  Package,
  Play,
  Search,
  ShieldAlert,
  Sparkles,
  Smartphone,
  Square,
  Zap
} from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import { deviceStatusLabel } from '../shared/deviceWorkflow';
import { nextTroubleshootingContext } from '../shared/troubleshootingContext';

const ISSUE_OPTIONS = () => ([
  { id: 'crash', label: tr("应用闪退/崩溃"), icon: ShieldAlert },
  { id: 'freeze', label: tr("卡顿/无响应"), icon: AlertCircle },
  { id: 'install', label: tr("安装/启动失败"), icon: Package },
  { id: 'performance', label: tr("发热/性能异常"), icon: Zap },
  { id: 'connection', label: tr("设备连接异常"), icon: Smartphone },
  { id: 'generic', label: tr("通用问题排查"), icon: Search }
]);

const DEFAULT_STEPS = () => ([
  { id: 'device', label: tr("设备连接"), status: 'pending', detail: '' },
  { id: 'package', label: tr("应用信息"), status: 'pending', detail: '' },
  { id: 'performance', label: tr("性能快照"), status: 'pending', detail: '' },
  { id: 'logs', label: tr("关键日志"), status: 'pending', detail: '' },
  { id: 'inspection', label: tr("巡检证据"), status: 'pending', detail: '' },
  { id: 'aiSummary', label: tr("AI 总结"), status: 'pending', detail: '' }
]);

function filterProgressSteps(sourceSteps, options) {
  const list = Array.isArray(sourceSteps) && sourceSteps.length > 0 ? sourceSteps : DEFAULT_STEPS();
  return list.filter(step => {
    if (step.id === 'inspection') return options.includeInspection === true;
    if (step.id === 'aiSummary') return options.includeAiSummary === true;
    return true;
  });
}

function TroubleshootingWizard({ devices, theme, vipStatus, showToast, onOpenMemberCenter, activeDeviceId, onActiveDeviceChange, navigationContext }) {
  const locale = useLocale();
  const t = theme;
  const isDark = isDarkTheme(t);
  const onlineDevices = useMemo(() => { void locale; return devices.filter(device => device.status === 'device'); }, [devices, locale]);
  const [runningDeviceId, setRunningDeviceId] = useState('');
  const [issueType, setIssueType] = useState('crash');
  const [packageName, setPackageName] = useState('');
  const [packageSearch, setPackageSearch] = useState('');
  const [packagePickerOpen, setPackagePickerOpen] = useState(false);
  const [packageLoading, setPackageLoading] = useState(false);
  const [packageError, setPackageError] = useState('');
  const [packageItems, setPackageItems] = useState([]);
  const [packageDeviceId, setPackageDeviceId] = useState('');
  const [includeInspection, setIncludeInspection] = useState(true);
  const [includeAiSummary, setIncludeAiSummary] = useState(true);
  const [steps, setSteps] = useState(DEFAULT_STEPS());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [evidenceDeviceId, setEvidenceDeviceId] = useState(activeDeviceId || '');
  const [taskStateLoaded, setTaskStateLoaded] = useState(false);
  const packagePickerRef = useRef(null);
  const appliedContextRef = useRef(null);
  const contextDeviceRef = useRef(activeDeviceId || '');
  const packageRequestRef = useRef(0);

  const hasVip = vipStatus?.activated === true;
  const isVipLoading = vipStatus?.reason === 'loading';
  const selectedDeviceId = running ? runningDeviceId || activeDeviceId : activeDeviceId;
  const selectedDevice = onlineDevices.find(device => device.id === selectedDeviceId);
  const deviceOptions = useMemo(() => {
    void locale;
    const options = devices.map(device => ({
      value: device.id,
      label: device.model || device.name || device.id,
      description: `${device.id} · ${deviceStatusLabel(device.status)}`
    }));
    if (selectedDeviceId && !devices.some(device => device.id === selectedDeviceId)) {
      options.unshift({ value: selectedDeviceId, label: tr("{0} · 已断开", { 0: selectedDeviceId }), description: tr("已保留选择，请重新连接") });
    }
    return options.length ? options : [{ value: '', label: tr("暂无设备"), description: tr("请连接设备后刷新"), disabled: true }];
  }, [devices, selectedDeviceId, locale]);
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const panel = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200';
  const soft = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const input = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700';

  useEffect(() => {
    const next = nextTroubleshootingContext({
      currentDeviceId: contextDeviceRef.current, activeDeviceId,
      running: running || !taskStateLoaded, navigationContext, appliedRequestId: appliedContextRef.current
    });
    if (!next) return;
    contextDeviceRef.current = next.deviceId;
    appliedContextRef.current = next.appliedRequestId;
    packageRequestRef.current += 1;
    setPackageName(next.packageName);
    setPackageSearch(next.packageName);
    setPackagePickerOpen(false);
    setPackageItems([]);
    setPackageDeviceId('');
    setPackageError('');
    setPackageLoading(false);
    setResult(null);
    setError('');
    setSteps(DEFAULT_STEPS());
    setEvidenceDeviceId(next.deviceId);
  }, [activeDeviceId, navigationContext, running, taskStateLoaded]);

  const filteredPackages = useMemo(() => {
    void locale;
    const keyword = packageSearch.trim().toLowerCase();
    if (!keyword) return packageItems.slice(0, 80);
    return packageItems
      .filter(item => {
        const values = [item.packageName, item.apkName, item.path].map(value => String(value || '').toLowerCase());
        return values.some(value => value.includes(keyword));
      })
      .slice(0, 80);
  }, [packageItems, packageSearch, locale]);

  useEffect(() => {
    if (!window.electronAPI?.onTroubleshootingProgress) {
      setTaskStateLoaded(true);
      return undefined;
    }
    let alive = true;
    let receivedUpdate = false;
    const offProgress = window.electronAPI.onTroubleshootingProgress((event) => {
      receivedUpdate = true;
      setRunning(event.status === 'running' || event.status === 'cancelling');
      if (event.deviceId) setRunningDeviceId(event.deviceId);
      if (event.deviceId) setEvidenceDeviceId(event.deviceId);
      if (typeof event.includeInspection === 'boolean') setIncludeInspection(event.includeInspection);
      if (typeof event.includeAiSummary === 'boolean') setIncludeAiSummary(event.includeAiSummary);
      if (Array.isArray(event.steps)) setSteps(event.steps);
    });
    const offDone = window.electronAPI.onTroubleshootingDone((event) => {
      receivedUpdate = true;
      setRunning(false);
      if (event.deviceId) setEvidenceDeviceId(event.deviceId);
      if (typeof event.includeInspection === 'boolean') setIncludeInspection(event.includeInspection);
      if (typeof event.includeAiSummary === 'boolean') setIncludeAiSummary(event.includeAiSummary);
      if (Array.isArray(event.steps)) setSteps(event.steps);
      setResult(event.result || null);
      if (!event.result?.ok && !event.result?.cancelled) setError(event.result?.error || tr("排查失败，请查看执行步骤"));
      if (event.result?.ok) showToast?.(tr("一键问题排查完成"));
      else if (event.result?.cancelled) showToast?.(tr("一键问题排查已取消"));
      else showToast?.(tr("一键问题排查失败：{0}", { 0: event.result?.error || tr("未知错误") }));
    });
    Promise.resolve(window.electronAPI.troubleshootingState?.()).then(res => {
      if (!alive || receivedUpdate) return;
      const task = res?.task;
      if (!task) return;
      const taskRunning = task.status === 'running' || task.status === 'cancelling';
      setRunning(taskRunning);
      if (task.deviceId) setRunningDeviceId(task.deviceId);
      if (task.deviceId) setEvidenceDeviceId(task.deviceId);
      if (taskRunning) {
        contextDeviceRef.current = task.deviceId;
        setPackageName(task.packageName || '');
        setPackageSearch(task.packageName || '');
      }
      if (typeof task.includeInspection === 'boolean') setIncludeInspection(task.includeInspection);
      if (typeof task.includeAiSummary === 'boolean') setIncludeAiSummary(task.includeAiSummary);
      if (Array.isArray(task.steps)) setSteps(task.steps);
      if (task.result) setResult(task.result);
    }).catch(() => {
      if (alive) setError(tr("排查状态读取失败，请刷新页面后确认是否有运行中的任务"));
    }).finally(() => {
      if (alive) setTaskStateLoaded(true);
    });
    return () => {
      alive = false;
      packageRequestRef.current += 1;
      offProgress?.();
      offDone?.();
    };
  }, [showToast]);

  useEffect(() => {
    if (!packageDeviceId || packageDeviceId === selectedDeviceId) return;
    setPackagePickerOpen(false);
    setPackageError('');
  }, [packageDeviceId, selectedDeviceId]);

  useEffect(() => {
    if (!packagePickerOpen) return undefined;
    const onMouseDown = (event) => {
      if (packagePickerRef.current?.contains(event.target)) return;
      setPackagePickerOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setPackagePickerOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [packagePickerOpen]);

  const startTroubleshooting = async () => {
    if (!window.electronAPI?.troubleshootingStart) {
      showToast?.(tr("一键问题排查需要 Electron 环境"));
      return;
    }
    if (!taskStateLoaded || running) return;
    setEvidenceDeviceId(selectedDeviceId);
    if (!selectedDevice) {
      setError(tr("当前设备不可用，请重新连接或明确选择另一台在线设备。"));
      return;
    }
    setError('');
    setResult(null);
    setSteps(DEFAULT_STEPS());
    setPackagePickerOpen(false);
    setRunning(true);
    setRunningDeviceId(selectedDeviceId);
    try {
      const res = await window.electronAPI.troubleshootingStart({
        deviceId: selectedDeviceId,
        deviceLabel: selectedDevice?.model || selectedDevice?.name || selectedDeviceId,
        issueType,
        packageName: packageName.trim(),
        includeInspection: hasVip && includeInspection,
        includeAiSummary
      });
      if (!res.ok) throw new Error(res.error || tr("启动失败"));
      if (res.task?.steps) setSteps(res.task.steps);
    } catch (error) {
      setRunning(false);
      setError(error.message);
      showToast?.(tr("一键问题排查启动失败：{0}", { 0: error.message }));
    }
  };

  const cancelTroubleshooting = async () => {
    await window.electronAPI?.troubleshootingCancel?.();
  };

  const loadPackages = async () => {
    const targetDeviceId = selectedDeviceId;
    setPackageSearch(packageName.trim());
    if (!selectedDevice) {
      setPackagePickerOpen(false);
      showToast?.(tr("请先选择在线设备"));
      return;
    }
    if (!window.electronAPI?.packageList) {
      setPackagePickerOpen(false);
      showToast?.(tr("应用列表需要 Electron 环境"));
      return;
    }
    setPackagePickerOpen(true);
    setPackageError('');
    if (packageDeviceId === targetDeviceId && packageItems.length > 0) return;
    const requestId = ++packageRequestRef.current;
    setPackageLoading(true);
    try {
      const res = await window.electronAPI.packageList({ deviceId: targetDeviceId });
      if (requestId !== packageRequestRef.current) return;
      if (res?.ok) {
        setPackageItems(res.packages || []);
        setPackageDeviceId(targetDeviceId);
      } else {
        setPackageItems([]);
        setPackageDeviceId('');
        setPackageError(res?.error || tr("应用列表读取失败"));
      }
    } catch (error) {
      if (requestId !== packageRequestRef.current) return;
      setPackageItems([]);
      setPackageDeviceId('');
      setPackageError(error.message || tr("应用列表读取失败"));
    } finally {
      if (requestId === packageRequestRef.current) setPackageLoading(false);
    }
  };

  const selectPackage = (item) => {
    setPackageName(item.packageName || '');
    setPackageSearch(item.packageName || '');
    setPackagePickerOpen(false);
  };

  const openPath = async (targetPath) => {
    if (!targetPath) return;
    const res = await window.electronAPI?.troubleshootingOpenFolder?.(targetPath);
    if (res && !res.ok) showToast?.(tr("打开失败：{0}", { 0: res.error || tr("未知错误") }));
  };

  const visibleSteps = useMemo(
    () => { void locale; return filterProgressSteps(evidenceDeviceId === selectedDeviceId ? steps : DEFAULT_STEPS(), { includeInspection: hasVip && includeInspection, includeAiSummary }); },
    [steps, evidenceDeviceId, selectedDeviceId, hasVip, includeInspection, includeAiSummary, locale]
  );
  const completedCount = visibleSteps.filter(step => ['success', 'failed', 'skipped'].includes(step.status)).length;
  const progressTotal = visibleSteps.length;
  const progressPercent = progressTotal ? Math.round(completedCount / progressTotal * 100) : 0;
  const progressGridClass = progressTotal >= 5 ? 'grid sm:grid-cols-2 lg:grid-cols-5 gap-2' : 'grid sm:grid-cols-2 lg:grid-cols-4 gap-2';

  return (
    <div className="space-y-5">
      <section className={`rounded-xl border ${panel} overflow-hidden`}>
        <div className={`px-5 py-4 border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center">
                <ClipboardCheck size={22} className="text-emerald-400" />
              </div>
              <div>
                <h3 className={`text-base font-semibold ${text}`}>{tr("采集诊断证据")}</h3>
                <p className={`text-xs mt-0.5 ${muted}`}>{running ? tr("正在排查：{0}", { 0: runningDeviceId }) : tr("选择场景后开始；不会因切换页面自动执行")}</p>
              </div>
            </div>
            <div className={`text-xs px-3 py-1.5 rounded-full border ${soft}`}>
              {running ? tr("排查中") : result ? tr("已有结果") : tr("待开始")}
            </div>
          </div>
        </div>

        <div className="p-5 grid xl:grid-cols-[360px_1fr] gap-5">
          <div className="space-y-4">
            <div>
              <FieldLabel label={tr("目标设备")} isDark={isDark} />
              <DeviceSelect
                value={selectedDeviceId}
                options={deviceOptions}
                isDark={isDark}
                disabled={running}
                onChange={(value) => {
                  onActiveDeviceChange?.(value);
                }}
              />
              {selectedDeviceId && !selectedDevice && <p role="status" className="mt-2 text-xs text-amber-500">{tr("当前设备不可用，已保留选择。恢复连接后才能开始排查。")}</p>}
            </div>

            <div>
              <FieldLabel label={tr("问题类型")} isDark={isDark} />
              <div className="grid grid-cols-2 gap-2">
                {ISSUE_OPTIONS().map(option => {
                  const Icon = option.icon;
                  const active = issueType === option.id;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      disabled={running}
                      onClick={() => setIssueType(option.id)}
                      className={`min-h-[74px] rounded-lg border px-3 py-2 text-left transition-colors ${
                        active
                          ? 'border-emerald-500 bg-emerald-500/15 text-emerald-300'
                          : isDark ? 'border-[#3E4145] hover:bg-[#3E4145] text-[#E8EAED]' : 'border-slate-200 hover:bg-slate-50 text-slate-700'
                      }`}
                    >
                      <Icon size={17} className={active ? 'text-emerald-300' : muted} />
                      <div className="text-xs font-medium mt-2 leading-snug">{option.label}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <FieldLabel label={tr("目标包名")} isDark={isDark} optional />
              <div ref={packagePickerRef}>
                <div className="flex gap-2">
                  <input
                    value={packageName}
                    onChange={(event) => {
                      setPackageName(event.target.value);
                      setPackageSearch(event.target.value);
                    }}
                    onFocus={() => {
                      if (packageItems.length > 0 && packageDeviceId === selectedDeviceId) setPackagePickerOpen(true);
                    }}
                    disabled={running}
                    placeholder="com.example.app"
                    className={`min-w-0 flex-1 px-3 py-2.5 border rounded-lg text-sm font-mono outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                  />
                  <button
                    type="button"
                    onClick={loadPackages}
                    disabled={running || packageLoading || !selectedDevice}
                    className={`shrink-0 px-3 py-2.5 rounded-lg border text-sm flex items-center justify-center gap-1.5 disabled:opacity-60 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
                  >
                    {packageLoading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}{tr("搜索")}</button>
                </div>

                {packagePickerOpen && (
                  <div className={`mt-2 w-full rounded-lg border shadow-sm ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
                    <div className={`border-b p-2 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                      <input
                        autoFocus
                        value={packageSearch}
                        onChange={(event) => setPackageSearch(event.target.value)}
                        placeholder={tr("搜索包名或 APK 名")}
                        className={`w-full px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${input}`}
                      />
                    </div>
                    <div className="max-h-56 overflow-y-auto p-2">
                      {packageLoading ? (
                        <div className={`py-8 text-center text-sm ${muted}`}>
                          <Loader2 size={18} className="mx-auto mb-2 animate-spin" />{tr("正在读取应用列表...")}</div>
                      ) : packageError ? (
                        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                          {tr(packageError)}
                        </div>
                      ) : filteredPackages.length === 0 ? (
                        <div className={`py-8 text-center text-sm ${muted}`}>{tr("未找到匹配应用")}</div>
                      ) : filteredPackages.map(item => (
                        <PackageOption
                          key={item.packageName}
                          item={item}
                          isDark={isDark}
                          onSelect={selectPackage}
                        />
                      ))}
                    </div>
                    <div className={`border-t px-3 py-2 flex items-center justify-between gap-2 text-xs ${isDark ? 'border-[#3E4145]' : 'border-slate-100'} ${muted}`}>
                      <span>{packageItems.length > 0 ? tr("共 {0} 个应用", { 0: packageItems.length }) : tr("也可以直接手动输入包名")}</span>
                      <button
                        type="button"
                        onClick={() => setPackagePickerOpen(false)}
                        className={isDark ? 'text-[#E8EAED] hover:text-emerald-300' : 'text-slate-700 hover:text-emerald-600'}
                      >{tr("收起")}</button>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <label className={`flex items-start gap-3 rounded-lg border p-3 ${soft}`}>
              <input
                type="checkbox"
                checked={hasVip && includeInspection}
                disabled={running || !hasVip}
                onChange={(event) => setIncludeInspection(event.target.checked)}
                className="mt-1 w-4 h-4 accent-emerald-500"
              />
              <span className="flex-1">
                <span className={`block text-sm font-medium ${text}`}>{tr("包含巡检证据包")}</span>
                <span className={`block text-xs mt-1 ${muted}`}>
                  {hasVip ? tr("生成完整巡检报告和证据包") : isVipLoading ? tr("正在加载会员状态") : tr("会员版可用")}
                </span>
              </span>
              {!hasVip && !isVipLoading && (
                <button
                  type="button"
                  onClick={onOpenMemberCenter}
                  className="text-xs text-amber-400 flex items-center gap-1"
                >
                  <Lock size={12} />{tr("会员")}</button>
              )}
            </label>

            <label className={`flex items-start gap-3 rounded-lg border p-3 ${soft}`}>
              <input
                type="checkbox"
                checked={includeAiSummary}
                disabled={running}
                onChange={(event) => setIncludeAiSummary(event.target.checked)}
                className="mt-1 w-4 h-4 accent-emerald-500"
              />
              <span className="flex-1">
                <span className={`block text-sm font-medium ${text}`}>{tr("报告包含 AI 总结")}</span>
                <span className={`block text-xs mt-1 ${muted}`}>{tr("勾选后会在问题排查报告末尾追加 AI 总结")}</span>
              </span>
              <Sparkles size={15} className="mt-0.5 text-emerald-400" />
            </label>

            <div className="flex gap-2">
              {running ? (
                <button
                  type="button"
                  onClick={cancelTroubleshooting}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-red-500 hover:bg-red-600 text-white font-medium flex items-center justify-center gap-2"
                >
                  <Square size={16} />{tr("取消排查")}</button>
              ) : (
                <button
                  type="button"
                  onClick={startTroubleshooting}
                  disabled={!selectedDevice || !taskStateLoaded}
                  className="flex-1 px-4 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-medium flex items-center justify-center gap-2"
                >
                  <Play size={16} />{tr("开始排查")}</button>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div className={`rounded-xl border p-4 ${soft}`}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className={`font-semibold ${text}`}>{tr("执行进度")}</div>
                  <div className={`text-xs mt-1 ${muted}`}>{tr("{0}/{1} 项完成", { 0: completedCount, 1: progressTotal })}</div>
                </div>
                <div className={`text-sm font-semibold ${running ? 'text-emerald-400' : muted}`}>{progressPercent}%</div>
              </div>
              <div className={`h-2 rounded-full overflow-hidden mt-3 ${isDark ? 'bg-[#101214]' : 'bg-slate-200'}`}>
                <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>

            <div className={progressGridClass}>
              {visibleSteps.map(step => (
                <StepTile key={step.id} step={step} isDark={isDark} />
              ))}
            </div>

              {error && evidenceDeviceId === selectedDeviceId && (
              <div className="rounded-lg border border-red-500/25 bg-red-500/10 text-red-400 px-4 py-3 text-sm flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{tr(error)}</span>
              </div>
            )}

            {result && evidenceDeviceId === selectedDeviceId && (
              <ResultPanel result={result} isDark={isDark} text={text} muted={muted} soft={soft} onOpenPath={openPath} />
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function StepTile({ step, isDark }) {
  useLocale();
  const statusClass = {
    pending: isDark ? 'border-[#3E4145] bg-[#202124] text-[#9AA0A6]' : 'border-slate-200 bg-slate-50 text-slate-500',
    running: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
    failed: 'border-red-500/30 bg-red-500/10 text-red-400',
    skipped: 'border-amber-500/30 bg-amber-500/10 text-amber-400'
  }[step.status] || '';
  return (
    <div className={`rounded-lg border px-3 py-3 min-h-[92px] ${statusClass}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">{step.label}</span>
        {step.status === 'running' ? <Loader2 size={14} className="animate-spin" /> : step.status === 'success' ? <CheckCircle2 size={14} /> : step.status === 'failed' ? <AlertCircle size={14} /> : null}
      </div>
      <div className="text-[11px] leading-relaxed mt-2 line-clamp-2">{step.detail || statusText(step.status)}</div>
    </div>
  );
}

function ResultPanel({ result, isDark, text, muted, soft, onOpenPath }) {
  useLocale();
  const ok = result.ok && !result.cancelled;
  return (
    <div className={`rounded-xl border p-4 ${soft}`}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
            {ok ? <CheckCircle2 size={21} /> : <AlertCircle size={21} />}
          </div>
          <div>
            <div className={`font-semibold ${text}`}>{result.title || (ok ? tr("排查完成") : tr("排查未完成"))}</div>
            <div className={`text-sm mt-1 ${muted}`}>{result.message || result.error || tr("已生成排查结果")}</div>
          </div>
        </div>
        <div className={`px-2.5 py-1 rounded-full text-xs ${ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-amber-500/15 text-amber-400'}`}>
          {result.cancelled ? tr("已取消") : ok ? tr("完成") : tr("需关注")}
        </div>
      </div>

      {Array.isArray(result.suggestions) && result.suggestions.length > 0 && (
        <div className="mt-4">
          <div className={`text-xs font-semibold mb-2 ${text}`}>{tr("建议")}</div>
          <div className="space-y-1.5">
            {result.suggestions.map((item, index) => (
              <div key={`${item}-${index}`} className={`text-xs ${muted}`}>{index + 1}. {item}</div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {result.reportPath && (
          <button onClick={() => onOpenPath(result.reportPath)} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
            <FileText size={15} />{tr("打开报告")}</button>
        )}
        {result.outputDir && (
          <button onClick={() => onOpenPath(result.outputDir)} className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
            <FolderOpen size={15} />{tr("打开目录")}</button>
        )}
      </div>
    </div>
  );
}

function DeviceSelect({ value, options, isDark, disabled, onChange }) {
  useLocale();
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex] || options[0] || { value: '', label: tr("暂无在线设备"), description: '' };
  const allDisabled = disabled || options.length === 0 || options.every(option => option.disabled);
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const gap = 8;
      const viewportHeight = window.innerHeight || 720;
      const viewportWidth = window.innerWidth || 1024;
      const width = Math.max(rect.width, 240);
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
              <Smartphone size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm font-medium ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{option.label}</span>
              {option.description && <span className={`block truncate text-xs mt-0.5 leading-snug ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{option.description}</span>}
            </span>
            {selectedOption && <Check size={15} className="mt-1 text-emerald-400 shrink-0" />}
          </button>
        );
      })}
    </div>,
    document.body
  ) : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={allDisabled}
        onClick={() => setOpen(prev => !prev)}
        className={`w-full px-3 py-2.5 rounded-lg border text-sm transition-colors flex items-center justify-between gap-3 disabled:cursor-not-allowed disabled:opacity-60 ${isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="flex items-center gap-2 min-w-0">
          <Smartphone size={15} className="text-emerald-400 shrink-0" />
          <span className="truncate">{selected.label}</span>
        </span>
        <ChevronDown size={15} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {menu}
    </div>
  );
}

function PackageOption({ item, isDark, onSelect }) {
  useLocale();
  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className={`w-full rounded-lg px-3 py-2 text-left transition-colors ${isDark ? 'hover:bg-[#2D2F33]' : 'hover:bg-slate-50'}`}
    >
      <div className="flex items-start gap-2">
        <Package size={15} className={`mt-0.5 shrink-0 ${item.system ? 'text-slate-400' : 'text-emerald-400'}`} />
        <div className="min-w-0 flex-1">
          <div className={`truncate font-mono text-xs ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{item.packageName}</div>
          <div className={`mt-1 truncate text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{item.apkName || item.path || tr("应用")}</div>
        </div>
        {item.system && (
          <span className="shrink-0 rounded bg-slate-500/10 px-1.5 py-0.5 text-[10px] text-slate-400">SYS</span>
        )}
      </div>
    </button>
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

function FieldLabel({ label, isDark, optional }) {
  useLocale();
  return (
    <div className={`text-xs font-medium mb-1.5 ${isDark ? 'text-[#BDC1C6]' : 'text-slate-600'}`}>
      {label}{optional ? <span className="ml-1 opacity-60">{tr("可选")}</span> : null}
    </div>
  );
}

function statusText(status) {
  if (status === 'pending') return tr("等待执行");
  if (status === 'running') return tr("正在执行");
  if (status === 'success') return tr("已完成");
  if (status === 'failed') return tr("执行失败");
  if (status === 'skipped') return tr("已跳过");
  return '';
}

export default TroubleshootingWizard;
