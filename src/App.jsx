import { useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { RefreshCw, Smartphone, Settings, Camera, RotateCcw, Wifi, Loader2, FolderOpen, Download, Folder, Package, Copy, X, Palette, History, Video, Bot, DownloadCloud, CheckCircle2, AlertCircle, Crown, Lock, ClipboardCheck, Gauge, ClipboardList, ShieldCheck, ArrowLeft } from 'lucide-react';
import './index.css';
import themes from './data/themes';
import { getChangelog } from './data/changelogs';
import DeviceCard from './components/DeviceCard';
import MemberCenter from './components/MemberCenter';
// 性能监控面板
import PerformanceDashboard from './components/PerformanceDashboard';
import TaskCenter from './components/TaskCenter';
import TroubleshootingWizard from './components/TroubleshootingWizard';
import ArtifactCenter from './components/ArtifactCenter';
import QualityCenter from './components/QualityCenter';
import EnvironmentCheckWizard from './components/EnvironmentCheckWizard';
import GlobalCommandPalette, { GlobalCommandSettings } from './components/GlobalCommandPalette';
import DangerConfirmModal from './components/DangerConfirmModal';
import { isCommandShortcutMatch, normalizeCommandSettings } from './data/globalCommands';
import { clearConfirmSuppressionMemory, isConfirmSuppressed, rememberConfirmSuppressed } from './shared/confirmMemory';

const getOperationErrorMessage = (error) => {
  const lines = String(error || '未知错误')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || '未知错误';
};

function App() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [activeTab, setActiveTab] = useState('devices');
  const [activeSettingsSection, setActiveSettingsSection] = useState('settings-commands');
  const [wifiIp, setWifiIp] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [scrcpySettings, setScrcpySettings] = useState({
    screenOff: false,
    stayAwake: true,
    bitrate: '8 Mbps',
    maxSize: '0'
  });
  // Toast 提示状态
  const [toast, setToast] = useState(null);
  // 避免连续提示时旧定时器清掉新的 Toast。
  const toastTimerRef = useRef(null);
  const showToast = useCallback((message, duration = 5000) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(message);
    toastTimerRef.current = setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, duration);
  }, []);
  // Confirm 确认框状态
  const [confirmModal, setConfirmModal] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  // 更新安装确认框状态（带加载条）
  const [updateInstallModal, setUpdateInstallModal] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [environmentCheckModalOpen, setEnvironmentCheckModalOpen] = useState(false);
  const showConfirm = useCallback((options, onConfirm) => {
    const next = typeof options === 'string'
      ? { title: '确认操作', message: options, onConfirm }
      : { ...options, onConfirm: options?.onConfirm || onConfirm };
    if (next.rememberKey && isConfirmSuppressed(next.rememberKey)) {
      Promise.resolve()
        .then(() => next.onConfirm?.())
        .catch((err) => showToast(`操作失败: ${err?.message || '未知错误'}`));
      return;
    }
    next.rememberChoice = false;
    next.rememberLabel = next.rememberLabel || '下次不再提示';
    setConfirmModal(next);
  }, [showToast]);
  const runConfirmModal = async () => {
    if (!confirmModal?.onConfirm) return;
    setConfirmLoading(true);
    try {
      const result = await confirmModal.onConfirm();
      if (result !== false) {
        if (confirmModal.rememberKey && confirmModal.rememberChoice) {
          rememberConfirmSuppressed(confirmModal.rememberKey);
        }
        setConfirmModal(null);
      }
    } finally {
      setConfirmLoading(false);
    }
  };
  // 截图保存路径
  const [screenshotPath, setScreenshotPath] = useState('');
  // 录屏保存路径
  const [screenRecordPath, setScreenRecordPath] = useState('');
  // 巡检报告与证据包保存路径
  const [inspectionPath, setInspectionPath] = useState('');
  const inspectionPathLoadedRef = useRef(false);
  // 性能导出与分析报告保存路径
  const [performancePath, setPerformancePath] = useState('');
  const performancePathLoadedRef = useRef(false);
  // 任务中心产物保存路径
  const [taskCenterPath, setTaskCenterPath] = useState('');
  const taskCenterPathLoadedRef = useRef(false);
  // 质量中心产物保存路径
  const [qualityCenterPath, setQualityCenterPath] = useState('');
  const qualityCenterPathLoadedRef = useRef(false);
  const [backgroundTasks, setBackgroundTasks] = useState({ inspection: null, performanceReport: null });
  const backgroundTaskHideTimersRef = useRef({});
  const [deviceNames, setDeviceNames] = useState({});
  const [expandedDeviceIds, setExpandedDeviceIds] = useState(new Set());
  const [apkInstallPaths, setApkInstallPaths] = useState({});
  const [apkPushPaths, setApkPushPaths] = useState({});
  const [apkInstallResults, setApkInstallResults] = useState({});
  const [apkPushResults, setApkPushResults] = useState({});
  const [apkPushRemotePaths, setApkPushRemotePaths] = useState({});
  const [apkBrowserPaths, setApkBrowserPaths] = useState({});
  const [apkBrowserItemsMap, setApkBrowserItemsMap] = useState({});
  const [apkBrowserLoadingMap, setApkBrowserLoadingMap] = useState({});
  const [operationLoading, setOperationLoading] = useState({});
  // 记住上次文件选择对话框打开的文件夹路径
  const [lastSelectFolder, setLastSelectFolder] = useState('');
  // 推送远程路径历史记录
  const [pushRemotePathHistory, setPushRemotePathHistory] = useState([]);
  const [currentTheme, setCurrentTheme] = useState('default');
  const [customThemes, setCustomThemes] = useState([]);
  const [showThemeEditor, setShowThemeEditor] = useState(false);
  const [editingTheme, setEditingTheme] = useState(null);
  const [newThemeName, setNewThemeName] = useState('');
  // 自动更新状态
  const [appVersion, setAppVersion] = useState('');
  const [updaterState, setUpdaterState] = useState({
    checking: false,
    available: false,
    downloading: false,
    downloaded: false,
    progress: null,
    error: null,
    info: null,
    notAvailable: false
  });
  const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(() => {
    return localStorage.getItem('autoUpdateEnabled') !== 'false';
  });
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [globalCommandSettings, setGlobalCommandSettings] = useState(() => {
    try {
      return normalizeCommandSettings(JSON.parse(localStorage.getItem('globalCommandSettings') || '{}'));
    } catch {
      return normalizeCommandSettings({});
    }
  });
  // 更新说明弹窗（版本升级后首次打开时显示）
  const [showChangelog, setShowChangelog] = useState(false);
  const [changelogContent, setChangelogContent] = useState(null);
  // appVersion 的 ref，供事件回调中读取最新值（避免闭包捕获旧值）
  const appVersionRef = useRef('');
  useEffect(() => { appVersionRef.current = appVersion; }, [appVersion]);
  useEffect(() => {
    localStorage.setItem('globalCommandSettings', JSON.stringify(globalCommandSettings));
  }, [globalCommandSettings]);
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!globalCommandSettings.enabled) return;
      if (isCommandShortcutMatch(event, globalCommandSettings.shortcut)) {
        event.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [globalCommandSettings.enabled, globalCommandSettings.shortcut]);
  const [themeColors, setThemeColors] = useState({
    primary: 'emerald',
    primaryFrom: 'from-emerald-500',
    primaryTo: 'to-emerald-600',
    useGradient: true,
    secondary: 'bg-slate-100',
    secondaryText: 'text-slate-700',
    secondaryBorder: 'border-slate-200',
    bg: 'bg-slate-50',
    card: 'bg-white',
    cardBorder: 'border-slate-200',
    input: 'border-slate-200',
    terminalBg: 'bg-[#202124]',
    terminalOutput: 'bg-[#0D0E10]',
    terminalText: 'text-[#E8EAED]',
    terminalAccent: 'text-emerald-400'
  });
  // 连接历史记录
  const [connectionHistory, setConnectionHistory] = useState([]);
  // 终端命令历史记录（全局共享）
  const [terminalCommandHistory, setTerminalCommandHistory] = useState([]);
  // VIP 会员状态
  const [vipStatus, setVipStatus] = useState({
    activated: false, scope: 'free', type: null,
    issuedAt: null, expiresAt: null, machineId: null, reason: 'loading'
  });
  const refreshVipStatus = useCallback(async () => {
    if (!window.electronAPI?.vipGetStatus) return;
    try {
      const s = await window.electronAPI.vipGetStatus();
      setVipStatus(s);
    } catch (error) {
      setVipStatus(prev => ({ ...prev, activated: false, scope: 'free', reason: 'vip_status_failed', error: error.message }));
    }
  }, []);

  const allThemes = { ...themes, ...Object.fromEntries(customThemes.map(t => [t.key, t])) };
  const theme = allThemes[currentTheme] || themes.default;

  // 组件卸载时清理 Toast 定时器，避免窗口关闭后仍触发状态更新。
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
        toastTimerRef.current = null;
      }
    };
  }, []);

  const saveCustomTheme = () => {
    const themeName = newThemeName.trim() || `自定义${customThemes.length + 1}`;
    const isDarkCard = themeColors.card.includes('slate-800') || themeColors.card.includes('gradient');
    const autoText = isDarkCard ? 'text-[#E8EAED]' : 'text-slate-700';
    const autoTextMuted = isDarkCard ? 'text-slate-400' : 'text-slate-400';
    const customTheme = {
      name: themeName,
      preview: themeColors.card,
      primary: themeColors.primary,
      card: themeColors.card,
      header: `${themeColors.card} ${themeColors.cardBorder} border-b`,
      button: {
        primary: themeColors.useGradient
          ? `bg-gradient-to-r ${themeColors.primaryFrom} ${themeColors.primaryTo} text-white`
          : `bg-${themeColors.primary}-500 text-white`,
        secondary: `${themeColors.secondary} ${themeColors.secondaryText} ${themeColors.secondaryBorder} border`,
        outline: `${themeColors.secondaryBorder} border ${themeColors.secondaryText}`
      },
      text: autoText,
      textMuted: autoTextMuted,
      input: `${themeColors.input} ${themeColors.bg}`,
      terminal: {
        bg: themeColors.terminalBg,
        output: themeColors.terminalOutput,
        text: themeColors.terminalText,
        accent: themeColors.terminalAccent
      },
      isCustom: true
    };

    const customKey = `custom_${Date.now()}`;
    if (editingTheme) {
      setCustomThemes(prev => prev.map(t => t.key === editingTheme.key ? { ...customTheme, key: editingTheme.key } : t));
    } else {
      setCustomThemes(prev => [...prev, { ...customTheme, key: customKey }]);
    }
    setCurrentTheme(editingTheme?.key || customKey);
    setShowThemeEditor(false);
    setEditingTheme(null);
    setNewThemeName('');
  };

  const deleteCustomTheme = (themeKey) => {
    setCustomThemes(prev => prev.filter(t => t.key !== themeKey));
    if (currentTheme === themeKey) {
      setCurrentTheme('default');
    }
  };

  const editCustomTheme = (customTheme) => {
    setEditingTheme(customTheme);
    setNewThemeName(customTheme.name);
    const isGradient = customTheme.button.primary.includes('gradient');
    setThemeColors({
      primary: customTheme.primary,
      primaryFrom: isGradient ? customTheme.button.primary.split(' ')[1] : `from-${customTheme.primary}-500`,
      primaryTo: isGradient ? customTheme.button.primary.split(' ')[2] : `to-${customTheme.primary}-600`,
      useGradient: isGradient,
      secondary: customTheme.button.secondary.split(' ')[0] || 'bg-slate-100',
      secondaryText: customTheme.button.secondary.split(' ')[1] || 'text-slate-700',
      secondaryBorder: customTheme.button.secondary.split(' ')[3] || 'border-slate-200',
      bg: customTheme.header.includes('slate-50') ? 'bg-slate-50' : customTheme.header.includes('pink-50') ? 'bg-pink-50' : customTheme.header.includes('blue-50') ? 'bg-blue-50' : 'bg-slate-50',
      card: customTheme.card,
      cardBorder: customTheme.card.includes('border-') ? customTheme.card.split('border-')[1].split(' ')[0] : 'border-slate-200',
      input: customTheme.input,
      terminalBg: customTheme.terminal.bg,
      terminalOutput: customTheme.terminal.output,
      terminalText: customTheme.terminal.text,
      terminalAccent: customTheme.terminal.accent
    });
    setShowThemeEditor(true);
  };

  const fetchDevices = async () => {
    setLoading(true);
    setError('');
    try {
      if (window.electronAPI) {
        let timeoutId = null;
        try {
          const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error('获取设备列表超时，请检查 ADB 是否正常运行')), 10000);
          });
          const devs = await Promise.race([
            window.electronAPI.getDevices(),
            timeoutPromise
          ]);
          setDevices(devs);
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      } else {
        // Mock data for browser testing
        setDevices([
          { id: 'emulator-5554', status: 'device', model: 'Pixel 6 Pro' },
          { id: '192.168.1.100:5555', status: 'offline', model: 'Unknown' },
        ]);
      }
    } catch (err) {
      setError(err.message || '获取设备列表失败');
      setDevices([]);
    } finally {
      setLoading(false);
    }
  };

  const globalCommands = useMemo(() => {
    const builtIns = [
      { id: 'cmd-devices', title: '设备列表', description: '查看已连接设备', action: 'tab:devices', group: '导航' },
      { id: 'cmd-environment', title: '环境自检', description: '检查 ADB、scrcpy 和设备授权', action: 'environmentCheck', group: '工具' },
      { id: 'cmd-troubleshoot', title: '问题排查', description: '按问题场景自动采集证据', action: 'tab:troubleshoot', group: '导航' },
      { id: 'cmd-artifacts', title: '产物中心', description: '查看报告、数据和证据目录', action: 'tab:artifacts', group: '导航' },
      { id: 'cmd-quality', title: '质量中心', description: '生成回归差异报告和验收证据', action: 'tab:quality', group: '导航' },
      { id: 'cmd-history', title: '连接历史', description: '查看无线连接历史', action: 'tab:history', group: '导航' },
      { id: 'cmd-tasks', title: '任务中心', description: '运行复现脚本和自动化压测', action: 'tab:tasks', group: '导航' },
      { id: 'cmd-performance', title: '性能监控', description: '查看设备资源与进程状态', action: 'tab:performance', group: '导航' },
      { id: 'cmd-settings', title: '偏好设置', description: '配置应用偏好', action: 'tab:settings', group: '导航' },
      { id: 'cmd-log', title: '打开日志分析', description: '打开独立日志分析窗口', action: 'logAnalyzer', group: '工具' },
      { id: 'cmd-refresh', title: '刷新设备', description: '重新获取设备列表', action: 'refreshDevices', group: '工具' }
    ];
    return [...builtIns, ...(globalCommandSettings.customCommands || [])];
  }, [globalCommandSettings.customCommands]);

  const runGlobalCommand = (command) => {
    const action = String(command?.action || '');
    if (action === 'environmentCheck' || action === 'tab:environment') {
      setEnvironmentCheckModalOpen(true);
      return;
    }
    if (action.startsWith('tab:')) {
      setActiveTab(action.slice(4));
      return;
    }
    if (action === 'logAnalyzer') {
      window.electronAPI?.logAnalyzerOpen?.();
      return;
    }
    if (action === 'refreshDevices') {
      fetchDevices();
      return;
    }
  };

  useEffect(() => {
    fetchDevices();
    const markSettingsLoaded = () => {
      inspectionPathLoadedRef.current = true;
      performancePathLoadedRef.current = true;
      taskCenterPathLoadedRef.current = true;
      qualityCenterPathLoadedRef.current = true;
    };
    const applySettings = (settings = {}) => {
      if (settings.screenshotPath) setScreenshotPath(settings.screenshotPath);
      if (settings.screenRecordPath) setScreenRecordPath(settings.screenRecordPath);
      if (settings.inspectionPath) setInspectionPath(settings.inspectionPath);
      if (settings.performancePath) setPerformancePath(settings.performancePath);
      if (settings.taskCenterPath) setTaskCenterPath(settings.taskCenterPath);
      if (settings.qualityCenterPath) setQualityCenterPath(settings.qualityCenterPath);
      if (Array.isArray(settings.pushRemotePathHistory)) setPushRemotePathHistory(settings.pushRemotePathHistory);
      markSettingsLoaded();
    };
    const loadSettingsFallback = async () => {
      if (!window.electronAPI) return;
      const [
        themesResult,
        screenshotResult,
        screenRecordResult,
        inspectionResult,
        performanceResult,
        taskCenterResult,
        qualityCenterResult,
        pushHistoryResult
      ] = await Promise.all([
        window.electronAPI.loadCustomThemes?.(),
        window.electronAPI.loadScreenshotPath?.(),
        window.electronAPI.loadScreenRecordPath?.(),
        window.electronAPI.loadInspectionPath?.(),
        window.electronAPI.loadPerformancePath?.(),
        window.electronAPI.loadTaskCenterPath?.(),
        window.electronAPI.loadQualityCenterPath?.(),
        window.electronAPI.loadPushRemotePathHistory?.()
      ]);
      if (themesResult?.success && themesResult.data?.length > 0) setCustomThemes(themesResult.data);
      applySettings({
        screenshotPath: screenshotResult?.data,
        screenRecordPath: screenRecordResult?.data,
        inspectionPath: inspectionResult?.data,
        performancePath: performanceResult?.data,
        taskCenterPath: taskCenterResult?.data,
        qualityCenterPath: qualityCenterResult?.data,
        pushRemotePathHistory: pushHistoryResult?.data
      });
    };
    const loadInitialSettings = async () => {
      if (!window.electronAPI) return;
      if (window.electronAPI.loadAllSettings) {
        const result = await window.electronAPI.loadAllSettings();
        if (result?.success) {
          if (result.data?.customThemes?.length > 0) setCustomThemes(result.data.customThemes);
          applySettings(result.data?.settings || {});
          return;
        }
      }
      await loadSettingsFallback();
    };
    loadInitialSettings();
    // 加载连接历史记录
    const loadConnectionHistory = async () => {
      if (window.electronAPI) {
        const result = await window.electronAPI.loadConnectionHistory();
        if (result.success && result.data) {
          setConnectionHistory(result.data);
        }
      }
    };
    loadConnectionHistory();
    // 加载终端命令历史记录
    const loadTerminalCmdHistory = async () => {
      if (window.electronAPI) {
        const result = await window.electronAPI.loadTerminalHistory();
        if (result.success && result.data) {
          setTerminalCommandHistory(result.data);
        }
      }
    };
    loadTerminalCmdHistory();
    // 初始化 VIP 状态
    refreshVipStatus();
  }, [refreshVipStatus]);

  useEffect(() => {
    const saveThemes = async () => {
      if (window.electronAPI) {
        await window.electronAPI.saveCustomThemes(customThemes);
      }
    };
    saveThemes();
  }, [customThemes]);

  // 保存截图路径变化时自动保存
  useEffect(() => {
    const saveScreenshotPath = async () => {
      if (window.electronAPI && screenshotPath) {
        await window.electronAPI.saveScreenshotPath(screenshotPath);
      }
    };
    saveScreenshotPath();
  }, [screenshotPath]);
  // 保存录屏路径变化时自动保存
  useEffect(() => {
    const saveScreenRecordPath = async () => {
      if (window.electronAPI && screenRecordPath) {
        await window.electronAPI.saveScreenRecordPath(screenRecordPath);
      }
    };
    saveScreenRecordPath();
  }, [screenRecordPath]);
  // 保存巡检路径变化时自动保存
  useEffect(() => {
    const saveInspectionPath = async () => {
      if (window.electronAPI && inspectionPathLoadedRef.current) {
        await window.electronAPI.saveInspectionPath(inspectionPath);
      }
    };
    saveInspectionPath();
  }, [inspectionPath]);
  // 保存性能导出路径变化时自动保存
  useEffect(() => {
    const savePerformancePath = async () => {
      if (window.electronAPI && performancePathLoadedRef.current) {
        await window.electronAPI.savePerformancePath(performancePath);
      }
    };
    savePerformancePath();
  }, [performancePath]);
  // 保存任务中心路径变化时自动保存
  useEffect(() => {
    const saveTaskCenterPath = async () => {
      if (window.electronAPI && taskCenterPathLoadedRef.current) {
        await window.electronAPI.saveTaskCenterPath(taskCenterPath);
      }
    };
    saveTaskCenterPath();
  }, [taskCenterPath]);
  // 保存质量中心路径变化时自动保存
  useEffect(() => {
    const saveQualityCenterPath = async () => {
      if (window.electronAPI && qualityCenterPathLoadedRef.current) {
        await window.electronAPI.saveQualityCenterPath(qualityCenterPath);
      }
    };
    saveQualityCenterPath();
  }, [qualityCenterPath]);

  useEffect(() => {
    const hideLater = (key, task) => {
      if (backgroundTaskHideTimersRef.current[key]) {
        clearTimeout(backgroundTaskHideTimersRef.current[key]);
      }
      backgroundTaskHideTimersRef.current[key] = setTimeout(() => {
        setBackgroundTasks(prev => {
          if (prev[key]?.id !== task?.id) return prev;
          return { ...prev, [key]: null };
        });
        backgroundTaskHideTimersRef.current[key] = null;
      }, 6000);
    };
    const setTask = (key, task, autoHide = false) => {
      setBackgroundTasks(prev => ({ ...prev, [key]: task || null }));
      if (autoHide && task) hideLater(key, task);
    };
    window.electronAPI?.inspectionState?.({}).then(res => {
      const task = res?.task;
      if (task && isBackgroundTaskActive(task)) setTask('inspection', task);
    });
    window.electronAPI?.perfReportState?.({}).then(res => {
      const task = res?.task;
      if (task && isBackgroundTaskActive(task)) setTask('performanceReport', task);
    });
    const offInspectionProgress = window.electronAPI?.onInspectionProgress?.((progress) => {
      setTask('inspection', {
        id: progress.taskId,
        taskId: progress.taskId,
        deviceId: progress.deviceId,
        status: 'running',
        progress
      });
    });
    const offInspectionDone = window.electronAPI?.onInspectionDone?.((result) => {
      const task = {
        id: result.taskId,
        taskId: result.taskId,
        deviceId: result.deviceId,
        status: result.cancelled ? 'cancelled' : result.ok ? 'success' : 'failed',
        progress: { percent: 100, message: result.cancelled ? '巡检已取消' : result.ok ? '巡检已完成' : '巡检失败' },
        result
      };
      setTask('inspection', task, true);
    });
    const offReportProgress = window.electronAPI?.onPerfReportProgress?.((task) => {
      setTask('performanceReport', task);
    });
    const offReportDone = window.electronAPI?.onPerfReportDone?.((task) => {
      setTask('performanceReport', task, true);
      if (task?.result?.ok) showToast(`性能报告已生成：${task.result.path}`);
      else if (task?.result?.error) showToast(`性能报告生成失败：${task.result.error}`);
    });
    return () => {
      offInspectionProgress?.();
      offInspectionDone?.();
      offReportProgress?.();
      offReportDone?.();
      Object.values(backgroundTaskHideTimersRef.current).forEach(timer => {
        if (timer) clearTimeout(timer);
      });
      backgroundTaskHideTimersRef.current = {};
    };
  }, [showToast]);

  // 保存推送远程路径历史变化时自动持久化
  useEffect(() => {
    const savePushHistory = async () => {
      if (window.electronAPI && pushRemotePathHistory.length > 0) {
        await window.electronAPI.savePushRemotePathHistory(pushRemotePathHistory);
      }
    };
    savePushHistory();
  }, [pushRemotePathHistory]);

  // 获取应用版本号 + 主动查询是否需要显示更新说明
  // 使用拉取模式：渲染进程加载完成后主动调用 IPC 查询，避免事件推送丢失。
  // 同时保留 localStorage fallback：即使 main 进程时序或 IPC 异常，也能通过
  // localStorage.lastAppVersion 与当前版本的差异判断是否需要显示弹窗。
  useEffect(() => {
    const fetchVersionAndChangelog = async () => {
      let currentVersion = '';
      if (window.electronAPI?.getVersion) {
        currentVersion = await window.electronAPI.getVersion();
        setAppVersion(currentVersion);
      }

      let needsShow = false;
      let targetVersion = null;

      // 1. 优先使用 main 进程的 pendingChangelog 标志
      if (window.electronAPI?.checkChangelog) {
        try {
          const result = await window.electronAPI.checkChangelog();
          if (result?.needsShow && result?.version) {
            needsShow = true;
            targetVersion = result.version;
          }
        } catch (e) {
          console.warn('[Changelog] checkChangelog 查询失败:', e);
        }
      }

      // 2. fallback：localStorage 中记录的版本与当前版本不同
      const lastVersion = localStorage.getItem('lastAppVersion');
      if (!needsShow && currentVersion && lastVersion !== currentVersion) {
        needsShow = true;
        targetVersion = currentVersion;
      }

      if (needsShow && targetVersion) {
        const changelog = getChangelog(targetVersion);
        if (changelog) {
          setChangelogContent({ version: targetVersion, ...changelog });
          setShowChangelog(true);
        }
      }

      // 3. 更新 localStorage 中记录的版本
      if (currentVersion) {
        localStorage.setItem('lastAppVersion', currentVersion);
      }
    };
    fetchVersionAndChangelog();
  }, []);

  // 监听自动更新事件
  // 只处理下载相关事件：download-progress 和 update-downloaded。
  // 检查状态（checking / available / notAvailable）由 IPC 调用方直接管理，
  // 避免 electron-updater 事件与 IPC 返回值之间的竞态覆盖。
  useEffect(() => {
    if (!window.electronAPI?.onUpdaterEvent) return;
    const cleanup = window.electronAPI.onUpdaterEvent((data) => {
      const { eventName, payload } = data;
      setUpdaterState(prev => {
        switch (eventName) {
          case 'download-progress':
            return { ...prev, downloading: true, progress: payload };
          case 'update-downloaded':
            return { ...prev, downloading: false, downloaded: true, info: payload };
          default:
            return prev;
        }
      });
    });
    return cleanup;
  }, []);

  // 自动更新开关变化时持久化 + 启动时自动检查
  useEffect(() => {
    localStorage.setItem('autoUpdateEnabled', autoUpdateEnabled ? 'true' : 'false');
  }, [autoUpdateEnabled]);

  // 自动更新依赖 autoUpdateEnabled，避免开关变化后启动检查仍使用旧状态。
  // 应用启动后自动检查更新（仅在开关开启时）
  // 发现新版本后自动下载，下载完成后左下角显示安装图标
  useEffect(() => {
    if (!autoUpdateEnabled) return;
    if (!window.electronAPI?.checkForUpdates) return;
    const timer = setTimeout(async () => {
      try {
        console.log('[AutoUpdate] 开始自动检查更新...');
        // 直接管理检查状态，不依赖 electron-updater 事件
        setUpdaterState(prev => ({
          ...prev,
          checking: true,
          available: false,
          notAvailable: false,
          error: null
        }));
        const res = await window.electronAPI.checkForUpdates();
        console.log('[AutoUpdate] 检查结果:', res);
        // 如果服务器未配置或开发模式，静默失败
        if (!res?.success) {
          console.log('[AutoUpdate] 自动检查跳过:', res?.error);
          setUpdaterState(prev => ({ ...prev, checking: false, error: res?.error || '检查失败' }));
          return;
        }
        // 使用 IPC 返回值更新检查状态
        setUpdaterState(prev => ({
          ...prev,
          checking: false,
          available: !!res.available,
          notAvailable: !!res.notAvailable,
          info: res.info || prev.info
        }));
        // 发现有新版本，自动下载
        if (res.available) {
          console.log('[AutoUpdate] 发现新版本 v' + res.info?.version + '，开始自动下载...');
          // 标记正在下载
          setUpdaterState(prev => ({ ...prev, downloading: true }));
          const dlRes = await window.electronAPI?.downloadUpdate?.();
          console.log('[AutoUpdate] 下载结果:', dlRes);
          if (dlRes && !dlRes.success) {
            console.error('[AutoUpdate] 下载失败:', dlRes.error);
            setUpdaterState(prev => ({ ...prev, downloading: false, error: dlRes.error }));
          }
          // 下载成功后 update-downloaded 事件会触发，由 onUpdaterEvent 处理 downloaded 状态
        } else {
          console.log('[AutoUpdate] 当前已是最新版本');
        }
      } catch (err) {
        console.error('[AutoUpdate] 自动检查更新异常:', err);
        setUpdaterState(prev => ({ ...prev, checking: false, error: err.message }));
      }
    }, 3000); // 启动 3 秒后检查
    return () => clearTimeout(timer);
  }, [autoUpdateEnabled]);

  const handleScreenRecordStart = async (deviceId) => {
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbScreenRecordStart(deviceId);
        return res;
      }
      return { success: false, error: '录屏功能需要 Electron 环境' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const handleScreenRecordStop = async (deviceId) => {
    try {
      if (window.electronAPI) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let saveDir = screenRecordPath;
        if (!saveDir) {
          const userDataResult = await window.electronAPI.getUserDataPath();
          const baseDir = userDataResult.success ? userDataResult.path : '.';
          saveDir = `${baseDir}/screenrecord`;
        }
        await window.electronAPI.ensureFolder(saveDir);
        const localPath = `${saveDir}/screenrecord-${timestamp}.mp4`;
        const res = await window.electronAPI.adbScreenRecordStop(deviceId, localPath);
        return res;
      }
      return { success: false, error: '录屏功能需要 Electron 环境' };
    } catch (err) {
      return { success: false, error: err.message };
    }
  };

  const handleStartScrcpy = async (deviceId) => {
    setOperationLoading(prev => ({ ...prev, [`scrcpy_${deviceId}`]: true }));
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.startScrcpy(deviceId, scrcpySettings);
        showToast(res?.message || `开始投屏 ${deviceId}`);
      } else {
        showToast(`开始投屏 ${deviceId}`);
      }
    } catch (err) {
      showToast(`启动失败: ${err.message}`);
    } finally {
      setOperationLoading(prev => ({ ...prev, [`scrcpy_${deviceId}`]: false }));
    }
  };

  const handleAdbCommand = async (deviceId, command) => {
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbShell(deviceId, command);
        if (!res.success) {
          showToast(`命令执行失败: ${res.error}`);
        }
      } else {
        console.log(`发送命令到 ${deviceId}: adb shell ${command}`);
      }
    } catch (err) {
      showToast(`命令执行错误: ${err.message}`);
    }
  };

  const handleExecuteCommand = async (deviceId, command) => {
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbShell(deviceId, command);
        if (res.success) {
          return res.output || '命令执行成功';
        }
        if (res.cancelled) {
          return res.output ? `（已中断）\n${res.output}` : '命令已中断';
        }
        // 失败/超时但已有部分输出时一并展示，便于查看交互式命令的回显
        if (res.output) {
          return `${res.error}\n${res.output}`;
        }
        return `命令执行失败: ${res.error}`;
      } else {
        return '终端功能需要 Electron 环境';
      }
    } catch (err) {
      return `命令执行错误: ${err.message}`;
    }
  };

  // 保存终端命令到全局共享历史记录
  const handleSaveTerminalCommand = async (command) => {
    const trimmedCmd = (command || '').trim();
    if (!trimmedCmd) return;
    setTerminalCommandHistory(prev => {
      const filtered = prev.filter(c => c !== trimmedCmd);
      return [trimmedCmd, ...filtered].slice(0, 100);
    });
    if (window.electronAPI) {
      await window.electronAPI.saveTerminalCommand(trimmedCmd);
    }
  };

  // 清空终端命令历史记录
  const handleClearTerminalHistory = async () => {
    showConfirm({
      title: '清空终端命令历史',
      message: '确定清空所有已保存的终端命令吗？',
      detail: '该操作只清除本机命令历史，不影响当前终端输出和设备数据。',
      confirmLabel: '清空历史',
      rememberKey: 'app.clearTerminalHistory',
      onConfirm: async () => {
        setTerminalCommandHistory([]);
        if (window.electronAPI) {
          await window.electronAPI.clearTerminalHistory();
        }
        showToast('终端命令历史已清除');
      }
    });
  };

  const handleScreenshot = async (deviceId) => {
    setOperationLoading(prev => ({ ...prev, [`screenshot_${deviceId}`]: true }));
    try {
      if (window.electronAPI) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let saveDir = screenshotPath;
        if (!saveDir) {
          const userDataResult = await window.electronAPI.getUserDataPath();
          const baseDir = userDataResult.success ? userDataResult.path : '.';
          saveDir = `${baseDir}/screenshot`;
        }
        await window.electronAPI.ensureFolder(saveDir);
        const localPath = `${saveDir}/screenshot-${timestamp}.png`;
        const res = await window.electronAPI.adbShell(deviceId, 'screencap -p /sdcard/screen.png');
        if (res.success) {
          const pullRes = await window.electronAPI.adbScreenshot(deviceId, localPath);
          if (pullRes.success) {
            showToast(`截图已保存: ${localPath}`);
          } else {
            showToast(`截图保存失败: ${pullRes.error}`);
          }
        } else {
          showToast(`截图命令失败: ${res.error}`);
        }
      } else {
        showToast('截图功能需要 Electron 环境');
      }
    } catch (err) {
      showToast(`截图错误: ${err.message}`);
    } finally {
      setOperationLoading(prev => ({ ...prev, [`screenshot_${deviceId}`]: false }));
    }
  };

  const handleReboot = async (deviceId) => {
    showConfirm({
      title: '重启设备',
      message: `确定重启设备 ${deviceId} 吗？`,
      detail: '重启会中断当前投屏、日志抓取和未完成的设备操作。设备重新上线后可刷新列表继续使用。',
      confirmLabel: '重启设备',
      rememberKey: 'device.reboot',
      onConfirm: async () => {
        setOperationLoading(prev => ({ ...prev, [`reboot_${deviceId}`]: true }));
        try {
          if (window.electronAPI) {
            const res = await window.electronAPI.adbReboot(deviceId);
            if (res.success) {
              showToast('设备正在重启...');
              // 延迟多次刷新，确保设备重新上线后列表更新
              [3000, 6000, 10000, 15000, 20000].forEach(delay => setTimeout(() => fetchDevices(), delay));
            } else {
              showToast(`重启失败: ${res.error}`);
            }
          } else {
            showToast('重启功能需要 Electron 环境');
          }
        } catch (err) {
          showToast(`重启失败: ${err.message}`);
        } finally {
          setOperationLoading(prev => ({ ...prev, [`reboot_${deviceId}`]: false }));
        }
      }
    });
  };

  const handleRebootLoader = async (deviceId) => {
    showConfirm({
      title: '进入 Loader 模式',
      message: `确定让设备 ${deviceId} 进入 loader 模式吗？`,
      detail: '设备会断开当前 ADB 会话并进入刷机/引导模式；通常需要手动重启或刷机工具才能回到系统。',
      confirmLabel: '进入 Loader',
      rememberKey: 'device.rebootLoader',
      onConfirm: async () => {
        setOperationLoading(prev => ({ ...prev, [`loader_${deviceId}`]: true }));
        try {
          if (window.electronAPI) {
            const res = await window.electronAPI.adbRebootLoader(deviceId);
            if (res.success) {
              showToast('设备正在进入loader模式...');
              // 延迟多次刷新，确保设备状态变更后列表更新
              [3000, 6000, 10000, 15000, 20000].forEach(delay => setTimeout(() => fetchDevices(), delay));
            } else {
              showToast(`进入loader模式失败: ${res.error}`);
            }
          } else {
            showToast('Loader模式需要 Electron 环境');
          }
        } catch (err) {
          showToast(`进入loader模式失败: ${err.message}`);
        } finally {
          setOperationLoading(prev => ({ ...prev, [`loader_${deviceId}`]: false }));
        }
      }
    });
  };

  const handleUnlock = async (deviceId) => {
    showConfirm({
      title: '设备解锁 Unlock',
      message: `即将对设备 ${deviceId} 执行 Unlock 解锁流程。`,
      detail: '执行前必须先在开发者模式中打开 OEM 解锁。设备端可能需要手动确认解锁，解锁过程可能会清除设备数据。',
      confirmLabel: '开始 Unlock',
      rememberKey: 'device.unlock',
      onConfirm: async () => {
        setOperationLoading(prev => ({ ...prev, [`unlock_${deviceId}`]: true }));
        try {
          if (window.electronAPI) {
            const res = await window.electronAPI.adbUnlock(deviceId);
            if (res.success) {
              showToast(res.message || 'Unlock 命令已执行，设备正在重启...');
              // 延迟多次刷新，确保设备重启完成后列表更新
              [8000, 12000, 16000, 20000].forEach(delay => setTimeout(() => fetchDevices(), delay));
            } else {
              showToast(`Unlock 失败: ${res.error}`);
            }
          } else {
            showToast('Unlock 功能需要 Electron 环境');
          }
        } catch (err) {
          showToast(`Unlock 执行失败: ${err.message}`);
        } finally {
          setOperationLoading(prev => ({ ...prev, [`unlock_${deviceId}`]: false }));
        }
      }
    });
  };

  const handleRoot = async (deviceId) => {
    setOperationLoading(prev => ({ ...prev, [`root_${deviceId}`]: true }));
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbRoot(deviceId);
        if (res.success) {
          showToast(`Root 成功！${res.message}`);
        } else {
          showToast(`Root 失败: ${res.error}`);
        }
      } else {
        showToast('Root 功能需要 Electron 环境');
      }
    } catch (err) {
      showToast(`Root 执行失败: ${err.message}`);
    } finally {
      setOperationLoading(prev => ({ ...prev, [`root_${deviceId}`]: false }));
    }
  };

  const handleRemount = async (deviceId) => {
    setOperationLoading(prev => ({ ...prev, [`remount_${deviceId}`]: true }));
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbRemount(deviceId);
        if (res.success) {
          showToast(`Remount 成功！${res.message}`);
        } else {
          showToast(`Remount 失败: ${res.error}`);
        }
      } else {
        showToast('Remount 功能需要 Electron 环境');
      }
    } catch (err) {
      showToast(`Remount 执行失败: ${err.message}`);
    } finally {
      setOperationLoading(prev => ({ ...prev, [`remount_${deviceId}`]: false }));
    }
  };

  const handleSelectApkFile = async (deviceId, forWhat) => {
    try {
      if (window.electronAPI) {
        const dialogOptions = {
          properties: ['openFile']
        };
        // 安装仅限 APK，推送支持所有文件
        if (forWhat === 'install') {
          dialogOptions.filters = [{ name: 'APK Files', extensions: ['apk'] }];
        } else {
          dialogOptions.filters = [{ name: '所有文件', extensions: ['*'] }];
        }
        // 记住上次打开的文件夹路径
        if (lastSelectFolder) {
          dialogOptions.defaultPath = lastSelectFolder;
        }
        const result = await window.electronAPI.showOpenDialog(dialogOptions);
        if (!result.canceled && result.filePaths.length > 0) {
          // 记录选择的文件所在文件夹
          const selectedPath = result.filePaths[0];
          const folder = selectedPath.substring(0, selectedPath.lastIndexOf('\\') !== -1 ? selectedPath.lastIndexOf('\\') : selectedPath.lastIndexOf('/'));
          setLastSelectFolder(folder);
          if (forWhat === 'install') {
            setApkInstallPaths(prev => ({ ...prev, [deviceId]: selectedPath }));
          } else {
            setApkPushPaths(prev => ({ ...prev, [deviceId]: selectedPath }));
          }
        }
      } else {
        showToast('选择文件功能需要 Electron 环境');
      }
    } catch (err) {
      showToast(`选择文件失败: ${err.message}`);
    }
  };

  const handleInstallApk = async (deviceId) => {
    const apkPath = apkInstallPaths[deviceId];
    if (!apkPath) {
      showToast('请先选择一个 APK 文件');
      setApkInstallResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: '安装失败：请先选择一个 APK 文件' } }));
      return;
    }
    setApkInstallResults(prev => ({ ...prev, [deviceId]: null }));
    setOperationLoading(prev => ({ ...prev, [`install_${deviceId}`]: true }));
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbInstall(deviceId, apkPath);
        if (res.success) {
          showToast(`安装成功！文件: ${apkPath}`);
          setApkInstallResults(prev => ({ ...prev, [deviceId]: { status: 'success', message: '安装成功' } }));
        } else {
          showToast(`安装失败: ${res.error}`);
          setApkInstallResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: `安装失败：${getOperationErrorMessage(res.error)}` } }));
        }
      } else {
        showToast('安装功能需要 Electron 环境');
        setApkInstallResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: '安装失败：当前环境不支持安装功能' } }));
      }
    } catch (err) {
      showToast(`安装失败: ${err.message}`);
      setApkInstallResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: `安装失败：${getOperationErrorMessage(err.message)}` } }));
    } finally {
      setOperationLoading(prev => ({ ...prev, [`install_${deviceId}`]: false }));
    }
  };

  const handlePushApk = async (deviceId) => {
    const localPath = apkPushPaths[deviceId];
    const remotePath = apkPushRemotePaths[deviceId] !== undefined ? apkPushRemotePaths[deviceId] : '/sdcard/';
    if (!localPath) {
      showToast('请先选择一个文件');
      setApkPushResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: '推送失败：请先选择一个文件' } }));
      return;
    }
    if (!remotePath) {
      showToast('请输入远程路径');
      setApkPushResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: '推送失败：请输入远程路径' } }));
      return;
    }
    await runPushFile(deviceId, localPath, remotePath);
  };

  const runPushFile = async (deviceId, localPath, remotePath) => {
    setApkPushResults(prev => ({ ...prev, [deviceId]: null }));
    setOperationLoading(prev => ({ ...prev, [`push_${deviceId}`]: true }));
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbPush(deviceId, localPath, remotePath);
        if (res.success) {
          showToast(`推送成功！文件: ${localPath} 目标: ${remotePath}`);
          setApkPushResults(prev => ({ ...prev, [deviceId]: { status: 'success', message: '推送成功' } }));
          // 推送成功后将远程路径加入历史记录
          setPushRemotePathHistory(prev => {
            const filtered = prev.filter(p => p !== remotePath);
            return [remotePath, ...filtered].slice(0, 10);
          });
        } else {
          showToast(`推送失败: ${res.error}`);
          setApkPushResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: `推送失败：${getOperationErrorMessage(res.error)}` } }));
        }
      } else {
        showToast('推送功能需要 Electron 环境');
        setApkPushResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: '推送失败：当前环境不支持推送功能' } }));
      }
    } catch (err) {
      showToast(`推送失败: ${err.message}`);
      setApkPushResults(prev => ({ ...prev, [deviceId]: { status: 'error', message: `推送失败：${getOperationErrorMessage(err.message)}` } }));
    } finally {
      setOperationLoading(prev => ({ ...prev, [`push_${deviceId}`]: false }));
    }
  };

  const handleBrowseApk = async (deviceId, path) => {
    setApkBrowserLoadingMap(prev => ({ ...prev, [deviceId]: true }));
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbShellLs(deviceId, path);
        if (res.success) {
          setApkBrowserPaths(prev => ({ ...prev, [deviceId]: res.currentPath }));
          setApkBrowserItemsMap(prev => ({ ...prev, [deviceId]: res.items }));
        } else {
          showToast(`浏览失败: ${res.error}`);
        }
      } else {
        showToast('浏览功能需要 Electron 环境');
      }
    } catch (err) {
      showToast(`浏览失败: ${err.message}`);
    } finally {
      setApkBrowserLoadingMap(prev => ({ ...prev, [deviceId]: false }));
    }
  };

  const handlePullFile = async (deviceId, remotePath) => {
    try {
      if (window.electronAPI) {
        setOperationLoading(prev => ({ ...prev, [`pull_${deviceId}_${remotePath}`]: true }));
        const fileName = remotePath.split('/').pop() || 'downloaded_file';
        const saveResult = await window.electronAPI.showSaveDialog({
          defaultPath: fileName,
          filters: [{ name: 'All Files', extensions: ['*'] }]
        });

        if (saveResult.canceled || !saveResult.filePath) {
          setOperationLoading(prev => ({ ...prev, [`pull_${deviceId}_${remotePath}`]: false }));
          return;
        }

        const res = await window.electronAPI.adbPull(deviceId, remotePath, saveResult.filePath);
        if (res.success) {
          showToast(res.message);
        } else {
          showToast(`拉取失败: ${res.error}`);
        }
      } else {
        showToast('拉取功能需要 Electron 环境');
      }
    } catch (err) {
      showToast(`拉取失败: ${err.message}`);
    } finally {
      setOperationLoading(prev => {
        const newState = { ...prev };
        Object.keys(newState).forEach(key => {
          if (key.startsWith(`pull_${deviceId}_`)) {
            newState[key] = false;
          }
        });
        return newState;
      });
    }
  };

  const handleWifiConnect = async (e) => {
    e.preventDefault();
    if (!wifiIp.trim()) return;

    setIsConnecting(true);
    try {
      if (window.electronAPI) {
        const res = await window.electronAPI.adbConnect(wifiIp.trim());
        if (res.success) {
          showToast(`连接成功: ${res.message}`);
          setWifiIp('');
          fetchDevices();
          // 保存到历史记录
          await window.electronAPI.saveConnectionHistory({
            deviceId: wifiIp.trim(),
            deviceName: wifiIp.trim(),
            ip: wifiIp.trim(),
            type: 'wifi'
          });
          // 刷新历史记录
          const historyResult = await window.electronAPI.loadConnectionHistory();
          if (historyResult.success) {
            setConnectionHistory(historyResult.data);
          }
        } else {
          showToast(`连接失败: ${res.error}`);
        }
      } else {
        showToast(`模拟 Wi-Fi 连接到: ${wifiIp}`);
        setWifiIp('');
        fetchDevices();
      }
    } catch (err) {
      showToast(`网络请求错误: ${err.message}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async (deviceId) => {
    showConfirm({
      title: '断开设备连接',
      message: `确定断开设备 ${deviceId} 吗？`,
      detail: '断开后当前投屏、文件操作和终端命令都会失去目标设备。可重新插拔 USB 或重新发起 Wi-Fi 连接恢复。',
      confirmLabel: '断开连接',
      rememberKey: 'device.disconnect',
      onConfirm: async () => {
        try {
          if (window.electronAPI) {
            const res = await window.electronAPI.adbDisconnect(deviceId);
            if (res.success) {
              fetchDevices();
            } else {
              showToast(`断开连接失败: ${res.error}`);
            }
          } else {
            showToast(`模拟断开设备: ${deviceId}`);
            fetchDevices();
          }
        } catch (err) {
          showToast(`断开请求错误: ${err.message}`);
        }
      }
    });
  };

  const handleDeviceNameChange = (deviceId, newName) => {
    if (newName) {
      setDeviceNames(prev => ({ ...prev, [deviceId]: newName }));
    } else {
      setDeviceNames(prev => {
        const updated = { ...prev };
        delete updated[deviceId];
        return updated;
      });
    }
  };

  const t = theme || themes.default;
  const settingsSectionClass = `rounded-xl border shadow-sm p-4 lg:p-6 scroll-mt-20 ${t.primary === 'tech' ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`;
  const settingsNavShellClass = t.primary === 'tech'
    ? 'bg-[#202124] border-[#3E4145]/80'
    : 'bg-slate-50 border-slate-200/80';
  const settingsNavPanelClass = t.primary === 'tech'
    ? 'bg-[#2D2F33] border-[#3E4145] shadow-[0_18px_36px_rgba(0,0,0,0.36)]'
    : 'bg-white border-slate-200 shadow-[0_18px_36px_rgba(15,23,42,0.14)]';
  const settingsNavItemClass = t.primary === 'tech'
    ? 'border-[#4A4D52] text-[#BDC1C6] hover:bg-[#3E4145] hover:text-[#E8EAED]'
    : 'border-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-800';
  const settingsNavActiveItemClass = t.primary === 'tech'
    ? 'border-emerald-500/45 bg-emerald-500/15 text-emerald-300 shadow-sm'
    : 'border-emerald-500/35 bg-emerald-50 text-emerald-700 shadow-sm';
  const scrollToSettingsSection = (sectionId) => {
    setActiveSettingsSection(sectionId);
    document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const settingsSections = useMemo(() => [
    { id: 'settings-commands', label: '快捷命令', icon: ClipboardList },
    { id: 'settings-cast', label: '投屏', icon: Smartphone },
    { id: 'settings-paths', label: '保存路径', icon: Folder },
    { id: 'settings-appearance', label: '外观', icon: Palette },
    { id: 'settings-update', label: '更新', icon: Package },
    { id: 'settings-danger', label: '高危操作', icon: RotateCcw }
  ], []);

  useEffect(() => {
    if (activeTab !== 'settings') return undefined;

    const scrollContainer = document.querySelector('main');
    const sectionElements = settingsSections
      .map((item) => document.getElementById(item.id))
      .filter(Boolean);

    if (!scrollContainer || sectionElements.length === 0) return undefined;

    let frameId = null;
    const updateActiveSection = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(() => {
        const navShell = scrollContainer.querySelector('[data-settings-nav="true"]');
        const targetY = (navShell?.getBoundingClientRect().bottom ?? scrollContainer.getBoundingClientRect().top) + 16;
        let currentSectionId = sectionElements[0].id;

        sectionElements.forEach((sectionElement) => {
          if (sectionElement.getBoundingClientRect().top <= targetY) {
            currentSectionId = sectionElement.id;
          }
        });

        setActiveSettingsSection((prev) => (prev === currentSectionId ? prev : currentSectionId));
      });
    };

    updateActiveSection();
    scrollContainer.addEventListener('scroll', updateActiveSection, { passive: true });
    window.addEventListener('resize', updateActiveSection);

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      scrollContainer.removeEventListener('scroll', updateActiveSection);
      window.removeEventListener('resize', updateActiveSection);
    };
  }, [activeTab, settingsSections]);

  return (
    <div className={`flex h-screen select-none ${t.primary === 'tech' ? 'bg-[#202124] text-[#E8EAED]' : 'bg-slate-50 text-slate-900'}`}>
      {/* Toast 提示 */}
      {toast && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 px-4 py-2 bg-[#2D2F33] text-white rounded-lg shadow-lg text-sm">
          {toast}
        </div>
      )}
      <GlobalCommandPalette
        open={commandPaletteOpen}
        commands={globalCommands}
        theme={theme}
        onClose={() => setCommandPaletteOpen(false)}
        onRun={runGlobalCommand}
      />
      {/* 更新说明弹窗（版本升级后首次打开时显示，放在顶层确保任何页面都能弹出） */}
      {showChangelog && changelogContent && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[100] p-4">
          <div className={`w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden ${t.primary === 'tech' ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
            <div className="relative px-6 py-5 bg-gradient-to-br from-cyan-500/20 via-purple-500/20 to-emerald-500/20 border-b border-[#3E4145]/50">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-emerald-500 flex items-center justify-center shadow-lg">
                  <DownloadCloud size={24} className="text-white" />
                </div>
                <div className="flex-1">
                  <h3 className={`text-lg font-bold ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                    {changelogContent.title}
                  </h3>
                  <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>
                    发布日期：{changelogContent.date}
                  </p>
                </div>
                <button
                  onClick={() => setShowChangelog(false)}
                  className={`p-1.5 rounded-lg transition-colors ${t.primary === 'tech' ? 'text-[#9AA0A6] hover:bg-[#3E4145] hover:text-[#E8EAED]' : 'text-[#9AA0A6] hover:bg-slate-100 hover:text-slate-600'}`}
                >
                  <X size={20} />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-2.5">
              {changelogContent.items.map((item, idx) => {
                const typeConfig = {
                  feature: { label: '新增', color: t.primary === 'tech' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-emerald-50 text-emerald-700 border-emerald-200' },
                  fix: { label: '修复', color: t.primary === 'tech' ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-red-50 text-red-600 border-red-200' },
                  improve: { label: '优化', color: t.primary === 'tech' ? 'bg-cyan-500/20 text-cyan-400 border-cyan-500/30' : 'bg-cyan-50 text-cyan-600 border-cyan-200' }
                };
                const cfg = typeConfig[item.type] || typeConfig.improve;
                return (
                  <div key={idx} className="flex items-center gap-3">
                    <span className={`inline-flex h-6 min-w-11 shrink-0 items-center justify-center px-2 text-[10px] leading-none font-semibold rounded border ${cfg.color}`}>
                      {cfg.label}
                    </span>
                    <span className={`text-sm leading-6 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>
                      {item.text}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className={`px-6 py-4 border-t flex items-center justify-between ${t.primary === 'tech' ? 'border-[#3E4145] bg-[#202124]/50' : 'border-slate-100 bg-slate-50'}`}>
              <span className={`text-xs ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                感谢使用，如有问题请反馈
              </span>
              <button
                onClick={() => setShowChangelog(false)}
                className={`px-5 py-2 text-sm font-medium rounded-lg transition-all active:scale-95 shadow-sm ${
                  t.primary === 'tech'
                    ? 'bg-gradient-to-r from-cyan-500 to-emerald-500 hover:from-cyan-600 hover:to-emerald-600 text-white'
                    : 'bg-gradient-to-r from-cyan-600 to-emerald-600 hover:from-cyan-700 hover:to-emerald-700 text-white'
                }`}
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
      <DangerConfirmModal
        open={!!confirmModal}
        theme={theme}
        title={confirmModal?.title}
        message={confirmModal?.message}
        detail={confirmModal?.detail}
        bullets={confirmModal?.bullets || []}
        confirmLabel={confirmModal?.confirmLabel || '确定'}
        cancelLabel={confirmModal?.cancelLabel || '取消'}
        tone={confirmModal?.tone || 'danger'}
        loading={confirmLoading}
        rememberChoice={!!confirmModal?.rememberChoice}
        rememberLabel={confirmModal?.rememberLabel || '下次不再提示'}
        onRememberChoiceChange={confirmModal?.rememberKey ? (checked) => {
          setConfirmModal(prev => prev ? { ...prev, rememberChoice: checked } : prev);
        } : undefined}
        onCancel={() => setConfirmModal(null)}
        onConfirm={runConfirmModal}
      />

      {/* 更新安装确认对话框（带加载条） */}
      {updateInstallModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className={`p-6 rounded-xl shadow-2xl max-w-sm w-full mx-4 ${t.primary === 'tech' ? 'bg-[#2D2F33]' : 'bg-white'}`}>
            {!updateInstalling ? (
              <>
                <div className="flex items-center gap-3 mb-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center ${t.primary === 'tech' ? 'bg-emerald-500/20' : 'bg-emerald-100'}`}>
                    <DownloadCloud size={20} className="text-emerald-500" />
                  </div>
                  <div>
                    <h3 className={`text-base font-semibold ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                      安装更新并重启
                    </h3>
                    <p className={`text-xs ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                      新版本 v{updaterState.info?.version || '未知'} 已准备就绪
                    </p>
                  </div>
                </div>
                <p className={`mb-5 text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-slate-600'}`}>
                  安装过程中应用将自动关闭并重启，请确保已保存所有操作。是否立即安装？
                </p>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => setUpdateInstallModal(false)}
                    className={`px-4 py-2 text-sm rounded-lg transition-colors ${t.primary === 'tech' ? 'bg-[#3E4145] text-[#E8EAED] hover:bg-slate-600' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
                  >
                    稍后
                  </button>
                  <button
                    onClick={async () => {
                      setUpdateInstalling(true);
                      // 短暂延迟让加载条可见，然后执行安装
                      setTimeout(() => {
                        window.electronAPI?.installUpdate?.();
                      }, 800);
                    }}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition-colors"
                  >
                    <RefreshCw size={14} />
                    安装并重启
                  </button>
                </div>
              </>
            ) : (
              <div className="py-4">
                <div className="flex items-center justify-center mb-4">
                  <Loader2 size={32} className="animate-spin text-emerald-500" />
                </div>
                <p className={`text-center text-sm mb-4 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>
                  正在安装更新，应用即将重启…
                </p>
                <div className={`h-1.5 rounded-full overflow-hidden ${t.primary === 'tech' ? 'bg-[#3E4145]' : 'bg-slate-200'}`}>
                  <div className="h-full bg-emerald-500 rounded-full animate-[loading_1.2s_ease-in-out_infinite]" style={{ width: '100%' }} />
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {environmentCheckModalOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-6"
          onClick={() => setEnvironmentCheckModalOpen(false)}
        >
          <div
            className={`flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border shadow-2xl ${t.primary === 'tech' ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className={`flex items-center justify-between gap-4 border-b px-6 py-4 ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-200'}`}>
              <div>
                <h3 className={`text-lg font-semibold ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                  环境自检
                </h3>
                <p className={`mt-1 text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>
                  检查 ADB、scrcpy 和设备授权状态
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEnvironmentCheckModalOpen(false)}
                className={`rounded-lg p-2 transition-colors ${t.primary === 'tech' ? 'text-[#9AA0A6] hover:bg-[#3E4145] hover:text-[#E8EAED]' : 'text-slate-500 hover:bg-slate-200 hover:text-slate-700'}`}
                aria-label="关闭环境自检"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5">
              <EnvironmentCheckWizard
                devices={devices}
                theme={theme}
                showToast={showToast}
                onRefreshDevices={fetchDevices}
              />
            </div>
          </div>
        </div>
      )}
      {/* Sidebar */}
      <div className="w-60 lg:w-64 shrink-0 flex flex-col pt-6 lg:pt-8 bg-[#202124] text-[#E8EAED]">
        <div className={`px-4 lg:px-5 mb-6 lg:mb-8 flex items-center space-x-3 ${t.primary === 'cyan' || t.primary === 'blue' ? 'text-cyan-400' : t.primary === 'pink' ? 'text-pink-400' : t.primary === 'green' ? 'text-green-400' : t.primary === 'orange' ? 'text-orange-400' : 'text-emerald-400'}`}>
          <Smartphone size={28} />
          <h1 className="text-xl font-bold tracking-wide">卓控台</h1>
        </div>

        <nav className="flex-1 px-3 lg:px-4 space-y-2">
          <button
            onClick={() => setActiveTab('devices')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'devices' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <Smartphone size={20} />
            <span className="font-medium">设备列表</span>
          </button>
          <button
            onClick={() => setActiveTab('troubleshoot')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'troubleshoot' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <ClipboardCheck size={20} />
            <span className="font-medium">问题排查</span>
          </button>
          <button
            onClick={() => setActiveTab('performance')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'performance' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <Gauge size={20} />
            <span className="font-medium">性能监控</span>
          </button>
          <button
            onClick={() => setActiveTab('quality')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'quality' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <ShieldCheck size={20} />
            <span className="font-medium">质量中心</span>
          </button>
          <button
            onClick={() => setActiveTab('tasks')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'tasks' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <ClipboardList size={20} />
            <span className="font-medium">任务中心</span>
          </button>
          <button
            onClick={() => setActiveTab('artifacts')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'artifacts' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <FolderOpen size={20} />
            <span className="font-medium">产物中心</span>
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'settings' ? `${t.primary === 'cyan' || t.primary === 'blue' ? 'bg-cyan-500/20 text-cyan-400' : t.primary === 'pink' ? 'bg-pink-500/20 text-pink-400' : t.primary === 'green' ? 'bg-green-500/20 text-green-400' : t.primary === 'orange' ? 'bg-orange-500/20 text-orange-400' : 'bg-emerald-500/20 text-emerald-400'}` : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <Settings size={20} />
            <span className="font-medium">偏好设置</span>
          </button>
          <button
            onClick={() => {
              if (window.electronAPI && window.electronAPI.logAnalyzerOpen) {
                window.electronAPI.logAnalyzerOpen();
              }
            }}
            className="w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors hover:bg-[#2D2F33]"
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <Bot size={20} />
            <span className="font-medium">AI 日志助手</span>
          </button>
          <button
            onClick={() => {
              setActiveTab('member');
              refreshVipStatus();
            }}
            className={`w-full flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${activeTab === 'member' ? 'bg-amber-500/20 text-amber-400' : 'hover:bg-[#2D2F33]'}`}
            style={{ WebkitAppRegion: 'no-drag' }}
          >
            <Crown size={20} />
            <span className="font-medium">会员中心</span>
          </button>
        </nav>

        <BackgroundTaskStack
          tasks={buildSidebarBackgroundTasks(backgroundTasks)}
          onOpen={(tab) => setActiveTab(tab)}
        />

        {/* 左下角更新安装入口（已下载完成时显示） */}
        {updaterState.downloaded && (
          <div className="px-4 py-3 border-t border-[#3E4145]">
            <button
              onClick={() => setUpdateInstallModal(true)}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 transition-all active:scale-95"
              title={`新版本 v${updaterState.info?.version || ''} 已就绪，点击安装并重启`}
            >
              <div className="relative">
                <DownloadCloud size={20} />
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
              </div>
              <div className="flex-1 text-left">
                <div className="text-xs font-semibold">新版本已就绪</div>
                <div className="text-[10px] opacity-70">v{updaterState.info?.version || '未知'} · 点击安装</div>
              </div>
            </button>
          </div>
        )}
      </div>

      {/* Main Content */}
      <div className="min-w-0 flex-1 flex flex-col pt-6 lg:pt-8 h-screen overflow-hidden">
        {/* Header */}
        <header className={`px-4 lg:px-6 xl:px-8 pb-4 lg:pb-6 border-b flex flex-wrap justify-between items-center gap-3 sticky top-0 z-10 ${t.primary === 'tech' ? 'bg-[#202124]/90 border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
          <div className="min-w-0">
            {/* 性能监控 Tab 标题与描述 */}
            <h2 className={`text-2xl font-bold ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
              {activeTab === 'devices' ? '已连接设备' : activeTab === 'troubleshoot' ? '问题排查' : activeTab === 'artifacts' ? '产物中心' : activeTab === 'quality' ? '质量中心' : activeTab === 'history' ? '连接历史' : activeTab === 'tasks' ? '任务中心' : activeTab === 'performance' ? '性能监控' : activeTab === 'member' ? '会员中心' : '全局设置'}
            </h2>
            <p className={`text-sm mt-1 ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>
              {activeTab === 'devices' ? '管理并投屏您的 Android 设备' : activeTab === 'troubleshoot' ? '按问题场景自动采集诊断证据' : activeTab === 'artifacts' ? '集中查看报告、数据和证据目录' : activeTab === 'quality' ? '生成回归差异报告、验收证据和设备守护记录' : activeTab === 'history' ? '查看无线连接历史记录' : activeTab === 'tasks' ? '编排复现脚本并批量运行到多台设备' : activeTab === 'performance' ? '观察设备资源与进程状态' : activeTab === 'member' ? '管理您的会员权益与激活' : '配置 Scrcpy 及 ADB 相关偏好'}
            </p>
          </div>

          {activeTab === 'devices' && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setEnvironmentCheckModalOpen(true)}
                className={`flex items-center space-x-2 rounded-lg border px-4 py-2 font-medium transition-colors ${t.primary === 'tech' ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
              >
                <ClipboardCheck size={18} />
                <span>环境自检</span>
              </button>
              <button
                onClick={fetchDevices}
                disabled={loading}
                className={`flex items-center space-x-2 px-4 py-2 rounded-lg font-medium transition-colors disabled:opacity-50 ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''}`}
              >
                <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                <span>刷新</span>
              </button>
            </div>
          )}
        </header>

        {/* Content Area */}
        <main className="flex-1 overflow-y-auto p-4 lg:p-6 xl:p-8">
          {error && (
            <div className={`p-4 rounded-lg mb-6 border ${t.primary === 'tech' ? 'bg-red-900/30 text-red-400 border-red-800' : 'bg-red-50 text-red-600 border-red-200'}`}>
              {error}
            </div>
          )}

          {activeTab === 'devices' && (
            <>
              {/* Wi-Fi Connect Section */}
              <div className={`mb-6 lg:mb-8 p-4 lg:p-5 rounded-xl border shadow-sm flex flex-col xl:flex-row xl:items-center justify-between gap-4 ${t.primary === 'tech' ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
                <div className="min-w-0 w-full xl:w-auto">
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className={`text-base lg:text-lg font-semibold flex items-center gap-2 whitespace-nowrap ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                      <Wifi size={20} className={t.primary === 'cyan' || t.primary === 'blue' ? 'text-blue-400' : t.primary === 'pink' ? 'text-pink-400' : t.primary === 'green' ? 'text-green-400' : t.primary === 'orange' ? 'text-orange-400' : 'text-emerald-500'} />
                      Wi-Fi 无线连接
                    </h3>
                    <button
                      type="button"
                      onClick={() => setActiveTab('history')}
                      title="查看无线连接历史"
                      className={`inline-flex w-fit items-center gap-2 px-3 py-1.5 rounded-lg border text-sm font-medium transition-colors ${t.primary === 'tech' ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
                    >
                      <History size={16} />
                      <span>连接历史</span>
                      <span className={`px-1.5 py-0.5 rounded-full text-[11px] leading-none ${t.primary === 'tech' ? 'bg-[#3E4145] text-[#BDC1C6]' : 'bg-slate-100 text-slate-500'}`}>
                        {connectionHistory.length}
                      </span>
                    </button>
                  </div>
                  <p className={`text-sm mt-1 ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>输入设备的 IP 地址和端口 (例如: 192.168.1.100:5555)</p>
                </div>
                <form onSubmit={handleWifiConnect} className="flex w-full xl:w-auto gap-2">
                  <input
                    type="text"
                    value={wifiIp}
                    onChange={(e) => setWifiIp(e.target.value)}
                    placeholder="IP 地址:端口"
                    className={`min-w-0 flex-1 xl:w-64 px-4 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none transition-all ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-400' : 'bg-slate-50 border-slate-200'}`}
                  />
                  <button
                    type="submit"
                    disabled={isConnecting || !wifiIp.trim()}
                    className={`px-6 py-2 rounded-lg font-medium transition-colors whitespace-nowrap ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} disabled:opacity-50`}
                  >
                    {isConnecting ? '连接中...' : '连接'}
                  </button>
                </form>
              </div>

              <div className="grid gap-6 grid-cols-1 xl:grid-cols-2">
                {devices.length === 0 && !loading && !error ? (
                  <div className={`col-span-full flex flex-col items-center justify-center py-20 ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#9AA0A6]'}`}>
                    <Smartphone size={48} className={`mb-4 opacity-50 ${t.primary === 'cyan' || t.primary === 'blue' ? 'text-cyan-400' : t.primary === 'pink' ? 'text-pink-400' : t.primary === 'green' ? 'text-green-400' : t.primary === 'orange' ? 'text-orange-400' : 'text-emerald-400'}`} />
                    <p className="text-lg">未发现设备</p>
                    <p className="text-sm">请确保已开启 USB 调试并连接设备</p>
                  </div>
                ) : (
                  (() => {
                    const FREE_DEVICE_LIMIT = 1;
                    const isVipOrLoading = vipStatus.activated || vipStatus.reason === 'loading';
                    const visibleDevices = isVipOrLoading ? devices : devices.slice(0, FREE_DEVICE_LIMIT);
                    const lockedCount = isVipOrLoading ? 0 : Math.max(0, devices.length - FREE_DEVICE_LIMIT);
                    return (
                      <>
                        {visibleDevices.map(device => (
                    <DeviceCard
                      key={device.id}
                      device={device}
                      deviceName={deviceNames[device.id]}
                      onNameChange={handleDeviceNameChange}
                      onStart={() => handleStartScrcpy(device.id)}
                      onCommand={(cmd) => handleAdbCommand(device.id, cmd)}
                      onScreenshot={() => handleScreenshot(device.id)}
                      onScreenRecordStart={(deviceId) => handleScreenRecordStart(deviceId)}
                      onScreenRecordStop={(deviceId) => handleScreenRecordStop(deviceId)}
                      onReboot={() => handleReboot(device.id)}
                      onRebootLoader={() => handleRebootLoader(device.id)}
                      onUnlock={() => handleUnlock(device.id)}
                      onRoot={() => handleRoot(device.id)}
                      onRemount={() => handleRemount(device.id)}
                      onDisconnect={() => handleDisconnect(device.id)}
                      showApkManager={expandedDeviceIds.has(device.id)}
                      onApkManager={() => {
                        setExpandedDeviceIds(prev => {
                          const next = new Set(prev);
                          if (next.has(device.id)) {
                            next.delete(device.id);
                          } else {
                            next.add(device.id);
                          }
                          return next;
                        });
                      }}
                      onSelectApkForInstall={() => handleSelectApkFile(device.id, 'install')}
                      onSelectApkForPush={() => handleSelectApkFile(device.id, 'push')}
                      onInstallApk={() => handleInstallApk(device.id)}
                      onPushApk={() => handlePushApk(device.id)}
                      onBrowsePath={(path) => handleBrowseApk(device.id, path)}
                      onPullFile={(path) => handlePullFile(device.id, path)}
                      onPushPathChange={(path) => setApkPushRemotePaths(prev => ({ ...prev, [device.id]: path }))}
                      onPushLocalPathChange={(path) => setApkPushPaths(prev => ({ ...prev, [device.id]: path }))}
                      onInstallPathChange={(path) => setApkInstallPaths(prev => ({ ...prev, [device.id]: path }))}
                      showToast={showToast}
                      apkInstallPath={apkInstallPaths[device.id] ?? ''}
                      apkPushPath={apkPushPaths[device.id] ?? ''}
                      apkInstallResult={apkInstallResults[device.id] ?? null}
                      apkPushResult={apkPushResults[device.id] ?? null}
                      apkPushRemotePath={apkPushRemotePaths[device.id] !== undefined ? apkPushRemotePaths[device.id] : '/sdcard/'}
                      pushRemotePathHistory={pushRemotePathHistory}
                      apkBrowserPath={apkBrowserPaths[device.id] ?? '/sdcard'}
                      apkBrowserItems={apkBrowserItemsMap[device.id] || []}
                      apkBrowserLoading={apkBrowserLoadingMap[device.id] || false}
                      operationLoading={operationLoading}
                      onExecuteCommand={handleExecuteCommand}
                      theme={theme}
                      sharedCommandHistory={terminalCommandHistory}
                      onSaveTerminalCommand={handleSaveTerminalCommand}
                      onClearTerminalHistory={handleClearTerminalHistory}
                      vipStatus={vipStatus}
                      inspectionPath={inspectionPath}
                      onInspectionPathChange={setInspectionPath}
                      onOpenMemberCenter={() => setActiveTab('member')}
                    />
                  ))}
                  {lockedCount > 0 && (
                    <div className={`col-span-full flex items-center justify-center gap-3 p-6 rounded-xl border-2 border-dashed ${t.primary === 'tech' ? 'border-[#3E4145] bg-slate-800/40' : 'border-slate-300 bg-slate-50'}`}>
                      <Lock size={20} className="text-amber-400" />
                      <span className={`text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                        还有 {lockedCount} 台设备已连接，<button onClick={() => setActiveTab('member')} className="text-amber-400 hover:underline font-medium">开通会员</button>解锁全部
                      </span>
                    </div>
                  )}
                      </>
                    );
                  })()
                )}
              </div>
            </>
          )}

          {activeTab === 'troubleshoot' && (
            <TroubleshootingWizard
              devices={devices}
              theme={theme}
              vipStatus={vipStatus}
              showToast={showToast}
              onOpenMemberCenter={() => setActiveTab('member')}
            />
          )}

          {activeTab === 'artifacts' && (
            <ArtifactCenter
              theme={theme}
              showToast={showToast}
              showConfirm={showConfirm}
            />
          )}

          {activeTab === 'quality' && (
            <QualityCenter
              devices={devices}
              deviceLoading={loading}
              onRefreshDevices={fetchDevices}
              theme={theme}
              showToast={showToast}
            />
          )}

          {activeTab === 'history' && (
            <div className="space-y-6">
              {/* 连接历史记录页面 */}
              <div className={`p-6 rounded-xl border shadow-sm ${t.primary === 'tech' ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setActiveTab('devices')}
                      className={`inline-flex w-fit items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${t.primary === 'tech' ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
                    >
                      <ArrowLeft size={16} />
                      返回设备列表
                    </button>
                    <h3 className={`text-lg font-semibold flex items-center gap-2 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                      <History size={20} className={t.primary === 'cyan' || t.primary === 'blue' ? 'text-blue-400' : t.primary === 'pink' ? 'text-pink-400' : t.primary === 'green' ? 'text-green-400' : t.primary === 'orange' ? 'text-orange-400' : 'text-emerald-500'} />
                      连接历史
                      <span className={`text-sm font-normal ml-2 px-2 py-0.5 rounded-full ${t.primary === 'tech' ? 'bg-[#3E4145] text-[#9AA0A6]' : 'bg-slate-100 text-[#80868B]'}`}>
                        {connectionHistory.length} 条
                      </span>
                    </h3>
                  </div>
                  {connectionHistory.length > 0 && (
                    <button
                      onClick={() => {
                        showConfirm({
                          title: '清除连接历史',
                          message: '确定要清除所有连接历史吗？',
                          confirmLabel: '清除历史',
                          rememberKey: 'history.clearConnections',
                          onConfirm: async () => {
                            if (window.electronAPI) {
                              await window.electronAPI.clearConnectionHistory();
                            }
                            setConnectionHistory([]);
                            showToast('历史记录已清除');
                          }
                        });
                      }}
                      className={`text-sm px-4 py-2 rounded-lg transition-colors flex items-center gap-2 ${t.primary === 'tech' ? 'text-[#9AA0A6] hover:text-red-400 hover:bg-red-900/30' : 'text-[#80868B] hover:text-red-600 hover:bg-red-50'}`}
                    >
                      <RotateCcw size={14} />
                      一键清除
                    </button>
                  )}
                </div>
                {connectionHistory.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-16">
                    <History size={48} className={`mb-4 opacity-30 ${t.primary === 'cyan' || t.primary === 'blue' ? 'text-cyan-400' : t.primary === 'pink' ? 'text-pink-400' : t.primary === 'green' ? 'text-green-400' : t.primary === 'orange' ? 'text-orange-400' : 'text-emerald-400'}`} />
                    <p className={`text-lg ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>暂无连接历史</p>
                    <p className={`text-sm mt-1 ${t.primary === 'tech' ? 'text-slate-600' : 'text-[#9AA0A6]'}`}>通过 Wi-Fi 连接设备后会显示在这里</p>
                  </div>
                ) : (
                  <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                    {(() => {
                      const FREE_HISTORY_LIMIT = 5;
                      const isVipOrLoading = vipStatus.activated || vipStatus.reason === 'loading';
                      const visibleHistory = isVipOrLoading ? connectionHistory : connectionHistory.slice(0, FREE_HISTORY_LIMIT);
                      const lockedHistoryCount = isVipOrLoading ? 0 : Math.max(0, connectionHistory.length - FREE_HISTORY_LIMIT);
                      return (
                        <>
                          {visibleHistory.map((item) => (
                      <div
                        key={item.id}
                        className={`p-4 rounded-xl border transition-all hover:shadow-md group ${t.primary === 'tech' ? 'bg-slate-700/50 border-[#5F6368] hover:border-slate-500' : 'bg-slate-50 border-slate-200 hover:border-slate-300'}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-2">
                              <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${t.primary === 'tech' ? 'bg-slate-600' : 'bg-slate-200'}`}>
                                {item.type === 'wifi' ? (
                                  <Wifi size={16} className="text-emerald-500" />
                                ) : (
                                  <Smartphone size={16} className="text-slate-500" />
                                )}
                              </div>
                              <span className={`font-semibold truncate ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>
                                {item.deviceName}
                              </span>
                            </div>
                            {item.ip && (
                              <div className="flex items-center gap-2 mb-2">
                                <code className={`text-sm px-2 py-1 rounded ${t.primary === 'tech' ? 'bg-slate-600 text-[#E8EAED]' : 'bg-slate-200 text-slate-600'}`}>{item.ip}</code>
                                <button
                                  onClick={() => {
                                    navigator.clipboard.writeText(item.ip);
                                    showToast('IP 已复制');
                                  }}
                                  className={`p-1.5 rounded-lg transition-colors ${t.primary === 'tech' ? 'hover:bg-slate-600 text-[#9AA0A6] hover:text-[#E8EAED]' : 'hover:bg-slate-200 text-[#9AA0A6] hover:text-slate-600'}`}
                                  title="复制 IP"
                                >
                                  <Copy size={14} />
                                </button>
                              </div>
                            )}
                            <div className={`text-xs ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                              {new Date(item.timestamp).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </div>
                          </div>
                        </div>
                        <div className={`mt-3 pt-3 border-t flex gap-2 ${t.primary === 'tech' ? 'border-[#5F6368]' : 'border-slate-200'}`}>
                          <button
                            onClick={() => {
                              setWifiIp(item.ip || item.deviceId);
                              setActiveTab('devices');
                              showToast('已填入 IP，请点击连接');
                            }}
                            className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''}`}
                          >
                            连接
                          </button>
                        </div>
                      </div>
                    ))}
                    {lockedHistoryCount > 0 && (
                      <div className={`col-span-full flex items-center justify-center gap-3 p-5 rounded-xl border-2 border-dashed ${t.primary === 'tech' ? 'border-[#3E4145] bg-slate-800/40' : 'border-slate-300 bg-slate-50'}`}>
                        <Lock size={18} className="text-amber-400" />
                        <span className={`text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                          还有 {lockedHistoryCount} 条历史记录，<button onClick={() => setActiveTab('member')} className="text-amber-400 hover:underline font-medium">开通会员</button>查看全部
                        </span>
                      </div>
                    )}
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'tasks' && (
            <TaskCenter
              devices={devices}
              theme={theme}
              taskCenterPath={taskCenterPath}
              showToast={showToast}
            />
          )}

          {/* 性能监控页面 */}
          {activeTab === 'performance' && (
            <PerformanceDashboard
              devices={devices}
              theme={theme}
              vipStatus={vipStatus}
              performancePath={performancePath}
              showToast={showToast}
              onOpenMemberCenter={() => setActiveTab('member')}
              onRefreshVipStatus={refreshVipStatus}
            />
          )}

          {activeTab === 'member' && (
            <MemberCenter
              theme={theme}
              vipStatus={vipStatus}
              onActivated={refreshVipStatus}
              showToast={showToast}
            />
          )}

          {activeTab === 'settings' && (
            <div className="space-y-4">
              <div data-settings-nav="true" className={`sticky -top-4 z-[8] -mx-4 -mt-4 px-4 pt-2 pb-2 border-b lg:-top-6 lg:-mx-6 lg:-mt-6 lg:px-6 lg:pt-3 xl:-top-8 xl:-mx-8 xl:-mt-8 xl:px-8 xl:pt-3 ${settingsNavShellClass}`}>
                <div className={`rounded-xl border p-1.5 ${settingsNavPanelClass}`}>
                  <div className="flex gap-2 overflow-x-auto pb-0.5">
                    {settingsSections.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeSettingsSection === item.id;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          aria-current={isActive ? 'true' : undefined}
                          onClick={() => scrollToSettingsSection(item.id)}
                          className={`min-w-[128px] shrink-0 xl:min-w-0 xl:flex-1 px-3 py-2 rounded-lg border text-sm font-medium flex items-center justify-center gap-2 transition-all ${isActive ? settingsNavActiveItemClass : settingsNavItemClass}`}
                        >
                          <Icon size={15} className="shrink-0" />
                          <span className="whitespace-nowrap">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>

              <section id="settings-commands" className={settingsSectionClass}>
              <GlobalCommandSettings
                settings={globalCommandSettings}
                theme={theme}
                onChange={setGlobalCommandSettings}
              />
              </section>

              <section id="settings-cast" className={settingsSectionClass}>
              <h3 className={`text-lg font-semibold mb-4 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>Scrcpy 投屏设置</h3>
              <p className={`text-sm mb-6 ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>这些设置将在启动新的投屏会话时应用。</p>

              <div className="space-y-4">
                <div className={`flex items-center justify-between py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div>
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>投屏时关闭设备屏幕</span>
                    <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>--turn-screen-off</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={scrcpySettings.screenOff}
                      onChange={(e) => setScrcpySettings(prev => ({ ...prev, screenOff: e.target.checked }))}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                  </label>
                </div>

                <div className={`flex items-center justify-between py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div>
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>保持唤醒</span>
                    <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>设备在投屏期间保持唤醒状态</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={scrcpySettings.stayAwake}
                      onChange={(e) => setScrcpySettings(prev => ({ ...prev, stayAwake: e.target.checked }))}
                      className="sr-only peer"
                    />
                    <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                  </label>
                </div>

                <div className={`flex items-center justify-between py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div>
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>视频比特率</span>
                    <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>--video-bit-rate</p>
                  </div>
                  <select
                    value={scrcpySettings.bitrate}
                    onChange={(e) => setScrcpySettings(prev => ({ ...prev, bitrate: e.target.value }))}
                    className={`border text-sm rounded-lg focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                  >
                    <option value="2 Mbps">2 Mbps</option>
                    <option value="4 Mbps">4 Mbps</option>
                    <option value="8 Mbps">8 Mbps (推荐)</option>
                    <option value="16 Mbps">16 Mbps</option>
                    <option value="32 Mbps">32 Mbps</option>
                  </select>
                </div>

                <div className={`flex items-center justify-between py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div>
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>最大分辨率</span>
                    <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>--max-size，0 表示不限制</p>
                  </div>
                  <select
                    value={scrcpySettings.maxSize}
                    onChange={(e) => setScrcpySettings(prev => ({ ...prev, maxSize: e.target.value }))}
                    className={`border text-sm rounded-lg focus:ring-emerald-500 focus:border-emerald-500 block p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                  >
                    <option value="0">不限制</option>
                    <option value="1920">1920</option>
                    <option value="1280">1280</option>
                    <option value="1024">1024</option>
                    <option value="720">720</option>
                  </select>
                </div>
              </div>
              </section>

              <section id="settings-paths" className={settingsSectionClass}>
                <div className="mb-5">
                  <h3 className={`text-lg font-semibold ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>保存路径</h3>
                  <p className={`text-sm mt-1 ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>集中管理截图、录屏、巡检、性能、任务和质量产物目录。</p>
                </div>
                <div className="space-y-4">
                {/* 截图保存路径设置 */}
                <div className={`py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Camera size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>截图保存路径</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={screenshotPath}
                      onChange={(e) => setScreenshotPath(e.target.value)}
                      placeholder="默认: %APPDATA%/adb-workbench/screenshot/"
                      className={`flex-1 border text-sm rounded-lg p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    />
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          const result = await window.electronAPI.selectFolder();
                          if (result.success && result.path) {
                            setScreenshotPath(result.path);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <FolderOpen size={16} />
                      浏览
                    </button>
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          let targetPath = screenshotPath;
                          if (!targetPath) {
                            const userDataResult = await window.electronAPI.getUserDataPath();
                            targetPath = userDataResult.success ? `${userDataResult.path}/screenshot` : '';
                          }
                          if (targetPath) {
                            await window.electronAPI.openFolder(targetPath);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <Folder size={16} />
                      打开
                    </button>
                  </div>
                  <p className={`text-xs mt-1.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                    截图将保存到此目录，默认为 %APPDATA%/adb-workbench/screenshot/
                  </p>
                </div>

                {/* 录屏保存路径设置 */}
                <div className={`py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Video size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>录屏保存路径</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={screenRecordPath}
                      onChange={(e) => setScreenRecordPath(e.target.value)}
                      placeholder="默认: %APPDATA%/adb-workbench/screenrecord/"
                      className={`flex-1 border text-sm rounded-lg p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    />
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          const result = await window.electronAPI.selectFolder();
                          if (result.success && result.path) {
                            setScreenRecordPath(result.path);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <FolderOpen size={16} />
                      浏览
                    </button>
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          let targetPath = screenRecordPath;
                          if (!targetPath) {
                            const userDataResult = await window.electronAPI.getUserDataPath();
                            targetPath = userDataResult.success ? `${userDataResult.path}/screenrecord` : '';
                          }
                          if (targetPath) {
                            await window.electronAPI.openFolder(targetPath);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <Folder size={16} />
                      打开
                    </button>
                  </div>
                  <p className={`text-xs mt-1.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                    录屏文件将保存到此目录，默认为 %APPDATA%/adb-workbench/screenrecord/
                  </p>
                </div>

                {/* 巡检保存路径设置 */}
                <div className={`py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <ClipboardCheck size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>巡检保存路径</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={inspectionPath}
                      onChange={(e) => setInspectionPath(e.target.value)}
                      placeholder="默认: %APPDATA%/adb-workbench/inspection/"
                      className={`flex-1 border text-sm rounded-lg p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    />
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          const result = await window.electronAPI.selectFolder();
                          if (result.success && result.path) {
                            setInspectionPath(result.path);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <FolderOpen size={16} />
                      浏览
                    </button>
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          let targetPath = inspectionPath;
                          if (!targetPath) {
                            const userDataResult = await window.electronAPI.getUserDataPath();
                            targetPath = userDataResult.success ? `${userDataResult.path}/inspection` : '';
                          }
                          if (targetPath) {
                            await window.electronAPI.openFolder(targetPath);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <Folder size={16} />
                      打开
                    </button>
                  </div>
                  <p className={`text-xs mt-1.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                    巡检报告和证据包将保存到此目录，默认为 %APPDATA%/adb-workbench/inspection/
                  </p>
                </div>

                {/* 性能导出保存路径设置 */}
                <div className={`py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <Gauge size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>性能导出保存路径</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={performancePath}
                      onChange={(e) => setPerformancePath(e.target.value)}
                      placeholder="默认: %APPDATA%/adb-workbench/performance-monitor/"
                      className={`flex-1 border text-sm rounded-lg p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    />
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          const result = await window.electronAPI.selectFolder();
                          if (result.success && result.path) {
                            setPerformancePath(result.path);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <FolderOpen size={16} />
                      浏览
                    </button>
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          let targetPath = performancePath;
                          if (!targetPath) {
                            const userDataResult = await window.electronAPI.getUserDataPath();
                            targetPath = userDataResult.success ? `${userDataResult.path}/performance-monitor` : '';
                          }
                          if (targetPath) {
                            await window.electronAPI.ensureFolder(targetPath);
                            await window.electronAPI.openFolder(targetPath);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <Folder size={16} />
                      打开
                    </button>
                  </div>
                  <p className={`text-xs mt-1.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                    性能数据和分析报告将保存到此目录，默认为 %APPDATA%/adb-workbench/performance-monitor/
                  </p>
                </div>

                {/* 任务中心保存路径设置 */}
                <div className={`py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <ClipboardList size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>任务中心保存路径</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={taskCenterPath}
                      onChange={(e) => setTaskCenterPath(e.target.value)}
                      placeholder="默认: %APPDATA%/adb-workbench/task-center-artifacts/"
                      className={`flex-1 border text-sm rounded-lg p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    />
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          const result = await window.electronAPI.selectFolder();
                          if (result.success && result.path) {
                            setTaskCenterPath(result.path);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <FolderOpen size={16} />
                      浏览
                    </button>
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          let targetPath = taskCenterPath;
                          if (!targetPath) {
                            const userDataResult = await window.electronAPI.getUserDataPath();
                            targetPath = userDataResult.success ? `${userDataResult.path}/task-center-artifacts` : '';
                          }
                          if (targetPath) {
                            await window.electronAPI.ensureFolder(targetPath);
                            await window.electronAPI.openFolder(targetPath);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <Folder size={16} />
                      打开
                    </button>
                  </div>
                  <p className={`text-xs mt-1.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                    每次任务执行完成后，会在此目录下生成“脚本名-执行完成时间”的独立文件夹。
                  </p>
                </div>

                {/* 质量中心保存路径设置 */}
                <div className={`py-3 border-b ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <div className="flex items-center gap-2 mb-2">
                    <ShieldCheck size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>质量中心保存路径</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={qualityCenterPath}
                      onChange={(e) => setQualityCenterPath(e.target.value)}
                      placeholder="默认: %APPDATA%/adb-workbench/quality-center/"
                      className={`flex-1 border text-sm rounded-lg p-2.5 ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                    />
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          const result = await window.electronAPI.selectFolder();
                          if (result.success && result.path) {
                            setQualityCenterPath(result.path);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <FolderOpen size={16} />
                      浏览
                    </button>
                    <button
                      onClick={async () => {
                        if (window.electronAPI) {
                          let targetPath = qualityCenterPath;
                          if (!targetPath) {
                            const userDataResult = await window.electronAPI.getUserDataPath();
                            targetPath = userDataResult.success ? `${userDataResult.path}/quality-center` : '';
                          }
                          if (targetPath) {
                            await window.electronAPI.ensureFolder(targetPath);
                            await window.electronAPI.openFolder(targetPath);
                          }
                        }
                      }}
                      className={`px-3 py-2.5 rounded-lg font-medium transition-colors flex items-center gap-1.5 ${t.primary === 'tech' ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED] border border-[#5F6368]' : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-200'}`}
                    >
                      <Folder size={16} />
                      打开
                    </button>
                  </div>
                  <p className={`text-xs mt-1.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>
                    回归基线、回归报告和设备守护报告将保存到此目录，默认为 %APPDATA%/adb-workbench/quality-center/
                  </p>
                </div>
                </div>
              </section>

              <section id="settings-appearance" className={settingsSectionClass}>
                {/* Theme Selection */}
                <div className="py-3">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Palette size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                      <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>界面主题</span>
                    </div>
                    <button
                      onClick={() => {
                        setEditingTheme(null);
                        setNewThemeName('');
                        setThemeColors({
                          primary: 'emerald',
                          primaryFrom: 'from-emerald-500',
                          primaryTo: 'to-emerald-600',
                          useGradient: true,
                          secondary: 'bg-slate-100',
                          secondaryText: 'text-slate-700',
                          secondaryBorder: 'border-slate-200',
                          bg: 'bg-slate-50',
                          card: 'bg-white',
                          cardBorder: 'border-slate-200',
                          input: 'border-slate-200',
                          terminalBg: 'bg-[#202124]',
                          terminalOutput: 'bg-[#0D0E10]',
                          terminalText: 'text-[#E8EAED]',
                          terminalAccent: 'text-emerald-400'
                        });
                        setShowThemeEditor(true);
                      }}
                      className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} text-white`}
                    >
                      + 自定义主题
                    </button>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                    {Object.entries(allThemes).filter(([key]) => !key.startsWith('custom_') || customThemes.some(t => t.key === key)).map(([key, themeOption]) => {
                      const isCustom = themeOption.isCustom;
                      return (
                        <div key={key} className="relative">
                          <button
                            onClick={() => setCurrentTheme(key)}
                            className={`w-full p-3 rounded-xl border-2 transition-all ${
                              currentTheme === key
                                ? 'border-emerald-500 shadow-lg scale-105'
                                : 'border-slate-200 hover:border-slate-300 hover:shadow-md'
                            } ${themeOption.preview}`}
                          >
                            <div className={`text-xs font-medium mb-1 ${themeOption.text}`}>{themeOption.name}</div>
                            <div className="flex gap-1">
                              <div className={`w-4 h-4 rounded-full ${themeOption.button.primary.split(' ')[0]}`} />
                              <div className={`w-4 h-4 rounded-full ${themeOption.button.secondary.split(' ')[0]}`} />
                              <div className={`w-4 h-4 rounded-full ${themeOption.button.outline.split(' ')[0]}`} />
                            </div>
                            {currentTheme === key && (
                              <div className="absolute -top-2 -right-2 w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center">
                                <span className="text-white text-xs">✓</span>
                              </div>
                            )}
                          </button>
                          {isCustom && (
                            <div className="absolute -top-1 -left-1 flex gap-1">
                              <button
                                onClick={(e) => { e.stopPropagation(); editCustomTheme(themeOption); }}
                                className="w-5 h-5 bg-blue-500 hover:bg-blue-600 rounded-full flex items-center justify-center"
                                title="编辑"
                              >
                                <span className="text-white text-xs">✎</span>
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteCustomTheme(key); }}
                                className="w-5 h-5 bg-red-500 hover:bg-red-600 rounded-full flex items-center justify-center"
                                title="删除"
                              >
                                <span className="text-white text-xs">×</span>
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>

              <section id="settings-update" className={settingsSectionClass}>
                {/* 关于与更新 */}
                <div className="py-3">
                  <div className="flex items-center gap-2 mb-3">
                    <Package size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                    <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>关于与更新</span>
                  </div>

                  <div className="space-y-3">
                    {/* 版本号显示 */}
                    <div className={`flex items-center justify-between px-3 py-2 rounded-lg ${t.primary === 'tech' ? 'bg-[#3E4145]/50' : 'bg-slate-50'}`}>
                      <span className={`text-sm ${t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'}`}>当前版本</span>
                      <span className={`text-sm font-mono font-semibold ${t.primary === 'tech' ? 'text-cyan-400' : 'text-cyan-600'}`}>v{appVersion || '2.0.0'}</span>
                    </div>

                    {/* 自动更新开关 */}
                    <div className={`flex items-center justify-between py-2 ${t.primary === 'tech' ? 'border-[#3E4145]' : 'border-slate-100'} border-b`}>
                      <div>
                        <span className={`font-medium text-sm ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>启动时自动检查更新</span>
                        <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>应用启动 3 秒后自动检测新版本</p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer">
                        <input
                          type="checkbox"
                          checked={autoUpdateEnabled}
                          onChange={(e) => setAutoUpdateEnabled(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-cyan-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-cyan-500"></div>
                      </label>
                    </div>

                    {/* 更新状态与操作按钮 */}
                    <div className="space-y-2">
                      {/* 错误提示 */}
                      {updaterState.error && (
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${t.primary === 'tech' ? 'bg-red-500/10 text-red-400' : 'bg-red-50 text-red-600'}`}>
                          <AlertCircle size={14} />
                          <span className="flex-1">{updaterState.error}</span>
                        </div>
                      )}

                      {/* 检查中 */}
                      {updaterState.checking && (
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${t.primary === 'tech' ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-50 text-cyan-600'}`}>
                          <Loader2 size={14} className="animate-spin" />
                          <span>正在检查更新…</span>
                        </div>
                      )}

                      {/* 已是最新版本 */}
                      {updaterState.notAvailable && !updaterState.checking && (
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${t.primary === 'tech' ? 'bg-slate-500/10 text-slate-400' : 'bg-slate-100 text-slate-500'}`}>
                          <CheckCircle2 size={14} />
                          <span>当前已是最新版本</span>
                        </div>
                      )}

                      {/* 发现新版本 */}
                      {updaterState.available && !updaterState.downloaded && (
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${t.primary === 'tech' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'}`}>
                          <DownloadCloud size={14} />
                          <span className="font-semibold">发现新版本 v{updaterState.info?.version || '未知'}</span>
                        </div>
                      )}

                      {/* 下载进度 */}
                      {updaterState.downloading && updaterState.progress && (
                        <div className={`px-3 py-2 rounded-lg text-xs ${t.primary === 'tech' ? 'bg-cyan-500/10 text-cyan-400' : 'bg-cyan-50 text-cyan-700'}`}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="flex items-center gap-1.5">
                              <Loader2 size={12} className="animate-spin" />
                              正在下载…
                            </span>
                            <span className="font-mono">{updaterState.progress.percent.toFixed(1)}%</span>
                          </div>
                          <div className={`h-1.5 rounded-full overflow-hidden ${t.primary === 'tech' ? 'bg-[#3E4145]' : 'bg-slate-200'}`}>
                            <div
                              className="h-full bg-cyan-500 transition-all"
                              style={{ width: `${updaterState.progress.percent}%` }}
                            />
                          </div>
                          <div className="flex justify-between mt-1 opacity-70 text-[10px]">
                            <span>{(updaterState.progress.transferred / 1024 / 1024).toFixed(2)} MB</span>
                            <span>{(updaterState.progress.total / 1024 / 1024).toFixed(2)} MB</span>
                          </div>
                        </div>
                      )}

                      {/* 下载完成 */}
                      {updaterState.downloaded && (
                        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${t.primary === 'tech' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-emerald-50 text-emerald-700'}`}>
                          <CheckCircle2 size={14} />
                          <span className="flex-1">更新已下载完成，点击"立即安装"重启应用</span>
                        </div>
                      )}

                      {/* 操作按钮组 */}
                      <div className="flex flex-wrap gap-2 pt-1">
                        {/* 检查更新按钮 */}
                        <button
                          onClick={async () => {
                            setUpdaterState(prev => ({ ...prev, error: null, checking: true, notAvailable: false, available: false }));
                            const res = await window.electronAPI?.checkForUpdates?.();
                            if (!res?.success) {
                              setUpdaterState(prev => ({ ...prev, checking: false, error: res?.error || '检查失败' }));
                            } else {
                              // 使用 IPC 返回的状态作为兜底（事件可能已先行更新 state）
                              setUpdaterState(prev => ({
                                ...prev,
                                checking: false,
                                available: !!res.available,
                                notAvailable: !!res.notAvailable,
                                info: res.info || prev.info
                              }));
                            }
                          }}
                          disabled={updaterState.checking || updaterState.downloading}
                          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all disabled:opacity-50 disabled:cursor-not-allowed ${
                            t.primary === 'tech'
                              ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145] active:scale-95 shadow-sm'
                              : 'border-slate-300 text-slate-700 hover:bg-slate-100 active:scale-95 shadow-sm'
                          }`}
                          title="手动检查是否有新版本"
                        >
                          <RefreshCw size={14} className={updaterState.checking ? 'animate-spin' : ''} />
                          <span>检查更新</span>
                        </button>

                        {/* 下载按钮（发现新版本且未下载时显示） */}
                        {updaterState.available && !updaterState.downloading && !updaterState.downloaded && (
                          <button
                            onClick={() => window.electronAPI?.downloadUpdate?.()}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all active:scale-95 shadow-sm ${
                              t.primary === 'tech'
                                ? 'bg-cyan-500 hover:bg-cyan-600 text-white'
                                : 'bg-cyan-600 hover:bg-cyan-700 text-white'
                            }`}
                          >
                            <Download size={14} />
                            <span>下载更新</span>
                          </button>
                        )}

                        {/* 立即安装按钮（下载完成后显示） */}
                        {updaterState.downloaded && (
                          <button
                            onClick={() => window.electronAPI?.installUpdate?.()}
                            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all active:scale-95 shadow-sm ${
                              t.primary === 'tech'
                                ? 'bg-emerald-500 hover:bg-emerald-600 text-white'
                                : 'bg-emerald-600 hover:bg-emerald-700 text-white'
                            }`}
                          >
                            <DownloadCloud size={14} />
                            <span>立即安装并重启</span>
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </section>

              <section id="settings-danger" className={settingsSectionClass}>
                {/* 重置所有设置（放在最后） */}
                <div className="py-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <RotateCcw size={16} className={t.primary === 'tech' ? 'text-[#9AA0A6]' : 'text-[#80868B]'} />
                      <div>
                        <span className={`font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>重置所有设置</span>
                        <p className={`text-xs mt-0.5 ${t.primary === 'tech' ? 'text-[#80868B]' : 'text-[#9AA0A6]'}`}>清除所有自定义配置，恢复默认状态</p>
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        showConfirm({
                          title: '重置所有设置',
                          message: '确定要重置所有设置吗？这将清除所有自定义主题和配置。',
                          confirmLabel: '重置',
                          rememberKey: 'settings.resetAll',
                          onConfirm: async () => {
                          setCustomThemes([]);
                          setCurrentTheme('default');
                          setScreenshotPath('');
                          setScreenRecordPath('');
                          // 重置巡检保存路径
                          setInspectionPath('');
                          setPerformancePath('');
                          setTaskCenterPath('');
                          setQualityCenterPath('');
                          setScrcpySettings({
                            screenOff: false,
                            stayAwake: true,
                            bitrate: '8 Mbps',
                            maxSize: '0'
                          });
                          // 重置自动更新开关为默认值（开启）
                          setAutoUpdateEnabled(true);
                          localStorage.setItem('autoUpdateEnabled', 'true');
                          if (window.electronAPI) {
                            await window.electronAPI.saveCustomThemes([]);
                            await window.electronAPI.saveScreenshotPath('');
                            await window.electronAPI.saveScreenRecordPath('');
                            // 同步清空巡检保存路径
                            await window.electronAPI.saveInspectionPath('');
                            await window.electronAPI.savePerformancePath('');
                            await window.electronAPI.saveTaskCenterPath('');
                            await window.electronAPI.saveQualityCenterPath('');
                          }
                          clearConfirmSuppressionMemory();
                          showToast('所有设置已重置为默认值');
                          }
                        });
                      }}
                      className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${t.primary === 'tech' ? 'bg-red-500/20 hover:bg-red-500/30 text-red-400 border border-red-500/30' : 'bg-red-50 hover:bg-red-100 text-red-600 border border-red-200'}`}
                    >
                      <RotateCcw size={16} />
                      重置
                    </button>
                  </div>
                </div>
              </section>

                {/* Custom Theme Editor Modal */}
                {showThemeEditor && (
                  <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 overflow-y-auto">
                    <div className={`w-full max-w-xl my-4 mx-2 sm:mx-auto p-4 sm:p-6 rounded-xl border shadow-xl ${t.primary === 'tech' ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
                      <div className="flex items-center justify-between mb-4">
                        <h4 className={`text-lg font-semibold ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                          {editingTheme ? '编辑自定义主题' : '创建自定义主题'}
                        </h4>
                        <button onClick={() => setShowThemeEditor(false)} className={`p-1 ${t.primary === 'tech' ? 'text-[#9AA0A6] hover:text-[#E8EAED]' : 'text-[#9AA0A6] hover:text-slate-600'}`}>
                          <X size={20} />
                        </button>
                      </div>

                      <div className="space-y-4 overflow-y-auto">
                        <div>
                          <label className={`block text-sm font-medium mb-1 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>主题名称</label>
                          <input
                            type="text"
                            value={newThemeName}
                            onChange={(e) => setNewThemeName(e.target.value)}
                            placeholder="输入主题名称..."
                            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-400' : 'bg-white border-slate-200 text-slate-700'}`}
                          />
                        </div>

                        <div>
                          <label className={`block text-sm font-medium mb-2 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>主色调</label>
                          <div className="flex flex-wrap gap-2">
                            {[
                              { name: 'emerald', color: '#10b981' },
                              { name: 'cyan', color: '#06b6d4' },
                              { name: 'blue', color: '#3b82f6' },
                              { name: 'pink', color: '#ec4899' },
                              { name: 'rose', color: '#f43f5e' },
                              { name: 'green', color: '#22c55e' },
                              { name: 'orange', color: '#f97316' },
                              { name: 'amber', color: '#f59e0b' },
                              { name: 'purple', color: '#a855f7' },
                              { name: 'red', color: '#ef4444' }
                            ].map(({ name, color }) => (
                              <button
                                key={name}
                                onClick={() => setThemeColors(prev => ({ ...prev, primary: name, primaryFrom: `from-${name}-500`, primaryTo: `to-${name}-600` }))}
                                style={{ backgroundColor: color }}
                                className={`w-7 h-7 rounded-full flex-shrink-0 ${themeColors.primary === name ? 'ring-2 ring-offset-2 ring-emerald-500' : ''}`}
                              />
                            ))}
                          </div>
                        </div>

                        <div className="flex items-center justify-between">
                          <span className={`text-sm font-medium ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>按钮渐变</span>
                          <label className="relative inline-flex items-center cursor-pointer">
                            <input
                              type="checkbox"
                              checked={themeColors.useGradient}
                              onChange={(e) => setThemeColors(prev => ({ ...prev, useGradient: e.target.checked }))}
                              className="sr-only peer"
                            />
                            <div className="w-9 h-5 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                            <span className={`ml-2 text-xs ${themeColors.useGradient ? 'text-emerald-500' : 'text-slate-400'}`}>{themeColors.useGradient ? '开启' : '关闭'}</span>
                          </label>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <label className={`block text-sm font-medium mb-1 ${themeColors.useGradient ? (t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700') : 'text-[#9AA0A6]'}`}>按钮渐变起点</label>
                            <select
                              value={themeColors.primaryFrom}
                              onChange={(e) => setThemeColors(prev => ({ ...prev, primaryFrom: e.target.value }))}
                              disabled={!themeColors.useGradient}
                              className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none ${themeColors.useGradient ? (t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700') : 'bg-slate-100 border-slate-200 text-[#9AA0A6] cursor-not-allowed'}`}
                            >
                              {[
                                { value: 'from-emerald-400', label: '翠绿' },
                                { value: 'from-cyan-400', label: '青色' },
                                { value: 'from-blue-400', label: '蓝色' },
                                { value: 'from-pink-400', label: '粉色' },
                                { value: 'from-rose-400', label: '玫红' },
                                { value: 'from-green-400', label: '绿色' },
                                { value: 'from-orange-400', label: '橙色' },
                                { value: 'from-amber-400', label: '琥珀' },
                                { value: 'from-purple-400', label: '紫色' },
                                { value: 'from-red-400', label: '红色' }
                              ].map(c => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className={`block text-sm font-medium mb-1 ${themeColors.useGradient ? (t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700') : 'text-[#9AA0A6]'}`}>按钮渐变终点</label>
                            <select
                              value={themeColors.primaryTo}
                              onChange={(e) => setThemeColors(prev => ({ ...prev, primaryTo: e.target.value }))}
                              disabled={!themeColors.useGradient}
                              className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none ${themeColors.useGradient ? (t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700') : 'bg-slate-100 border-slate-200 text-[#9AA0A6] cursor-not-allowed'}`}
                            >
                              {[
                                { value: 'to-emerald-500', label: '翠绿' },
                                { value: 'to-cyan-500', label: '青色' },
                                { value: 'to-blue-500', label: '蓝色' },
                                { value: 'to-pink-500', label: '粉色' },
                                { value: 'to-rose-500', label: '玫红' },
                                { value: 'to-green-500', label: '绿色' },
                                { value: 'to-orange-500', label: '橙色' },
                                { value: 'to-amber-500', label: '琥珀' },
                                { value: 'to-purple-500', label: '紫色' },
                                { value: 'to-red-500', label: '红色' }
                              ].map(c => (
                                <option key={c.value} value={c.value}>{c.label}</option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <div>
                          <label className={`block text-sm font-medium mb-1 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>卡片背景</label>
                          <select
                            value={themeColors.card}
                            onChange={(e) => setThemeColors(prev => ({ ...prev, card: e.target.value }))}
                            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                          >
                            <option value="bg-white">白色</option>
                            <option value="bg-slate-800/80">深灰半透明</option>
                            <option value="bg-pink-50">粉色</option>
                            <option value="bg-blue-50">蓝色</option>
                            <option value="bg-green-50">绿色</option>
                            <option value="bg-orange-50">橙色</option>
                            <option value="bg-purple-50">紫色</option>
                          </select>
                        </div>

                        <div>
                          <label className={`block text-sm font-medium mb-1 ${t.primary === 'tech' ? 'text-[#E8EAED]' : 'text-slate-700'}`}>终端背景</label>
                          <select
                            value={themeColors.terminalBg}
                            onChange={(e) => setThemeColors(prev => ({ ...prev, terminalBg: e.target.value }))}
                            className={`w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none ${t.primary === 'tech' ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED]' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                          >
                            <option value="bg-[#202124]">深灰 (#202124)</option>
                            <option value="bg-[#202124]">深灰 (slate-900)</option>
                            <option value="bg-black">纯黑</option>
                            <option value="bg-gradient-to-br from-pink-900 to-rose-900">粉紫渐变</option>
                            <option value="bg-gradient-to-br from-slate-800 to-slate-900">灰渐变</option>
                            <option value="bg-gradient-to-br from-blue-900 to-slate-900">蓝渐变</option>
                            <option value="bg-gradient-to-br from-green-900 to-slate-900">绿渐变</option>
                          </select>
                        </div>
                      </div>

                      <div className="flex justify-end gap-3 mt-6">
                        <button
                          onClick={() => setShowThemeEditor(false)}
                          className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${t.primary === 'tech' ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                        >
                          取消
                        </button>
                        <button
                          onClick={saveCustomTheme}
                          className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${t.button.primary.split(' ')[0]} ${t.button.primary.split(' ')[1] || ''} text-white`}
                        >
                          {editingTheme ? '保存修改' : '创建主题'}
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
          )}
        </main>
      </div>
    </div>
  );
}

function BackgroundTaskStack({ tasks, onOpen }) {
  if (!tasks.length) return null;
  return (
    <div className="px-4 py-3 border-t border-[#3E4145] space-y-2">
      {tasks.map(task => {
        const Icon = task.icon;
        const active = task.status === 'running' || task.status === 'cancelling';
        const StatusIcon = active ? Loader2 : task.status === 'failed' ? AlertCircle : CheckCircle2;
        return (
          <button
            key={task.key}
            type="button"
            onClick={() => onOpen?.(task.tab)}
            className="w-full rounded-lg border border-[#3E4145] bg-[#2D2F33]/80 px-3 py-2.5 text-left hover:bg-[#3E4145] transition-colors"
            title={task.title}
          >
            <div className="flex items-center gap-2">
              <Icon size={16} className={task.status === 'failed' ? 'text-red-400' : 'text-emerald-400'} />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold text-[#E8EAED] truncate">{task.title}</div>
                <div className="text-[10px] text-[#9AA0A6] truncate">{task.message}</div>
              </div>
              <StatusIcon size={15} className={`${active ? 'animate-spin text-emerald-400' : task.status === 'failed' ? 'text-red-400' : 'text-emerald-400'} shrink-0`} />
            </div>
            <div className="mt-2 h-1.5 rounded-full overflow-hidden bg-[#202124]">
              <div className={`h-full rounded-full transition-all ${task.status === 'failed' ? 'bg-red-400' : task.status === 'cancelled' ? 'bg-amber-400' : 'bg-emerald-400'}`} style={{ width: `${task.percent}%` }} />
            </div>
          </button>
        );
      })}
    </div>
  );
}

function buildSidebarBackgroundTasks(backgroundTasks) {
  return [
    toSidebarTask('inspection', backgroundTasks.inspection),
    toSidebarTask('performanceReport', backgroundTasks.performanceReport)
  ].filter(Boolean);
}

function toSidebarTask(key, task) {
  if (!task) return null;
  const running = isBackgroundTaskActive(task);
  const failed = task.status === 'failed';
  const cancelled = task.status === 'cancelled';
  const percent = getBackgroundTaskPercent(key, task);
  if (!running && !failed && !cancelled && task.status !== 'success') return null;
  if (key === 'inspection') {
    return {
      key,
      tab: 'devices',
      icon: ClipboardCheck,
      status: task.status || 'running',
      title: running ? '设备巡检运行中' : cancelled ? '设备巡检已取消' : failed ? '设备巡检失败' : '设备巡检完成',
      message: task.progress?.stepLabel || task.progress?.message || task.result?.error || task.deviceId || '等待巡检进度',
      percent
    };
  }
  return {
    key,
    tab: 'performance',
    icon: Gauge,
    status: task.status || 'running',
    title: running ? '性能报告生成中' : failed ? '性能报告失败' : '性能报告完成',
    message: task.progress?.message || task.result?.error || task.deviceId || '等待报告进度',
    percent
  };
}

function getBackgroundTaskPercent(key, task) {
  const progress = task?.progress || {};
  if (Number.isFinite(progress.percent)) return Math.max(0, Math.min(100, Math.round(progress.percent)));
  if (key === 'inspection' && progress.total) {
    return Math.max(0, Math.min(100, Math.round((Number(progress.index) || 0) / progress.total * 100)));
  }
  if (task?.status === 'success' || task?.status === 'failed' || task?.status === 'cancelled') return 100;
  return 5;
}

function isBackgroundTaskActive(task) {
  return task?.status === 'running' || task?.status === 'cancelling';
}

export default App;
