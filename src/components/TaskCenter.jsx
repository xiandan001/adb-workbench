// 任务中心：复现脚本、多设备批量执行和运行历史。

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isConfirmSuppressed, rememberConfirmSuppressed } from '../shared/confirmMemory';
import {
  advanceOnboardingStage,
  createSingleReplayScript,
  findOnboardingTask,
  isTerminalTask,
  ONBOARDING_EVENTS,
  ONBOARDING_STAGES
} from '../shared/taskCenterOnboarding';
import TaskCenterOnboarding from './TaskCenterOnboarding';
import TaskCenterQuickStart from './TaskCenterQuickStart';
import TaskCenterRecordingWorkspace from './TaskCenterRecordingWorkspace';
import {
  AlertCircle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  ClipboardList,
  Download,
  FolderOpen,
  Gauge,
  HelpCircle,
  Loader2,
  Maximize2,
  Package,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Smartphone,
  Square,
  Terminal,
  Trash2,
  Upload
} from 'lucide-react';

const STEP_TYPES = [
  { value: 'shell', label: 'Shell 命令', description: '执行一条 ADB shell 命令', icon: Terminal },
  { value: 'installApk', label: '安装 APK', description: '安装本地 APK 到设备', icon: Package },
  { value: 'pushFile', label: '推送文件', description: '推送本地文件到设备路径', icon: Upload },
  { value: 'screenshot', label: '截图', description: '保存当前设备画面', icon: Camera },
  { value: 'imageCompare', label: '截图比对', description: '采集截图并与基准图做相似度验收', icon: Camera },
  { value: 'perfSnapshot', label: '性能采样', description: '采集一次性能快照', icon: Gauge },
  { value: 'tap', label: '点击', description: '按坐标或控件选择器点击', icon: Smartphone },
  { value: 'longPress', label: '长按', description: '按坐标或控件选择器长按', icon: Smartphone },
  { value: 'swipe', label: '滑动', description: '按坐标执行滑动手势', icon: Smartphone },
  { value: 'input', label: '输入文本', description: '向当前焦点输入文本', icon: Terminal },
  { value: 'keyevent', label: '按键', description: '发送 Android keyevent', icon: Terminal },
  { value: 'waitText', label: '等待文本', description: '等待界面出现指定文本', icon: Search },
  { value: 'assertText', label: '断言文本', description: '校验界面文本存在', icon: CheckCircle2 },
  { value: 'inspection', label: '巡检摘要', description: '生成巡检报告和证据包', icon: ClipboardList },
  { value: 'waitLog', label: '等待日志', description: '轮询直到日志命中', icon: Search },
  { value: 'externalScript', label: '外部脚本', description: '调用 Appium、Maestro、UIAutomator2 或自定义命令', icon: Terminal },
  { value: 'delay', label: '等待', description: '等待指定毫秒数', icon: Clock3 }
];

const LONG_PRESS_RECORD_THRESHOLD_MS = 600;
const RECORD_ACTIONS_REFRESH_SNAPSHOT = new Set(['tap', 'longPress', 'swipe', 'input', 'keyevent']);
const RECORDER_BACKGROUND_REFRESH_DELAY_MS = 300;

const QUICK_TEMPLATES = [
  {
    id: 'record',
    title: '录制操作流程',
    description: '读取设备界面后，直接点击或拖拽设备画面生成步骤。',
    icon: Smartphone,
    action: 'template'
  },
  {
    id: 'launch',
    title: '启动应用稳定性',
    description: '填写包名后循环启动应用，自动采集截图和性能快照。',
    icon: Package,
    action: 'template'
  },
  {
    id: 'compare',
    title: '截图比对验收',
    description: '采集当前画面并与基准图比对，适合页面稳定性验证。',
    icon: Camera,
    action: 'template'
  },
  {
    id: 'install-launch',
    title: '安装后启动验证',
    description: '安装 APK、清理日志、启动应用并采集首屏与性能证据。',
    icon: Package,
    action: 'template'
  },
  {
    id: 'crash-capture',
    title: '崩溃复现采集',
    description: '清空日志后启动应用，等待崩溃或 ANR 关键词并保留证据。',
    icon: AlertCircle,
    action: 'template'
  },
  {
    id: 'smoke',
    title: '基础冒烟检查',
    description: '读取设备状态、返回桌面、截图并生成巡检摘要。',
    icon: CheckCircle2,
    action: 'template'
  },
  {
    id: 'performance-watch',
    title: '性能观察模板',
    description: '循环启动目标应用，间隔采集性能快照和页面截图。',
    icon: Gauge,
    action: 'template'
  },
  {
    id: 'external',
    title: '导入外部脚本',
    description: '导入现有 Python、bat、Maestro、Appium 或自定义脚本。',
    icon: Terminal,
    action: 'import'
  }
];

function TaskCenter({ devices, theme, taskCenterPath, showToast, onRefreshDevices }) {
  const t = theme;
  const isDark = t.primary === 'tech';
  const onlineDevices = useMemo(() => devices.filter(device => device.status === 'device'), [devices]);
  const [scripts, setScripts] = useState([]);
  const [selectedScriptId, setSelectedScriptId] = useState('');
  const [draft, setDraft] = useState(createEmptyScript());
  const [selectedDeviceIds, setSelectedDeviceIds] = useState([]);
  const [activeTasks, setActiveTasks] = useState([]);
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recorder, setRecorder] = useState(createRecorderState());
  const [editorMode, setEditorMode] = useState('simple');
  const [workspaceView, setWorkspaceView] = useState('home');
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingLoaded, setOnboardingLoaded] = useState(false);
  const [onboardingLoadError, setOnboardingLoadError] = useState('');
  const [onboardingStatus, setOnboardingStatus] = useState(null);
  const [onboardingStage, setOnboardingStage] = useState(ONBOARDING_STAGES.WELCOME);
  const [recordingTaskId, setRecordingTaskId] = useState('');
  const [confirmDialog, setConfirmDialog] = useState(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [externalImportDialog, setExternalImportDialog] = useState(null);
  const [externalImportLoading, setExternalImportLoading] = useState(false);
  const recorderMountedRef = useRef(true);
  const recorderRefreshTimerRef = useRef(null);
  const recorderActionInFlightRef = useRef(false);
  const recorderBackgroundRefreshInFlightRef = useRef(false);

  const panelClass = isDark ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200';
  const softClass = isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const onboardingInteractionActive = onboardingOpen
    && onboardingStage !== ONBOARDING_STAGES.WELCOME
    && onboardingStage !== ONBOARDING_STAGES.RESULT;

  const clearScheduledRecorderRefresh = ({ clearVisual = false } = {}) => {
    if (!recorderRefreshTimerRef.current) return;
    clearTimeout(recorderRefreshTimerRef.current);
    recorderRefreshTimerRef.current = null;
    if (clearVisual && !recorderBackgroundRefreshInFlightRef.current && recorderMountedRef.current) {
      setRecorder(prev => prev.backgroundLoading ? { ...prev, backgroundLoading: false } : prev);
    }
  };

  useEffect(() => {
    recorderMountedRef.current = true;
    return () => {
      recorderMountedRef.current = false;
      clearScheduledRecorderRefresh();
    };
  }, []);

  useEffect(() => {
    let alive = true;
    async function loadState() {
      setLoading(true);
      try {
        const [scriptRes, stateRes, settingsRes] = await Promise.all([
          window.electronAPI?.taskScriptsList?.(),
          window.electronAPI?.taskState?.(),
          window.electronAPI?.loadAllSettings?.()
        ]);
        if (!alive) return;
        const nextScripts = scriptRes?.scripts || [];
        setScripts(nextScripts);
        const first = nextScripts[0] || createEmptyScript();
        setSelectedScriptId(first.id);
        setDraft(cloneScript(first));
        setActiveTasks(stateRes?.activeTasks || []);
        setHistory(stateRes?.history || []);
        const onboardingState = settingsRes?.success
          ? settingsRes.data?.settings?.taskCenterOnboarding
          : null;
        setOnboardingStatus(onboardingState?.status || null);
        setOnboardingLoadError(settingsRes?.success ? '' : (settingsRes?.error || '教程状态读取失败'));
        setOnboardingOpen(!onboardingState);
        setOnboardingLoaded(true);
      } catch (error) {
        if (!alive) return;
        setOnboardingStatus(null);
        setOnboardingLoadError(error.message || '教程状态读取失败');
        setOnboardingOpen(true);
        setOnboardingLoaded(true);
      } finally {
        if (alive) setLoading(false);
      }
    }
    loadState();
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    setSelectedDeviceIds(prev => {
      if (prev.length === 0 && onlineDevices.length > 0) {
        return [onlineDevices[0].id];
      }
      return prev.filter(id => onlineDevices.some(device => device.id === id));
    });
  }, [onlineDevices]);

  useEffect(() => {
    if (!window.electronAPI?.onTaskCenterUpdate) return undefined;
    return window.electronAPI.onTaskCenterUpdate((event) => {
      if (Array.isArray(event?.activeTasks)) setActiveTasks(event.activeTasks);
      if (Array.isArray(event?.history)) setHistory(event.history);
    });
  }, []);

  const activeCount = activeTasks.filter(task => task.status === 'running' || task.status === 'queued').length;
  const selectedScript = scripts.find(script => script.id === selectedScriptId);
  const recordingTask = useMemo(
    () => findOnboardingTask(recordingTaskId, activeTasks, history),
    [recordingTaskId, activeTasks, history]
  );
  const recordingTaskView = recordingTaskId === 'pending'
    ? { id: 'pending', status: 'queued', totalSteps: draft.steps?.length || 0 }
    : recordingTask;

  useEffect(() => {
    if (!onboardingOpen
      || onboardingStage !== ONBOARDING_STAGES.REPLAY
      || !recordingTaskId
      || !isTerminalTask(recordingTask)) return;
    setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.TASK_FINISHED));
  }, [onboardingOpen, onboardingStage, recordingTaskId, recordingTask]);

  useEffect(() => {
    if (!onboardingInteractionActive || !recorder.deviceId || recordingTaskId) return;
    if (onlineDevices.some(device => device.id === recorder.deviceId)) return;
    clearScheduledRecorderRefresh();
    setRecorder(prev => ({
      ...prev,
      deviceId: '',
      nodes: [],
      selectedNodeIndex: '',
      screenshotDataUrl: '',
      screenshotWidth: 0,
      screenshotHeight: 0,
      loading: false,
      recording: false,
      backgroundLoading: false
    }));
    setSelectedDeviceIds([]);
    setOnboardingStage(ONBOARDING_STAGES.DEVICE_SELECT);
  }, [onboardingInteractionActive, onlineDevices, recorder.deviceId, recordingTaskId]);

  const runConfirmDialog = async () => {
    if (!confirmDialog?.onConfirm) return;
    setConfirmLoading(true);
    try {
      const result = await confirmDialog.onConfirm();
      if (result !== false) {
        if (confirmDialog.rememberKey && confirmDialog.rememberChoice) {
          rememberConfirmSuppressed(confirmDialog.rememberKey);
        }
        setConfirmDialog(null);
      }
    } catch (error) {
      showToast?.(`操作失败：${error.message || '未知错误'}`);
    } finally {
      setConfirmLoading(false);
    }
  };

  const openConfirmDialog = (dialog) => {
    const next = {
      ...dialog,
      rememberChoice: false,
      rememberLabel: dialog.rememberLabel || '下次不再提示'
    };
    if (next.rememberKey && isConfirmSuppressed(next.rememberKey)) {
      Promise.resolve()
        .then(() => next.onConfirm?.())
        .catch((error) => showToast?.(`操作失败：${error.message || '未知错误'}`));
      return;
    }
    setConfirmDialog(next);
  };

  const persistOnboardingStatus = async (status) => {
    const result = await window.electronAPI?.saveSettingsPatch?.({
      taskCenterOnboarding: {
        schemaVersion: 1,
        status,
        updatedAt: new Date().toISOString()
      }
    });
    if (!result?.success) {
      showToast?.(`教程状态保存失败：${result?.error || '未知错误'}`);
      return false;
    }
    setOnboardingLoadError('');
    setOnboardingStatus(status);
    setOnboardingOpen(false);
    setOnboardingStage(ONBOARDING_STAGES.WELCOME);
    setWorkspaceView('home');
    return true;
  };

  const retryOnboardingStateLoad = async () => {
    try {
      const result = await window.electronAPI?.loadAllSettings?.();
      if (!result?.success) {
        setOnboardingLoadError(result?.error || '教程状态读取失败');
        return false;
      }
      const nextState = result.data?.settings?.taskCenterOnboarding || null;
      setOnboardingStatus(nextState?.status || null);
      setOnboardingLoadError('');
      setOnboardingOpen(!nextState);
      return true;
    } catch (error) {
      setOnboardingLoadError(error.message || '教程状态读取失败');
      return false;
    }
  };

  const requestSkipOnboarding = () => {
    openConfirmDialog({
      title: '跳过新手教程',
      message: '确定跳过教程吗？之后仍可通过任务中心右上角的“新手教程”重新打开。',
      confirmLabel: '确认跳过',
      icon: HelpCircle,
      onConfirm: () => persistOnboardingStatus('skipped')
    });
  };

  const openOnboarding = () => {
    setOnboardingStage(ONBOARDING_STAGES.WELCOME);
    setRecordingTaskId('');
    setOnboardingOpen(true);
  };

  const startOnboarding = () => {
    clearScheduledRecorderRefresh();
    setWorkspaceView('home');
    setSelectedDeviceIds([]);
    setRecorder(createRecorderState());
    setRecordingTaskId('');
    setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.START));
  };

  useEffect(() => {
    if (onlineDevices.length === 0) {
      clearScheduledRecorderRefresh();
      setRecorder(prev => prev.deviceId ? { ...prev, deviceId: '', loading: false, recording: false, backgroundLoading: false } : prev);
      return;
    }
    if (onboardingInteractionActive && (
      onboardingStage === ONBOARDING_STAGES.RECORDING_ENTRY
      || onboardingStage === ONBOARDING_STAGES.DEVICE_SELECT
    )) {
      setRecorder(prev => onlineDevices.some(device => device.id === prev.deviceId)
        ? prev
        : { ...prev, deviceId: '', loading: false, recording: false, backgroundLoading: false });
      return;
    }
    const preferred = selectedDeviceIds[0] || onlineDevices[0].id;
    setRecorder(prev => onlineDevices.some(device => device.id === prev.deviceId) ? prev : {
      ...prev,
      deviceId: preferred,
      loading: false,
      recording: false,
      backgroundLoading: false
    });
  }, [onlineDevices, selectedDeviceIds, onboardingInteractionActive, onboardingStage]);

  const updateRecorder = (patch) => {
    if (Object.prototype.hasOwnProperty.call(patch, 'deviceId')) clearScheduledRecorderRefresh();
    setRecorder(prev => ({ ...prev, ...patch }));
  };

  const selectScript = (script) => {
    setSelectedScriptId(script.id);
    setDraft(cloneScript(script));
  };

  const createScript = () => {
    const next = createEmptyScript();
    setSelectedScriptId(next.id);
    setDraft(next);
    setEditorMode('simple');
  };

  const applyQuickTemplate = (templateId) => {
    if (templateId === 'external') {
      importStressScript();
      return;
    }
    const next = createTemplateScript(templateId);
    setSelectedScriptId(next.id);
    setDraft(next);
    setEditorMode('simple');
    if (templateId === 'record') showToast?.('已创建录制流程，选择设备后读取界面即可开始');
    if (templateId === 'launch') showToast?.('已创建启动应用压测模板，请先填写应用包名');
    if (templateId === 'compare') showToast?.('已创建截图比对模板，请设置基准图后运行');
    if (templateId === 'install-launch') showToast?.('已创建安装后启动验证模板，请先选择 APK 并填写包名');
    if (templateId === 'crash-capture') showToast?.('已创建崩溃复现采集模板，请填写目标应用包名');
    if (templateId === 'smoke') showToast?.('已创建基础冒烟检查模板，可直接选择设备运行');
    if (templateId === 'performance-watch') showToast?.('已创建性能观察模板，请填写目标应用包名');
  };

  const openScriptEditor = (script) => {
    selectScript(script);
    setEditorMode('simple');
    setWorkspaceView('editor');
  };

  const startRecording = () => {
    applyQuickTemplate('record');
    setRecordingTaskId('');
    if (onboardingOpen && onboardingStage === ONBOARDING_STAGES.RECORDING_ENTRY) {
      setSelectedDeviceIds([]);
      setRecorder(createRecorderState());
      setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.OPEN_RECORDING));
    }
    setWorkspaceView('recording');
  };

  const openAdvancedEditor = () => {
    setEditorMode('advanced');
    setWorkspaceView('editor');
  };

  const saveScript = async () => {
    setSaving(true);
    try {
      const res = await window.electronAPI?.taskScriptSave?.({ script: draft });
      if (res?.ok) {
        setScripts(res.scripts || []);
        setSelectedScriptId(res.script.id);
        setDraft(cloneScript(res.script));
        showToast?.('复现脚本已保存');
      } else {
        showToast?.(`保存失败：${res?.error || '未知错误'}`);
      }
    } finally {
      setSaving(false);
    }
  };

  const deleteScript = async () => {
    if (!selectedScript) return;
    const scriptToDelete = selectedScript;
    openConfirmDialog({
      title: '删除复现脚本',
      message: `确定删除「${scriptToDelete.name}」吗？`,
      detail: `脚本中的 ${scriptToDelete.steps?.length || 0} 个步骤会一并删除；已有运行历史和证据文件不会被清除。`,
      confirmLabel: '删除脚本',
      rememberKey: 'taskCenter.deleteScript',
      icon: Trash2,
      onConfirm: async () => {
        const res = await window.electronAPI?.taskScriptDelete?.({ id: scriptToDelete.id });
        if (!res?.ok) {
          showToast?.(`删除失败：${res?.error || '未知错误'}`);
          return false;
        }
        const nextScripts = res.scripts || [];
        setScripts(nextScripts);
        const next = nextScripts[0] || createEmptyScript();
        setSelectedScriptId(next.id);
        setDraft(cloneScript(next));
        showToast?.('脚本已删除');
        return true;
      }
    });
  };

  const completeStressScriptImport = async (filePath, scriptArgs = '') => {
    const res = await window.electronAPI?.taskStressImport?.({ filePath, scriptArgs });
    if (res?.ok) {
      setScripts(res.scripts || []);
      setSelectedScriptId(res.script.id);
      setDraft(cloneScript(res.script));
      setWorkspaceView('editor');
      showToast?.('脚本已导入');
      return true;
    }
    showToast?.(`导入失败：${res?.error || '未知错误'}`);
    return false;
  };

  const importStressScript = async () => {
    const dialog = await window.electronAPI?.showOpenDialog?.({
      title: '导入任务或外部脚本',
      properties: ['openFile'],
      filters: [
        { name: '任务及外部脚本', extensions: ['json', 'yaml', 'yml', 'py', 'sh'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    const filePath = dialog?.filePaths?.[0];
    if (!filePath) return;
    const extension = filePath.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() || '';
    if (extension === 'py' || extension === 'sh') {
      setExternalImportDialog({ filePath, args: '' });
      return;
    }
    await completeStressScriptImport(filePath);
  };

  const confirmExternalScriptImport = async () => {
    if (!externalImportDialog || externalImportLoading) return;
    setExternalImportLoading(true);
    try {
      const imported = await completeStressScriptImport(externalImportDialog.filePath, externalImportDialog.args);
      if (imported) setExternalImportDialog(null);
    } finally {
      setExternalImportLoading(false);
    }
  };

  const exportStressScript = async () => {
    const dialog = await window.electronAPI?.showSaveDialog?.({
      title: '导出自动化压测脚本',
      defaultPath: `${draft.name || 'stress-script'}.json`,
      filters: [
        { name: 'JSON 压测脚本', extensions: ['json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    const filePath = dialog?.filePath;
    if (!filePath) return;
    const res = await window.electronAPI?.taskStressExport?.({ script: draft, filePath });
    if (res?.ok) {
      showToast?.('压测脚本已导出');
    } else {
      showToast?.(`导出失败：${res?.error || '未知错误'}`);
    }
  };

  const runScript = async () => {
    if (selectedDeviceIds.length === 0) {
      showToast?.('请至少选择一台在线设备');
      return;
    }
    const res = await window.electronAPI?.taskRun?.({
      script: draft,
      deviceIds: selectedDeviceIds,
      outputBaseDir: taskCenterPath,
      continueOnError: draft.continueOnError,
      concurrency: 1
    });
    if (res?.ok) {
      showToast?.(draft.mode === 'stress' ? '自动化压测已开始' : '任务已加入队列');
    } else {
      showToast?.(`启动失败：${res?.error || '未知错误'}`);
    }
  };

  const refreshRecorderSnapshot = async ({ deviceId = recorder.deviceId, silent = false, background = false } = {}) => {
    if (!deviceId) {
      showToast?.('请选择录制设备');
      return false;
    }
    if (!background) clearScheduledRecorderRefresh({ clearVisual: true });
    setRecorder(prev => prev.deviceId === deviceId ? {
      ...prev,
      ...(background ? { backgroundLoading: true } : { loading: true, error: '' })
    } : prev);
    try {
      const res = await window.electronAPI?.taskStressUiSnapshot?.({ deviceId });
      if (!recorderMountedRef.current) return false;
      if (res?.ok) {
        const screenshotDataUrl = res.screenshotDataUrl || recorder.screenshotDataUrl;
        const screenshotWidth = res.screenshotWidth || recorder.screenshotWidth;
        const screenshotHeight = res.screenshotHeight || recorder.screenshotHeight;
        const hasValidScreenshot = Boolean(screenshotDataUrl && screenshotWidth && screenshotHeight);
        setRecorder(prev => prev.deviceId === deviceId ? ({
          ...prev,
          nodes: res.nodes || [],
          selectedNodeIndex: '',
          screenshotDataUrl: res.screenshotDataUrl || prev.screenshotDataUrl,
          screenshotWidth: res.screenshotWidth || prev.screenshotWidth,
          screenshotHeight: res.screenshotHeight || prev.screenshotHeight,
          ...(background ? { backgroundLoading: false } : { loading: false }),
          error: background ? prev.error : (res.error || res.screenshotError || (hasValidScreenshot ? '' : '未获取到有效设备画面'))
        }) : prev);
        if (!silent) showToast?.(`已读取 ${res.nodes?.length || 0} 个界面控件`);
        return hasValidScreenshot;
      } else {
        const message = res?.error || '未知错误';
        setRecorder(prev => prev.deviceId === deviceId ? {
          ...prev,
          ...(background ? { backgroundLoading: false } : { loading: false, error: message })
        } : prev);
        if (!silent) showToast?.(`读取界面失败：${message}`);
        return false;
      }
    } catch (error) {
      if (!recorderMountedRef.current) return false;
      const message = error.message || '未知错误';
      setRecorder(prev => prev.deviceId === deviceId ? {
        ...prev,
        ...(background ? { backgroundLoading: false } : { loading: false, error: message })
      } : prev);
      if (!silent) showToast?.(`读取界面失败：${message}`);
      return false;
    }
  };

  const scheduleRecorderSnapshotRefresh = (deviceId) => {
    if (!deviceId || !recorderMountedRef.current) return;
    clearScheduledRecorderRefresh();
    setRecorder(prev => prev.deviceId === deviceId ? { ...prev, backgroundLoading: true } : prev);
    recorderRefreshTimerRef.current = setTimeout(async () => {
      recorderRefreshTimerRef.current = null;
      if (!recorderMountedRef.current) return;
      if (recorderActionInFlightRef.current || recorderBackgroundRefreshInFlightRef.current) {
        scheduleRecorderSnapshotRefresh(deviceId);
        return;
      }
      recorderBackgroundRefreshInFlightRef.current = true;
      let refreshed = false;
      try {
        refreshed = await refreshRecorderSnapshot({ deviceId, silent: true, background: true });
      } finally {
        recorderBackgroundRefreshInFlightRef.current = false;
      }
      if (refreshed && recorderMountedRef.current) showToast?.('设备画面已刷新');
    }, RECORDER_BACKGROUND_REFRESH_DELAY_MS);
  };

  const appendRecordedStep = (step, mode = 'stress') => {
    setDraft(prev => ({
      ...prev,
      mode,
      steps: [...(prev.steps || []), { ...step, id: `step-${Date.now()}-${Math.random().toString(16).slice(2)}` }]
    }));
  };

  const recordAction = async (action, extra = {}, options = {}) => {
    if (!recorder.deviceId) {
      showToast?.('请选择录制设备');
      return null;
    }
    if (recorder.loading || recorder.recording || recorder.backgroundLoading) return null;
    clearScheduledRecorderRefresh({ clearVisual: true });
    const deviceId = recorder.deviceId;
    const selectedNode = recorder.nodes.find(item => String(item.index) === String(recorder.selectedNodeIndex));
    const node = Object.prototype.hasOwnProperty.call(extra, 'node') ? extra.node : selectedNode;
    let shouldRefreshSnapshot = false;
    let recordedStep = null;
    recorderActionInFlightRef.current = true;
    setRecorder(prev => ({ ...prev, recording: true, error: '' }));
    try {
      const res = await window.electronAPI?.taskStressRecordAction?.({
        deviceId,
        action,
        node,
        ...extra
      });
      if (res?.ok && res.step) {
        const recordingMode = workspaceView === 'recording' ? 'replay' : 'stress';
        appendRecordedStep(res.step, recordingMode);
        recordedStep = res.step;
        if (RECORD_ACTIONS_REFRESH_SNAPSHOT.has(action) && !options.skipRefresh) {
          shouldRefreshSnapshot = true;
          showToast?.('已执行并记录步骤，设备画面将在空闲时刷新');
        } else {
          showToast?.('已执行并记录步骤');
        }
      } else {
        showToast?.(`录制失败：${res?.error || '未知错误'}`);
      }
    } catch (error) {
      showToast?.(`录制失败：${error.message || '未知错误'}`);
    } finally {
      recorderActionInFlightRef.current = false;
      if (recorderMountedRef.current) setRecorder(prev => ({ ...prev, recording: false }));
    }
    if (shouldRefreshSnapshot) scheduleRecorderSnapshotRefresh(deviceId);
    return recordedStep;
  };

  const changeRecordingDevice = (patch) => {
    updateRecorder(patch);
    if (!Object.prototype.hasOwnProperty.call(patch, 'deviceId')) return;
    setSelectedDeviceIds(patch.deviceId ? [patch.deviceId] : []);
    setRecordingTaskId('');
    if (onboardingOpen && onboardingStage === ONBOARDING_STAGES.DEVICE_SELECT && patch.deviceId) {
      setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.SELECT_DEVICE));
    }
  };

  const refreshRecordingSnapshot = async () => {
    const refreshed = await refreshRecorderSnapshot();
    if (refreshed && onboardingOpen && onboardingStage === ONBOARDING_STAGES.SNAPSHOT) {
      setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.SNAPSHOT_READY));
    }
    return refreshed;
  };

  const recordFromRecordingWorkspace = async (action, extra = {}) => {
    const step = await recordAction(action, extra, { skipRefresh: true });
    if (step && action === 'tap' && onboardingOpen && onboardingStage === ONBOARDING_STAGES.RECORD_TAP) {
      setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.TAP_RECORDED));
    }
    return step;
  };

  const runRecordingReplay = async ({ tutorial = false } = {}) => {
    const deviceId = recorder.deviceId;
    if (!deviceId || !onlineDevices.some(device => device.id === deviceId)) {
      showToast?.('请选择一台在线设备');
      return false;
    }
    if (!draft.steps?.length) {
      showToast?.('请先录制至少一个步骤');
      return false;
    }
    const replayScript = createSingleReplayScript(draft);
    setDraft(replayScript);
    setSelectedDeviceIds([deviceId]);
    setRecordingTaskId('pending');
    try {
      const res = await window.electronAPI?.taskRun?.({
        script: replayScript,
        deviceIds: [deviceId],
        outputBaseDir: taskCenterPath,
        continueOnError: false,
        concurrency: 1
      });
      if (!res?.ok || !res.task?.id) {
        setRecordingTaskId('');
        showToast?.(`启动失败：${res?.error || '未知错误'}`);
        return false;
      }
      setRecordingTaskId(res.task.id);
      setActiveTasks(prev => prev.some(task => task.id === res.task.id)
        ? prev
        : [res.task, ...prev]);
      if (tutorial || (onboardingOpen && onboardingStage === ONBOARDING_STAGES.REPLAY)) {
        setOnboardingStage(current => advanceOnboardingStage(current, ONBOARDING_EVENTS.REPLAY_STARTED));
      }
      showToast?.('回放任务已开始');
      return true;
    } catch (error) {
      setRecordingTaskId('');
      showToast?.(`启动失败：${error.message || '未知错误'}`);
      return false;
    }
  };

  const cancelRecordingReplay = async () => {
    if (!recordingTaskId || recordingTaskId === 'pending') return;
    await cancelTask(recordingTaskId);
  };

  const restartOnboardingRecording = () => {
    clearScheduledRecorderRefresh();
    setRecordingTaskId('');
    setDraft(prev => ({ ...createSingleReplayScript(prev), steps: [] }));
    setRecorder(prev => ({
      ...prev,
      nodes: [],
      selectedNodeIndex: '',
      screenshotDataUrl: '',
      screenshotWidth: 0,
      screenshotHeight: 0,
      loading: false,
      recording: false,
      backgroundLoading: false,
      error: ''
    }));
    setOnboardingStage(ONBOARDING_STAGES.SNAPSHOT);
    setWorkspaceView('recording');
  };

  const replayOnboardingRecording = () => {
    setOnboardingStage(ONBOARDING_STAGES.REPLAY);
    runRecordingReplay({ tutorial: true });
  };

  const clearRecordedSteps = () => {
    const stepCount = draft.steps?.length || 0;
    if (stepCount === 0) return;
    openConfirmDialog({
      title: '清空脚本步骤',
      message: '确定清空当前脚本步骤吗？',
      detail: `当前 ${stepCount} 个步骤会从草稿中移除；如果脚本尚未保存，关闭页面后无法恢复。`,
      confirmLabel: '清空步骤',
      rememberKey: 'taskCenter.clearSteps',
      icon: AlertCircle,
      onConfirm: () => {
        setDraft(prev => ({ ...prev, steps: [] }));
        showToast?.('脚本步骤已清空');
        return true;
      }
    });
  };

  const cancelTask = async (taskId) => {
    const res = await window.electronAPI?.taskCancel?.({ taskId });
    if (!res?.ok) showToast?.(`取消失败：${res?.error || '未知错误'}`);
  };

  const clearHistory = async () => {
    if (history.length === 0) return;
    const historyCount = history.length;
    openConfirmDialog({
      title: '清空运行历史',
      message: '确定清空全部运行历史吗？',
      detail: `${historyCount} 条历史记录会从任务中心移除；已保存到磁盘的报告和证据目录不会被删除。`,
      confirmLabel: '清空历史',
      rememberKey: 'taskCenter.clearHistory',
      icon: AlertCircle,
      onConfirm: async () => {
        const res = await window.electronAPI?.taskHistoryClear?.();
        if (!res?.ok) {
          showToast?.(`清空失败：${res?.error || '未知错误'}`);
          return false;
        }
        setHistory([]);
        showToast?.('任务历史已清空');
        return true;
      }
    });
  };

  const toggleDevice = (deviceId) => {
    setSelectedDeviceIds(prev => prev.includes(deviceId) ? prev.filter(id => id !== deviceId) : [...prev, deviceId]);
  };

  const updateStep = (index, patch) => {
    setDraft(prev => ({
      ...prev,
      steps: prev.steps.map((step, i) => i === index ? { ...step, ...patch } : step)
    }));
  };

  const addStep = (type) => {
    setDraft(prev => ({
      ...prev,
      steps: [...prev.steps, createStep(type)]
    }));
  };

  const removeStep = (index) => {
    setDraft(prev => ({
      ...prev,
      steps: prev.steps.filter((_, i) => i !== index)
    }));
  };

  const moveStep = (index, delta) => {
    setDraft(prev => {
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= prev.steps.length) return prev;
      const next = [...prev.steps];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return { ...prev, steps: next };
    });
  };

  if (loading) {
    return (
      <div className={`rounded-xl border p-8 text-center ${panelClass}`}>
        <Loader2 size={28} className="mx-auto mb-3 animate-spin text-emerald-500" />
        <div className={muted}>正在加载任务中心...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className={`rounded-xl border p-5 shadow-sm ${panelClass}`}>
        <div className="flex flex-col xl:flex-row xl:items-center gap-4">
          <div className="flex-1 min-w-0">
            <h3 className={`text-lg font-semibold flex items-center gap-2 ${text}`}>
              <ClipboardList size={20} className="text-emerald-500" />
              任务中心
            </h3>
            <p className={`text-sm mt-1 ${muted}`}>先选择目标，复杂设置会在需要时再显示。</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3 w-full xl:w-auto xl:items-center">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={openOnboarding}
                className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 ${t.button.secondary}`}
              >
                <HelpCircle size={15} />
                新手教程
              </button>
              {workspaceView === 'editor' && (
                <>
                  <button
                    type="button"
                    onClick={() => setWorkspaceView('home')}
                    className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 ${t.button.secondary}`}
                  >
                    <ArrowLeft size={15} />
                    返回快速入口
                  </button>
                  <div className={`inline-flex rounded-lg border p-1 ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-slate-50'}`}>
                    <button
                      type="button"
                      onClick={() => setEditorMode('simple')}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${editorMode === 'simple' ? 'bg-emerald-600 text-white shadow-sm' : isDark ? 'text-[#BDC1C6] hover:bg-[#3E4145]' : 'text-slate-600 hover:bg-white'}`}
                    >
                      普通模式
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditorMode('advanced')}
                      className={`px-3 py-1.5 rounded-md text-sm transition-colors ${editorMode === 'advanced' ? 'bg-emerald-600 text-white shadow-sm' : isDark ? 'text-[#BDC1C6] hover:bg-[#3E4145]' : 'text-slate-600 hover:bg-white'}`}
                    >
                      高级编排
                    </button>
                  </div>
                </>
              )}
            </div>
            <div className="grid grid-cols-3 gap-3 w-full sm:min-w-[420px]">
              <StatCard label="在线设备" value={onlineDevices.length} theme={t} />
              <StatCard label="运行任务" value={activeCount} theme={t} />
              <StatCard label="历史记录" value={history.length} theme={t} />
            </div>
          </div>
        </div>
      </div>

      {workspaceView === 'home' ? (
        <TaskCenterQuickStart
          theme={t}
          scripts={scripts}
          activeTasks={activeTasks}
          history={history}
          onRecord={startRecording}
          onImport={importStressScript}
          onOpenScript={openScriptEditor}
          onOpenAdvanced={openAdvancedEditor}
        />
      ) : workspaceView === 'recording' ? (
        <TaskCenterRecordingWorkspace
          theme={t}
          draft={draft}
          saving={saving}
          task={recordingTaskView}
          onBack={() => setWorkspaceView('home')}
          onSave={saveScript}
          onReplay={runRecordingReplay}
          onCancel={cancelRecordingReplay}
          onClearSteps={clearRecordedSteps}
          onOpenAdvanced={openAdvancedEditor}
          recorderPanel={(
            <StressRecorder
              recorder={recorder}
              onlineDevices={onlineDevices}
              isDark={isDark}
              softClass={softClass}
              focusedMode
              tapOnly
              onChange={changeRecordingDevice}
              onRefresh={refreshRecordingSnapshot}
              onRefreshDevices={onRefreshDevices}
              onRecord={recordFromRecordingWorkspace}
              onClearSteps={clearRecordedSteps}
            />
          )}
        />
      ) : (
        <div className="grid gap-5 xl:grid-cols-[240px_minmax(0,1fr)] min-[1920px]:grid-cols-[240px_minmax(760px,1fr)_340px] items-start">
        <section className={`rounded-xl border shadow-sm overflow-hidden min-w-0 ${panelClass}`}>
          <div className={`px-4 py-3 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
            <div className={`font-semibold ${text}`}>复现脚本</div>
            <div className="flex items-center gap-2">
              <button onClick={importStressScript} className={`p-2 rounded-lg border ${t.button.secondary}`} title="导入压测脚本">
                <Upload size={15} />
              </button>
              <button onClick={createScript} className={`p-2 rounded-lg border ${t.button.secondary}`} title="新建脚本">
                <Plus size={15} />
              </button>
            </div>
          </div>
          <div className="max-h-[720px] overflow-y-auto p-3 space-y-2">
            {scripts.length === 0 ? (
              <div className={`py-12 text-center text-sm ${muted}`}>暂无脚本</div>
            ) : scripts.map(script => (
              <button
                key={script.id}
                onClick={() => selectScript(script)}
                className={`w-full text-left rounded-lg border p-3 transition-colors ${draft.id === script.id ? 'border-emerald-500/40 bg-emerald-500/10' : isDark ? 'border-[#3E4145] hover:bg-[#2D2F33]' : 'border-slate-200 hover:bg-slate-50'}`}
              >
                <div className={`font-medium truncate ${text}`}>{script.name}</div>
                <div className={`text-xs mt-1 line-clamp-2 ${muted}`}>{script.description || '无描述'}</div>
                <div className={`text-[11px] mt-2 ${muted}`}>{script.mode === 'stress' ? '自动化压测' : '复现脚本'} · {script.steps?.length || 0} 个步骤</div>
              </button>
            ))}
          </div>
        </section>

        <section className={`rounded-xl border shadow-sm min-w-0 ${panelClass}`}>
          <div className={`px-5 py-4 border-b flex flex-wrap items-center gap-3 ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
            <div className="flex-1 min-w-[260px]">
              <input
                value={draft.name}
                onChange={(e) => setDraft(prev => ({ ...prev, name: e.target.value }))}
                className={`w-full text-lg font-semibold bg-transparent outline-none ${text}`}
                placeholder="脚本名称"
              />
              <input
                value={draft.description}
                onChange={(e) => setDraft(prev => ({ ...prev, description: e.target.value }))}
                className={`w-full mt-1 text-sm bg-transparent outline-none ${muted}`}
                placeholder="描述这个脚本的用途"
              />
            </div>
            {editorMode === 'advanced' && (
              <>
                <label className={`flex items-center gap-2 text-xs ${muted}`}>
                  <input
                    type="checkbox"
                    checked={draft.continueOnError}
                    onChange={(e) => setDraft(prev => ({ ...prev, continueOnError: e.target.checked }))}
                    className="accent-emerald-500"
                  />
                  失败后继续执行
                </label>
                <label className={`flex items-center gap-2 text-xs ${muted}`}>
                  <input
                    type="checkbox"
                    checked={draft.mode === 'stress'}
                    onChange={(e) => setDraft(prev => ({ ...prev, mode: e.target.checked ? 'stress' : 'replay' }))}
                    className="accent-emerald-500"
                  />
                  自动化压测
                </label>
              </>
            )}
            <button onClick={saveScript} disabled={saving} className={`px-4 py-2 rounded-lg flex items-center gap-2 disabled:opacity-50 ${t.button.secondary}`}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
              保存
            </button>
            {draft.mode === 'stress' && (
              <button onClick={exportStressScript} className={`px-4 py-2 rounded-lg flex items-center gap-2 ${t.button.secondary}`}>
                <Download size={15} />
                导出
              </button>
            )}
            <button onClick={deleteScript} className="px-4 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 flex items-center gap-2">
              <Trash2 size={15} />
              删除
            </button>
          </div>

          <div className="p-5 space-y-5">
            {editorMode === 'simple' ? (
              <SimpleModePanel
                draft={draft}
                theme={t}
                isDark={isDark}
                softClass={softClass}
                muted={muted}
                text={text}
                onlineDevices={onlineDevices}
                selectedDeviceIds={selectedDeviceIds}
                recorder={recorder}
                saving={saving}
                onApplyTemplate={applyQuickTemplate}
                onDraftChange={(patch) => setDraft(prev => ({ ...prev, ...patch }))}
                onToggleDevice={toggleDevice}
                onSelectAllDevices={() => setSelectedDeviceIds(onlineDevices.map(device => device.id))}
                onClearDevices={() => setSelectedDeviceIds([])}
                onRun={runScript}
                onSave={saveScript}
                onRecorderChange={updateRecorder}
                onRecorderRefresh={refreshRecorderSnapshot}
                onRecord={recordAction}
                onClearSteps={clearRecordedSteps}
                onUpdateStep={updateStep}
                onRemoveStep={removeStep}
                onMoveStep={moveStep}
                onOpenAdvanced={() => setEditorMode('advanced')}
              />
            ) : (
              <>
                <div className={`rounded-xl border p-4 ${softClass}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className={`font-semibold ${text}`}>运行目标</div>
                      <div className={`text-xs mt-1 ${muted}`}>默认串行执行，保护 ADB 和设备稳定性。</div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setSelectedDeviceIds(onlineDevices.map(device => device.id))} className={`px-3 py-2 text-xs rounded-lg border ${t.button.secondary}`}>全选</button>
                      <button onClick={() => setSelectedDeviceIds([])} className={`px-3 py-2 text-xs rounded-lg border ${t.button.secondary}`}>清空</button>
                      <button onClick={runScript} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium flex items-center gap-2">
                        <Play size={15} />
                        {draft.mode === 'stress' ? '开始压测' : '运行'}
                      </button>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap gap-2">
                    {onlineDevices.length === 0 ? (
                      <div className={`text-sm ${muted}`}>暂无在线设备</div>
                    ) : onlineDevices.map(device => {
                      const selected = selectedDeviceIds.includes(device.id);
                      return (
                        <button
                          key={device.id}
                          onClick={() => toggleDevice(device.id)}
                          className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 transition-colors ${selected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}
                        >
                          <Smartphone size={14} />
                          <span>{device.model || device.id}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {draft.mode === 'stress' && (
                  <>
                    <StressConfig
                      script={draft}
                      isDark={isDark}
                      softClass={softClass}
                      onChange={(patch) => setDraft(prev => ({ ...prev, ...patch }))}
                    />
                    <StressRecorder
                      recorder={recorder}
                      onlineDevices={onlineDevices}
                      isDark={isDark}
                      softClass={softClass}
                      onChange={updateRecorder}
                      onRefresh={refreshRecorderSnapshot}
                      onRecord={recordAction}
                      onClearSteps={clearRecordedSteps}
                    />
                  </>
                )}

                <div className={`rounded-xl border overflow-hidden ${softClass}`}>
                  <div className={`px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
                    <div>
                      <div className={`font-semibold ${text}`}>步骤编排</div>
                      <div className={`text-xs mt-1 ${muted}`}>{draft.steps.length} 个步骤</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {STEP_TYPES.map(type => {
                        const Icon = type.icon;
                        return (
                          <button key={type.value} onClick={() => addStep(type.value)} className={`px-2.5 py-1.5 text-xs rounded-lg border flex items-center gap-1.5 ${t.button.secondary}`}>
                            <Icon size={12} />
                            {type.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="p-4 space-y-3">
                    {draft.steps.length === 0 ? (
                      <div className={`py-12 text-center text-sm ${muted}`}>添加一个步骤开始编排复现流程</div>
                    ) : draft.steps.map((step, index) => (
                      <StepEditor
                        key={step.id}
                        step={step}
                        index={index}
                        theme={t}
                        isDark={isDark}
                        onChange={(patch) => updateStep(index, patch)}
                        onRemove={() => removeStep(index)}
                        onMoveUp={() => moveStep(index, -1)}
                        onMoveDown={() => moveStep(index, 1)}
                      />
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="space-y-6 xl:col-span-2 min-[1920px]:col-span-1">
          <TaskList
            title="运行中"
            tasks={activeTasks}
            empty="当前没有运行中的任务"
            theme={t}
            onCancel={cancelTask}
            onOpenPath={(targetPath) => window.electronAPI?.openFolder?.(targetPath)}
          />
          <TaskList
            title="运行历史"
            tasks={history}
            empty="暂无运行历史"
            theme={t}
            onClear={history.length > 0 ? clearHistory : null}
            onOpenPath={(targetPath) => window.electronAPI?.openFolder?.(targetPath)}
          />
        </section>
        </div>
      )}
      {onboardingLoaded && (
        <TaskCenterOnboarding
          open={onboardingOpen}
          stage={onboardingStage}
          taskId={recordingTaskId}
          task={recordingTaskView}
          theme={t}
          onStart={startOnboarding}
          onPersistStatus={persistOnboardingStatus}
          onRequestSkip={onboardingStatus ? () => setOnboardingOpen(false) : requestSkipOnboarding}
          onTemporaryClose={() => setOnboardingOpen(false)}
          onReplay={replayOnboardingRecording}
          onRestartRecording={restartOnboardingRecording}
          onCancelTask={cancelRecordingReplay}
          onRetryStateLoad={retryOnboardingStateLoad}
          dismissLabel={onboardingStatus ? '关闭' : '跳过'}
          initialError={onboardingLoadError}
        />
      )}
      <ConfirmDialog
        dialog={confirmDialog}
        theme={t}
        loading={confirmLoading}
        onRememberChoiceChange={confirmDialog?.rememberKey ? (checked) => {
          setConfirmDialog(prev => prev ? { ...prev, rememberChoice: checked } : prev);
        } : undefined}
        onCancel={() => setConfirmDialog(null)}
        onConfirm={runConfirmDialog}
      />
      <ExternalScriptImportDialog
        dialog={externalImportDialog}
        theme={t}
        loading={externalImportLoading}
        onChange={(args) => {
          setExternalImportDialog(prev => prev ? { ...prev, args } : prev);
        }}
        onCancel={() => setExternalImportDialog(null)}
        onConfirm={confirmExternalScriptImport}
      />
    </div>
  );
}

function SimpleModePanel({
  draft,
  theme,
  isDark,
  softClass,
  muted,
  text,
  onlineDevices,
  selectedDeviceIds,
  recorder,
  saving,
  onApplyTemplate,
  onDraftChange,
  onToggleDevice,
  onSelectAllDevices,
  onClearDevices,
  onRun,
  onSave,
  onRecorderChange,
  onRecorderRefresh,
  onRecord,
  onClearSteps,
  onUpdateStep,
  onRemoveStep,
  onMoveStep,
  onOpenAdvanced
}) {
  const loop = draft.loop || {};
  const acceptance = draft.acceptance || {};
  const report = draft.report || {};
  const launchStepIndex = (draft.steps || []).findIndex(step => step.type === 'shell' && /^monkey\s+-p\s+/i.test(step.command || ''));
  const launchPackage = launchStepIndex >= 0 ? extractMonkeyPackage(draft.steps[launchStepIndex].command) : '';
  const setLoop = (patch) => onDraftChange({ loop: { ...loop, ...patch } });
  const setAcceptance = (patch) => onDraftChange({ acceptance: { ...acceptance, ...patch } });
  const setReport = (patch) => onDraftChange({ report: { ...report, ...patch } });
  const selectedCount = selectedDeviceIds.length;

  const updateLaunchPackage = (value) => {
    if (launchStepIndex < 0) return;
    onUpdateStep(launchStepIndex, { command: value.trim() ? `monkey -p ${value.trim()} 1` : 'monkey -p com.example.app 1' });
  };

  return (
    <>
      <div className={`rounded-xl border p-4 ${softClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className={`font-semibold ${text}`}>选择场景</div>
            <div className={`text-xs mt-1 ${muted}`}>从模板开始，后续可以录制补充步骤。</div>
          </div>
          <button type="button" onClick={onOpenAdvanced} className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 ${theme.button.secondary}`}>
            <Terminal size={13} />
            高级编排
          </button>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
          {QUICK_TEMPLATES.map(template => {
            const Icon = template.icon;
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onApplyTemplate(template.id)}
                className={`rounded-xl border p-4 text-left transition-colors ${isDark ? 'border-[#3E4145] bg-[#202124] hover:bg-[#25272B]' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-400">
                  <Icon size={18} />
                </span>
                <span className={`mt-3 block text-sm font-semibold ${text}`}>{template.title}</span>
                <span className={`mt-1 block text-xs leading-relaxed ${muted}`}>{template.description}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={`rounded-xl border p-4 ${softClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className={`font-semibold ${text}`}>运行设备</div>
            <div className={`text-xs mt-1 ${muted}`}>已选择 {selectedCount} 台设备，默认串行运行。</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onSelectAllDevices} className={`px-3 py-2 text-xs rounded-lg border ${theme.button.secondary}`}>全选</button>
            <button type="button" onClick={onClearDevices} className={`px-3 py-2 text-xs rounded-lg border ${theme.button.secondary}`}>清空</button>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {onlineDevices.length === 0 ? (
            <div className={`text-sm ${muted}`}>暂无在线设备</div>
          ) : onlineDevices.map(device => {
            const selected = selectedDeviceIds.includes(device.id);
            return (
              <button
                key={device.id}
                type="button"
                onClick={() => onToggleDevice(device.id)}
                className={`px-3 py-2 rounded-lg border text-sm flex items-center gap-2 transition-colors ${selected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}
              >
                <Smartphone size={14} />
                <span>{device.model || device.id}</span>
              </button>
            );
          })}
        </div>
      </div>

      {launchStepIndex >= 0 && (
        <div className={`rounded-xl border p-4 ${softClass}`}>
          <div className={`font-semibold ${text}`}>应用启动设置</div>
          <div className="mt-3 max-w-xl">
            <TextField label="应用包名" value={launchPackage} onChange={updateLaunchPackage} placeholder="com.example.app" isDark={isDark} />
          </div>
        </div>
      )}

      <StressRecorder
        recorder={recorder}
        onlineDevices={onlineDevices}
        isDark={isDark}
        softClass={softClass}
        simpleMode
        onChange={onRecorderChange}
        onRefresh={onRecorderRefresh}
        onRecord={onRecord}
        onClearSteps={onClearSteps}
      />

      <SimpleStepList
        steps={draft.steps || []}
        theme={theme}
        isDark={isDark}
        text={text}
        muted={muted}
        onUpdateStep={onUpdateStep}
        onRemoveStep={onRemoveStep}
        onMoveStep={onMoveStep}
        onOpenAdvanced={onOpenAdvanced}
      />

      <div className={`rounded-xl border p-4 ${softClass}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className={`font-semibold ${text}`}>运行设置</div>
            <div className={`text-xs mt-1 ${muted}`}>只保留常用选项，高级阈值和脚本参数可去高级编排调整。</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onSave} disabled={saving} className={`px-4 py-2 rounded-lg border text-sm flex items-center gap-2 disabled:opacity-50 ${theme.button.secondary}`}>
              {saving ? <RefreshCw size={15} className="animate-spin" /> : <Save size={15} />}
              保存
            </button>
            <button type="button" onClick={onRun} className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium flex items-center gap-2">
              <Play size={15} />
              开始运行
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-4">
          <NumberField label="运行次数" value={loop.count ?? 1} onChange={(value) => setLoop({ count: value })} isDark={isDark} />
          <NumberField label="最长时长(ms)" value={loop.durationMs ?? 0} onChange={(value) => setLoop({ durationMs: value })} isDark={isDark} />
          <NumberField label="每轮间隔(ms)" value={loop.intervalMs ?? 1000} onChange={(value) => setLoop({ intervalMs: value })} isDark={isDark} />
          <NumberField label="最低成功率(%)" value={acceptance.minSuccessRate ?? 100} onChange={(value) => setAcceptance({ minSuccessRate: value })} isDark={isDark} />
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          <CheckOption label="失败后继续" checked={loop.continueOnError !== false} onChange={(checked) => setLoop({ continueOnError: checked })} isDark={isDark} />
          <CheckOption label="检测崩溃日志" checked={acceptance.failOnCrash !== false} onChange={(checked) => setAcceptance({ failOnCrash: checked })} isDark={isDark} />
          <CheckOption label="检测 ANR 日志" checked={acceptance.failOnAnr !== false} onChange={(checked) => setAcceptance({ failOnAnr: checked })} isDark={isDark} />
          <CheckOption label="生成 AI 分析" checked={report.includeAiSummary === true} onChange={(checked) => setReport({ includeAiSummary: checked })} isDark={isDark} />
        </div>
      </div>
    </>
  );
}

function SimpleStepList({ steps, theme, isDark, text, muted, onUpdateStep, onRemoveStep, onMoveStep, onOpenAdvanced }) {
  return (
    <div className={`rounded-xl border overflow-hidden ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <div className={`px-4 py-3 border-b flex flex-wrap items-center justify-between gap-3 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
        <div>
          <div className={`font-semibold ${text}`}>已录制步骤</div>
          <div className={`text-xs mt-1 ${muted}`}>{steps.length} 个步骤，默认按顺序执行。</div>
        </div>
        <button type="button" onClick={onOpenAdvanced} className={`px-3 py-2 rounded-lg border text-xs ${theme.button.secondary}`}>编辑高级字段</button>
      </div>
      <div className="p-4 space-y-2">
        {steps.length === 0 ? (
          <div className={`py-10 text-center text-sm ${muted}`}>选择模板或在设备画面上点击、拖拽，系统会自动生成步骤。</div>
        ) : steps.map((step, index) => {
          const summary = getStepSummary(step);
          const Icon = summary.icon;
          const simpleEditable = isSimpleEditableStep(step);
          return (
            <div key={step.id || index} className={`rounded-lg border p-3 ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
              <div className="flex flex-wrap items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
                  <Icon size={15} />
                </div>
                <div className="min-w-0 flex-1">
                  <input
                    value={step.label || summary.title}
                    onChange={(event) => onUpdateStep(index, { label: event.target.value })}
                    className={`w-full bg-transparent text-sm font-semibold outline-none ${text}`}
                    placeholder={summary.title}
                  />
                  <div className={`mt-1 text-xs truncate ${muted}`}>{summary.detail}</div>
                </div>
                {step.critical === true && (
                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-400">验收点</span>
                )}
                {!simpleEditable && (
                  <span className={`rounded-full border px-2 py-1 text-[11px] ${isDark ? 'border-[#5F6368] text-[#9AA0A6]' : 'border-slate-200 text-slate-500'}`}>高级步骤</span>
                )}
                <button type="button" onClick={() => onUpdateStep(index, { critical: step.critical !== true })} className={`px-2 py-1.5 rounded-lg border text-xs ${theme.button.secondary}`}>验收点</button>
                <button type="button" onClick={() => onMoveStep(index, -1)} className={`px-2 py-1.5 rounded-lg border text-xs ${theme.button.secondary}`}>上移</button>
                <button type="button" onClick={() => onMoveStep(index, 1)} className={`px-2 py-1.5 rounded-lg border text-xs ${theme.button.secondary}`}>下移</button>
                <button type="button" onClick={() => onRemoveStep(index)} className="p-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10" title="删除步骤">
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfirmDialog({ dialog, theme, loading, onRememberChoiceChange, onCancel, onConfirm }) {
  useEffect(() => {
    if (!dialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dialog, loading, onCancel]);

  if (!dialog || typeof document === 'undefined') return null;

  const isDark = theme.primary === 'tech';
  const Icon = dialog.icon || AlertCircle;
  const panelClass = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200';
  const titleClass = isDark ? 'text-[#E8EAED]' : 'text-slate-900';
  const textClass = isDark ? 'text-[#BDC1C6]' : 'text-slate-600';
  const detailClass = isDark ? 'bg-[#2D2F33] border-[#3E4145] text-[#9AA0A6]' : 'bg-slate-50 border-slate-200 text-slate-500';
  const cancelClass = isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-50';

  return createPortal(
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-black/55 px-4 py-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !loading) onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-confirm-title"
        className={`w-full max-w-md rounded-xl border p-5 shadow-2xl ${panelClass}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-red-500/10 text-red-400">
            <Icon size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="task-confirm-title" className={`text-base font-semibold ${titleClass}`}>{dialog.title}</h3>
            <p className={`mt-2 text-sm leading-6 ${textClass}`}>{dialog.message}</p>
            {dialog.detail && (
              <div className={`mt-3 rounded-lg border px-3 py-2 text-xs leading-5 ${detailClass}`}>
                {dialog.detail}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {onRememberChoiceChange ? (
            <label className={`inline-flex items-center gap-2 text-sm ${textClass}`}>
              <input
                type="checkbox"
                checked={!!dialog.rememberChoice}
                disabled={loading}
                onChange={(event) => onRememberChoiceChange(event.target.checked)}
                className="h-4 w-4 rounded border-slate-300 text-emerald-500 focus:ring-emerald-500 disabled:opacity-60"
              />
              <span>{dialog.rememberLabel || '下次不再提示'}</span>
            </label>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            autoFocus
            disabled={loading}
            onClick={onCancel}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors disabled:opacity-60 ${cancelClass}`}
          >
            取消
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className="px-4 py-2 text-sm rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? '处理中...' : dialog.confirmLabel || '确定'}
          </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function ExternalScriptImportDialog({ dialog, theme, loading, onChange, onCancel, onConfirm }) {
  useEffect(() => {
    if (!dialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape' && !loading) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [dialog, loading, onCancel]);

  if (!dialog || typeof document === 'undefined') return null;

  const isDark = theme.primary === 'tech';
  const fileName = String(dialog.filePath || '').split(/[\\/]/).pop() || '外部脚本';
  const panelClass = isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200';
  const titleClass = isDark ? 'text-[#E8EAED]' : 'text-slate-900';
  const textClass = isDark ? 'text-[#BDC1C6]' : 'text-slate-600';
  const pathClass = isDark ? 'bg-[#2D2F33] border-[#3E4145] text-[#9AA0A6]' : 'bg-slate-50 border-slate-200 text-slate-500';
  const cancelClass = isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-50';

  return createPortal(
    <div
      className="fixed inset-0 z-[145] flex items-center justify-center bg-black/55 px-4 py-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !loading) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="external-script-import-title"
        className={`w-full max-w-lg rounded-xl border p-5 shadow-2xl ${panelClass}`}
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          if (!loading) onConfirm();
        }}
      >
        <div className="flex items-start gap-4">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-400">
            <Terminal size={22} />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id="external-script-import-title" className={`text-base font-semibold ${titleClass}`}>导入外部脚本</h3>
            <p className={`mt-2 text-sm ${textClass}`}>{fileName}</p>
            <div className={`mt-3 break-all rounded-lg border px-3 py-2 text-xs leading-5 ${pathClass}`}>
              {dialog.filePath}
            </div>
          </div>
        </div>
        <label className="mt-5 block">
          <span className={`block text-xs font-medium ${textClass}`}>脚本参数（可选）</span>
          <input
            autoFocus
            value={dialog.args || ''}
            disabled={loading}
            onChange={(event) => onChange(event.target.value)}
            placeholder="-s {deviceId} -n 20"
            className={`${fieldClass(isDark, 'font-mono')} mt-2 disabled:opacity-60`}
          />
          <span className={`mt-2 block text-xs leading-5 ${textClass}`}>
            可留空。如脚本需要指定设备，请按脚本规范填写参数，可使用 {'{deviceId}'} 等占位符。
          </span>
        </label>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className={`px-4 py-2 text-sm rounded-lg border transition-colors disabled:opacity-60 ${cancelClass}`}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={loading}
            className="px-4 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
          >
            {loading && <Loader2 size={14} className="animate-spin" />}
            {loading ? '导入中...' : '导入脚本'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}

function StressConfig({ script, isDark, softClass, onChange }) {
  const loop = script.loop || {};
  const acceptance = script.acceptance || {};
  const thresholds = acceptance.thresholds || {};
  const report = script.report || {};
  const setLoop = (patch) => onChange({ loop: { ...loop, ...patch } });
  const setAcceptance = (patch) => onChange({ acceptance: { ...acceptance, ...patch } });
  const setThresholds = (patch) => setAcceptance({ thresholds: { ...thresholds, ...patch } });
  const setReport = (patch) => onChange({ report: { ...report, ...patch } });

  return (
    <div className={`rounded-xl border p-4 ${softClass}`}>
      <div className={`font-semibold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>自动化压测</div>
      <div className={`text-xs mt-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>本地 ADB/UIAutomator 执行，AI 只允许参与报告总结。</div>

      <div className="mt-4 grid gap-3 lg:grid-cols-4">
        <NumberField label="循环次数" value={loop.count ?? 1} onChange={(value) => setLoop({ count: value })} isDark={isDark} />
        <NumberField label="最长时长(ms)" value={loop.durationMs ?? 0} onChange={(value) => setLoop({ durationMs: value })} isDark={isDark} />
        <NumberField label="轮次间隔(ms)" value={loop.intervalMs ?? 1000} onChange={(value) => setLoop({ intervalMs: value })} isDark={isDark} />
        <NumberField label="最低成功率(%)" value={acceptance.minSuccessRate ?? 100} onChange={(value) => setAcceptance({ minSuccessRate: value })} isDark={isDark} />
      </div>

      <div className="mt-3 grid gap-3 lg:grid-cols-4">
        <NumberField label="CPU阈值(%)" value={thresholds.cpu ?? ''} onChange={(value) => setThresholds({ cpu: value })} isDark={isDark} />
        <NumberField label="内存阈值(%)" value={thresholds.memory ?? ''} onChange={(value) => setThresholds({ memory: value })} isDark={isDark} />
        <NumberField label="温度阈值(℃)" value={thresholds.batteryTemp ?? ''} onChange={(value) => setThresholds({ batteryTemp: value })} isDark={isDark} />
        <NumberField label="存储阈值(%)" value={thresholds.dataUsed ?? ''} onChange={(value) => setThresholds({ dataUsed: value })} isDark={isDark} />
      </div>

      <div className="mt-4 flex flex-wrap gap-3">
        <CheckOption label="失败后继续下一轮" checked={loop.continueOnError !== false} onChange={(checked) => setLoop({ continueOnError: checked })} isDark={isDark} />
        <CheckOption label="检测崩溃日志" checked={acceptance.failOnCrash !== false} onChange={(checked) => setAcceptance({ failOnCrash: checked })} isDark={isDark} />
        <CheckOption label="检测 ANR 日志" checked={acceptance.failOnAnr !== false} onChange={(checked) => setAcceptance({ failOnAnr: checked })} isDark={isDark} />
        <CheckOption label="轮次性能快照" checked={report.includePerformance === true} onChange={(checked) => setReport({ includePerformance: checked })} isDark={isDark} />
        <CheckOption label="报告 AI 分析" checked={report.includeAiSummary === true} onChange={(checked) => setReport({ includeAiSummary: checked })} isDark={isDark} />
      </div>
    </div>
  );
}

function CheckOption({ label, checked, onChange, isDark }) {
  return (
    <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs ${isDark ? 'border-[#5F6368] bg-[#2D2F33] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-700'}`}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-emerald-500" />
      {label}
    </label>
  );
}

function StressRecorder({ recorder, onlineDevices, isDark, softClass, simpleMode = false, focusedMode = false, tapOnly = false, onChange, onRefresh, onRefreshDevices, onRecord, onClearSteps }) {
  const selectedNode = recorder.nodes.find(node => String(node.index) === String(recorder.selectedNodeIndex));
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const previewRef = useRef(null);
  const detachedPreviewRef = useRef(null);
  const detachedViewportRef = useRef(null);
  const pointerRef = useRef(null);
  const [gesture, setGesture] = useState(null);
  const [detachedOpen, setDetachedOpen] = useState(false);
  const [detachedViewportSize, setDetachedViewportSize] = useState({ width: 0, height: 0 });
  const hasScreenshot = Boolean(recorder.screenshotDataUrl && recorder.screenshotWidth && recorder.screenshotHeight);
  const recorderBusy = recorder.loading || recorder.recording || recorder.backgroundLoading;
  const recorderRefreshBusy = recorder.loading || recorder.backgroundLoading;
  const recorderBusyLabel = recorder.recording ? '正在执行并记录操作...' : recorder.backgroundLoading ? '正在刷新设备画面...' : '正在读取设备画面...';

  useEffect(() => {
    if (!detachedOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      pointerRef.current = null;
      setGesture(null);
      setDetachedOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detachedOpen]);

  useEffect(() => {
    if (!detachedOpen || !detachedViewportRef.current) return undefined;
    const element = detachedViewportRef.current;
    let frameId = 0;
    const updateViewportSize = () => {
      const rect = element.getBoundingClientRect();
      setDetachedViewportSize(prev => {
        const width = Math.floor(rect.width);
        const height = Math.floor(rect.height);
        if (prev.width === width && prev.height === height) return prev;
        return { width, height };
      });
    };
    const scheduleUpdate = () => {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(updateViewportSize);
    };
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(element);
    scheduleUpdate();
    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      observer.disconnect();
    };
  }, [detachedOpen]);

  useEffect(() => {
    if (!recorderBusy) return undefined;
    pointerRef.current = null;
    const frameId = requestAnimationFrame(() => setGesture(null));
    return () => cancelAnimationFrame(frameId);
  }, [recorderBusy]);

  const closeDetachedPreview = () => {
    pointerRef.current = null;
    setGesture(null);
    setDetachedOpen(false);
  };

  const handlePreviewPointerDown = (event, element) => {
    if (!hasScreenshot || recorderBusy) return;
    const point = getPreviewDevicePoint(event, element, recorder);
    if (!point) return;
    pointerRef.current = { ...point, pointerId: event.pointerId, startedAt: Date.now(), points: [point] };
    setGesture({ start: point, current: point, points: [point] });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handlePreviewPointerMove = (event, element) => {
    const start = pointerRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const point = getPreviewDevicePoint(event, element, recorder);
    if (!point) return;
    start.points = appendGesturePoint(start.points, point);
    setGesture({ start, current: point, points: start.points });
  };

  const handlePreviewPointerUp = (event, element) => {
    const start = pointerRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    const end = getPreviewDevicePoint(event, element, recorder) || start;
    const points = simplifyGesturePoints(appendGesturePoint(start.points, end, true));
    pointerRef.current = null;
    setGesture(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const clickThreshold = Math.max(12, Math.min(recorder.screenshotWidth, recorder.screenshotHeight) * 0.01);
    if (distance <= clickThreshold) {
      const node = findNodeAtPoint(recorder.nodes, end);
      const durationMs = Math.max(300, Math.min(10000, Date.now() - start.startedAt || recorder.longPress.durationMs || 800));
      if (node) onChange({ selectedNodeIndex: node.index });
      if (tapOnly) {
        onRecord('tap', { node: null, x: end.x, y: end.y });
        return;
      }
      if (durationMs >= LONG_PRESS_RECORD_THRESHOLD_MS) {
        onChange({ longPress: { ...recorder.longPress, x: end.x, y: end.y, durationMs } });
        onRecord('longPress', { node: null, x: end.x, y: end.y, durationMs });
        return;
      }
      onRecord('tap', { node: null, x: end.x, y: end.y });
      return;
    }
    if (tapOnly) return;
    const durationMs = Math.max(80, Math.min(10000, Date.now() - start.startedAt || recorder.swipe.durationMs || 300));
    onChange({ swipe: { ...recorder.swipe, x: start.x, y: start.y, endX: end.x, endY: end.y, durationMs, points } });
    onRecord('swipe', { x: start.x, y: start.y, endX: end.x, endY: end.y, durationMs, points, curve: points.length > 2 });
  };

  const detachedPreview = hasScreenshot && detachedOpen && typeof document !== 'undefined' ? createPortal(
    <div className="fixed inset-0 z-[150] bg-black/70 p-4">
      <div className={`flex h-full flex-col overflow-hidden rounded-xl border shadow-2xl ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
        <div className={`flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <div>
            <div className={`font-semibold ${text}`}>设备画面</div>
            <div className={`mt-1 text-xs ${muted}`}>{recorder.screenshotWidth}x{recorder.screenshotHeight} · 点击记录点击，长按记录长按，拖拽记录滑动</div>
          </div>
          <button
            type="button"
            onClick={closeDetachedPreview}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
          >
            关闭
          </button>
        </div>
        <div ref={detachedViewportRef} className={`flex flex-1 items-center justify-center overflow-hidden p-4 ${isDark ? 'bg-black/30' : 'bg-slate-50'}`}>
          <RecorderPreviewSurface
            recorder={recorder}
            previewRef={detachedPreviewRef}
            gesture={gesture}
            busy={recorderBusy}
            busyLabel={recorderBusyLabel}
            isDark={isDark}
            className={`relative mx-auto overflow-hidden rounded-lg border touch-none select-none shadow-xl ${recorderBusy ? 'cursor-wait' : 'cursor-crosshair'} ${isDark ? 'border-[#3E4145] bg-black' : 'border-slate-200 bg-slate-100'}`}
            style={getDetachedPreviewStyle(recorder, detachedViewportSize)}
            onPointerDown={(event) => handlePreviewPointerDown(event, detachedPreviewRef.current)}
            onPointerMove={(event) => handlePreviewPointerMove(event, detachedPreviewRef.current)}
            onPointerUp={(event) => handlePreviewPointerUp(event, detachedPreviewRef.current)}
            onPointerCancel={() => { pointerRef.current = null; setGesture(null); }}
          />
        </div>
      </div>
    </div>,
    document.body
  ) : null;

  return (
    <div className={`rounded-xl border p-4 ${softClass}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className={`font-semibold ${text}`}>录制回放</div>
          <div className={`text-xs mt-1 ${muted}`}>
            {focusedMode
              ? '选择设备并读取界面后，点击一个安全位置即可录制。'
              : simpleMode
                ? '读取界面后，直接点击、长按或拖拽设备画面生成步骤。'
                : '读取设备 UI 层级，执行一次操作并追加为可回放步骤。'}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div data-task-center-guide={focusedMode ? 'device-select' : undefined} className="flex flex-wrap items-center gap-2">
            {focusedMode && onlineDevices.length === 0 && (
              <>
                <span className={`text-xs ${muted}`}>暂无在线设备，请检查 USB 调试和授权。</span>
                <button type="button" onClick={onRefreshDevices} className={`rounded-lg border px-3 py-2 text-xs ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}>
                  重新检测
                </button>
              </>
            )}
            {onlineDevices.map(device => {
              const selected = recorder.deviceId === device.id;
              return (
                <button
                  key={device.id}
                  disabled={recorderBusy}
                  onClick={() => {
                    closeDetachedPreview();
                    onChange({ deviceId: device.id, nodes: [], selectedNodeIndex: '', screenshotDataUrl: '', screenshotWidth: 0, screenshotHeight: 0, loading: false, recording: false, backgroundLoading: false, error: '' });
                  }}
                  className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50 ${selected ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}
                >
                  <Smartphone size={13} />
                  <span className="max-w-[180px] truncate">{device.model || device.name || device.id}</span>
                </button>
              );
            })}
          </div>
          <button data-task-center-guide={focusedMode ? 'snapshot' : undefined} onClick={onRefresh} disabled={!recorder.deviceId || recorderBusy || recorder.backgroundLoading} className={`px-3 py-2 rounded-lg border text-xs flex items-center gap-1.5 disabled:opacity-50 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-white'}`}>
            <RefreshCw size={13} className={recorderRefreshBusy ? 'animate-spin' : ''} />
            读取界面
          </button>
          {!focusedMode && (
            <button onClick={onClearSteps} className="px-3 py-2 rounded-lg border border-red-500/30 text-xs text-red-400 hover:bg-red-500/10 inline-flex items-center gap-1.5">
              <Trash2 size={13} />
              清空步骤
            </button>
          )}
        </div>
      </div>

      {recorder.error && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${isDark ? 'border-red-500/30 bg-red-500/10 text-red-300' : 'border-red-200 bg-red-50 text-red-600'}`}>
          {recorder.error}
        </div>
      )}

      <div className={`mt-4 grid gap-4 ${focusedMode ? 'grid-cols-1' : '2xl:grid-cols-[minmax(300px,0.9fr)_minmax(380px,1.1fr)]'}`}>
        <div className={`rounded-lg border overflow-hidden min-w-0 ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
          <div className={`px-3 py-2 border-b flex flex-wrap items-center justify-between gap-3 text-xs ${isDark ? 'border-[#3E4145] text-[#9AA0A6]' : 'border-slate-100 text-slate-500'}`}>
            <div className="flex items-center gap-2">
              <span>设备画面</span>
              <span>{hasScreenshot ? `${recorder.screenshotWidth}x${recorder.screenshotHeight}` : '未读取'}</span>
              {recorder.backgroundLoading && !recorder.loading && (
                <span className="inline-flex items-center gap-1 text-emerald-500">
                  <Loader2 size={12} className="animate-spin" />
                  后台刷新中
                </span>
              )}
            </div>
            {hasScreenshot && !focusedMode && (
              <button
                type="button"
                onClick={() => setDetachedOpen(true)}
                className={`inline-flex h-7 items-center gap-1 rounded-md border px-2 ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                title="放大查看"
              >
                <Maximize2 size={12} />
                放大查看
              </button>
            )}
          </div>
          <div className="p-3">
            {hasScreenshot ? (
              <RecorderPreviewSurface
                recorder={recorder}
                previewRef={previewRef}
                gesture={gesture}
                busy={recorderBusy}
                busyLabel={recorderBusyLabel}
                isDark={isDark}
                guideTarget={focusedMode ? 'preview' : undefined}
                showNodeOverlays={!focusedMode}
                className={`relative mx-auto max-h-[460px] max-w-full overflow-hidden rounded-lg border touch-none select-none ${recorderBusy ? 'cursor-wait' : 'cursor-crosshair'} ${isDark ? 'border-[#3E4145] bg-black' : 'border-slate-200 bg-slate-100'}`}
                style={{ aspectRatio: `${recorder.screenshotWidth} / ${recorder.screenshotHeight}` }}
                onPointerDown={(event) => handlePreviewPointerDown(event, previewRef.current)}
                onPointerMove={(event) => handlePreviewPointerMove(event, previewRef.current)}
                onPointerUp={(event) => handlePreviewPointerUp(event, previewRef.current)}
                onPointerCancel={() => { pointerRef.current = null; setGesture(null); }}
              />
            ) : (
              <div className={`py-16 text-center text-sm ${muted}`}>
                {recorder.loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Loader2 size={16} className="animate-spin" />
                    正在读取设备画面...
                  </span>
                ) : focusedMode ? '点击“读取界面”后，可在真实设备画面上录制一次点击。' : '点击“读取界面”后，可直接在设备画面上点击、长按或拖拽录制。'}
              </div>
            )}
          </div>

          {!focusedMode && (
            <>
              <div className={`border-t px-3 py-2 flex items-center justify-between gap-3 text-xs ${isDark ? 'border-[#3E4145] text-[#9AA0A6]' : 'border-slate-100 text-slate-500'}`}>
                <span>当前界面控件</span>
                <span>{recorder.nodes.length > 0 ? `${recorder.nodes.length} 个` : '未读取'}</span>
              </div>
              <div className="max-h-[220px] overflow-y-auto p-2 space-y-1.5">
                {recorder.nodes.length === 0 ? (
                  <div className={`py-8 text-center text-sm ${muted}`}>控件列表为空</div>
                ) : recorder.nodes.map(node => (
                  <button
                    key={node.index}
                    onClick={() => onChange({ selectedNodeIndex: node.index })}
                    className={`w-full rounded-lg border px-3 py-2.5 text-left transition-colors ${String(recorder.selectedNodeIndex) === String(node.index) ? 'border-emerald-500/40 bg-emerald-500/10' : isDark ? 'border-transparent hover:bg-[#2D2F33]' : 'border-transparent hover:bg-slate-50'}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className={`text-sm font-semibold truncate ${text}`}>{node.label}</div>
                        <div className={`text-[11px] mt-1 truncate ${muted}`}>{node.resourceId || node.contentDesc || node.className || node.xpath || '无标识'}</div>
                      </div>
                      <div className={`text-[10px] shrink-0 ${muted}`}>#{node.index}</div>
                    </div>
                    <div className={`mt-1 text-[11px] truncate ${muted}`}>{node.bounds}</div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {!focusedMode && <div className="space-y-3 min-w-0">
          <div className={`rounded-lg border p-4 ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
            <div className={`text-xs mb-2 ${muted}`}>选中控件</div>
            <div className={`text-base font-semibold break-words ${text}`}>{selectedNode?.label || '未选择控件'}</div>
            {simpleMode ? (
              <div className={`text-xs mt-1 ${muted}`}>设备画面点击按坐标保存；等待和断言会保存控件信息。</div>
            ) : (
              <>
                <div className={`text-xs mt-1 break-all ${muted}`}>{selectedNode?.resourceId || selectedNode?.contentDesc || selectedNode?.className || selectedNode?.xpath || '-'}</div>
                <div className={`text-[11px] mt-1 ${muted}`}>{selectedNode?.bounds || '-'}</div>
              </>
            )}
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <button disabled={!selectedNode || recorderBusy} onClick={() => onRecord('tap')} className={recorderButtonClass(isDark)}>
                <Smartphone size={13} />
                点击
              </button>
              <button disabled={!selectedNode || recorderBusy} onClick={() => onRecord('longPress', { durationMs: recorder.longPress.durationMs })} className={recorderButtonClass(isDark)}>
                <Smartphone size={13} />
                长按
              </button>
              <button disabled={!selectedNode || recorderBusy} onClick={() => onRecord('waitText', { timeoutMs: recorder.timeoutMs })} className={recorderButtonClass(isDark)}>
                <Clock3 size={13} />
                等待
              </button>
              <button disabled={!selectedNode || recorderBusy} onClick={() => onRecord('assertText', { timeoutMs: recorder.timeoutMs })} className={recorderButtonClass(isDark)}>
                <CheckCircle2 size={13} />
                断言
              </button>
            </div>
          </div>

          <div className={`grid gap-3 ${simpleMode ? 'lg:grid-cols-1' : 'lg:grid-cols-2'}`}>
            <div className={`rounded-lg border p-3 space-y-2 ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
              <TextField label="输入文本" value={recorder.inputText} onChange={(value) => onChange({ inputText: value })} placeholder="输入到当前焦点" isDark={isDark} />
              <button disabled={!recorder.inputText || recorderBusy} onClick={() => onRecord('input', { text: recorder.inputText })} className={recorderButtonClass(isDark, true)}>
                <Terminal size={13} />
                输入并记录
              </button>
            </div>

            {!simpleMode && (
              <div className={`rounded-lg border p-3 space-y-2 ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
                <TextField label="KeyCode" value={recorder.keyCode} onChange={(value) => onChange({ keyCode: value })} placeholder="例如：66" isDark={isDark} />
                <button disabled={!recorder.keyCode || recorderBusy} onClick={() => onRecord('keyevent', { keyCode: recorder.keyCode })} className={recorderButtonClass(isDark, true)}>
                  <Terminal size={13} />
                  按键并记录
                </button>
              </div>
            )}
          </div>
        </div>}
      </div>

      {!focusedMode && <div className={`mt-4 rounded-lg border p-4 ${isDark ? 'border-[#3E4145] bg-[#202124]' : 'border-slate-200 bg-white'}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className={`text-sm font-semibold ${text}`}>手势与等待</div>
            <div className={`text-xs mt-1 ${muted}`}>在设备画面上点击会记录点击，拖拽会记录滑动；手动坐标只作为兜底。</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button disabled={recorderBusy} onClick={() => onRecord('delay', { durationMs: recorder.delayMs })} className={recorderButtonClass(isDark)}>
              <Clock3 size={13} />
              追加等待步骤
            </button>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <NumberField label="等待/断言超时(ms)" value={recorder.timeoutMs} onChange={(value) => onChange({ timeoutMs: value })} isDark={isDark} />
          <NumberField label="等待步骤(ms)" value={recorder.delayMs} onChange={(value) => onChange({ delayMs: value })} isDark={isDark} />
        </div>
        {!simpleMode && (
          <details className={`mt-4 rounded-lg border ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
            <summary className={`cursor-pointer px-3 py-2 text-xs ${muted}`}>高级手动坐标</summary>
            <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-5">
              <NumberField label="起点X" value={recorder.swipe.x} onChange={(value) => onChange({ swipe: { ...recorder.swipe, x: value, points: [] } })} isDark={isDark} />
              <NumberField label="起点Y" value={recorder.swipe.y} onChange={(value) => onChange({ swipe: { ...recorder.swipe, y: value, points: [] } })} isDark={isDark} />
              <NumberField label="终点X" value={recorder.swipe.endX} onChange={(value) => onChange({ swipe: { ...recorder.swipe, endX: value, points: [] } })} isDark={isDark} />
              <NumberField label="终点Y" value={recorder.swipe.endY} onChange={(value) => onChange({ swipe: { ...recorder.swipe, endY: value, points: [] } })} isDark={isDark} />
              <NumberField label="滑动时长(ms)" value={recorder.swipe.durationMs} onChange={(value) => onChange({ swipe: { ...recorder.swipe, durationMs: value, points: [] } })} isDark={isDark} />
              <button disabled={recorderBusy} onClick={() => onRecord('swipe', recorder.swipe)} className={`${recorderButtonClass(isDark, true)} lg:col-span-5`}>
                <Smartphone size={13} />
                按手动坐标滑动并记录
              </button>
              <NumberField label="长按X" value={recorder.longPress.x} onChange={(value) => onChange({ longPress: { ...recorder.longPress, x: value } })} isDark={isDark} />
              <NumberField label="长按Y" value={recorder.longPress.y} onChange={(value) => onChange({ longPress: { ...recorder.longPress, y: value } })} isDark={isDark} />
              <NumberField label="长按时长(ms)" value={recorder.longPress.durationMs} onChange={(value) => onChange({ longPress: { ...recorder.longPress, durationMs: value } })} isDark={isDark} />
              <button disabled={recorderBusy || recorder.longPress.x === '' || recorder.longPress.y === ''} onClick={() => onRecord('longPress', recorder.longPress)} className={`${recorderButtonClass(isDark, true)} lg:col-span-2`}>
                <Smartphone size={13} />
                按手动坐标长按并记录
              </button>
            </div>
          </details>
        )}
      </div>}
      {detachedPreview}
    </div>
  );
}

function recorderButtonClass(isDark, full = false) {
  return `${full ? 'w-full ' : ''}inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border text-xs disabled:opacity-50 disabled:cursor-not-allowed ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`;
}

function RecorderPreviewSurface({ recorder, previewRef, gesture, busy = false, busyLabel = '正在读取设备画面...', isDark = false, guideTarget, showNodeOverlays = true, className, style, onPointerDown, onPointerMove, onPointerUp, onPointerCancel }) {
  return (
    <div
      ref={previewRef}
      role="button"
      tabIndex={0}
      data-task-center-guide={guideTarget}
      aria-busy={busy}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      className={className}
      style={style}
      title="点击记录点击动作，长按记录长按动作，拖拽记录滑动动作"
    >
      <img
        src={recorder.screenshotDataUrl}
        alt="设备画面"
        draggable={false}
        className="h-full w-full object-contain"
      />
      <div className="pointer-events-none absolute inset-0">
        {showNodeOverlays && recorder.nodes.map(node => node.rect && (
          <div
            key={node.index}
            className={`absolute rounded-sm border ${String(recorder.selectedNodeIndex) === String(node.index) ? 'border-emerald-400 bg-emerald-400/15' : 'border-emerald-300/40 bg-emerald-300/5'}`}
            style={nodeOverlayStyle(node, recorder)}
          />
        ))}
        {gesture && (
          <svg className="absolute inset-0 h-full w-full" viewBox={`0 0 ${recorder.screenshotWidth} ${recorder.screenshotHeight}`} preserveAspectRatio="none">
            <polyline points={formatSvgPoints(gesture.points || [gesture.start, gesture.current])} fill="none" stroke="#22c55e" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx={gesture.start.x} cy={gesture.start.y} r="10" fill="#22c55e" />
            <circle cx={gesture.current.x} cy={gesture.current.y} r="10" fill="#10b981" />
          </svg>
        )}
      </div>
      {busy && (
        <div className={`absolute inset-0 z-20 flex items-center justify-center ${isDark ? 'bg-black/55 text-[#E8EAED]' : 'bg-white/75 text-slate-700'} backdrop-blur-[1px]`}>
          <div className={`inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-sm ${isDark ? 'border-[#3E4145] bg-[#202124]/95' : 'border-slate-200 bg-white/95'}`}>
            <Loader2 size={16} className="animate-spin text-emerald-500" />
            <span>{busyLabel}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function getDetachedPreviewStyle(recorder, viewportSize) {
  const width = Number(recorder.screenshotWidth) || 1;
  const height = Number(recorder.screenshotHeight) || 1;
  const viewportWidth = Math.max(1, Number(viewportSize?.width) || width);
  const viewportHeight = Math.max(1, Number(viewportSize?.height) || height);
  const fitScale = Math.min(viewportWidth / width, viewportHeight / height);
  const previewWidth = Math.max(1, Math.floor(width * fitScale));
  const previewHeight = Math.max(1, Math.floor(height * fitScale));
  return {
    width: `${previewWidth}px`,
    height: `${previewHeight}px`
  };
}

function getPreviewDevicePoint(event, element, recorder) {
  if (!element || !recorder.screenshotWidth || !recorder.screenshotHeight) return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = Math.max(0, Math.min(recorder.screenshotWidth, Math.round((event.clientX - rect.left) / rect.width * recorder.screenshotWidth)));
  const y = Math.max(0, Math.min(recorder.screenshotHeight, Math.round((event.clientY - rect.top) / rect.height * recorder.screenshotHeight)));
  return { x, y };
}

function appendGesturePoint(points, point, force = false) {
  const nextPoint = { x: Math.round(point.x), y: Math.round(point.y) };
  const source = Array.isArray(points) ? points : [];
  const last = source[source.length - 1];
  if (!force && last && Math.hypot(nextPoint.x - last.x, nextPoint.y - last.y) < 8) return source;
  if (last && last.x === nextPoint.x && last.y === nextPoint.y) return source;
  return [...source, nextPoint].slice(-120);
}

function simplifyGesturePoints(points, maxPoints = 48) {
  const source = (Array.isArray(points) ? points : [])
    .map(point => ({ x: Math.round(Number(point.x)), y: Math.round(Number(point.y)) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (source.length <= maxPoints) return source;
  const result = [source[0]];
  const step = (source.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i += 1) {
    result.push(source[Math.round(i * step)]);
  }
  result.push(source[source.length - 1]);
  return result;
}

function formatSvgPoints(points) {
  return (Array.isArray(points) ? points : [])
    .map(point => `${Math.round(point.x)},${Math.round(point.y)}`)
    .join(' ');
}

function formatGesturePointsInput(points) {
  if (Array.isArray(points)) return points.length > 0 ? JSON.stringify(points) : '';
  return String(points || '');
}

function findNodeAtPoint(nodes, point) {
  const candidates = (nodes || []).filter(node => {
    const rect = node.rect;
    return rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  });
  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => rectArea(a.rect) - rectArea(b.rect))[0];
}

function rectArea(rect) {
  return Math.max(0, rect.right - rect.left) * Math.max(0, rect.bottom - rect.top);
}

function nodeOverlayStyle(node, recorder) {
  const rect = node.rect || {};
  const width = recorder.screenshotWidth || 1;
  const height = recorder.screenshotHeight || 1;
  return {
    left: `${rect.left / width * 100}%`,
    top: `${rect.top / height * 100}%`,
    width: `${Math.max(0, rect.right - rect.left) / width * 100}%`,
    height: `${Math.max(0, rect.bottom - rect.top) / height * 100}%`
  };
}

function StepTypeDropdown({ value, isDark, onChange }) {
  const rootRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);
  const selectedIndex = Math.max(0, STEP_TYPES.findIndex(type => type.value === value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = STEP_TYPES[selectedIndex] || STEP_TYPES[0];
  const SelectedIcon = selected.icon;

  useEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportWidth = window.innerWidth || 1024;
      const viewportHeight = window.innerHeight || 768;
      const gap = 8;
      const width = Math.min(320, Math.max(288, rect.width));
      const spaceBelow = viewportHeight - rect.bottom - gap;
      const spaceAbove = rect.top - gap;
      const openUp = spaceBelow < 240 && spaceAbove > spaceBelow;
      const availableHeight = openUp ? spaceAbove - gap : spaceBelow - gap;
      const maxHeight = Math.max(180, Math.min(320, availableHeight));
      const top = openUp
        ? Math.max(gap, rect.top - maxHeight - gap)
        : Math.min(viewportHeight - maxHeight - gap, rect.bottom + gap);
      const left = Math.min(viewportWidth - width - gap, Math.max(gap, rect.right - width));
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
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!rootRef.current?.contains(event.target) && !menuRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex(prev => (prev + 1) % STEP_TYPES.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex(prev => (prev - 1 + STEP_TYPES.length) % STEP_TYPES.length);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const next = STEP_TYPES[activeIndex] || STEP_TYPES[0];
        onChange(next.value);
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [activeIndex, onChange, open]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

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
      {STEP_TYPES.map((type, index) => {
        const Icon = type.icon;
        const selectedOption = type.value === value;
        const active = index === activeIndex;
        return (
          <button
            key={type.value}
            type="button"
            role="option"
            aria-selected={selectedOption}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => {
              onChange(type.value);
              setOpen(false);
            }}
            className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors flex items-start gap-3 ${active ? 'bg-emerald-500/10' : isDark ? 'hover:bg-[#2D2F33]' : 'hover:bg-slate-50'}`}
          >
            <span className={`mt-0.5 h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${selectedOption ? 'bg-emerald-500 text-white' : 'bg-emerald-500/10 text-emerald-400'}`}>
              <Icon size={15} />
            </span>
            <span className="min-w-0 flex-1">
              <span className={`block text-sm font-medium ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{type.label}</span>
              <span className={`block text-xs mt-0.5 leading-snug ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{type.description}</span>
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
        onClick={() => setOpen(prev => !prev)}
        className={`min-w-[160px] px-3 py-2 rounded-lg border text-sm transition-colors flex items-center justify-between gap-3 ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
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

function StepEditor({ step, index, theme, isDark, onChange, onRemove, onMoveUp, onMoveDown }) {
  const t = theme;
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const selectedType = STEP_TYPES.find(type => type.value === step.type) || STEP_TYPES[0];
  const Icon = selectedType.icon;
  const unlimitedScriptTimeout = hasUnlimitedExternalScriptTimeout(step);

  return (
    <div className={`rounded-lg border p-4 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-emerald-500/10 text-emerald-400 flex items-center justify-center shrink-0">
          <Icon size={16} />
        </div>
        <div className="flex-1 min-w-[240px]">
          <input
            value={step.label}
            onChange={(e) => onChange({ label: e.target.value })}
            className={`w-full font-medium bg-transparent outline-none ${text}`}
            placeholder="步骤名称"
          />
          <div className={`text-xs mt-0.5 ${muted}`}>步骤 {index + 1}</div>
        </div>
        <StepTypeDropdown
          value={step.type}
          isDark={isDark}
          onChange={(value) => onChange({ ...createStep(value), id: step.id, label: getTypeLabel(value) })}
        />
        <button onClick={onMoveUp} className={`px-2 py-2 rounded-lg border text-xs ${t.button.secondary}`}>上移</button>
        <button onClick={onMoveDown} className={`px-2 py-2 rounded-lg border text-xs ${t.button.secondary}`}>下移</button>
        <button onClick={onRemove} className="p-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10" title="删除步骤">
          <Trash2 size={14} />
        </button>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        {renderStepFields(step, onChange, isDark)}
        {unlimitedScriptTimeout ? (
          <div>
            <FieldLabel label="执行超时" isDark={isDark} />
            <div className={`w-full rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-[#5F6368] bg-[#2D2F33] text-[#E8EAED]' : 'border-slate-200 bg-slate-50 text-slate-700'}`}>
              不限制（可手动取消）
            </div>
          </div>
        ) : (
          <NumberField label="超时(ms)" value={step.timeoutMs} onChange={(value) => onChange({ timeoutMs: value })} isDark={isDark} />
        )}
      </div>
    </div>
  );
}

function hasUnlimitedExternalScriptTimeout(step) {
  if (step?.type !== 'externalScript') return false;
  const extension = String(step.scriptPath || '').trim().match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() || '';
  return extension === 'py' || extension === 'sh';
}

function renderStepFields(step, onChange, isDark) {
  if (step.type === 'shell') {
    return (
      <label className="lg:col-span-2 block">
        <FieldLabel label="Shell 命令" isDark={isDark} />
        <textarea
          value={step.command}
          onChange={(e) => onChange({ command: e.target.value })}
          rows={3}
          placeholder="例如：dumpsys window | grep mCurrentFocus"
          className={fieldClass(isDark, 'font-mono')}
        />
      </label>
    );
  }
  if (step.type === 'installApk') {
    return <TextField label="APK 路径" value={step.localPath} onChange={(value) => onChange({ localPath: value })} placeholder="C:\\path\\app.apk" isDark={isDark} />;
  }
  if (step.type === 'pushFile') {
    return (
      <>
        <TextField label="本地文件" value={step.localPath} onChange={(value) => onChange({ localPath: value })} placeholder="C:\\path\\file.txt" isDark={isDark} />
        <TextField label="设备路径" value={step.remotePath} onChange={(value) => onChange({ remotePath: value })} placeholder="/sdcard/" isDark={isDark} />
      </>
    );
  }
  if (step.type === 'screenshot') {
    return <TextField label="保存路径（可选）" value={step.localPath} onChange={(value) => onChange({ localPath: value })} placeholder="留空则保存到任务产物目录" isDark={isDark} />;
  }
  if (step.type === 'imageCompare') {
    return (
      <>
        <TextField label="基准图路径" value={step.baselinePath} onChange={(value) => onChange({ baselinePath: value })} placeholder="C:\\path\\baseline.png" isDark={isDark} />
        <NumberField label="相似度阈值(%)" value={step.threshold} onChange={(value) => onChange({ threshold: value })} isDark={isDark} />
      </>
    );
  }
  if (step.type === 'tap' || step.type === 'longPress') {
    return (
      <>
        <TextField label="文本选择器" value={step.text} onChange={(value) => onChange({ text: value })} placeholder="例如：登录" isDark={isDark} />
        <TextField label="resource-id" value={step.resourceId} onChange={(value) => onChange({ resourceId: value })} placeholder="com.example:id/login" isDark={isDark} />
        <TextField label="content-desc" value={step.contentDesc} onChange={(value) => onChange({ contentDesc: value })} placeholder="例如：登录按钮" isDark={isDark} />
        <TextField label="className" value={step.className} onChange={(value) => onChange({ className: value })} placeholder="android.widget.TextView" isDark={isDark} />
        <TextField label="XPath-like 路径" value={step.xpath} onChange={(value) => onChange({ xpath: value })} placeholder="录制后自动生成，可手动调整" isDark={isDark} />
        <NumberField label="X坐标（可选）" value={step.x ?? ''} onChange={(value) => onChange({ x: value })} isDark={isDark} />
        <NumberField label="Y坐标（可选）" value={step.y ?? ''} onChange={(value) => onChange({ y: value })} isDark={isDark} />
        {step.type === 'longPress' && <NumberField label="长按时长(ms)" value={step.durationMs} onChange={(value) => onChange({ durationMs: value })} isDark={isDark} />}
      </>
    );
  }
  if (step.type === 'swipe') {
    return (
      <>
        <NumberField label="起点X" value={step.x ?? ''} onChange={(value) => onChange({ x: value })} isDark={isDark} />
        <NumberField label="起点Y" value={step.y ?? ''} onChange={(value) => onChange({ y: value })} isDark={isDark} />
        <NumberField label="终点X" value={step.endX ?? ''} onChange={(value) => onChange({ endX: value })} isDark={isDark} />
        <NumberField label="终点Y" value={step.endY ?? ''} onChange={(value) => onChange({ endY: value })} isDark={isDark} />
        <NumberField label="滑动时长(ms)" value={step.durationMs} onChange={(value) => onChange({ durationMs: value })} isDark={isDark} />
        <TextAreaField label="曲线路径点(JSON，可选)" value={formatGesturePointsInput(step.points)} onChange={(value) => onChange({ points: value })} placeholder='例如：[{"x":100,"y":200},{"x":180,"y":260},{"x":260,"y":220}]' isDark={isDark} />
      </>
    );
  }
  if (step.type === 'input') {
    return <TextField label="输入文本" value={step.text} onChange={(value) => onChange({ text: value })} placeholder="输入到当前焦点" isDark={isDark} />;
  }
  if (step.type === 'keyevent') {
    return <TextField label="KeyCode" value={step.keyCode} onChange={(value) => onChange({ keyCode: value })} placeholder="例如：66 表示 Enter" isDark={isDark} />;
  }
  if (step.type === 'waitText' || step.type === 'assertText') {
    return (
      <>
        <TextField label="文本" value={step.text} onChange={(value) => onChange({ text: value })} placeholder="需要等待或断言的文本" isDark={isDark} />
        <TextField label="包含文本（可选）" value={step.textContains} onChange={(value) => onChange({ textContains: value })} placeholder="只要求控件文本包含该内容" isDark={isDark} />
        <TextField label="resource-id（可选）" value={step.resourceId} onChange={(value) => onChange({ resourceId: value })} placeholder="可选：进一步限定控件" isDark={isDark} />
        <TextField label="content-desc（可选）" value={step.contentDesc} onChange={(value) => onChange({ contentDesc: value })} placeholder="可选：无文本控件的描述" isDark={isDark} />
        <TextField label="className（可选）" value={step.className} onChange={(value) => onChange({ className: value })} placeholder="android.widget.TextView" isDark={isDark} />
        <TextField label="XPath-like 路径（可选）" value={step.xpath} onChange={(value) => onChange({ xpath: value })} placeholder="录制后自动生成，可手动调整" isDark={isDark} />
        {step.type === 'waitText' && <NumberField label="轮询间隔(ms)" value={step.intervalMs} onChange={(value) => onChange({ intervalMs: value })} isDark={isDark} />}
      </>
    );
  }
  if (step.type === 'externalScript') {
    return (
      <>
        <TextField label="适配器" value={step.adapter} onChange={(value) => onChange({ adapter: value })} placeholder="custom / maestro / appium / uiautomator2" isDark={isDark} />
        <TextField label="脚本路径" value={step.scriptPath} onChange={(value) => onChange({ scriptPath: value })} placeholder="C:\\path\\script.py 或 .yaml" isDark={isDark} />
        <TextField label="命令（可选）" value={step.command} onChange={(value) => onChange({ command: value })} placeholder="留空时按脚本后缀或适配器推断" isDark={isDark} />
        <TextField label="参数" value={step.args} onChange={(value) => onChange({ args: value })} placeholder="{deviceId} {artifactDir} {scriptPath} {adb}" isDark={isDark} />
        <TextField label="工作目录（可选）" value={step.workingDir} onChange={(value) => onChange({ workingDir: value })} placeholder="留空默认脚本所在目录" isDark={isDark} />
      </>
    );
  }
  if (step.type === 'inspection') {
    return (
      <>
        <label className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-[#5F6368] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
          <span className={isDark ? 'text-[#E8EAED]' : 'text-slate-700'}>包含 bugreport</span>
          <input
            type="checkbox"
            checked={step.includeBugreport === true}
            onChange={(e) => onChange({ includeBugreport: e.target.checked })}
            className="h-4 w-4 accent-emerald-500"
          />
        </label>
        <label className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-[#5F6368] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
          <span className={isDark ? 'text-[#E8EAED]' : 'text-slate-700'}>包含 AI 总结</span>
          <input
            type="checkbox"
            checked={step.includeAiSummary !== false}
            onChange={(e) => onChange({ includeAiSummary: e.target.checked })}
            className="h-4 w-4 accent-emerald-500"
          />
        </label>
      </>
    );
  }
  if (step.type === 'waitLog') {
    return (
      <>
        <TextField label="关键词" value={step.keyword} onChange={(value) => onChange({ keyword: value })} placeholder="等待出现的日志关键词" isDark={isDark} />
        <TextField label="正则（可选）" value={step.regex} onChange={(value) => onChange({ regex: value })} placeholder="优先使用正则匹配" isDark={isDark} />
        <NumberField label="轮询间隔(ms)" value={step.intervalMs} onChange={(value) => onChange({ intervalMs: value })} isDark={isDark} />
      </>
    );
  }
  if (step.type === 'delay') {
    return <NumberField label="等待时长(ms)" value={step.durationMs} onChange={(value) => onChange({ durationMs: value })} isDark={isDark} />;
  }
  return (
    <div className={`text-sm ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
      该步骤无需额外参数。
    </div>
  );
}

function TaskList({ title, tasks, empty, theme, onCancel, onClear, onOpenPath }) {
  const isDark = theme.primary === 'tech';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  return (
    <div className={`rounded-xl border shadow-sm overflow-hidden ${isDark ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`}>
      <div className={`px-4 py-3 border-b flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
        <div className={`font-semibold ${text}`}>{title}</div>
        {onClear && <button onClick={onClear} className="text-xs text-red-400 hover:underline">清空</button>}
      </div>
      <div className="max-h-[440px] overflow-y-auto p-3 space-y-3">
        {tasks.length === 0 ? (
          <div className={`py-10 text-center text-sm ${muted}`}>{empty}</div>
        ) : tasks.map(task => (
          <TaskCard key={task.id} task={task} theme={theme} onCancel={onCancel} onOpenPath={onOpenPath} />
        ))}
      </div>
    </div>
  );
}

function TaskCard({ task, theme, onCancel, onOpenPath }) {
  const isDark = theme.primary === 'tech';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const progress = task.totalSteps ? Math.round(((task.completedSteps + task.failedSteps) / task.totalSteps) * 100) : 0;
  const running = task.status === 'running' || task.status === 'queued';
  return (
    <div className={`rounded-lg border p-3 ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className={`font-medium truncate ${text}`}>{task.scriptName}</div>
          <div className={`text-xs mt-1 ${muted}`}>{formatTime(task.startedAt || task.createdAt)} · {task.deviceRuns?.length || 0} 台设备</div>
        </div>
        <StatusPill status={task.status} />
      </div>
      <div className={`mt-3 h-2 rounded-full overflow-hidden ${isDark ? 'bg-[#2D2F33]' : 'bg-slate-200'}`}>
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
      </div>
      <div className={`mt-2 text-xs ${muted}`}>完成 {task.completedSteps || 0}，失败 {task.failedSteps || 0}，总计 {task.totalSteps || 0}</div>
      {task.mode === 'stress' && task.stressSummary && (
        <div className={`mt-2 text-xs ${task.stressSummary.passed ? 'text-emerald-400' : 'text-red-400'}`}>
          压测轮次 {task.stressSummary.successRounds || 0}/{task.stressSummary.totalRounds || 0}，成功率 {task.stressSummary.successRate || 0}%
        </div>
      )}
      {task.artifactDir && (
        <div className={`mt-2 rounded border px-2 py-2 ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
          <div className={`text-[11px] truncate ${muted}`}>{task.artifactDir}</div>
          <button
            onClick={() => onOpenPath?.(task.artifactDir)}
            className={`mt-2 w-full px-2 py-1.5 rounded-lg border text-xs flex items-center justify-center gap-1.5 ${theme.button.secondary}`}
          >
            <FolderOpen size={12} />
            打开目录
          </button>
        </div>
      )}
      {running && (
        <div className="mt-3 space-y-2">
          {(task.deviceRuns || []).map(run => (
            <div key={run.deviceId} className={`rounded border px-2 py-1.5 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className={`text-xs font-mono truncate ${text}`}>{run.deviceId}</span>
                <StatusPill status={run.status} compact />
              </div>
              {(run.steps || []).slice(-2).map(step => (
                <div key={`${step.id}-${step.index}`} className={`text-[11px] mt-1 truncate ${step.status === 'failed' ? 'text-red-400' : muted}`}>
                  {step.label}{step.error ? `：${step.error}` : step.artifact ? `：${step.artifact}` : ''}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {running && onCancel && (
        <button onClick={() => onCancel(task.id)} className="mt-3 w-full px-3 py-2 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 flex items-center justify-center gap-2">
          <Square size={13} />
          取消任务
        </button>
      )}
    </div>
  );
}

function StatusPill({ status, compact }) {
  const map = {
    queued: ['等待中', 'bg-slate-500/10 text-slate-400 border-slate-500/20', Clock3],
    running: ['执行中', 'bg-blue-500/10 text-blue-400 border-blue-500/20', Loader2],
    success: ['成功', 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', CheckCircle2],
    failed: ['失败', 'bg-red-500/10 text-red-400 border-red-500/20', AlertCircle],
    cancelled: ['已取消', 'bg-amber-500/10 text-amber-400 border-amber-500/20', AlertCircle]
  };
  const [label, cls, Icon] = map[status] || map.queued;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border ${compact ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-xs'} ${cls}`}>
      <Icon size={compact ? 10 : 12} className={status === 'running' ? 'animate-spin' : ''} />
      {label}
    </span>
  );
}

function StatCard({ label, value, theme }) {
  const isDark = theme.primary === 'tech';
  return (
    <div className={`rounded-lg border px-4 py-3 ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <div className={`text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{label}</div>
      <div className={`text-xl font-bold mt-1 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{value}</div>
    </div>
  );
}

function TextField({ label, value, onChange, placeholder, isDark }) {
  return (
    <label className="block">
      <FieldLabel label={label} isDark={isDark} />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={fieldClass(isDark)} />
    </label>
  );
}

function TextAreaField({ label, value, onChange, placeholder, isDark }) {
  return (
    <label className="block lg:col-span-2">
      <FieldLabel label={label} isDark={isDark} />
      <textarea value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} rows={3} className={fieldClass(isDark, 'font-mono')} />
    </label>
  );
}

function NumberField({ label, value, onChange, isDark }) {
  return (
    <label className="block">
      <FieldLabel label={label} isDark={isDark} />
      <input type="number" value={value} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} className={fieldClass(isDark)} />
    </label>
  );
}

function FieldLabel({ label, isDark }) {
  return <span className={`block text-xs font-medium mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{label}</span>;
}

function fieldClass(isDark, extra = '') {
  return `w-full px-3 py-2 rounded-lg border text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-white border-slate-200 text-slate-700 placeholder-slate-400'} ${extra}`;
}

function createTemplateScript(templateId) {
  const script = {
    ...createEmptyScript(),
    id: `script-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    mode: 'stress',
    continueOnError: true,
    loop: { count: 10, durationMs: 0, intervalMs: 1000, continueOnError: true },
    acceptance: { minSuccessRate: 95, failOnCrash: true, failOnAnr: true, thresholds: { cpu: '', memory: '', batteryTemp: '', dataUsed: '' } },
    report: { includeAiSummary: false, includePerformance: true }
  };

  if (templateId === 'launch') {
    return {
      ...script,
      name: '启动应用稳定性压测',
      description: '循环启动应用，采集截图和性能快照，用于验证启动稳定性。',
      steps: [
        { ...createStep('shell'), label: '启动应用', command: 'monkey -p com.example.app 1', timeoutMs: 15000, critical: true },
        { ...createStep('delay'), label: '等待应用稳定', durationMs: 2000, timeoutMs: 5000 },
        { ...createStep('screenshot'), label: '保存启动截图', timeoutMs: 30000 },
        { ...createStep('perfSnapshot'), label: '采集性能快照', timeoutMs: 30000 }
      ]
    };
  }

  if (templateId === 'compare') {
    return {
      ...script,
      name: '截图比对验收',
      description: '采集当前画面并和基准图比对，用于验证页面显示是否稳定。',
      steps: [
        { ...createStep('screenshot'), label: '保存当前截图', timeoutMs: 30000 },
        { ...createStep('imageCompare'), label: '截图比对验收', baselinePath: '', threshold: 98, timeoutMs: 30000, critical: true }
      ]
    };
  }

  if (templateId === 'install-launch') {
    return {
      ...script,
      name: '安装后启动验证',
      description: '安装 APK 后清理日志并启动应用，自动采集首屏截图和性能快照。',
      loop: { ...script.loop, count: 1, intervalMs: 1000 },
      acceptance: { ...script.acceptance, minSuccessRate: 100 },
      steps: [
        { ...createStep('installApk'), label: '安装 APK', localPath: '', timeoutMs: 120000, critical: true },
        { ...createStep('shell'), label: '清理历史日志', command: 'logcat -c', timeoutMs: 10000 },
        { ...createStep('shell'), label: '启动应用', command: 'monkey -p com.example.app 1', timeoutMs: 15000, critical: true },
        { ...createStep('delay'), label: '等待首屏稳定', durationMs: 2500, timeoutMs: 5000 },
        { ...createStep('screenshot'), label: '保存首屏截图', timeoutMs: 30000 },
        { ...createStep('perfSnapshot'), label: '采集启动后性能', timeoutMs: 30000 }
      ]
    };
  }

  if (templateId === 'crash-capture') {
    return {
      ...script,
      name: '崩溃复现采集',
      description: '清理日志后启动应用，等待崩溃或 ANR 日志命中，并生成基础巡检摘要。',
      loop: { ...script.loop, count: 1, intervalMs: 1000 },
      acceptance: { ...script.acceptance, minSuccessRate: 100, failOnCrash: true, failOnAnr: true },
      steps: [
        { ...createStep('shell'), label: '清理历史日志', command: 'logcat -c', timeoutMs: 10000 },
        { ...createStep('shell'), label: '启动应用', command: 'monkey -p com.example.app 1', timeoutMs: 15000, critical: true },
        { ...createStep('delay'), label: '等待复现场景', durationMs: 3000, timeoutMs: 5000 },
        { ...createStep('waitLog'), label: '等待崩溃或 ANR 日志', regex: 'FATAL EXCEPTION|ANR in|Application Not Responding', intervalMs: 2000, timeoutMs: 60000, critical: true },
        { ...createStep('screenshot'), label: '保存现场截图', timeoutMs: 30000 },
        { ...createStep('inspection'), label: '生成基础巡检摘要', includeBugreport: false, includeAiSummary: false, timeoutMs: 120000 }
      ]
    };
  }

  if (templateId === 'smoke') {
    return {
      ...script,
      name: '基础冒烟检查',
      description: '快速读取设备基础状态，返回桌面后采集截图、性能快照和巡检摘要。',
      loop: { ...script.loop, count: 1, intervalMs: 1000 },
      acceptance: { ...script.acceptance, minSuccessRate: 100 },
      steps: [
        { ...createStep('shell'), label: '读取设备型号', command: 'getprop ro.product.model', timeoutMs: 10000, critical: true },
        { ...createStep('shell'), label: '读取系统版本', command: 'getprop ro.build.version.release', timeoutMs: 10000 },
        { ...createStep('shell'), label: '返回桌面', command: 'input keyevent HOME', timeoutMs: 10000 },
        { ...createStep('delay'), label: '等待桌面稳定', durationMs: 1500, timeoutMs: 5000 },
        { ...createStep('screenshot'), label: '保存桌面截图', timeoutMs: 30000 },
        { ...createStep('perfSnapshot'), label: '采集基础性能', timeoutMs: 30000 },
        { ...createStep('inspection'), label: '生成基础巡检摘要', includeBugreport: false, includeAiSummary: false, timeoutMs: 120000 }
      ]
    };
  }

  if (templateId === 'performance-watch') {
    return {
      ...script,
      name: '性能观察模板',
      description: '循环启动目标应用并采集性能快照和截图，用于观察长时间使用后的资源变化。',
      loop: { ...script.loop, count: 20, intervalMs: 3000, continueOnError: true },
      acceptance: {
        ...script.acceptance,
        minSuccessRate: 95,
        thresholds: { cpu: 85, memory: '', batteryTemp: 50, dataUsed: '' }
      },
      steps: [
        { ...createStep('shell'), label: '启动应用', command: 'monkey -p com.example.app 1', timeoutMs: 15000, critical: true },
        { ...createStep('delay'), label: '等待应用稳定', durationMs: 3000, timeoutMs: 5000 },
        { ...createStep('perfSnapshot'), label: '采集性能快照', timeoutMs: 30000 },
        { ...createStep('screenshot'), label: '保存观察截图', timeoutMs: 30000 }
      ]
    };
  }

  return {
    ...script,
    name: '录制操作流程',
    description: '读取设备界面后点击或拖拽录制，自动生成可回放步骤。',
    mode: 'replay',
    continueOnError: false,
    loop: { count: 1, durationMs: 0, intervalMs: 0, continueOnError: false },
    acceptance: { minSuccessRate: 0, failOnCrash: false, failOnAnr: false, thresholds: {} },
    report: { includeAiSummary: false, includePerformance: false },
    steps: []
  };
}

function getStepSummary(step) {
  const target = getStepTargetText(step);
  if (step.type === 'shell') return { title: step.label || '执行命令', detail: step.command || '未填写命令', icon: Terminal };
  if (step.type === 'installApk') return { title: step.label || '安装 APK', detail: step.localPath || '未选择 APK', icon: Package };
  if (step.type === 'pushFile') return { title: step.label || '推送文件', detail: `${step.localPath || '本地文件'} -> ${step.remotePath || '/sdcard/'}`, icon: Upload };
  if (step.type === 'screenshot') return { title: step.label || '保存截图', detail: step.localPath || '保存到任务产物目录', icon: Camera };
  if (step.type === 'imageCompare') return { title: step.label || '截图比对', detail: `${step.baselinePath || '未设置基准图'}，阈值 ${step.threshold || 98}%`, icon: Camera };
  if (step.type === 'perfSnapshot') return { title: step.label || '采集性能快照', detail: '记录 CPU、内存、温度和存储空间', icon: Gauge };
  if (step.type === 'tap') return { title: step.label || `点击 ${target}`, detail: target, icon: Smartphone };
  if (step.type === 'longPress') return { title: step.label || `长按 ${target}`, detail: `${target}，${step.durationMs || 800}ms`, icon: Smartphone };
  if (step.type === 'swipe') return { title: step.label || '滑动屏幕', detail: getSwipeSummary(step), icon: Smartphone };
  if (step.type === 'input') return { title: step.label || '输入文本', detail: step.text || '未填写输入文本', icon: Terminal };
  if (step.type === 'keyevent') return { title: step.label || '发送按键', detail: `KeyCode ${step.keyCode || '-'}`, icon: Terminal };
  if (step.type === 'waitText') return { title: step.label || `等待 ${target}`, detail: `最长等待 ${step.timeoutMs || 30000}ms`, icon: Clock3 };
  if (step.type === 'assertText') return { title: step.label || `断言 ${target}`, detail: `校验界面存在 ${target}`, icon: CheckCircle2 };
  if (step.type === 'inspection') return { title: step.label || '生成巡检摘要', detail: step.includeBugreport ? '包含 bugreport' : '基础巡检报告', icon: ClipboardList };
  if (step.type === 'waitLog') return { title: step.label || '等待日志命中', detail: step.regex || step.keyword || '未填写关键词', icon: Search };
  if (step.type === 'externalScript') return { title: step.label || '执行外部脚本', detail: step.scriptPath || step.command || '未选择脚本', icon: Terminal };
  if (step.type === 'delay') return { title: step.label || '等待', detail: `${step.durationMs || 1000}ms`, icon: Clock3 };
  return { title: step.label || '高级步骤', detail: getTypeLabel(step.type), icon: Terminal };
}

function getStepTargetText(step) {
  if (step.text) return step.text;
  if (step.textContains) return step.textContains;
  if (step.contentDesc) return step.contentDesc;
  if (step.resourceId) return step.resourceId;
  if (step.className) return step.className;
  if (step.xpath) return step.xpath;
  if (step.x !== '' && step.y !== '' && step.x != null && step.y != null) return `坐标 ${step.x}, ${step.y}`;
  return '目标控件';
}

function getSwipeSummary(step) {
  const hasStart = step.x !== '' && step.y !== '' && step.x != null && step.y != null;
  const hasEnd = step.endX !== '' && step.endY !== '' && step.endX != null && step.endY != null;
  if (!hasStart || !hasEnd) return '未设置滑动坐标';
  const curve = Array.isArray(step.points) && step.points.length > 2;
  return `${curve ? '曲线' : '直线'} ${step.x},${step.y} -> ${step.endX},${step.endY}`;
}

function isSimpleEditableStep(step) {
  return ['shell', 'screenshot', 'imageCompare', 'perfSnapshot', 'tap', 'longPress', 'swipe', 'input', 'waitText', 'assertText', 'delay', 'externalScript'].includes(step.type);
}

function extractMonkeyPackage(command) {
  const match = String(command || '').match(/\bmonkey\s+-p\s+([^\s]+)\s+1\b/i);
  return match?.[1] || '';
}

function createEmptyScript() {
  return {
    id: `script-${Date.now()}`,
    name: '新复现脚本',
    description: '',
    mode: 'replay',
    continueOnError: true,
    loop: { count: 1, durationMs: 0, intervalMs: 1000, continueOnError: true },
    acceptance: { minSuccessRate: 100, failOnCrash: true, failOnAnr: true, thresholds: { cpu: '', memory: '', batteryTemp: '', dataUsed: '' } },
    report: { includeAiSummary: false, includePerformance: false },
    steps: [createStep('shell')]
  };
}

function createRecorderState() {
  return {
    deviceId: '',
    nodes: [],
    selectedNodeIndex: '',
    loading: false,
    recording: false,
    backgroundLoading: false,
    error: '',
    screenshotDataUrl: '',
    screenshotWidth: 0,
    screenshotHeight: 0,
    inputText: '',
    keyCode: '66',
    timeoutMs: 10000,
    delayMs: 1000,
    swipe: {
      x: '',
      y: '',
      endX: '',
      endY: '',
      durationMs: 300,
      points: []
    },
    longPress: {
      x: '',
      y: '',
      durationMs: 800
    }
  };
}

function createStep(type) {
  return {
    id: `step-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type,
    label: getTypeLabel(type),
    command: type === 'shell' ? 'getprop ro.product.model' : '',
    localPath: '',
    remotePath: type === 'pushFile' ? '/sdcard/' : '',
    keyword: '',
    regex: '',
    text: '',
    textContains: '',
    resourceId: '',
    contentDesc: '',
    className: '',
    xpath: '',
    selector: {},
    x: '',
    y: '',
    endX: '',
    endY: '',
    points: [],
    keyCode: '',
    baselinePath: '',
    threshold: 98,
    adapter: type === 'externalScript' ? 'custom' : '',
    scriptPath: '',
    args: '',
    workingDir: '',
    critical: false,
    outputBaseDir: '',
    includeBugreport: false,
    includeAiSummary: true,
    timeoutMs: type === 'waitLog' ? 60000 : 30000,
    intervalMs: 2000,
    durationMs: type === 'longPress' ? 800 : 1000,
    continueOnError: false
  };
}

function getTypeLabel(type) {
  return STEP_TYPES.find(item => item.value === type)?.label || '执行步骤';
}

function cloneScript(script) {
  return JSON.parse(JSON.stringify(script || createEmptyScript()));
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN');
}

export default TaskCenter;
