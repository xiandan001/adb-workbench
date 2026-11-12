import { tr, useLocale } from '../shared/i18n';
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Video, ScrollText, Shield, Save, RotateCcw, Loader, Unlock, Package, Terminal, Download, Upload, FolderOpen, Folder, File, ChevronDown, ChevronRight, ArrowLeft, Copy, RefreshCw, Send, Loader2, Maximize2, Minimize2, X, ClipboardCheck } from 'lucide-react';
import themes from '../data/themes';
import DeviceCardHeader from './DeviceCardHeader';
import ControlButton from './ControlButton';
import SelectMenu from './SelectMenu';
import DeviceNavigationControls from './DeviceNavigationControls';
import DeviceRecordingStatus from './DeviceRecordingStatus';
import DeviceRecentMedia from './DeviceRecentMedia';
import AiContextButton from './AiContextButton';
import useDeviceRecording from './useDeviceRecording';
import './DeviceCard.css';
// 设备巡检面板：采集逻辑在主进程 inspection 模块中
import InspectionPanel from './InspectionPanel';
// App 包管理增强面板
import PackageManagerPanel from './PackageManagerPanel';
// 通用危险确认弹窗（用于 su 不支持等提醒）
import DangerConfirmModal from './DangerConfirmModal';
import { isDarkTheme } from '../shared/theme';
import { deviceConnectionHint } from '../shared/deviceWorkflow';
import { recordingButtonState } from '../shared/recordingWorkspace';
import { isHarmonyDevice } from '../shared/devicePlatform';
import { deviceTerminalCommands, deviceTerminalPresentation, createDeviceTerminalRequest } from '../shared/deviceTerminal';
import { trapAppMessageFocus } from '../shared/appMessageDialog';
import useDeviceWorkingState from '../shared/useDeviceWorkingState';
import { DEVICE_WORKING_LIMITS, visibleDeviceTerminalOutput, deviceWorkingErrorMessage } from '../shared/deviceWorkingState';

function DeviceTerminalSurface({ fullscreen, children }) {
  return fullscreen && typeof document !== 'undefined' ? createPortal(children, document.body) : children;
}

function DeviceCard({ device, deviceName, onNameChange, onStart, onScreenshot, onScreenRecordStart, onScreenRecordStop, onReboot, onRebootLoader, onUnlock, onRoot, onRemount, onDisconnect, showApkManager, onApkManager, onSelectApkForInstall, recentApks, onSelectRecentApk, onSelectApkForPush, onInstallApk, onPushApk, onBrowsePath, onPullFile, onPushPathChange, showToast, apkInstallPath, apkPushPath, apkInstallResult, apkPushResult, apkPushRemotePath, pushRemotePathHistory, apkBrowserPath, apkBrowserItems, apkBrowserLoading, operationLoading, onExecuteCommand, theme, sharedCommandHistory, onSaveTerminalCommand, onClearTerminalHistory, vipStatus, inspectionPath, onInspectionPathChange, onOpenMemberCenter, isActive, onSelectDevice, onEnvironmentCheck, onInspectApplication, onViewApplicationLogs, onOpenReproduction, operationError, onDismissOperationError, isPinned, onTogglePin, deviceCardDensity = 'full' }) {
  useLocale();
  const isOnline = device.status === 'device';
  const harmony = isHarmonyDevice(device);
  const working = useDeviceWorkingState(device.id);
  const setWorkingField = working.set;
  const { maintenanceOpen, showTerminal, terminalFontSize, terminalCommand, terminalOutput, panelOrder, isExecuting,
    recordWithLogs, moreToolsOpen } = working.state;
  const setMaintenanceOpen = value => working.set('maintenanceOpen', value);
  const setShowTerminal = value => working.set('showTerminal', value);
  const setTerminalFontSize = useCallback(value => setWorkingField('terminalFontSize', value), [setWorkingField]);
  const setTerminalCommand = value => working.set('terminalCommand', value);
  const setTerminalOutput = value => working.set('terminalOutput', value);
  const setPanelOrder = useCallback(value => setWorkingField('panelOrder', value), [setWorkingField]);
  const setIsExecuting = value => working.set('isExecuting', value);
  const setRecordWithLogs = value => working.set('recordWithLogs', value);
  const compact = deviceCardDensity === 'compact';
  const showSecondaryTools = !compact || moreToolsOpen;
  const visibleOutput = visibleDeviceTerminalOutput(terminalOutput);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(deviceName || '');
  // 终端放大模式：脱离原位置，全屏覆盖
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  // 终端字体大小（Ctrl+滚轮缩放，范围 10-28px）
  const terminalOutputRef = useRef(null);
  const terminalScrollRestoreRef = useRef(working.state.terminalScroll);
  const terminalInputRef = useRef(null);
  const terminalRootRef = useRef(null);
  const terminalExpandRef = useRef(null);
  const terminalPanelRef = useRef(null);
  const terminalWasFullscreen = useRef(false);
  // SU 提权模式：开启后命令以 root 身份执行
  const [suMode, setSuMode] = useState(false);
  // 提权策略：'direct'=adb root 已生效（命令本身是 root）；'su'=需 su -c 包装
  const [suStrategy, setSuStrategy] = useState('none');
  const [suChecking, setSuChecking] = useState(false);
  // su 不支持时的提醒弹窗
  const [suUnsupportedOpen, setSuUnsupportedOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showHistory, setShowHistory] = useState(false);
  const recording = useDeviceRecording(device.id, onScreenRecordStart, onScreenRecordStop);
  const recordButton = recordingButtonState(recording.session, { loaded: recording.loaded, pending: recording.pending, isOnline });
  const recordingActive = ['starting', 'recording', 'stopping', 'saving'].includes(recording.session?.status);
  // 设备巡检弹窗状态
  const [showInspection, setShowInspection] = useState(false);
  const commandHistory = sharedCommandHistory || [];
  const terminalCommands = deviceTerminalCommands(device);
  const terminal = deviceTerminalPresentation(device, suMode);
  // 旧 APK 区块仅作为临时回退源码保留，默认不渲染。
  const showLegacyApkManager = Boolean(globalThis.__XBH_LEGACY_APK_MANAGER__);

  useEffect(() => {
    setPanelOrder(prev => {
      const next = prev.filter(panel => {
        if (panel === 'apk') return showApkManager;
        if (panel === 'terminal') return showTerminal;
        return false;
      });
      if (showApkManager && !next.includes('apk')) next.push('apk');
      if (showTerminal && !next.includes('terminal')) next.push('terminal');
      return next.length === prev.length && next.every((panel, index) => panel === prev[index]) ? prev : next;
    });
  }, [showApkManager, showTerminal, setPanelOrder]);

  const getPanelOrder = (panel) => {
    const index = panelOrder.indexOf(panel);
    return index === -1 ? 20 : 10 + index;
  };

  const changeTerminalFullscreen = value => {
    const output = terminalOutputRef.current;
    terminalScrollRestoreRef.current = output ? { top: output.scrollTop,
      atBottom: output.scrollHeight - output.clientHeight - output.scrollTop <= 2 } : null;
    setTerminalFullscreen(value);
  };

  useEffect(() => {
    const wasFullscreen = terminalWasFullscreen.current;
    terminalWasFullscreen.current = terminalFullscreen;
    if (!showTerminal || (!terminalFullscreen && !wasFullscreen)) return undefined;
    const frame = requestAnimationFrame(() => {
      const target = terminalFullscreen ? (terminalInputRef.current?.disabled ? terminalPanelRef.current : terminalInputRef.current) : terminalExpandRef.current;
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [showTerminal, terminalFullscreen]);

  const handleNameSubmit = () => {
    onNameChange(device.id, editName.trim());
    setIsEditing(false);
  };

  const handleNameKeyDown = (e) => {
    if (e.key === 'Enter') {
      handleNameSubmit();
    } else if (e.key === 'Escape') {
      setEditName(deviceName || '');
      setIsEditing(false);
    }
  };

  const handleTerminalSubmit = async (e) => {
    e?.preventDefault();
    if (!terminalCommand.trim() || isExecuting || !isOnline) return;

    if (!working.beginExecution()) return;
    setShowHistory(false);
    const rawCmd = terminalCommand.trim();
    const request = createDeviceTerminalRequest(device, rawCmd, { root: suMode, strategy: suStrategy });
    setTerminalOutput(prev => [...prev, { type: 'command', prompt: request.prompt, text: request.text }]);
    setTerminalCommand('');
    setHistoryIndex(-1);
    try {
      onSaveTerminalCommand?.(rawCmd);
      if (onExecuteCommand) {
        const result = await onExecuteCommand(request.deviceId, request.command);
        if (typeof result === 'string') setTerminalOutput(prev => [...prev, { type: 'output', text: result }]);
        else {
          if (result?.output) setTerminalOutput(prev => [...prev, { type: 'output', text: result.output }]);
          if (result?.success) {
            if (!result.output) setTerminalOutput(prev => [...prev, { type: 'output', text: tr('命令执行成功') }]);
          } else {
            const message = result?.cancelled ? tr('命令已中断') : tr('命令执行失败: {0}', { 0: result?.error || tr('未知错误') });
            setTerminalOutput(prev => [...prev, { type: result?.cancelled ? 'output' : 'error', text: message }]);
            setTerminalCommand(current => current || rawCmd);
          }
        }
      }
    } catch (err) {
      setTerminalOutput(prev => [...prev, { type: 'error', text: `Error: ${err.message}` }]);
      setTerminalCommand(current => current || rawCmd);
    } finally {
      setIsExecuting(false);
    }
  };

  // 检测设备是否支持提权，返回策略：
  //  'su-c'   = 标准 su -c（Magisk/AOSP）
  //  'su-sh'  = busybox/toybox su（不识别 -c，需 su 0 sh -c）
  //  'direct' = adb root 已生效，shell 本身是 root（su 不可用时的兜底）
  //  'none'   = 不支持
  // 用户主动开启 SU，优先使用 su 包装；仅当 su 不可用时才回退 direct
  const checkSuSupported = async () => {
    if (harmony) {
      try {
        const result = await window.electronAPI.adbShell(device.id, 'id');
        return { supported: result?.success && /uid=0\b/.test(result.output || ''), strategy: 'direct' };
      } catch { return { supported: false, strategy: 'none' }; }
    }
    const MARK = '__SU_OK__';
    // 1. 标准 su -c（用单引号包裹命令，与实际执行一致）
    try {
      const r1 = await window.electronAPI.adbShell(device.id, `su -c 'echo ${MARK}'`);
      if (r1?.output?.includes(MARK)) {
        return { supported: true, strategy: 'su-c' };
      }
    } catch {
      // Ignore unsupported su -c form and try the next strategy.
    }
    // 2. 兼容 busybox/toybox：su 不识别 -c，改用 su 0 sh -c
    try {
      const r2 = await window.electronAPI.adbShell(device.id, `su 0 sh -c 'echo ${MARK}'`);
      if (r2?.output?.includes(MARK)) {
        return { supported: true, strategy: 'su-sh' };
      }
    } catch {
      // Ignore unsupported su shell form and try direct root detection.
    }
    // 3. 兜底：adb root 已生效（id 直接是 root），无需 su 包装
    try {
      const idRes = await window.electronAPI.adbShell(device.id, 'id');
      if (/uid=0/.test(idRes?.output || '')) {
        return { supported: true, strategy: 'direct' };
      }
    } catch {
      // Ignore id check failures and report unsupported below.
    }
    return { supported: false, strategy: 'none' };
  };

  // 切换 SU 模式：关→开时先静默检测，支持才开启，否则弹窗提醒
  const toggleSuMode = async () => {
    if (suMode) {
      setSuMode(false);
      return;
    }
    if (!isOnline) return;
    setSuChecking(true);
    const { supported, strategy } = await checkSuSupported();
    setSuChecking(false);
    if (supported) {
      setSuStrategy(strategy);
      setSuMode(true);
    } else {
      setSuUnsupportedOpen(true);
    }
  };

  const closeSuWarning = () => {
    setSuUnsupportedOpen(false);
    requestAnimationFrame(() => {
      const trigger = terminalRootRef.current;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    });
  };

  // 中断当前正在执行的命令（如 su 等交互式命令挂起时可手动停止）
  const handleCancelExecute = async () => {
    try {
      if (window.electronAPI?.adbShellCancel) {
        await window.electronAPI.adbShellCancel(device.id);
      }
    } catch {
      // 主进程回调会自动 resolve 执行中的 Promise，忽略中断请求异常
    }
  };

  const handleTerminalKeyDown = (e) => {
    // 放大模式下按 Esc 退出
    if (e.key === 'Escape' && terminalFullscreen) {
      e.preventDefault();
      changeTerminalFullscreen(false);
      return;
    }
    // Ctrl+= / Ctrl+- 调整字号
    if (terminalFullscreen && (e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      setTerminalFontSize((s) => Math.min(28, s + 1));
      return;
    }
    if (terminalFullscreen && (e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      setTerminalFontSize((s) => Math.max(10, s - 1));
      return;
    }
    // Ctrl+0 重置字号
    if (terminalFullscreen && (e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      setTerminalFontSize(12);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTerminalSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setShowHistory(false);
      if (commandHistory.length > 0) {
        const newIndex = historyIndex === -1 ? 0 : Math.min(historyIndex + 1, commandHistory.length - 1);
        setHistoryIndex(newIndex);
        setTerminalCommand(commandHistory[newIndex] || '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowHistory(false);
      if (historyIndex !== -1) {
        const newIndex = historyIndex - 1;
        setHistoryIndex(newIndex);
        setTerminalCommand(newIndex === -1 ? '' : commandHistory[newIndex] || '');
      }
    }
  };

  // 终端放大模式下 Ctrl+滚轮缩放字体（10-28px 临界值）
  useEffect(() => {
    if (!terminalFullscreen) return;
    const el = terminalOutputRef.current;
    if (!el) return;
    const onWheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 1 : -1;
      setTerminalFontSize((s) => Math.max(10, Math.min(28, s + delta)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [terminalFullscreen, setTerminalFontSize]);

  // 终端有新输出时自动滚动到底部
  useLayoutEffect(() => {
    const el = terminalOutputRef.current;
    const restore = terminalScrollRestoreRef.current;
    terminalScrollRestoreRef.current = null;
    if (!el) return;
    if (restore) {
      const maximum = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = restore.atBottom ? maximum : Math.min(Math.max(0, restore.top), maximum);
    } else el.scrollTop = el.scrollHeight;
  }, [terminalOutput, isExecuting, terminalFullscreen, showTerminal]);

  const clearTerminal = () => {
    setTerminalOutput([]);
    working.set('terminalOutputTruncated', false);
  };

  const handleTerminalFocus = () => {
    if (terminalCommand === '' && commandHistory.length > 0) {
      setShowHistory(true);
    }
  };

  const handleTerminalBlur = () => {
    setTimeout(() => setShowHistory(false), 200);
  };

  const isLoading = (key) => operationLoading?.[key] || false;

  const t = theme || themes.default;
  const scrcpyLoading = isLoading(`scrcpy_${device.id}`);

  return (
    <div data-accent={t.primary} data-dark={isDarkTheme(t)} data-density={deviceCardDensity} onClickCapture={event => {
      if (!event.target.closest('[data-device-pin]')) onSelectDevice?.();
    }} className={`device-card ${t.card} rounded-xl border shadow-sm overflow-hidden hover:shadow-md transition-shadow flex flex-col ${isActive ? 'ring-1 ring-emerald-500/50' : ''}`}>
      <DeviceCardHeader device={device} deviceName={deviceName} theme={t} isOnline={isOnline}
        isActive={isActive} isPinned={isPinned} scrcpyLoading={scrcpyLoading}
        isEditing={isEditing} editName={editName} onEditNameChange={setEditName}
        onEditNameKeyDown={handleNameKeyDown} onNameSubmit={handleNameSubmit}
        onBeginRename={() => { setEditName(deviceName || ''); setIsEditing(true); }}
        onSelectDevice={onSelectDevice} onTogglePin={onTogglePin} onDisconnect={onDisconnect} onStart={onStart} />

      <div className={`device-card-actions ${t.text}`}>
        {working.state.storageError && <div role="alert" className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
          {deviceWorkingErrorMessage(working.state.storageError)}<button type="button" onClick={working.retrySave} className="ml-2 underline">{tr('重试')}</button>
        </div>}
        {operationError && (
          <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-400">
            <span className="min-w-0 flex-1 break-words">{tr(operationError)}</span>
            <AiContextButton context={{ view: { origin: 'device-error', title: tr('设备操作错误'), question: tr('请根据这条界面错误说明可能原因和验证方向。'), text: String(operationError), deviceId: device.id } }} />
            <button type="button" onClick={onDismissOperationError} className="shrink-0 underline">{tr("收起")}</button>
          </div>
        )}
        {!isOnline && (
          <div role="status" className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600">
            <p>{deviceConnectionHint(device.status)}</p>
            <button type="button" onClick={onEnvironmentCheck} className="mt-1 underline underline-offset-2">{tr("打开环境自检")}</button>
          </div>
        )}
        <DeviceNavigationControls deviceId={device.id} isOnline={isOnline} showToast={showToast} theme={t} onOpenApps={onApkManager} />
        <section className="device-control-section" aria-label={tr("常用工具")}>
          <div className="device-control-toolbar"><h4 className={`device-control-heading ${t.textMuted}`}>{tr("常用工具")}</h4>
            {compact && <button type="button" aria-expanded={moreToolsOpen} onClick={() => working.set('moreToolsOpen', !moreToolsOpen)}
              className={`device-more-tools rounded border px-2 py-1 text-xs ${t.button.secondary}`}>{moreToolsOpen ? tr('收起更多工具') : tr('更多工具')}<ChevronDown size={12} className={moreToolsOpen ? 'rotate-180' : ''} /></button>}
          </div>
          <div className="device-tool-grid">
            {showSecondaryTools && onOpenReproduction && <ControlButton icon={<ClipboardCheck size={16} />} label={tr('复现采证')} onClick={() => onOpenReproduction(device.id)} disabled={!isOnline} theme={t} isOnline={isOnline} />}
            <ControlButton
              icon={<Camera size={16} />}
              label={isLoading(`screenshot_${device.id}`) ? tr("截图中...") : tr("截图")}
              onClick={onScreenshot}
              disabled={!isOnline || isLoading(`screenshot_${device.id}`) || harmony && device.capabilities?.screenshot === false}
              title={harmony && device.capabilities?.screenshot === false ? tr('此设备未提供 UITest 截图能力。') : undefined}
              loading={isLoading(`screenshot_${device.id}`)}
              theme={t}
              isOnline={isOnline}
            />
            <ControlButton
              icon={recordButton.recording ? <div className="w-3 h-3 rounded-sm bg-white" /> : <Video size={16} />}
              label={recordButton.label}
              onClick={recordButton.recording ? recording.stop : () => recording.start({ withLogs: recordWithLogs })}
              disabled={recordButton.disabled}
              loading={recordButton.busy}
              theme={t}
              isOnline={isOnline}
              isRecording={recordButton.recording}
            />
            {showSecondaryTools && <ControlButton
              icon={<ScrollText size={16} />}
              label={tr("设备日志")}
              onClick={() => onViewApplicationLogs({ deviceId: device.id })}
              disabled={!isOnline}
              theme={t}
              isOnline={isOnline}
            />}
            <ControlButton
              icon={<Package size={16} />}
              label={harmony ? tr('应用管理') : tr("APK管理")}
              onClick={onApkManager}
              disabled={!isOnline}
              theme={t}
              isOnline={isOnline}
            />
            <ControlButton
              icon={<Terminal size={16} />}
              label={tr("终端")}
              onClick={() => { terminalScrollRestoreRef.current = working.state.terminalScroll; setShowTerminal(true); }}
              disabled={!isOnline}
              theme={t}
              isOnline={isOnline}
            />
            {/* 设备巡检报告与证据包导出入口 */}
            {showSecondaryTools && <ControlButton
              icon={<ClipboardCheck size={16} />}
              label={tr("巡检")}
              onClick={() => setShowInspection(true)}
              disabled={!isOnline}
              theme={t}
              isOnline={isOnline}
            />}
            {showSecondaryTools && <ControlButton
              icon={<RotateCcw size={16} />}
              label={isLoading(`reboot_${device.id}`) ? tr("重启中...") : tr("重启")}
              onClick={onReboot}
              disabled={!isOnline || isLoading(`reboot_${device.id}`)}
              loading={isLoading(`reboot_${device.id}`)}
              theme={t}
              isOnline={isOnline}
            />}
          </div>
          {showSecondaryTools && <label className={`device-record-options mt-2 text-xs ${t.textMuted}`} title={tr("默认关闭。随录屏开始和停止抓取日志，最多保存 100 MB，不会请求 AI 分析。")}>
            <input type="checkbox" checked={recordingActive ? Boolean(recording.session?.withLogs) : recordWithLogs} disabled={recordingActive || recording.pending || !recording.loaded} onChange={event => setRecordWithLogs(event.target.checked)} className="accent-emerald-500" /><span className="device-record-options-label">{tr("录屏同时抓取日志")}</span><span className="device-record-options-note text-[11px] opacity-75">{tr("不调用 AI · 上限 100 MB")}</span>
          </label>}
          <DeviceRecordingStatus recording={recording} isOnline={isOnline} theme={t} showToast={showToast} />
        </section>
        {showSecondaryTools && <section className="device-control-section" aria-label={tr("设备维护")}>
          <button
            type="button"
            aria-expanded={maintenanceOpen}
            onClick={() => {
              const next = !maintenanceOpen;
              setMaintenanceOpen(next);
            }}
            className={`device-control-heading device-maintenance-toggle ${t.textMuted}`}
          >
            <ChevronDown size={14} className={maintenanceOpen ? '' : '-rotate-90'} />{tr("设备维护")}</button>
          {maintenanceOpen && <div className="device-tool-grid device-maintenance-grid">
            <ControlButton
              icon={<Shield size={16} />}
              label={isLoading(`root_${device.id}`) ? tr("Root中...") : 'Root'}
              onClick={onRoot}
              disabled={!isOnline || isLoading(`root_${device.id}`)}
              loading={isLoading(`root_${device.id}`)}
              theme={t}
              isOnline={isOnline}
            />
            <ControlButton
              icon={<Save size={16} />}
              label={isLoading(`remount_${device.id}`) ? tr("Remount中...") : 'Remount'}
              onClick={onRemount}
              disabled={!isOnline || isLoading(`remount_${device.id}`)}
              loading={isLoading(`remount_${device.id}`)}
              theme={t}
              isOnline={isOnline}
            />
            <ControlButton
              icon={<Loader size={16} />}
              label={isLoading(`loader_${device.id}`) ? tr("Loader中...") : 'Loader'}
              onClick={onRebootLoader}
              title={harmony ? tr('鸿蒙设备不使用 Android Loader / Fastboot 解锁流程。') : undefined}
              disabled={harmony || !isOnline || isLoading(`loader_${device.id}`)}
              loading={isLoading(`loader_${device.id}`)}
              theme={t}
              isOnline={isOnline}
            />
            <ControlButton
              icon={<Unlock size={16} />}
              label={isLoading(`unlock_${device.id}`) ? tr("Unlock中...") : 'Unlock'}
              onClick={onUnlock}
              title={harmony ? tr('鸿蒙设备不使用 Android Loader / Fastboot 解锁流程。') : undefined}
              disabled={harmony || !isOnline || isLoading(`unlock_${device.id}`)}
              loading={isLoading(`unlock_${device.id}`)}
              theme={t}
              isOnline={isOnline}
            />
          </div>}
        </section>}
        {showSecondaryTools && <DeviceRecentMedia deviceId={device.id} theme={t} showToast={showToast} />}
      </div>

      {/* App 包管理增强：使用独立面板承载安装、推送、文件浏览、应用列表与会员操作 */}
      {showApkManager && (
        <div style={{ order: getPanelOrder('apk') }}>
          <PackageManagerPanel
            device={device}
            theme={t}
            vipStatus={vipStatus}
            showToast={showToast}
            onOpenMemberCenter={onOpenMemberCenter}
            onInspectApplication={onInspectApplication}
            onViewApplicationLogs={onViewApplicationLogs}
            onSelectApkForInstall={onSelectApkForInstall}
            recentApks={recentApks}
            onSelectRecentApk={onSelectRecentApk}
            onSelectApkForPush={onSelectApkForPush}
            onInstallApk={onInstallApk}
            onPushApk={onPushApk}
            onBrowsePath={onBrowsePath}
            onPullFile={onPullFile}
            onPushPathChange={onPushPathChange}
            apkInstallPath={apkInstallPath}
            apkPushPath={apkPushPath}
            apkInstallResult={apkInstallResult}
            apkPushResult={apkPushResult}
            apkPushRemotePath={apkPushRemotePath}
            pushRemotePathHistory={pushRemotePathHistory}
            apkBrowserPath={apkBrowserPath}
            apkBrowserItems={apkBrowserItems}
            apkBrowserLoading={apkBrowserLoading}
            operationLoading={operationLoading}
          />
        </div>
      )}

      {/* APK Manager Section */}
      {showLegacyApkManager && showApkManager && (
        <div style={{ order: getPanelOrder('apk') }} className={`border-t p-4 ${isDarkTheme(t) ? 'bg-slate-800/30' : 'bg-slate-50'}`}>
          <h4 className={`text-sm font-semibold mb-3 flex items-center gap-2 ${t.text}`}>
            <Package size={16} />{tr("APK 管理")}</h4>

          {/* Install APK */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Download size={14} className={t.primary === 'cyan' || t.primary === 'blue' ? 'text-blue-500' : t.primary === 'pink' ? 'text-pink-500' : t.primary === 'green' ? 'text-green-500' : t.primary === 'orange' ? 'text-orange-500' : 'text-emerald-500'} />
              <span className={`text-sm font-medium ${t.text}`}>{tr("安装 APK")}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={apkInstallPath}
                readOnly
                placeholder={tr("点击选择 APK 文件...")}
                className={`flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
              />
              <button
                onClick={onSelectApkForInstall}
                disabled={isLoading(`install_${device.id}`)}
                className={`px-4 py-2 text-sm border rounded-lg transition-colors flex items-center gap-1 ${t.button.secondary}`}
              >
                <FolderOpen size={14} />{tr("选择")}</button>
              <button
                onClick={onInstallApk}
                disabled={!apkInstallPath || isLoading(`install_${device.id}`)}
                className={`px-4 py-2 text-sm rounded-lg transition-colors flex items-center gap-1 ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} disabled:opacity-50`}
              >
                {isLoading(`install_${device.id}`) ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Download size={14} />
                )}
                {isLoading(`install_${device.id}`) ? tr("安装中...") : tr("安装")}
              </button>
            </div>
          </div>

          {/* Push File */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Upload size={14} className={t.primary === 'cyan' || t.primary === 'blue' ? 'text-blue-500' : t.primary === 'pink' ? 'text-pink-500' : t.primary === 'green' ? 'text-green-500' : t.primary === 'orange' ? 'text-orange-500' : 'text-blue-500'} />
              <span className={`text-sm font-medium ${t.text}`}>{tr("推送文件到设备")}</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={apkPushPath}
                readOnly
                placeholder={tr("点击选择文件...")}
                className={`flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
              />
              <button
                onClick={onSelectApkForPush}
                disabled={isLoading(`push_${device.id}`)}
                className={`px-4 py-2 text-sm border rounded-lg transition-colors flex items-center gap-1 ${t.button.secondary}`}
              >
                <FolderOpen size={14} />{tr("选择")}</button>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={apkPushRemotePath}
                  onChange={(e) => onPushPathChange?.(e.target.value)}
                  aria-label={tr("设备推送目标路径")}
                  placeholder="/sdcard/"
                  readOnly={false}
                  className={`w-40 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white ${t.input}`}
                />
                {pushRemotePathHistory?.length > 0 && <SelectMenu
                  id={`legacy-push-path-history-${device.id}`}
                  value={apkPushRemotePath}
                  options={[...new Set(pushRemotePathHistory)].map(path => ({ value: path, label: path }))}
                  onChange={path => onPushPathChange?.(path)}
                  isDark={isDarkTheme(t)}
                  accent={t.primary}
                  placeholder={tr("历史路径")}
                  compact
                  className="w-36"
                />}
              </div>
              <button
                onClick={onPushApk}
                disabled={!apkPushPath || isLoading(`push_${device.id}`)}
                className={`px-4 py-2 text-sm rounded-lg transition-colors flex items-center gap-1 ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} disabled:opacity-50`}
              >
                {isLoading(`push_${device.id}`) ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Upload size={14} />
                )}
                {isLoading(`push_${device.id}`) ? tr("推送中...") : tr("推送")}
              </button>
            </div>
          </div>

          {/* Browse Device */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Folder size={14} className="text-purple-500" />
              <span className={`text-sm font-medium ${t.text}`}>{tr("浏览设备文件")}</span>
              <div className="flex items-center gap-1 ml-auto">
                <span className={`text-xs font-mono px-2 py-1 rounded select-all ${isDarkTheme(t) ? 'bg-[#3E4145] text-[#E8EAED]' : 'bg-slate-100 text-slate-600'}`}>{apkBrowserPath}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(apkBrowserPath);
                    showToast(tr("路径已复制: {0}", { 0: apkBrowserPath }));
                  }}
                  className={`p-1 transition-colors ${isDarkTheme(t) ? 'text-[#9AA0A6] hover:text-cyan-400' : 'text-[#9AA0A6] hover:text-emerald-500'}`}
                  title={tr("复制路径")}
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onBrowsePath?.('/')}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors ${t.button.secondary}`}
              >{tr("/ (根目录)")}</button>
              <button
                onClick={() => onBrowsePath?.('/system/app')}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors ${t.button.secondary}`}
              >
                /system/app
              </button>
            <button
                onClick={() => onBrowsePath?.('/system_ext/app')}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors ${t.button.secondary}`}
              >
                /system_ext/app
              </button>
              <button
                onClick={() => onBrowsePath?.('/data/app')}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors ${t.button.secondary}`}
              >
                /data/app
              </button>
            </div>

            {/* File List */}
            <div className={`mt-3 border rounded-lg max-h-48 overflow-y-auto ${isDarkTheme(t) ? 'bg-slate-800/50 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
              {apkBrowserLoading ? (
                <div className={`p-4 text-center text-sm ${isDarkTheme(t) ? 'text-[#9AA0A6]' : 'text-[#9AA0A6]'}`}>{tr("加载中...")}</div>
              ) : apkBrowserItems.length === 0 ? (
                <div className={`p-4 text-center text-sm ${isDarkTheme(t) ? 'text-[#9AA0A6]' : 'text-[#9AA0A6]'}`}>{tr("暂无文件")}</div>
              ) : (
                <div className={`divide-y ${isDarkTheme(t) ? 'divide-slate-700' : 'divide-slate-100'}`}>
                  {apkBrowserItems.map((item, index) => (
                    <div
                      key={index}
                      className={`px-3 py-2 flex items-center justify-between cursor-pointer group ${isDarkTheme(t) ? 'hover:bg-[#3E4145]' : 'hover:bg-slate-50'}`}
                      onClick={() => item.isDirectory && item.name !== '.' && onBrowsePath?.(item.path)}
                    >
                      <div className="flex items-center gap-2">
                        {item.name === '.' ? (
                          <ArrowLeft size={14} className="text-slate-400" />
                        ) : item.name === '..' ? (
                          <ArrowLeft size={14} className="text-blue-400" />
                        ) : item.isDirectory ? (
                          <Folder size={14} className="text-amber-500" />
                        ) : (
                          <File size={14} className="text-slate-400" />
                        )}
                        <span className={`text-sm ${item.name === '..' ? 'text-blue-500 font-medium' : item.name === '.' ? 'text-slate-400' : t.text}`}>
                          {item.name === '.' ? tr("当前目录") : item.name === '..' ? tr("上一级目录") : item.name}
                        </span>
                      </div>
                      {!item.isDirectory && item.name !== '.' && item.name !== '..' ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.path);
                              showToast(tr("路径已复制: {0}", { 0: item.path }));
                            }}
                            className={`px-2 py-1 text-xs border rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${t.button.secondary}`}
                            title={tr("复制路径")}
                          >
                            <Copy size={12} />{tr("复制")}</button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onPullFile?.(item.path);
                            }}
                            disabled={isLoading(`pull_${device.id}_${item.path}`)}
                            className={`px-2 py-1 text-xs border rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${t.button.secondary} disabled:opacity-50`}
                          >
                            {isLoading(`pull_${device.id}_${item.path}`) ? (
                              <RefreshCw size={12} className="animate-spin" />
                            ) : (
                              <Download size={12} />
                            )}
                            {isLoading(`pull_${device.id}_${item.path}`) ? tr("拉取中") : tr("拉取")}
                          </button>
                        </div>
                      ) : item.isDirectory ? (
                        item.name !== '.' && <ChevronRight size={14} className="text-slate-400" />
                      ) : (
                        <span className="text-xs text-slate-400">{item.size}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Terminal Section */}
      {showTerminal && (
        // 放大模式：fixed 全屏覆盖；普通模式：原位置 border-t
        <DeviceTerminalSurface fullscreen={terminalFullscreen}>
        <div ref={terminalPanelRef} style={{ order: getPanelOrder('terminal') }}
          role={terminalFullscreen ? 'dialog' : undefined} aria-modal={terminalFullscreen || undefined} aria-label={terminalFullscreen ? terminal.title : undefined}
          tabIndex={terminalFullscreen ? -1 : undefined}
          onKeyDown={event => {
            if (!terminalFullscreen || event.defaultPrevented) return;
            if (event.key === 'Escape') { event.preventDefault(); changeTerminalFullscreen(false); }
            else trapAppMessageFocus(event);
          }}
          className={`device-terminal-panel ${terminalFullscreen ? 'device-terminal-fullscreen' : 'border-t p-4'} ${t.terminal.bg}`}>
          <div className={`device-terminal-header mb-3 ${t.terminal.accent} ${terminalFullscreen ? 'pb-3 border-b border-[#3E4145]' : ''}`}>
            <div className="device-terminal-title">
              <Terminal size={16} />
              <span className="device-terminal-name text-sm font-medium" title={terminal.title}>{terminal.title}</span>
              {terminalFullscreen && (
                <span className="text-xs text-slate-500 ml-2">{tr("（放大模式 · 按 Esc 或点击还原返回 · Ctrl+滚轮缩放）")}</span>
              )}
            </div>
            <div className="device-terminal-actions">
              {/* 放大模式下显示字号控制 */}
              {terminalFullscreen && (
                <div className="flex items-center gap-1 px-2 py-1 text-xs bg-[#3E4145] rounded">
                  <button
                    onClick={() => setTerminalFontSize((s) => Math.max(10, s - 1))}
                    className="w-5 h-5 flex items-center justify-center hover:bg-[#5F6368] rounded text-[#E8EAED] disabled:opacity-30"
                    disabled={terminalFontSize <= 10}
                    title={tr("缩小 (Ctrl+-)")}
                  >
                    -
                  </button>
                  <span className="text-[#9AA0A6] w-10 text-center">{terminalFontSize}px</span>
                  <button
                    onClick={() => setTerminalFontSize((s) => Math.min(28, s + 1))}
                    className="w-5 h-5 flex items-center justify-center hover:bg-[#5F6368] rounded text-[#E8EAED] disabled:opacity-30"
                    disabled={terminalFontSize >= 28}
                    title={tr("放大 (Ctrl+=)")}
                  >
                    +
                  </button>
                  <button
                    onClick={() => setTerminalFontSize(12)}
                    className="px-1.5 h-5 flex items-center justify-center hover:bg-[#5F6368] rounded text-[#9AA0A6] text-[10px]"
                    title={tr("重置 (Ctrl+0)")}
                  >{tr("重置")}</button>
                </div>
              )}
              <button
                onClick={clearTerminal}
                className="px-2 py-1 text-xs bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] rounded transition-colors"
              >{tr("清空输出")}</button>
              {commandHistory.length > 0 && (
                <button
                  onClick={() => {
                    if (onClearTerminalHistory) {
                      onClearTerminalHistory();
                    }
                    setHistoryIndex(-1);
                    setShowHistory(false);
                  }}
                  className="px-2 py-1 text-xs bg-[#3E4145] hover:bg-red-900/50 text-[#E8EAED] hover:text-red-400 rounded transition-colors flex items-center gap-1"
                >
                  <RotateCcw size={10} />{tr("清空历史命令")}</button>
              )}
              {/* 放大 / 还原按钮 */}
              <button
                ref={terminalExpandRef}
                onClick={() => changeTerminalFullscreen(!terminalFullscreen)}
                className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-[#3E4145] rounded transition-colors"
                title={terminalFullscreen ? tr("还原") : tr("放大")}
                aria-label={terminalFullscreen ? tr("还原") : tr("放大")}
              >
                {terminalFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                aria-label={tr("关闭")}
                onClick={() => {
                  setShowTerminal(false);
                  setTerminalFullscreen(false);
                  setHistoryIndex(-1);
                  setShowHistory(false);
                }}
                className="p-1 text-slate-400 hover:text-red-400 transition-colors"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Terminal Output - 放大模式下 flex-1 撑满，支持 Ctrl+滚轮缩放 */}
          <div
            ref={terminalOutputRef}
            onScroll={event => {
              const output = event.currentTarget;
              working.set('terminalScroll', { top: output.scrollTop,
                atBottom: output.scrollHeight - output.clientHeight - output.scrollTop <= 2 }, { silent: true });
            }}
            style={{ fontSize: `${terminalFontSize}px` }}
            className={`device-terminal-output ${t.terminal.output} rounded-lg p-3 mb-3 overflow-y-auto font-mono select-text border border-[#3E4145] ${terminalFullscreen ? 'flex-1' : 'h-56'}`}
          >
            {terminalOutput.length === 0 ? (
              <div className="flex items-center gap-2 text-slate-500 select-text py-2">
                <Terminal size={14} className="opacity-50" />
                <span>{tr("输入命令并按 Enter 执行...")}</span>
              </div>
            ) : (
              <div className="space-y-0.5">
                {visibleOutput.rows.map((line, index) => {
                  const isCmd = line.type === 'command';
                  const isErr = line.type === 'error';
                  return (
                    <div
                      key={index}
                      className={`flex items-start gap-2 px-2 py-1 rounded select-text transition-colors hover:bg-white/5 ${
                        isCmd ? 'bg-cyan-500/5' : isErr ? 'bg-red-500/5' : ''
                      }`}
                    >
                      {/* 行号 */}
                      <span className="text-slate-600 select-none text-[10px] mt-0.5 w-6 text-right shrink-0">
                        {String(line.position).padStart(2, '0')}
                      </span>
                      {/* 类型标记 */}
                      <span className={`select-none shrink-0 text-[10px] mt-0.5 w-4 ${
                        isCmd ? 'text-cyan-400' : isErr ? 'text-red-400' : 'text-slate-500'
                      }`}>
                        {isCmd ? line.prompt || '$' : isErr ? '!' : '›'}
                      </span>
                      {/* 内容 */}
                      <span className={`flex-1 break-all whitespace-pre-wrap ${
                        isCmd ? 'text-cyan-300 font-semibold' : isErr ? 'text-red-400' : 'text-slate-300'
                      }`}>
                        {line.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            {isExecuting && (
              <div className="flex items-center gap-2 px-2 py-1 text-amber-400 animate-pulse select-text">
                <Loader2 size={12} className="animate-spin" />
                <span className="text-xs">{tr("执行中...")}</span>
              </div>
            )}
          </div>

          <p className="mb-2 text-[11px] text-slate-500">{tr('终端输出仅在本次运行中保留，重启后不会恢复或自动执行命令。')}</p>
          {(working.state.terminalOutputTruncated || visibleOutput.clipped) && <p role="status" className="mb-2 text-xs text-amber-500">
            {working.state.terminalOutputTruncated ? tr('较早的终端输出已按内存上限清理。') : tr('仅显示最近的部分输出，较早内容仍在本次运行的缓冲中。')}
          </p>}
          {working.state.draftNotSaved && <p role="status" className="mb-2 text-xs text-amber-500">{tr('终端草稿超过 {0} 字符，仅在本次运行中保留。', { 0: DEVICE_WORKING_LIMITS.draft })}</p>}

          {/* Terminal Input */}
          <form onSubmit={handleTerminalSubmit} className="device-terminal-input">
            <span className={`font-mono text-sm transition-colors ${suMode ? 'text-red-400' : 'text-emerald-400'}`} title={suMode ? tr("ROOT 模式") : tr("普通模式")}>{suMode ? '#' : '$'}</span>
            <div className="device-terminal-input-field relative">
              <input
                ref={terminalInputRef}
                type="text"
                data-terminal-command
                value={terminalCommand}
                onChange={(e) => setTerminalCommand(e.target.value)}
                onKeyDown={handleTerminalKeyDown}
                onFocus={handleTerminalFocus}
                onBlur={handleTerminalBlur}
                disabled={isExecuting || !isOnline}
                placeholder={terminal.placeholder}
                className={`w-full px-3 py-2 pr-16 border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 ${suMode ? 'focus:ring-red-500 focus:border-red-500' : 'focus:ring-emerald-500 focus:border-emerald-500'} placeholder-slate-500 disabled:opacity-50 ${t.terminal.bg.replace('bg-', 'bg-').replace('gradient-to-br', 'bg-').includes('gradient') ? 'bg-[#2D2F33] border-[#3E4145] text-[#E8EAED]' : t.terminal.text.includes('300') ? 'bg-[#2D2F33] border-[#3E4145] text-[#E8EAED]' : 'bg-[#202124] border-[#3E4145] text-[#E8EAED]'}`}
              />
              {/* SU 模式开关：紧凑胶囊，内嵌输入框右侧，不额外占行 */}
              <button
                type="button"
                ref={terminalRootRef}
                onClick={toggleSuMode}
                disabled={!isOnline || isExecuting || suChecking}
                title={terminal.rootTitle}
                className={`absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all disabled:opacity-40 ${
                  suMode
                    ? 'bg-red-500/20 text-red-400 border-red-500/40 shadow-[0_0_8px_-2px] shadow-red-500/40'
                    : 'bg-[#3E4145]/60 text-slate-400 border-[#5F6368] hover:text-red-400 hover:border-red-500/40'
                }`}
              >
                {suChecking ? <Loader2 size={10} className="animate-spin" /> : <Shield size={10} />}
                {harmony ? 'ROOT' : 'SU'}
              </button>
              {showHistory && commandHistory.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-[#2D2F33] border border-[#3E4145] rounded-lg overflow-hidden shadow-lg max-h-40 overflow-y-auto z-50">
                  <div className="px-3 py-1 text-xs text-slate-500 border-b border-[#3E4145] flex items-center justify-between">
                    <span>{tr("历史命令")}</span>
                    <span>{commandHistory.length}/100</span>
                  </div>
                  {commandHistory.slice(0, 10).map((cmd, index) => (
                    <button
                      key={index}
                      type="button"
                      onClick={() => {
                        setTerminalCommand(cmd);
                        setShowHistory(false);
                      }}
                      className="w-full px-3 py-1.5 text-left text-sm text-[#E8EAED] hover:bg-[#3E4145] font-mono truncate"
                    >
                      {cmd}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {isExecuting ? (
              <button
                type="button"
                onClick={handleCancelExecute}
                title={tr("中断当前命令")}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
              >
                <X size={14} />{tr("停止")}</button>
            ) : (
              <button
                type="submit"
                disabled={!terminalCommand.trim() || !isOnline}
                className={`${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 disabled:opacity-50`}
              >
                <Send size={14} />{tr("执行")}</button>
            )}
          </form>

          {/* Quick Commands */}
          <div className="device-terminal-quick-commands mt-3 flex flex-wrap gap-2">
            <span className="text-xs text-slate-500">{tr("快捷命令:")}</span>
            {terminalCommands.map((cmd) => (
              <button
                key={cmd}
                type="button"
                disabled={isExecuting || !isOnline}
                onClick={() => {
                  setTerminalCommand(cmd);
                }}
                className="px-2 py-1 text-xs bg-[#2D2F33] hover:bg-[#3E4145] text-[#9AA0A6] hover:text-[#E8EAED] rounded transition-colors font-mono disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cmd}
              </button>
            ))}
          </div>
        </div>
        </DeviceTerminalSurface>
      )}
      {/* 设备巡检报告与证据包导出面板 */}
      <InspectionPanel
        open={showInspection}
        device={device}
        theme={t}
        vipStatus={vipStatus}
        inspectionPath={inspectionPath}
        onInspectionPathChange={onInspectionPathChange}
        onClose={() => setShowInspection(false)}
        onOpenMemberCenter={onOpenMemberCenter}
        showToast={showToast}
      />
      {/* SU 不支持提醒：设备未获取 root 权限或未授权 su */}
      <DangerConfirmModal
        open={suUnsupportedOpen}
        theme={t}
        title={terminal.rootWarning.title}
        message={terminal.rootWarning.message}
        bullets={terminal.rootWarning.bullets}
        detail={terminal.rootWarning.detail}
        confirmLabel={tr("知道了")}
        cancelLabel={tr("关闭")}
        tone="warning"
        onCancel={closeSuWarning}
        onConfirm={closeSuWarning}
      />
    </div>
  );
}

export default DeviceCard;
