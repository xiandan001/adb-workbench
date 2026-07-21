import { useState, useEffect, useRef } from 'react';
import { Smartphone, Unplug, Play, Camera, Video, Volume2, VolumeX, Shield, Save, RotateCcw, Loader, Unlock, Package, Terminal, Pencil, Download, Upload, FolderOpen, Folder, File, ChevronRight, ArrowLeft, Copy, RefreshCw, Send, Loader2, Maximize2, Minimize2, X, ClipboardCheck } from 'lucide-react';
import themes from '../data/themes';
import ControlButton from './ControlButton';
// 设备巡检面板：采集逻辑在主进程 inspection 模块中
import InspectionPanel from './InspectionPanel';
// App 包管理增强面板
import PackageManagerPanel from './PackageManagerPanel';
// 通用危险确认弹窗（用于 su 不支持等提醒）
import DangerConfirmModal from './DangerConfirmModal';

function DeviceCard({ device, deviceName, onNameChange, onStart, onCommand, onScreenshot, onScreenRecordStart, onScreenRecordStop, onReboot, onRebootLoader, onUnlock, onRoot, onRemount, onDisconnect, showApkManager, onApkManager, onSelectApkForInstall, onSelectApkForPush, onInstallApk, onPushApk, onBrowsePath, onPullFile, onPushPathChange, showToast, apkInstallPath, apkPushPath, apkInstallResult, apkPushResult, apkPushRemotePath, pushRemotePathHistory, apkBrowserPath, apkBrowserItems, apkBrowserLoading, operationLoading, onExecuteCommand, theme, sharedCommandHistory, onSaveTerminalCommand, onClearTerminalHistory, vipStatus, inspectionPath, onInspectionPathChange, onOpenMemberCenter }) {
  const isOnline = device.status === 'device';
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(deviceName || '');
  const [showTerminal, setShowTerminal] = useState(false);
  // 终端放大模式：脱离原位置，全屏覆盖
  const [terminalFullscreen, setTerminalFullscreen] = useState(false);
  // 终端字体大小（Ctrl+滚轮缩放，范围 10-28px）
  const [terminalFontSize, setTerminalFontSize] = useState(12);
  const terminalOutputRef = useRef(null);
  const [terminalCommand, setTerminalCommand] = useState('');
  const [terminalOutput, setTerminalOutput] = useState([]);
  const [panelOrder, setPanelOrder] = useState([]);
  const [isExecuting, setIsExecuting] = useState(false);
  // SU 提权模式：开启后命令以 root 身份执行
  const [suMode, setSuMode] = useState(false);
  // 提权策略：'direct'=adb root 已生效（命令本身是 root）；'su'=需 su -c 包装
  const [suStrategy, setSuStrategy] = useState('none');
  const [suChecking, setSuChecking] = useState(false);
  // su 不支持时的提醒弹窗
  const [suUnsupportedOpen, setSuUnsupportedOpen] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showHistory, setShowHistory] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isSavingRecord, setIsSavingRecord] = useState(false);
  // 设备巡检弹窗状态
  const [showInspection, setShowInspection] = useState(false);
  const commandHistory = sharedCommandHistory || [];
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
  }, [showApkManager, showTerminal]);

  const getPanelOrder = (panel) => {
    const index = panelOrder.indexOf(panel);
    return index === -1 ? 20 : 10 + index;
  };

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
    if (!terminalCommand.trim() || isExecuting) return;

    setIsExecuting(true);
    setShowHistory(false);
    const rawCmd = terminalCommand.trim();
    // 根据当前提权策略包装命令（direct 策略下无需包装，shell 已是 root）
    // 用单引号包裹内部命令，避免与 adb shell 外层传递时的双引号嵌套冲突
    const escaped = rawCmd.replace(/'/g, "'\\''");
    const finalCmd = !suMode ? rawCmd
      : suStrategy === 'su-c' ? `su -c '${escaped}'`
      : suStrategy === 'su-sh' ? `su 0 sh -c '${escaped}'`
      : rawCmd;
    setTerminalOutput(prev => [...prev, { type: 'command', text: `${suMode ? '#' : '$'} adb -s ${device.id} shell "${finalCmd}"` }]);
    setTerminalCommand('');
    setHistoryIndex(-1);
    if (onSaveTerminalCommand) {
      onSaveTerminalCommand(rawCmd);
    }

    try {
      if (onExecuteCommand) {
        const result = await onExecuteCommand(device.id, finalCmd);
        setTerminalOutput(prev => [...prev, { type: 'output', text: result }]);
      }
    } catch (err) {
      setTerminalOutput(prev => [...prev, { type: 'error', text: `Error: ${err.message}` }]);
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
      setTerminalFullscreen(false);
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
  }, [terminalFullscreen]);

  // 终端有新输出时自动滚动到底部
  useEffect(() => {
    const el = terminalOutputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [terminalOutput, isExecuting]);

  const clearTerminal = () => {
    setTerminalOutput([]);
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
    <div className={`${t.card} rounded-xl border shadow-sm overflow-hidden hover:shadow-md transition-shadow flex flex-col`}>
      <div className={`p-5 border-b flex justify-between items-start ${t.header.replace('border-b', 'border-b')}`}>
        <div className="flex items-center space-x-4">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${isOnline ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-blue-100 text-blue-600' : t.primary === 'pink' ? 'bg-pink-100 text-pink-600' : t.primary === 'green' ? 'bg-green-100 text-green-600' : t.primary === 'orange' ? 'bg-orange-100 text-orange-600' : 'bg-emerald-100 text-emerald-600'}` : 'bg-slate-100 text-slate-400'}`}>
            <Smartphone size={24} />
          </div>
          <div>
            {isEditing ? (
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={handleNameKeyDown}
                  onBlur={handleNameSubmit}
                  autoFocus
                  className="px-2 py-1 text-sm border border-emerald-400 rounded focus:outline-none focus:ring-1 focus:ring-emerald-500 w-32"
                  placeholder="输入设备名称"
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <h3 className={`text-lg font-bold ${t.text.replace('text-slate-700', 'text-slate-800').replace('text-pink-700', 'text-pink-800').replace('text-[#E8EAED]', 'text-[#E8EAED]')}`}>
                  {deviceName || device.model || '未知设备'}
                </h3>
                <button
                  onClick={() => {
                    setEditName(deviceName || '');
                    setIsEditing(true);
                  }}
                  className="p-1 text-slate-400 hover:text-emerald-500 transition-colors"
                  title="编辑名称"
                >
                  <Pencil size={14} />
                </button>
              </div>
            )}
            <div className="flex items-center space-x-2 mt-1">
              <span className={`w-2 h-2 rounded-full ${isOnline ? (t.primary === 'cyan' || t.primary === 'blue' ? 'bg-blue-500' : t.primary === 'pink' ? 'bg-pink-500' : t.primary === 'green' ? 'bg-green-500' : t.primary === 'orange' ? 'bg-orange-500' : 'bg-emerald-500') : 'bg-slate-300'}`}></span>
              <span className={`text-sm font-mono ${t.textMuted}`}>{device.id}</span>
              <span className={`text-xs px-2 py-0.5 rounded-full ${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-blue-100 text-blue-600' : t.primary === 'pink' ? 'bg-pink-100 text-pink-600' : t.primary === 'green' ? 'bg-green-100 text-green-600' : t.primary === 'orange' ? 'bg-orange-100 text-orange-600' : 'bg-slate-100 text-slate-600'} capitalize`}>
                {device.status === 'device' ? '在线' : device.status}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onDisconnect}
            title="断开设备"
            className="p-2 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
          >
            <Unplug size={20} />
          </button>
          <button
            onClick={onStart}
            disabled={!isOnline || scrcpyLoading}
            className={`${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} disabled:opacity-50 disabled:cursor-not-allowed min-w-[120px] px-5 py-2.5 rounded-lg font-medium flex items-center justify-center space-x-2 transition-colors`}
          >
            {scrcpyLoading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
            <span>{scrcpyLoading ? '启动中...' : '开始投屏'}</span>
          </button>
        </div>
      </div>

      <div className={`px-5 py-4 flex flex-wrap gap-2 ${t.primary === 'tech' ? 'bg-slate-800/50' : 'bg-slate-50'}`}>
        <ControlButton
          icon={<Camera size={16} />}
          label={isLoading(`screenshot_${device.id}`) ? '截图中...' : '截图'}
          onClick={onScreenshot}
          disabled={!isOnline || isLoading(`screenshot_${device.id}`)}
          loading={isLoading(`screenshot_${device.id}`)}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={isRecording ? <div className="w-4 h-4 rounded-full bg-red-700 shadow-sm shadow-red-900/30" /> : <Video size={16} />}
          label={isSavingRecord ? '保存中...' : isRecording ? '停止录屏' : '录屏'}
          onClick={async () => {
            if (isRecording) {
              setIsSavingRecord(true);
              const res = await onScreenRecordStop(device.id);
              setIsSavingRecord(false);
              if (res.success) {
                setIsRecording(false);
                showToast(`录屏已保存: ${res.path}`);
              } else {
                showToast(`录屏停止失败: ${res.error}`);
              }
            } else {
              const res = await onScreenRecordStart(device.id);
              if (res.success) {
                setIsRecording(true);
                showToast('录屏已开始');
              } else {
                showToast(`录屏启动失败: ${res.error}`);
              }
            }
          }}
          disabled={!isOnline || isSavingRecord}
          theme={t}
          isOnline={isOnline}
          isRecording={isRecording}
          isSaving={isSavingRecord}
        />
        <ControlButton
          icon={<Volume2 size={16} />}
          label="音量+"
          onClick={() => onCommand('input keyevent 24')}
          disabled={!isOnline}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<VolumeX size={16} />}
          label="音量-"
          onClick={() => onCommand('input keyevent 25')}
          disabled={!isOnline}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<Shield size={16} />}
          label={isLoading(`root_${device.id}`) ? 'Root中...' : 'Root'}
          onClick={onRoot}
          disabled={!isOnline || isLoading(`root_${device.id}`)}
          loading={isLoading(`root_${device.id}`)}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<Save size={16} />}
          label={isLoading(`remount_${device.id}`) ? 'Remount中...' : 'Remount'}
          onClick={onRemount}
          disabled={!isOnline || isLoading(`remount_${device.id}`)}
          loading={isLoading(`remount_${device.id}`)}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<RotateCcw size={16} />}
          label={isLoading(`reboot_${device.id}`) ? '重启中...' : '重启'}
          onClick={onReboot}
          disabled={!isOnline || isLoading(`reboot_${device.id}`)}
          loading={isLoading(`reboot_${device.id}`)}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<Loader size={16} />}
          label={isLoading(`loader_${device.id}`) ? 'Loader中...' : 'Loader'}
          onClick={onRebootLoader}
          disabled={!isOnline || isLoading(`loader_${device.id}`)}
          loading={isLoading(`loader_${device.id}`)}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<Unlock size={16} />}
          label={isLoading(`unlock_${device.id}`) ? 'Unlock中...' : 'Unlock'}
          onClick={onUnlock}
          disabled={!isOnline || isLoading(`unlock_${device.id}`)}
          loading={isLoading(`unlock_${device.id}`)}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<Package size={16} />}
          label="APK管理"
          onClick={onApkManager}
          disabled={!isOnline}
          theme={t}
          isOnline={isOnline}
        />
        <ControlButton
          icon={<Terminal size={16} />}
          label="终端"
          onClick={() => setShowTerminal(true)}
          disabled={!isOnline}
          theme={t}
          isOnline={isOnline}
        />
        {/* 设备巡检报告与证据包导出入口 */}
        <ControlButton
          icon={<ClipboardCheck size={16} />}
          label="巡检"
          onClick={() => setShowInspection(true)}
          disabled={!isOnline}
          theme={t}
          isOnline={isOnline}
        />
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
            onSelectApkForInstall={onSelectApkForInstall}
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
        <div style={{ order: getPanelOrder('apk') }} className={`border-t p-4 ${t.primary === 'tech' ? 'bg-slate-800/30' : 'bg-slate-50'}`}>
          <h4 className={`text-sm font-semibold mb-3 flex items-center gap-2 ${t.text}`}>
            <Package size={16} />
            APK 管理
          </h4>

          {/* Install APK */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Download size={14} className={t.primary === 'cyan' || t.primary === 'blue' ? 'text-blue-500' : t.primary === 'pink' ? 'text-pink-500' : t.primary === 'green' ? 'text-green-500' : t.primary === 'orange' ? 'text-orange-500' : 'text-emerald-500'} />
              <span className={`text-sm font-medium ${t.text}`}>安装 APK</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={apkInstallPath}
                readOnly
                placeholder="点击选择 APK 文件..."
                className={`flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
              />
              <button
                onClick={onSelectApkForInstall}
                disabled={isLoading(`install_${device.id}`)}
                className={`px-4 py-2 text-sm border rounded-lg transition-colors flex items-center gap-1 ${t.button.secondary}`}
              >
                <FolderOpen size={14} />
                选择
              </button>
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
                {isLoading(`install_${device.id}`) ? '安装中...' : '安装'}
              </button>
            </div>
          </div>

          {/* Push File */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <Upload size={14} className={t.primary === 'cyan' || t.primary === 'blue' ? 'text-blue-500' : t.primary === 'pink' ? 'text-pink-500' : t.primary === 'green' ? 'text-green-500' : t.primary === 'orange' ? 'text-orange-500' : 'text-blue-500'} />
              <span className={`text-sm font-medium ${t.text}`}>推送文件到设备</span>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={apkPushPath}
                readOnly
                placeholder="点击选择文件..."
                className={`flex-1 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 ${t.input}`}
              />
              <button
                onClick={onSelectApkForPush}
                disabled={isLoading(`push_${device.id}`)}
                className={`px-4 py-2 text-sm border rounded-lg transition-colors flex items-center gap-1 ${t.button.secondary}`}
              >
                <FolderOpen size={14} />
                选择
              </button>
              <div className="relative">
                <input
                  type="text"
                  value={apkPushRemotePath}
                  onChange={(e) => onPushPathChange?.(e.target.value)}
                  list={`push-remote-path-history-${device.id}`}
                  placeholder="/sdcard/"
                  readOnly={false}
                  className={`w-40 px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500 bg-white ${t.input}`}
                />
                <datalist id={`push-remote-path-history-${device.id}`}>
                  {(pushRemotePathHistory || []).map((path, idx) => (
                    <option key={idx} value={path} />
                  ))}
                </datalist>
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
                {isLoading(`push_${device.id}`) ? '推送中...' : '推送'}
              </button>
            </div>
          </div>

          {/* Browse Device */}
          <div>
            <div className="flex items-center gap-2 mb-2">
              <Folder size={14} className="text-purple-500" />
              <span className={`text-sm font-medium ${t.text}`}>浏览设备文件</span>
              <div className="flex items-center gap-1 ml-auto">
                <span className={`text-xs font-mono px-2 py-1 rounded select-all ${t.primary === 'tech' ? 'bg-[#3E4145] text-[#E8EAED]' : 'bg-slate-100 text-slate-600'}`}>{apkBrowserPath}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(apkBrowserPath);
                    showToast(`路径已复制: ${apkBrowserPath}`);
                  }}
                  className={`p-1 transition-colors ${t.primary === 'tech' ? 'text-[#9AA0A6] hover:text-cyan-400' : 'text-[#9AA0A6] hover:text-emerald-500'}`}
                  title="复制路径"
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => onBrowsePath?.('/')}
                className={`px-3 py-2 text-sm border rounded-lg transition-colors ${t.button.secondary}`}
              >
                / (根目录)
              </button>
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
            <div className={`mt-3 border rounded-lg max-h-48 overflow-y-auto ${t.primary === 'tech' ? 'bg-slate-800/50 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
              {apkBrowserLoading ? (
                <div className={`p-4 text-center text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#9AA0A6]'}`}>加载中...</div>
              ) : apkBrowserItems.length === 0 ? (
                <div className={`p-4 text-center text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#9AA0A6]'}`}>暂无文件</div>
              ) : (
                <div className={`divide-y ${t.primary === 'tech' ? 'divide-slate-700' : 'divide-slate-100'}`}>
                  {apkBrowserItems.map((item, index) => (
                    <div
                      key={index}
                      className={`px-3 py-2 flex items-center justify-between cursor-pointer group ${t.primary === 'tech' ? 'hover:bg-[#3E4145]' : 'hover:bg-slate-50'}`}
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
                          {item.name === '.' ? '当前目录' : item.name === '..' ? '上一级目录' : item.name}
                        </span>
                      </div>
                      {!item.isDirectory && item.name !== '.' && item.name !== '..' ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(item.path);
                              showToast(`路径已复制: ${item.path}`);
                            }}
                            className={`px-2 py-1 text-xs border rounded opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 ${t.button.secondary}`}
                            title="复制路径"
                          >
                            <Copy size={12} />
                            复制
                          </button>
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
                            {isLoading(`pull_${device.id}_${item.path}`) ? '拉取中' : '拉取'}
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
        <div style={{ order: getPanelOrder('terminal') }} className={`${terminalFullscreen ? 'fixed inset-0 z-50 p-6 flex flex-col' : `border-t p-4`} ${t.terminal.bg}`}>
          <div className={`flex items-center justify-between mb-3 ${t.terminal.accent} ${terminalFullscreen ? 'pb-3 border-b border-[#3E4145]' : ''}`}>
            <div className="flex items-center gap-2">
              <Terminal size={16} />
              <span className="text-sm font-medium">终端 - {device.id}</span>
              {terminalFullscreen && (
                <span className="text-xs text-slate-500 ml-2">（放大模式 · 按 Esc 或点击还原返回 · Ctrl+滚轮缩放）</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* 放大模式下显示字号控制 */}
              {terminalFullscreen && (
                <div className="flex items-center gap-1 px-2 py-1 text-xs bg-[#3E4145] rounded">
                  <button
                    onClick={() => setTerminalFontSize((s) => Math.max(10, s - 1))}
                    className="w-5 h-5 flex items-center justify-center hover:bg-[#5F6368] rounded text-[#E8EAED] disabled:opacity-30"
                    disabled={terminalFontSize <= 10}
                    title="缩小 (Ctrl+-)"
                  >
                    -
                  </button>
                  <span className="text-[#9AA0A6] w-10 text-center">{terminalFontSize}px</span>
                  <button
                    onClick={() => setTerminalFontSize((s) => Math.min(28, s + 1))}
                    className="w-5 h-5 flex items-center justify-center hover:bg-[#5F6368] rounded text-[#E8EAED] disabled:opacity-30"
                    disabled={terminalFontSize >= 28}
                    title="放大 (Ctrl+=)"
                  >
                    +
                  </button>
                  <button
                    onClick={() => setTerminalFontSize(12)}
                    className="px-1.5 h-5 flex items-center justify-center hover:bg-[#5F6368] rounded text-[#9AA0A6] text-[10px]"
                    title="重置 (Ctrl+0)"
                  >
                    重置
                  </button>
                </div>
              )}
              <button
                onClick={clearTerminal}
                className="px-2 py-1 text-xs bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] rounded transition-colors"
              >
                清空输出
              </button>
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
                  <RotateCcw size={10} />
                  清空历史命令
                </button>
              )}
              {/* 放大 / 还原按钮 */}
              <button
                onClick={() => setTerminalFullscreen((v) => !v)}
                className="p-1.5 text-slate-400 hover:text-cyan-400 hover:bg-[#3E4145] rounded transition-colors"
                title={terminalFullscreen ? '还原' : '放大'}
              >
                {terminalFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
              <button
                onClick={() => {
                  setShowTerminal(false);
                  setTerminalFullscreen(false);
                  setTerminalOutput([]);
                  setTerminalCommand('');
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
            style={{ fontSize: `${terminalFontSize}px` }}
            className={`${t.terminal.output} rounded-lg p-3 mb-3 overflow-y-auto font-mono select-text border border-[#3E4145] ${terminalFullscreen ? 'flex-1' : 'h-56'}`}
          >
            {terminalOutput.length === 0 ? (
              <div className="flex items-center gap-2 text-slate-500 select-text py-2">
                <Terminal size={14} className="opacity-50" />
                <span>输入命令并按 Enter 执行...</span>
              </div>
            ) : (
              <div className="space-y-0.5">
                {terminalOutput.map((line, index) => {
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
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      {/* 类型标记 */}
                      <span className={`select-none shrink-0 text-[10px] mt-0.5 w-4 ${
                        isCmd ? 'text-cyan-400' : isErr ? 'text-red-400' : 'text-slate-500'
                      }`}>
                        {isCmd ? '$' : isErr ? '!' : '›'}
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
                <span className="text-xs">执行中...</span>
              </div>
            )}
          </div>

          {/* Terminal Input */}
          <form onSubmit={handleTerminalSubmit} className="flex items-center gap-2">
            <span className={`font-mono text-sm transition-colors ${suMode ? 'text-red-400' : 'text-emerald-400'}`} title={suMode ? 'ROOT 模式' : '普通模式'}>{suMode ? '#' : '$'}</span>
            <div className="flex-1 relative">
              <input
                type="text"
                value={terminalCommand}
                onChange={(e) => setTerminalCommand(e.target.value)}
                onKeyDown={handleTerminalKeyDown}
                onFocus={handleTerminalFocus}
                onBlur={handleTerminalBlur}
                disabled={isExecuting || !isOnline}
                placeholder={suMode ? '以 ROOT 身份执行命令...' : '输入 ADB Shell 命令...'}
                className={`w-full px-3 py-2 pr-16 border rounded-lg font-mono text-sm focus:outline-none focus:ring-2 ${suMode ? 'focus:ring-red-500 focus:border-red-500' : 'focus:ring-emerald-500 focus:border-emerald-500'} placeholder-slate-500 disabled:opacity-50 ${t.terminal.bg.replace('bg-', 'bg-').replace('gradient-to-br', 'bg-').includes('gradient') ? 'bg-[#2D2F33] border-[#3E4145] text-[#E8EAED]' : t.terminal.text.includes('300') ? 'bg-[#2D2F33] border-[#3E4145] text-[#E8EAED]' : 'bg-[#202124] border-[#3E4145] text-[#E8EAED]'}`}
              />
              {/* SU 模式开关：紧凑胶囊，内嵌输入框右侧，不额外占行 */}
              <button
                type="button"
                onClick={toggleSuMode}
                disabled={!isOnline || isExecuting || suChecking}
                title={suMode ? '已开启 ROOT 模式，点击关闭' : '开启 ROOT 模式'}
                className={`absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border transition-all disabled:opacity-40 ${
                  suMode
                    ? 'bg-red-500/20 text-red-400 border-red-500/40 shadow-[0_0_8px_-2px] shadow-red-500/40'
                    : 'bg-[#3E4145]/60 text-slate-400 border-[#5F6368] hover:text-red-400 hover:border-red-500/40'
                }`}
              >
                {suChecking ? <Loader2 size={10} className="animate-spin" /> : <Shield size={10} />}
                SU
              </button>
              {showHistory && commandHistory.length > 0 && (
                <div className="absolute bottom-full left-0 right-0 mb-1 bg-[#2D2F33] border border-[#3E4145] rounded-lg overflow-hidden shadow-lg max-h-40 overflow-y-auto z-50">
                  <div className="px-3 py-1 text-xs text-slate-500 border-b border-[#3E4145] flex items-center justify-between">
                    <span>历史命令</span>
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
                title="中断当前命令"
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 bg-red-500/20 text-red-400 hover:bg-red-500/30 border border-red-500/30"
              >
                <X size={14} />
                停止
              </button>
            ) : (
              <button
                type="submit"
                disabled={!terminalCommand.trim() || !isOnline}
                className={`${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-1 disabled:opacity-50`}
              >
                <Send size={14} />
                执行
              </button>
            )}
          </form>

          {/* Quick Commands */}
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="text-xs text-slate-500">快捷命令:</span>
            {['pm list packages', 'getprop ro.build.version', 'dumpsys battery', 'cat /proc/meminfo', 'ls -la /data/'].map((cmd) => (
              <button
                key={cmd}
                onClick={() => {
                  setTerminalCommand(cmd);
                }}
                className="px-2 py-1 text-xs bg-[#2D2F33] hover:bg-[#3E4145] text-[#9AA0A6] hover:text-[#E8EAED] rounded transition-colors font-mono"
              >
                {cmd}
              </button>
            ))}
          </div>
        </div>
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
        title="设备暂不支持 su 命令"
        message="检测到当前设备无法以 root 身份执行命令，可能原因："
        bullets={[
          '设备未 Root 或未安装权限管理（如 Magisk）',
          '已 Root 但未给 ADB Shell 授权',
          '使用了受限用户版本的系统镜像'
        ]}
        detail="请先完成 Root 并在设备端授权后，再开启 ROOT 模式。"
        confirmLabel="知道了"
        cancelLabel="关闭"
        tone="warning"
        onCancel={() => setSuUnsupportedOpen(false)}
        onConfirm={() => setSuUnsupportedOpen(false)}
      />
    </div>
  );
}

export default DeviceCard;
