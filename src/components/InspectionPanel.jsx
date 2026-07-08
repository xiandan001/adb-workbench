// 设备巡检报告与证据包导出 UI：只负责交互和进度展示，采集逻辑在 main 进程

import { useEffect, useState } from 'react';
import { AlertCircle, Archive, CheckCircle2, ClipboardCheck, FolderOpen, Loader2, Lock, X } from 'lucide-react';

export default function InspectionPanel({ open, device, theme, vipStatus, inspectionPath, onInspectionPathChange, onClose, onOpenMemberCenter, showToast }) {
  const t = theme || {};
  const isDark = t.primary === 'tech';
  const isVipLoading = !vipStatus || vipStatus.reason === 'loading';
  const isVip = vipStatus?.activated === true;
  const [includeBugreport, setIncludeBugreport] = useState(false);
  const [includeAiSummary, setIncludeAiSummary] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !window.electronAPI?.onInspectionProgress) return;
    const offProgress = window.electronAPI.onInspectionProgress((data) => {
      if (data?.deviceId !== device?.id) return;
      setProgress(data);
    });
    const offDone = window.electronAPI.onInspectionDone((data) => {
      if (data?.deviceId !== device?.id) return;
      setRunning(false);
      setResult(data);
      if (data?.ok) {
        showToast?.(data.cancelled ? '巡检已取消，已生成部分报告' : '巡检完成，证据包已生成');
      } else if (data?.error) {
        setError(data.error);
      }
    });
    return () => {
      offProgress?.();
      offDone?.();
    };
  }, [open, device?.id, showToast]);

  useEffect(() => {
    if (!open || !device?.id || !window.electronAPI?.inspectionState) return undefined;
    let alive = true;
    window.electronAPI.inspectionState({ deviceId: device.id }).then((res) => {
      if (!alive) return;
      const task = res?.task;
      if (!task) {
        setRunning(false);
        setProgress(null);
        setResult(null);
        setError('');
        return;
      }
      const active = task.status === 'running' || task.status === 'cancelling';
      setRunning(active);
      setProgress(task.progress || null);
      setResult(task.result || null);
      setError(task.result && !task.result.ok ? task.result.error || '' : '');
    });
    return () => { alive = false; };
  }, [open, device?.id]);

  if (!open) return null;

  const panelClass = isDark
    ? 'bg-[#2D2F33] border-[#3E4145] text-[#E8EAED]'
    : 'bg-white border-slate-200 text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const soft = isDark ? 'bg-[#3E4145]/60 border-[#5F6368]' : 'bg-slate-50 border-slate-200';

  const startInspection = async () => {
    if (!isVip || isVipLoading) return;
    const initialProgress = { index: 0, total: includeBugreport ? 19 : 18, stepLabel: '准备巡检', status: 'running' };
    setRunning(true);
    setProgress(initialProgress);
    setResult(null);
    setError('');
    try {
      const res = await window.electronAPI.inspectionStart({
        deviceId: device.id,
        deviceLabel: device.model || device.id,
        includeBugreport,
        includeAiSummary,
        outputBaseDir: inspectionPath || undefined
      });
      if (!res?.ok) {
        setRunning(false);
        setError(res?.error || '巡检启动失败');
        setResult(res || null);
      } else if (res?.task) {
        setRunning(res.task.status === 'running' || res.task.status === 'cancelling');
        setProgress(res.task.progress || initialProgress);
      }
    } catch (e) {
      setRunning(false);
      setError(e.message || '巡检异常');
    }
  };

  const cancelInspection = async () => {
    await window.electronAPI?.inspectionCancel?.();
  };

  const resetPanel = () => {
    setRunning(false);
    setProgress(null);
    setResult(null);
    setError('');
    setIncludeBugreport(false);
    setIncludeAiSummary(true);
  };

  const closePanel = () => {
    if (!running) resetPanel();
    onClose?.();
  };

  const openFolder = async () => {
    const dir = result?.outputDir;
    if (!dir) return;
    const res = await window.electronAPI?.inspectionOpenFolder?.(dir);
    if (res && !res.ok) showToast?.('打开目录失败: ' + res.error);
  };

  const selectInspectionPath = async () => {
    const res = await window.electronAPI?.selectFolder?.();
    if (res?.success && res.path) {
      onInspectionPathChange?.(res.path);
    }
  };

  const progressPercent = progress?.total ? Math.round((progress.index / progress.total) * 100) : 0;
  const defaultInspectionPath = '默认: %APPDATA%/adb-workbench/inspection/';

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/55 backdrop-blur-sm p-4" onClick={closePanel}>
      <div className={`w-full max-w-2xl max-h-[86vh] rounded-xl border shadow-2xl overflow-hidden flex flex-col ${panelClass}`} onClick={(e) => e.stopPropagation()}>
        <div className={`shrink-0 px-5 py-4 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-emerald-500/15 flex items-center justify-center">
              <ClipboardCheck size={22} className="text-emerald-400" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">设备巡检</h3>
              <p className={`text-xs mt-0.5 ${muted}`}>{device?.model || device?.id} · {device?.id}</p>
            </div>
          </div>
          <button
            onClick={closePanel}
            className={`p-1.5 rounded-lg transition-colors ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-400 hover:bg-slate-100'}`}
            title="关闭"
          >
            <X size={20} />
          </button>
        </div>

        {isVipLoading ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className={`p-5 rounded-xl border flex items-center gap-4 ${soft}`}>
              <div className="w-11 h-11 rounded-full bg-emerald-500/15 flex items-center justify-center shrink-0">
                <Loader2 size={22} className="text-emerald-400 animate-spin" />
              </div>
              <div>
                <h4 className="font-semibold">正在加载会员状态</h4>
                <p className={`text-sm mt-1 ${muted}`}>请稍候，确认完成后再开始设备巡检。</p>
              </div>
            </div>
          </div>
        ) : !isVip ? (
          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <div className={`p-5 rounded-xl border flex gap-4 ${soft}`}>
              <div className="w-11 h-11 rounded-full bg-amber-500/15 flex items-center justify-center shrink-0">
                <Lock size={22} className="text-amber-400" />
              </div>
              <div className="flex-1">
                <h4 className="font-semibold">会员专属功能</h4>
                <p className={`text-sm mt-1 ${muted}`}>设备巡检会自动采集系统信息、日志、截图并导出证据包，当前基础版暂不可使用。</p>
                <div className="flex justify-end gap-2 mt-5">
                  <button onClick={closePanel} className={`px-4 py-2 text-sm rounded-lg border ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145]' : 'border-slate-200 hover:bg-slate-50'}`}>知道了</button>
                  <button
                    onClick={() => {
                      closePanel();
                      onOpenMemberCenter?.();
                    }}
                    className="px-4 py-2 text-sm rounded-lg bg-gradient-to-r from-amber-500 to-yellow-500 text-white font-medium"
                  >
                    去开通
                  </button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-5">
            <div className={`p-4 rounded-xl border ${soft}`}>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-medium">标准证据</div>
                  <p className={`text-xs mt-1 ${muted}`}>采集系统属性、运行状态、日志、截图和关键 dumpsys 输出。</p>
                </div>
                <span className="px-2.5 py-1 rounded-full text-xs bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">默认开启</span>
              </div>
              <div className="mt-4">
                <div className="font-medium mb-2">保存路径</div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={inspectionPath || ''}
                    onChange={(e) => onInspectionPathChange?.(e.target.value)}
                    disabled={running}
                    placeholder={defaultInspectionPath}
                    className={`flex-1 min-w-0 border text-xs rounded-lg p-2.5 disabled:opacity-60 ${isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700'}`}
                  />
                  <button
                    onClick={selectInspectionPath}
                    disabled={running}
                    className={`px-3 py-2.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 disabled:opacity-50 ${isDark ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-white hover:bg-slate-100 text-slate-700 border border-slate-200'}`}
                  >
                    <FolderOpen size={15} />
                    浏览
                  </button>
                </div>
                <p className={`text-xs mt-1.5 ${muted}`}>留空时使用 {defaultInspectionPath}</p>
              </div>
              <label className="mt-4 flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <div className="font-medium">包含 bugreport</div>
                  <p className={`text-xs mt-1 ${muted}`}>耗时较长、文件较大，仅在需要完整系统证据时勾选。</p>
                </div>
                <input
                  type="checkbox"
                  checked={includeBugreport}
                  onChange={(e) => setIncludeBugreport(e.target.checked)}
                  disabled={running}
                  className="w-5 h-5 accent-emerald-500"
                />
              </label>
              <label className="mt-4 flex items-center justify-between gap-4 cursor-pointer">
                <div>
                  <div className="font-medium">包含 AI 分析</div>
                  <p className={`text-xs mt-1 ${muted}`}>基于巡检摘要生成总体结论、优先关注项和下一步建议。</p>
                </div>
                <input
                  type="checkbox"
                  checked={includeAiSummary}
                  onChange={(e) => setIncludeAiSummary(e.target.checked)}
                  disabled={running}
                  className="w-5 h-5 accent-emerald-500"
                />
              </label>
            </div>

            {running && (
              <div className={`p-4 rounded-xl border ${soft}`}>
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin text-emerald-400" />
                    <span className="text-sm font-medium">{progress?.stepLabel || '执行中'}</span>
                  </div>
                  <span className={`text-xs ${muted}`}>{progress?.index || 0}/{progress?.total || 0}</span>
                </div>
                <div className={`h-2 rounded-full overflow-hidden ${isDark ? 'bg-[#202124]' : 'bg-slate-200'}`}>
                  <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progressPercent}%` }} />
                </div>
              </div>
            )}

            {error && (
              <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/10 text-sm text-red-400 flex items-start gap-2">
                <AlertCircle size={16} className="mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {result?.ok && (
              <div className={`p-4 rounded-xl border ${soft}`}>
                <div className="flex items-center gap-2 mb-3">
                  {result.cancelled ? <AlertCircle size={18} className="text-amber-400" /> : <CheckCircle2 size={18} className="text-emerald-400" />}
                  <span className="font-medium">{result.cancelled ? '已生成部分巡检结果' : '巡检完成'}</span>
                </div>
                {result.analysis && (
                  <div className={`mb-3 p-3 rounded-lg border text-xs ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
                    <div className="font-medium mb-1">健康结论：{result.analysis.summary}</div>
                    <div className={muted}>风险等级：{result.analysis.severity}</div>
                    {(result.analysis.findings || []).slice(0, 3).map((item, index) => (
                      <div key={`${item.label}-${index}`} className="mt-1 text-amber-400">{item.label}：{item.detail}</div>
                    ))}
                  </div>
                )}
                <div className={`text-xs space-y-1 ${muted}`}>
                  <div>报告：<span className="font-mono select-all">{result.reportPath}</span></div>
                  {result.aiSummary && !result.aiSummary.skipped && (
                    <div>
                      AI 分析：
                      <span>
                        {result.aiSummary.ok ? '已写入巡检报告' : result.aiSummary.error || '未生成'}
                      </span>
                    </div>
                  )}
                  <div>证据包：<span className="font-mono select-all">{result.zipPath || result.zipError || '未生成'}</span></div>
                  <div>成功 {result.successCount || 0} 项，失败 {result.failedCount || 0} 项</div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              {result?.outputDir && (
                <button onClick={openFolder} className={`px-4 py-2 text-sm rounded-lg border flex items-center gap-2 ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145]' : 'border-slate-200 hover:bg-slate-50'}`}>
                  <FolderOpen size={15} />
                  打开目录
                </button>
              )}
              {running ? (
                <button onClick={cancelInspection} className="px-4 py-2 text-sm rounded-lg bg-red-500/15 text-red-400 border border-red-500/25 hover:bg-red-500/20">
                  取消巡检
                </button>
              ) : (
                <button onClick={startInspection} className="px-5 py-2 text-sm rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium flex items-center gap-2">
                  <Archive size={15} />
                  开始巡检
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
