import { tr, useLocale, getLocale } from '../shared/i18n';
// H5: 导入 memo 用于 LogRow 性能优化
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, useDeferredValue, useRef, memo } from 'react';
import { Copy, Terminal, Radio, X, Sparkles, Loader2, Send, StopCircle, Maximize2, Minimize2, FileDown, Zap, Brain, ChevronDown, Lock, BookmarkPlus } from "lucide-react";
import { isDarkTheme } from '../shared/theme';
import { fingerprintLogLines, normalizeLogBuffers, normalizeLogFilter } from '../shared/logWorkspace';
import LogFilterPresets from './LogFilterPresets';
import LogSessionManager from './LogSessionManager';
import LogMarkers from './LogMarkers';
import AiOutboundPreviewHost from './AiOutboundPreviewHost';
import LogFilterHandoff from './LogFilterHandoff';
import useLogWorksetMemory from '../shared/useLogWorksetMemory';
import { captureLogMarker, logEntryIdentity, MAX_LOG_MARKERS } from '../shared/logMarkers';
import { appendLogWindow, boundLogWindow, createLogBatchBuffer } from '../shared/logStream';
// 日志诊断规则库面板
import DiagnosticRuleLibrary from './DiagnosticRuleLibrary';
import LogWorkbenchToolbar from './LogWorkbenchToolbar.jsx';
import LogClosePrompt from './LogClosePrompt.jsx';
import LogIssueInbox from './LogIssueInbox.jsx';
import LogEntryDetail from './LogEntryDetail.jsx';
import LogInlineAnalysisResult from './LogInlineAnalysisResult.jsx';
import LogInlineAnalysisScope from './LogInlineAnalysisScope.jsx';
import LogExportDialog from './LogExportDialog.jsx';
import AppMessageDialogHost from './AppMessageDialogHost.jsx';
import useLogViewPreferences from '../shared/useLogViewPreferences.js';
import useLogViewEngine from '../shared/useLogViewEngine.js';
import { prepareInlineLogAnalysis } from '../shared/logInlineAnalysis.js';
import { logTimeWarningText } from '../shared/logTimeLabels.js';
import { advanceLogAiRevision, buildLogClipboardText, freezeLogSessionSnapshot, logDocumentKey, logListPreview } from '../shared/logSessionSnapshot.js';
import { confirmAppMessage, showAppMessage } from '../shared/appMessageDialog.js';
import { applyLogRowFilter, logEntryTimestamp } from '../shared/logWorkbenchModel.js';
import useLogCloseProtection from '../shared/useLogCloseProtection.js';
import SelectMenu from './SelectMenu.jsx';

const emptyFilter = {};
const LOG_ROW_HEIGHT = 28;
const LOG_ROW_OVERSCAN = 30;

const levels = [
  { v: 'V', label: 'V Verbose' },
  { v: 'D', label: 'D Debug' },
  { v: 'I', label: 'I Info' },
  { v: 'W', label: 'W Warn' },
  { v: 'E', label: 'E Error' },
  { v: 'F', label: 'F Fatal' },
  { v: 'A', label: 'A Assert' }
];

const levelColors = {
  V: 'text-slate-400',
  D: 'text-blue-400',
  I: 'text-emerald-400',
  W: 'text-amber-400',
  E: 'text-red-400',
  F: 'text-red-500',
  A: 'text-white'
};

const levelBgColors = {
  V: 'bg-slate-500/10 border-slate-500/20',
  D: 'bg-blue-500/10 border-blue-500/20',
  I: 'bg-emerald-500/10 border-emerald-500/20',
  W: 'bg-amber-500/10 border-amber-500/20',
  E: 'bg-red-500/10 border-red-500/20',
  F: 'bg-red-500/20 border-red-500/30',
  A: 'bg-white/10 border-white/20'
};

function fmtTs(ts) {
  if (!Number.isFinite(ts)) return '--';
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

function compatibleFor(target, values) {
  const allowed = target.startsWith('hdc:') ? ['app', 'core', 'init', 'kmsg'] : ['main', 'system', 'radio', 'events', 'crash', 'kernel'];
  return Array.isArray(values) ? values.filter(value => allowed.includes(value)) : target.startsWith('hdc:') ? [] : ['main'];
}

export default function LogAnalyzer({ theme, vipStatus }) {
  const locale = useLocale();
  const t = theme || {
    primary: 'tech',
    button: {
      primary: 'bg-emerald-500 hover:bg-emerald-600 text-white'
    }
  };
  const isDark = isDarkTheme(t);
  const logTheme = useMemo(() => ({ primary: isDark ? 'tech' : 'default', text: isDark ? 'text-slate-100' : 'text-slate-800',
    textMuted: isDark ? 'text-slate-400' : 'text-slate-500', card: isDark ? 'border-slate-600 bg-[#202124] text-slate-100' : 'border-slate-200 bg-white text-slate-800',
    input: isDark ? 'border-slate-600 bg-[#2D2F33] text-slate-100' : 'border-slate-200 bg-slate-50 text-slate-700',
    button: { primary: 'bg-emerald-600 text-white hover:bg-emerald-500', secondary: isDark ? 'border-slate-600 bg-[#202124] text-slate-200 hover:bg-[#3E4145]' : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50' } }), [isDark]);
  // VIP 门控：LogAnalyzer 在独立窗口渲染，props 可能未传 vipStatus，故主动拉取
  const [vipStatusState, setVipStatusState] = useState(null);
  const effectiveVipStatus = vipStatus || vipStatusState;
  const isVip = effectiveVipStatus?.activated === true;
  const [vipBlockMsg, setVipBlockMsg] = useState('');
  const showVipBlock = (featureName) => setVipBlockMsg(featureName);
  const dismissVipBlock = () => setVipBlockMsg('');
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState('');
  const [running, setRunning] = useState(false);
  // runningRef: 在事件回调（useEffect 内）中同步读取捕获状态，判断是否应切换到 clean 状态
  const runningRef = useRef(false);
  const captureSessionRef = useRef({ captureId: '', deviceId: '', source: 'realtime' });
  const [source, setSource] = useState('realtime');
  const [entries, setEntries] = useState([]);
  const logBatchBufferRef = useRef(null);
  const markerContextRef = useRef({ entries: [], deviceId: '', count: 0 });
  const loadedWindowRef = useRef([]);
  const [truncated, setTruncated] = useState(false);
  const [sourceLabel, setSourceLabel] = useState('');
  const [captureDeviceId, setCaptureDeviceId] = useState('');
  const [sourceIdentity, setSourceIdentity] = useState('');
  const preferenceDevice = source === 'file' ? '' : captureDeviceId || deviceId;
  const viewPreferences = useLogViewPreferences(preferenceDevice, source);
  const setViewField = viewPreferences.setField;
  const forTargetView = viewPreferences.forTarget, setTargetField = viewPreferences.setTargetField;
  const targetViewReaderRef = useRef(forTargetView);
  useLayoutEffect(() => { targetViewReaderRef.current = forTargetView; }, [forTargetView]);
  const readTargetView = useCallback((target, targetSource) => targetViewReaderRef.current(target, targetSource), []);
  const flushViewPreferences = viewPreferences.retry;
  const [paused, setPaused] = useState(false), [timeRange, setTimeRange] = useState({ kind: 'all' });
  const [documentId, setDocumentId] = useState(() => crypto.randomUUID());
  const [issueOpen, setIssueOpen] = useState(false), [selectedIssue, setSelectedIssue] = useState(null), [detailEntry, setDetailEntry] = useState(null);
  const [archiveState, setArchiveState] = useState(null), [importState, setImportState] = useState(null), [diagnosticError, setDiagnosticError] = useState('');
  const [enabledRules, setEnabledRules] = useState([]), [exportOpen, setExportOpen] = useState(false), [analysisScope, setAnalysisScope] = useState(null);
  const [savedDocumentKey, setSavedDocumentKey] = useState(''), [initialLogStateLoaded, setInitialLogStateLoaded] = useState(false), [hydrateError, setHydrateError] = useState('');
  const latestDocument = useRef(null), refreshLogStateRef = useRef(null), commitResetRef = useRef(null), sourceEventRevision = useRef(0);
  const importRequestRef = useRef(''), importFlightRef = useRef(false), importEpochRef = useRef(0), pendingImportReset = useRef(null), pendingImportProgress = useRef(null), ignoredImports = useRef(new Set());
  const replaceFlightRef = useRef(false), startFlightRef = useRef(false), hydratedRef = useRef(false), mountedRef = useRef(true), aiRequestRef = useRef({ active: false, id: '', retired: new Set() });
  const sourceActionEpoch = useRef(0), stopPromiseRef = useRef(null);
  const conversationEpoch = useRef(0), [conversationReady, setConversationReady] = useState(true);
  const conversationBound = useRef(false), aiPreparing = useRef(false);
  const programmaticScroll = useRef(false);
  const scrollIntentUntil = useRef(0), scrollPointerActive = useRef(false);
  const preferenceTarget = useRef(''), restoringPreference = useRef(null), explicitPreference = useRef('');
  const preparedContext = useRef(null), startingSettings = useRef(null), preparedBufferTarget = useRef('');
  const filterTouched = useRef(false);
  const [evidence, setEvidence] = useState([]);
  const [markers, setMarkers] = useState([]);
  const [markerDraft, setMarkerDraft] = useState(null);
  const [locatedMarkerIdentity, setLocatedMarkerIdentity] = useState('');
  const markerIdentities = useMemo(() => { void locale; return new Set(markers.map(marker => logEntryIdentity(marker.entry))); }, [markers, locale]);
  const markerEntryIds = useMemo(() => { void locale; return new Set(markers.map(marker => marker.entry.id)); }, [markers, locale]);
  const evidenceByRef = useMemo(() => { void locale; return new Map(evidence.map(entry => [entry.ref, entry])); }, [evidence, locale]);
  const [aiHistoryReadOnly, setAiHistoryReadOnly] = useState(false);
  const [restoredSessionName, setRestoredSessionName] = useState('');
  const [filter, setFilterState] = useState(emptyFilter);
  const setFilter = useCallback(value => { filterTouched.current = true; setFilterState(value); }, []);
  const [pendingLogContext, setPendingLogContext] = useState(null);
  const [note, setNote] = useState(undefined);
  const [noteType, setNoteType] = useState('info');
  const [mcpRunning, setMcpRunning] = useState(false);
  const [mcpPort, setMcpPort] = useState(49321);
  const [mcpHelpVisible, setMcpHelpVisible] = useState(false);
  const [mcpConfigTab, setMcpConfigTab] = useState('trae');
  // AI 分析状态
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const aiAnalyzingRef = useRef(false);
  const [aiError, setAiError] = useState('');
  const [aiTurns, setAiTurnsState] = useState([]), [aiRevision, setAiRevision] = useState(0);
  const aiContentVersionRef = useRef({ revision: 0, turns: [] });
  const setAiTurns = useCallback(value => {
    const incoming = typeof value === 'function' ? value(aiTurnsRef.current) : value;
    const next = incoming.map(turn => Object.isFrozen(turn.evidenceRefs) ? turn : { ...turn, evidenceRefs: Object.freeze([...(turn.evidenceRefs || [])]) });
    const version = advanceLogAiRevision(aiContentVersionRef.current, next); aiContentVersionRef.current = version;
    aiTurnsRef.current = next; setAiRevision(version.revision); setAiTurnsState(next);
  }, []);
  const [aiThinkingMode, setAiThinkingMode] = useState(false); // 思考模式开关（默认快速模式）
  const [mapReduceProgress, setMapReduceProgress] = useState(null); // { phase, current, total, lineRange }
  const [contextUsage, setContextUsage] = useState(null); // { usedTokens, maxTokens, percent, messageCount }
  const [aiCustomPrompt, setAiCustomPrompt] = useState('');
  const [aiFullscreen, setAiFullscreen] = useState(false);
  const aiPanelHeight = viewPreferences.view.aiPanelHeight;
  const setAiPanelHeight = useCallback(value => setViewField('aiPanelHeight', value), [setViewField]);
  const aiListenersRef = useRef([]);
  const aiContentRef = useRef('');
  const aiReasoningRef = useRef('');
  const aiTurnsRef = useRef([]); // 对话轮次 ref
  const aiStreamEpochRef = useRef(0);
  const aiHistoryReadOnlyRef = useRef(false);
  const aiResizingRef = useRef(false);
  // 记录上次发送给 AI 的日志指纹（用于判断追问时日志是否变化）
  const aiLastLogHashRef = useRef('');
  // AI 自动诊断状态
  const [autoDiagnoseEnabled, setAutoDiagnoseEnabled] = useState(true);
  // 日志诊断规则库弹窗状态
  const [ruleLibraryOpen, setRuleLibraryOpen] = useState(false);
  const autoDiagnoseListenersRef = useRef([]);
  // 缓存最后一次检测到异常的 alert，用于"展开监控"时恢复显示（而非显示空状态）
  // 智能日志搜索状态
  const [smartSearchQuery, setSmartSearchQuery] = useState('');
  const [smartSearching, setSmartSearching] = useState(false), smartSearchingRef = useRef(false);
  const [smartSearchProgress, setSmartSearchProgress] = useState(null); // { completed, total, matchedCount }
  const [smartSearchResult, setSmartSearchResult] = useState(null); // { matchedEntries, analysis, query, matchedCount }
  const [smartSearchMatchedIds, setSmartSearchMatchedIds] = useState(new Set()); // 匹配的 entry ID 集合
  const [smartSearchIncremental, setSmartSearchIncremental] = useState([]); // 增量累积的匹配条目（流式显示）
  const [searchViewId, setSearchViewId] = useState(0);
  const smartSearchListenersRef = useRef([]);
  const smartRequestRef = useRef({ active: false, id: '', retired: new Set() });
  useEffect(() => window.electronAPI?.onAiOutboundChanged?.(payload => {
    const operation = aiRequestRef.current, operations = payload?.operations || [];
    const analysis = operations.find(item => item.id === operation.id);
    if (operation.active && analysis && ['cancelled', 'failed'].includes(analysis.status)) {
      operation.active = false; operation.retired.add(analysis.id); aiAnalyzingRef.current = false; setAiAnalyzing(false); setMapReduceProgress(null);
    }
  }), []);
  useLayoutEffect(() => { smartSearchingRef.current = smartSearching; }, [smartSearching]);
  // 当前搜索会话 ID：用于过滤旧搜索会话的事件，防止"停止→重新搜索"时
  // 旧搜索的 complete/chunk/progress 事件污染新搜索状态
  const searchSessionRef = useRef(0);
  const logListenersRef = useRef([]);
  const deferredFilter = useDeferredValue(filter);
  const logScrollRef = useRef(null);
  const logViewportRafRef = useRef(null);
  const logAutoScrollRafRef = useRef(null);
  const pendingLogViewportRef = useRef(null);
  const [logViewport, setLogViewport] = useState({ scrollTop: 0, height: 0 });
  // H7: onResizeStart 全局监听器泄漏修复 - 存储 mousemove/mouseup 监听器，组件卸载时清理
  const resizeListenersRef = useRef(null);
  // H6: 列宽拖拽 requestAnimationFrame 节流
  const colResizeRafRef = useRef(null);
  // M8: 过滤输入防抖 - 本地状态保持输入响应，防抖 setFilter
  const filterDebounceRef = useRef(null);
  const [filterTextInput, setFilterTextInput] = useState('');
  // M9: 导出分批处理状态
  const [copying, setCopying] = useState(false);
  // M13: 加载状态
  const [loading, setLoading] = useState(false);
  // L1: 智能滚动 - 仅在用户已滚动到底部时自动跟随
  const autoScrollRef = useRef(true);
  // UX1: note 自动清除定时器
  const noteTimerRef = useRef(null);
  // 多缓冲区抓取：默认仅 main（与原行为一致）
  // 可选项：main / system / radio / events / crash / kernel
  const isHarmonyTarget = deviceId.startsWith('hdc:');
  const isHarmonyLog = captureDeviceId.startsWith('hdc:') || entries.slice(0, 64).some(entry => entry.logFormat === 'hilog');
  const LOG_BUFFERS = isHarmonyTarget ? [
    { id: 'app', label: tr('应用日志'), desc: 'HiLog app' }, { id: 'core', label: tr('系统日志'), desc: 'HiLog core' },
    { id: 'init', label: tr('启动日志'), desc: 'HiLog init' }, { id: 'kmsg', label: tr('内核日志'), desc: tr('内核日志须单独选择。') },
  ] : [
    { id: 'main', label: tr("主日志"), desc: tr("应用与大部分系统日志（默认）") },
    { id: 'system', label: tr("系统日志"), desc: tr("SystemServer、系统服务") },
    { id: 'radio', label: tr("通信日志"), desc: 'Telephony / Wi-Fi / Bluetooth' },
    { id: 'events', label: tr("事件日志"), desc: tr("二进制事件统计") },
    { id: 'crash', label: tr("崩溃日志"), desc: tr("应用 crash 栈") },
    { id: 'kernel', label: tr("内核日志"), desc: tr("Linux kernel 日志") }
  ];
  const [buffers, setBuffers] = useState(['main']);
  const [scopeBuffers, setScopeBuffers] = useState(['main']);
  const rememberedFilter = source === 'file' || captureDeviceId && captureDeviceId !== deviceId ? forTargetView(deviceId, 'realtime').filter : filter;
  const worksetMemory = useLogWorksetMemory({ deviceId, filter: rememberedFilter, buffers });
  const compatibleBuffers = useMemo(() => buffers.filter(id => (isHarmonyTarget ? ['app', 'core', 'init', 'kmsg'] : ['main', 'system', 'radio', 'events', 'crash', 'kernel']).includes(id)), [buffers, isHarmonyTarget]);
  const selectedBuffers = compatibleBuffers;
  const preferenceKey = JSON.stringify([preferenceDevice, source]);

  function configureDevice(value) {
    const saved = readTargetView(value, 'realtime');
    setDeviceId(value); setBuffers(compatibleFor(value, saved.hasSavedView ? saved.buffers : value.startsWith('hdc:') ? [] : ['main']));
    preparedBufferTarget.current = value;
    if (preparedContext.current?.deviceId !== value) preparedContext.current = null;
    if (!latestDocument.current?.entries.length && !latestDocument.current?.markers.length && !latestDocument.current?.aiTurns.length) {
      filterTouched.current = false; if (!saved.hasSavedView) applyRememberedFilter({});
    }
  }
  const applyRememberedFilter = useCallback(value => { clearTimeout(filterDebounceRef.current); setFilterState(value); setFilterTextInput(value.text || ''); }, []);
  useEffect(() => {
    if (!initialLogStateLoaded || preferenceTarget.current === preferenceKey) return;
    preferenceTarget.current = preferenceKey;
    if (explicitPreference.current === preferenceKey || filterTouched.current) { explicitPreference.current = ''; restoringPreference.current = null; return; }
    if (!viewPreferences.hasSavedView) { restoringPreference.current = null; return; }
    const restored = normalizeLogFilter(viewPreferences.view.filter);
    restoringPreference.current = { key: preferenceKey, filter: JSON.stringify(restored) };
    applyRememberedFilter(restored);
  }, [preferenceKey, initialLogStateLoaded, viewPreferences.hasSavedView, viewPreferences.view.filter, applyRememberedFilter]);
  useEffect(() => {
    if (!initialLogStateLoaded || preferenceTarget.current !== preferenceKey) return;
    const selected = normalizeLogFilter(filter), key = JSON.stringify(selected), restoring = restoringPreference.current;
    if (restoring?.key === preferenceKey && restoring.filter !== key) return;
    restoringPreference.current = null;
    if (JSON.stringify(viewPreferences.view.filter) !== key) setViewField('filter', selected);
  }, [initialLogStateLoaded, preferenceKey, filter, setViewField, viewPreferences.view.filter]);
  const applyFilterPreset = (preset) => {
    clearTimeout(filterDebounceRef.current);
    setFilter(normalizeLogFilter(preset.filter));
    setFilterTextInput(preset.filter?.text || '');
    if (!runningRef.current) {
      setBuffers(normalizeLogBuffers(preset.buffers)); preparedBufferTarget.current = deviceId;
      viewPreferences.setTargetField(deviceId, 'realtime', 'buffers', normalizeLogBuffers(preset.buffers));
      if (source === 'file' || !captureDeviceId || deviceId === captureDeviceId) setScopeBuffers(normalizeLogBuffers(preset.buffers));
    }
    else setNote(tr('已套用过滤条件；抓取中的日志类型保持不变。'));
  };

  const applyContext = useCallback((context) => {
      if (!context?.deviceId && !context?.worksetLogs) return;
      if (!hydratedRef.current || runningRef.current || aiAnalyzingRef.current || smartSearchingRef.current || importFlightRef.current) {
        setPendingLogContext(context);
        setNote(tr("日志抓取或 AI 分析仍在运行，未切换设备或过滤条件；请先停止后重新打开设备日志"));
        return;
      }
      clearTimeout(filterDebounceRef.current);
      if (context.deviceId) setDeviceId(context.deviceId);
      const restoredFilter = context.worksetLogs ? normalizeLogFilter(context.worksetLogs.filter) : context.packageName ? { pkg: context.packageName } : {};
      const current = latestDocument.current;
      if (context.deviceId && (current?.entries.length || current?.deviceId || current?.source === 'file') && (current.deviceId !== context.deviceId || current.source !== 'realtime')) {
        preparedContext.current = { deviceId: context.deviceId, filter: restoredFilter, buffers: context.worksetLogs ? normalizeLogBuffers(context.worksetLogs.buffers) : null };
        setTargetField(context.deviceId, 'realtime', 'filter', restoredFilter);
        const remembered = context.worksetLogs ? normalizeLogBuffers(context.worksetLogs.buffers) : readTargetView(context.deviceId, 'realtime').buffers;
        setBuffers(compatibleFor(context.deviceId, remembered)); preparedBufferTarget.current = context.deviceId;
        setPendingLogContext(null); setNote(tr('已选择下次采集设备，当前显示来源保持不变；开始新抓取前会提示保存。')); return;
      }
      explicitPreference.current = JSON.stringify([context.deviceId || '', 'realtime']);
      setFilter(restoredFilter);
      setFilterTextInput(restoredFilter.text || '');
      if (context.worksetLogs) {
        const next = compatibleFor(context.deviceId || '', normalizeLogBuffers(context.worksetLogs.buffers));
        setBuffers(next); preparedBufferTarget.current = context.deviceId || ''; setScopeBuffers(next);
        setTargetField(context.deviceId || '', 'realtime', 'buffers', next);
      }
      setPendingLogContext(null);
      setNote(tr("已选择 {0}{1}，未自动抓取；现有日志保持不变", { 0: context.deviceId, 1: context.packageName ? ` / ${context.packageName}` : '' }));
  }, [readTargetView, setTargetField, setFilter]);
  useEffect(() => {
    if (pendingLogContext && initialLogStateLoaded && !running && !entries.length && !markers.length && !aiTurns.length) applyContext(pendingLogContext);
  }, [pendingLogContext, initialLogStateLoaded, running, entries.length, markers.length, aiTurns.length, applyContext]);
  useEffect(() => {
    const unsubscribe = window.electronAPI?.onLogAnalyzerContext?.(applyContext);
    window.electronAPI?.logAnalyzerGetContext?.().then(applyContext).catch(() => {});
    return () => unsubscribe?.();
  }, [applyContext]);

  const restoreSession = (session, response) => {
    sourceEventRevision.current++;
    logBatchBufferRef.current?.reset();
    aiStreamEpochRef.current += 1;
    aiHistoryReadOnlyRef.current = session.aiTurns.length > 0;
    searchSessionRef.current += 1;
    setSmartSearchResult(null);
    setSmartSearchMatchedIds(new Set());
    setSmartSearchIncremental([]);
    setSource(session.source);
    setSourceLabel(session.sourceLabel);
    setCaptureDeviceId(session.deviceId);
    if (session.deviceId) setDeviceId(session.deviceId);
    const restoredWindow = boundLogWindow(session.entries);
    setEntries(restoredWindow.entries); loadedWindowRef.current = restoredWindow.entries;
    setTruncated(session.truncated || restoredWindow.omittedRows > 0);
    clearTimeout(filterDebounceRef.current); setFilter(normalizeLogFilter(session.filter)); setFilterTextInput(session.filter?.text || '');
    setScopeBuffers(Array.isArray(session.buffers) ? [...session.buffers] : ['main']);
    if (session.source === 'realtime') { setBuffers(Array.isArray(session.buffers) ? [...session.buffers] : ['main']); preparedBufferTarget.current = session.deviceId || ''; }
    explicitPreference.current = JSON.stringify([session.source === 'file' ? '' : session.deviceId || '', session.source]);
    setTargetField(session.source === 'file' ? '' : session.deviceId || '', session.source, 'filter', normalizeLogFilter(session.filter));
    setTargetField(session.source === 'file' ? '' : session.deviceId || '', session.source, 'buffers', Array.isArray(session.buffers) ? [...session.buffers] : ['main']);
    setEvidence(session.evidence);
    setMarkers(session.markers || []);
    setMarkerDraft(null);
    setLocatedMarkerIdentity('');
    aiTurnsRef.current = session.aiTurns;
    setAiTurns(session.aiTurns);
    aiContentRef.current = '';
    aiReasoningRef.current = '';
    aiLastLogHashRef.current = '';
    setAiCustomPrompt('');
    setAiError('');
    setContextUsage(null);
    setPaused(false); setTimeRange(session.timeRange || { kind: 'all' }); setSelectedIssue(null); setDetailEntry(null); setAnalysisScope(null);
    captureSessionRef.current = { captureId: '', deviceId: session.deviceId || '', source: session.source, sourceIdentity: response?.sourceIdentity || '' };
    setSourceIdentity(response?.sourceIdentity || ''); hydratedRef.current = true; setInitialLogStateLoaded(true); setHydrateError('');
    runningRef.current = false; aiRequestRef.current.active = false;
    setRunning(false);
    setAiHistoryReadOnly(session.aiTurns.length > 0);
    setRestoredSessionName(session.name);
    setAiPanelOpen(session.aiTurns.length > 0);
    conversationEpoch.current++; conversationBound.current = false; setConversationReady(true);
    const restoredId = crypto.randomUUID(); setDocumentId(restoredId);
    setSavedDocumentKey(logDocumentKey({ ...session, documentId: restoredId, aiRevision: aiContentVersionRef.current.revision, timeRange: session.timeRange || { kind: 'all' } }));
    setNote(tr("已恢复“{0}”，没有启动采集或 AI 请求", { 0: session.name }));
  };

  // 日志列表列宽可拖拽调整（每列有 min/max 限制）
  // 列顺序：时间 | 级别 | 包名 | Tag | 消息
  const colWidths = { ...viewPreferences.view.colWidths, level: 28 };
  const setColWidths = useCallback(value => setViewField('colWidths', previous => {
    const next = typeof value === 'function' ? value({ ...previous, level: 28 }) : value;
    return { ts: next.ts, pkg: next.pkg, tag: next.tag };
  }), [setViewField]);
  const colResizeRef = useRef(null); // { col, startX, startWidth }

  function onColResizeStart(e, col) {
    e.preventDefault();
    e.stopPropagation();
    colResizeRef.current = {
      col,
      startX: e.clientX,
      startWidth: colWidths[col]
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  }

  // 同步 running 状态到 ref，供 useEffect 内的事件回调读取
  useEffect(() => {
    runningRef.current = running;
  }, [running]);
  useEffect(() => { captureSessionRef.current = { ...captureSessionRef.current, source, deviceId: captureDeviceId, sourceIdentity }; }, [source, captureDeviceId, sourceIdentity]);

  useEffect(() => {
    aiAnalyzingRef.current = aiAnalyzing;
  }, [aiAnalyzing]);

  useEffect(() => {
    function onMouseMove(ev) {
      if (!colResizeRef.current) return;
      const { col, startX, startWidth } = colResizeRef.current;
      const delta = ev.clientX - startX;
      let newWidth = startWidth + delta;
      // 应用 min/max 限制
      const limits = { ts: [100, 220], pkg: [60, 200], tag: [50, 200] };
      const [min, max] = limits[col] || [50, 300];
      newWidth = Math.round(Math.max(min, Math.min(max, newWidth)));
      // H6: 使用 requestAnimationFrame 节流，避免每次 mousemove 都触发 setColWidths 重渲染
      if (colResizeRafRef.current != null) return;
      colResizeRafRef.current = requestAnimationFrame(() => {
        colResizeRafRef.current = null;
        setColWidths(prev => ({ ...prev, [col]: newWidth }));
      });
    }
    function onMouseUp() {
      scrollPointerActive.current = false;
      if (colResizeRef.current) {
        // H6: 取消 pending raf，确保最终状态正确
        if (colResizeRafRef.current != null) {
          cancelAnimationFrame(colResizeRafRef.current);
          colResizeRafRef.current = null;
        }
        colResizeRef.current = null;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
        flushViewPreferences();
      }
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [setColWidths, flushViewPreferences]);

  const viewSource = smartSearching ? smartSearchIncremental : smartSearchResult ? smartSearchResult.matchedEntries : entries;
  const queryScopeKey = documentId + (smartSearching || smartSearchResult ? ':search:' + searchViewId : ':loaded');
  const viewEngine = useLogViewEngine({ entries: viewSource, filter: deferredFilter, timeRange, paused, scopeKey: queryScopeKey,
    rules: autoDiagnoseEnabled ? enabledRules : [] });
  const filtered = viewEngine.rows, counts = viewEngine.counts;
  const sourceTransitionBusy = loading || importState?.status === 'reading';
  const queryBlocked = sourceTransitionBusy || viewEngine.selectionPending || Boolean(viewEngine.error) || deferredFilter !== filter || filterTextInput !== (filter.text || '');
  const analysisBlocked = queryBlocked || !conversationReady;
  const snapshotTruncated = truncated || viewEngine.omittedRows > 0 || Boolean(smartSearching || smartSearchResult);
  const documentKey = useMemo(() => logDocumentKey({ documentId, entries, markers, aiTurns, aiRevision, filter, buffers: scopeBuffers, timeRange }),
    [documentId, entries, markers, aiTurns, aiRevision, filter, scopeBuffers, timeRange]);
  const hasUnsaved = Boolean(entries.length || markers.length || aiTurns.length) && documentKey !== savedDocumentKey;
  const reviewKey = useMemo(() => JSON.stringify([documentId, markers.map(marker => [marker.id, marker.note]), filter, scopeBuffers, aiTurns.length, timeRange]),
    [documentId, markers, filter, scopeBuffers, aiTurns.length, timeRange]);
  useLayoutEffect(() => {
    latestDocument.current = { name: restoredSessionName || tr('日志分析 {0}', { 0: new Date().toLocaleString(getLocale()) }), documentId, documentKey, hasUnsaved, aiRevision,
      entries, windowRows: viewEngine.windowRows, filtered, source, sourceLabel, deviceId: captureDeviceId, filter: { ...filter, text: filterTextInput || undefined },
      buffers: scopeBuffers, aiTurns: aiTurnsRef.current, evidence, markers, timeRange, truncated: snapshotTruncated, paused, selectedIssue, queryBlocked };
  });
  const close = useLogCloseProtection({ documentId, sourceIdentity, reviewKey, dirty: hasUnsaved, ready: initialLogStateLoaded, getSnapshot,
    getCaptureIdentity: () => captureSessionRef.current, onStop: stopCaptureAndImport, onStopAi: stopAllAnalysis,
    onSaved: sessionSaved, paused, onMessage: setNote });

  useLayoutEffect(() => {
    markerContextRef.current = { entries: viewEngine.windowRows, deviceId: captureDeviceId, count: markers.length };
  }, [viewEngine.windowRows, captureDeviceId, markers.length]);

  const addMarker = useCallback((entry) => {
    const context = markerContextRef.current;
    if (context.count >= MAX_LOG_MARKERS) {
      setNote(tr("问题标记已达 500 个上限，请保存会话后再整理标记；未丢弃任何标记"));
      return;
    }
    setMarkerDraft(captureLogMarker(entry, context.entries, context.deviceId, tr("问题标记"), crypto.randomUUID()));
  }, []);

  function locateMarker(marker) {
    const identity = logEntryIdentity(marker.entry);
    const index = filtered.findIndex(entry => entry.id === marker.entry.id && logEntryIdentity(entry, captureDeviceId) === identity);
    if (index < 0) return tr("原日志不在当前视图中，可能被过滤或已超过显示上限。下方仍保留标记时的上下文；可关闭窗口调整过滤条件后再定位。");
    const scroll = logScrollRef.current;
    if (!scroll) return tr("日志视图尚未就绪，请稍后再试。");
    autoScrollRef.current = false;
    if (logAutoScrollRafRef.current != null) cancelAnimationFrame(logAutoScrollRafRef.current);
    logAutoScrollRafRef.current = null;
    scroll.scrollTop = Math.max(0, index * LOG_ROW_HEIGHT - scroll.clientHeight / 3);
    syncLogViewport(scroll.scrollTop, scroll.clientHeight);
    setLocatedMarkerIdentity(identity);
    return true;
  }

  const syncLogViewport = useCallback((scrollTop, height) => {
    pendingLogViewportRef.current = { scrollTop, height };
    if (logViewportRafRef.current != null) return;
    logViewportRafRef.current = requestAnimationFrame(() => {
      logViewportRafRef.current = null;
      const next = pendingLogViewportRef.current;
      if (!next) return;
      setLogViewport((prev) => (
        prev.scrollTop === next.scrollTop && prev.height === next.height ? prev : next
      ));
    });
  }, []);

  const virtualLogRows = useMemo(() => {
    void locale;
    const total = filtered.length;
    if (total === 0) {
      return { entries: [], start: 0, topOffset: 0, totalHeight: 0 };
    }
    const viewportHeight = logViewport.height || 600;
    const rawStart = Math.floor(logViewport.scrollTop / LOG_ROW_HEIGHT) - LOG_ROW_OVERSCAN;
    const start = Math.min(Math.max(0, rawStart), Math.max(0, total - 1));
    const visibleCount = Math.ceil(viewportHeight / LOG_ROW_HEIGHT) + LOG_ROW_OVERSCAN * 2;
    const end = Math.min(total, start + visibleCount);
    return {
      entries: filtered.slice(start, end),
      start,
      topOffset: start * LOG_ROW_HEIGHT,
      totalHeight: total * LOG_ROW_HEIGHT
    };
  }, [filtered, logViewport, locale]);

  useEffect(() => {
    // L1: 仅在用户已处于底部时自动滚动，避免打断用户浏览；直接滚容器减少虚拟列表额外 DOM。
    if (paused || !autoScrollRef.current || !logScrollRef.current) return;
    if (logAutoScrollRafRef.current != null) {
      cancelAnimationFrame(logAutoScrollRafRef.current);
    }
    logAutoScrollRafRef.current = requestAnimationFrame(() => {
      logAutoScrollRafRef.current = null;
      const el = logScrollRef.current;
      if (!el) return;
      programmaticScroll.current = true; el.scrollTop = el.scrollHeight;
      syncLogViewport(el.scrollTop, el.clientHeight);
      requestAnimationFrame(() => { programmaticScroll.current = false; });
    });
  }, [filtered, paused, logViewport.height, syncLogViewport]);

  useEffect(() => {
    const el = logScrollRef.current;
    if (!el) return;
    const updateViewport = () => syncLogViewport(el.scrollTop, el.clientHeight);
    updateViewport();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateViewport);
      observer.observe(el);
      return () => observer.disconnect();
    }

    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, [syncLogViewport]);

  useEffect(() => {
    let disposed = false;
    mountedRef.current = true;
    const batchBuffer = createLogBatchBuffer(({ entries: batch, truncated: batchTruncated }) => {
      const previous = loadedWindowRef.current, rows = appendLogWindow(previous, batch);
      if (batchTruncated || rows.length < previous.length + batch.length) setTruncated(true);
      loadedWindowRef.current = rows; setEntries(rows);
    });
    logBatchBufferRef.current = batchBuffer;

    let hydratingPackets = { key: '', rows: [], truncated: false };
    async function refreshDevices() {
      try {
        const values = await window.electronAPI?.adbListDevices?.();
        if (!disposed && Array.isArray(values)) setDevices(values.map(device => ({ ...device, status: 'device', label: device.model ? device.model + ' · ' + device.id : device.id })));
      } catch (failure) { if (!disposed) { setNote(failure.message); setNoteType('error'); } }
    }
    function resetAnalysis() {
      aiStreamEpochRef.current++; const request = aiRequestRef.current;
      if (request.id) request.retired.add(request.id); request.active = false; request.id = '';
      if (aiAnalyzingRef.current) void window.electronAPI?.aiStopAnalyze?.().catch(() => {});
      if (smartSearchingRef.current) void window.electronAPI?.smartSearchStop?.().catch(() => {});
      aiAnalyzingRef.current = false; smartSearchingRef.current = false;
      setAiAnalyzing(false); setSmartSearching(false); searchSessionRef.current++;
      setSmartSearchResult(null); setSmartSearchIncremental([]); setSmartSearchMatchedIds(new Set());
      setSmartSearchProgress(null); setMapReduceProgress(null); setAnalysisScope(null);
      aiContentRef.current = ''; aiReasoningRef.current = ''; aiLastLogHashRef.current = ''; setAiTurns([]);
      setEvidence([]); setMarkers([]); setMarkerDraft(null); setAiError(''); setAiPanelOpen(false);
      aiHistoryReadOnlyRef.current = false; setAiHistoryReadOnly(false); setRestoredSessionName('');
      conversationEpoch.current++; conversationBound.current = false; setConversationReady(true);
    }
    function commitReset(payload) {
      if (disposed || !payload || !['file', 'realtime'].includes(payload.source)) return;
      if (payload.source === 'file' && payload.reason === 'import-completed') {
        if (ignoredImports.current.has(payload.requestId)) return;
        if (importFlightRef.current && !importRequestRef.current) { pendingImportReset.current = payload; return; }
        if (!importRequestRef.current || payload.requestId !== importRequestRef.current) return;
      }
      sourceEventRevision.current++; batchBuffer.reset(); hydratingPackets = { key: '', rows: [], truncated: false };
      if (payload.reason !== 'cleared') resetAnalysis();
      const bounded = boundLogWindow(payload.entries || []), rows = bounded.entries, identity = typeof payload.sourceIdentity === 'string' ? payload.sourceIdentity : '';
      captureSessionRef.current = { source: payload.source, deviceId: payload.deviceId || '', captureId: payload.captureId || '', sourceIdentity: identity, buffers: payload.buffers || [] };
      const requested = startingSettings.current?.deviceId === payload.deviceId ? startingSettings.current : null;
      if (payload.reason === 'capture-started') {
        filterTouched.current = false;
        if (requested) { explicitPreference.current = JSON.stringify([payload.deviceId || '', 'realtime']); applyRememberedFilter(requested.filter); }
        const actualBuffers = Array.isArray(payload.buffers) ? payload.buffers : requested?.buffers || [];
        setBuffers(actualBuffers); preparedBufferTarget.current = payload.deviceId || ''; setScopeBuffers(actualBuffers);
        setTargetField(payload.deviceId || '', 'realtime', 'buffers', actualBuffers);
        preparedContext.current = null; startingSettings.current = null;
      } else if (payload.source === 'file' && payload.reason === 'import-completed') {
        filterTouched.current = false; setScopeBuffers([]);
      }
      setSource(payload.source); setCaptureDeviceId(payload.deviceId || ''); setSourceIdentity(identity);
      if (payload.source === 'realtime' && payload.deviceId) setDeviceId(payload.deviceId);
      setSourceLabel(payload.sourceLabel || payload.fileName || (payload.source === 'file' ? tr('日志文件') : tr('设备 {0}', { 0: payload.deviceId || '' })));
      setEntries(rows); loadedWindowRef.current = rows; setTruncated(payload.truncated === true || bounded.omittedRows > 0);
      setDocumentId(crypto.randomUUID()); setSelectedIssue(null); setDetailEntry(null); setTimeRange({ kind: 'all' }); setPaused(false); autoScrollRef.current = true; scrollIntentUntil.current = 0; scrollPointerActive.current = false;
      hydratedRef.current = true; setInitialLogStateLoaded(true); setHydrateError(''); setNote(undefined);
      if (payload.source === 'file') {
        setRunning(false); runningRef.current = false; setImportState(payload.import || { requestId: payload.requestId, status: 'completed', keptCount: rows.length });
        importFlightRef.current = false; importRequestRef.current = ''; setLoading(false); setArchiveState(null);
      }
    }
    commitResetRef.current = commitReset;
    async function loadInitialState() {
      const revision = sourceEventRevision.current;
      void (async () => {
        try { const info = await window.electronAPI?.mcpGetInfo?.(); if (!disposed && info) { setMcpRunning(info.running); setMcpPort(info.port); } } catch { /* Optional MCP metadata. */ }
        try { const status = await window.electronAPI?.vipGetStatus?.(); if (!disposed && status) setVipStatusState(status); } catch { /* Optional membership metadata. */ }
      })();
      try {
        if (!window.electronAPI?.logGetState) {
          if (!window.electronAPI) { hydratedRef.current = true; setInitialLogStateLoaded(true); return; }
          throw new Error(tr('日志服务不可用，请重启桌面应用后重试。'));
        }
        const state = await window.electronAPI.logGetState();
        if (disposed || sourceEventRevision.current !== revision) return;
        if (!state || !['realtime', 'file'].includes(state.source)) throw new Error(tr('日志状态读取失败，请重试；当前内容保持不变。'));
        const identity = typeof state.sourceIdentity === 'string' ? state.sourceIdentity : '';
        captureSessionRef.current = { source: state.source, deviceId: state.deviceId || '', captureId: state.captureId || '', sourceIdentity: identity, buffers: state.buffers || [] };
        const actualBuffers = Array.isArray(state.buffers) ? state.buffers : state.source === 'file' ? [] : compatibleFor(state.deviceId || '', readTargetView(state.deviceId || '', state.source).buffers);
        setScopeBuffers(actualBuffers);
        if (state.source === 'realtime' && state.deviceId) { setBuffers(actualBuffers); preparedBufferTarget.current = state.deviceId; }
        setSource(state.source); setCaptureDeviceId(state.deviceId || ''); setSourceIdentity(identity);
        setRunning(state.running === true); runningRef.current = state.running === true;
        if (state.deviceId) setDeviceId(state.deviceId);
        const bounded = boundLogWindow(state.entries || []), rows = bounded.entries;
        setEntries(rows); loadedWindowRef.current = rows; setTruncated(state.truncated === true || bounded.omittedRows > 0);
        setSourceLabel(state.sourceLabel || (state.source === 'file' ? state.import?.fileName || tr('日志文件') : state.deviceId ? tr('设备 {0}', { 0: state.deviceId }) : ''));
        setArchiveState(state.archive || null); setImportState(state.import || null);
        if (state.import?.status === 'reading') { importRequestRef.current = state.import.requestId; importFlightRef.current = true; }
        const packetKey = JSON.stringify([state.source, state.captureId || '', state.deviceId || '', identity]);
        if (hydratingPackets.key === packetKey) {
          const ids = new Set(rows.map(row => row.id)); batchBuffer.push({ entries: hydratingPackets.rows.filter(row => !ids.has(row.id)), truncated: hydratingPackets.truncated });
        }
        hydratingPackets = { key: '', rows: [], truncated: false }; hydratedRef.current = true; setInitialLogStateLoaded(true); setHydrateError('');
      } catch (failure) { if (!disposed && sourceEventRevision.current === revision) { setHydrateError(failure.message); setInitialLogStateLoaded(false); } }
    }
    refreshLogStateRef.current = loadInitialState;
    function setupLogListeners() {
      const listeners = [];
      const listen = (method, callback) => { const off = window.electronAPI?.[method]?.(callback); if (off) listeners.push(off); };
      listen('onLogCaptureState', value => {
        const current = captureSessionRef.current;
        if (value.source !== 'realtime' || current.source !== 'realtime' || value.captureId !== current.captureId || value.deviceId !== current.deviceId
          || value.sourceIdentity && current.sourceIdentity && value.sourceIdentity !== current.sourceIdentity) return;
        runningRef.current = value.running === true; setRunning(value.running === true);
        if (value.omittedLines) { setTruncated(true); setNote(tr('已跳过 {0} 条超长日志，当前显示与归档可能不完整。', { 0: value.omittedLines })); }
        if (!value.running) { setNote(value.error || tr('日志采集已结束。')); setNoteType(value.error ? 'error' : 'info'); }
      });
      listen('onLogReset', commitReset);
      listen('onLogAppendBatch', payload => {
        if (!payload || payload.source !== 'realtime') return;
        if (!hydratedRef.current) {
          const key = JSON.stringify([payload.source, payload.captureId || '', payload.deviceId || '', payload.sourceIdentity || '']);
          const previous = hydratingPackets.key === key ? hydratingPackets.rows : [], incoming = payload.entries || [], rows = appendLogWindow(previous, incoming);
          hydratingPackets = { key, rows, truncated: payload.truncated === true || hydratingPackets.truncated || rows.length < previous.length + incoming.length };
          return;
        }
        const current = captureSessionRef.current;
        if (current.source !== payload.source || current.captureId !== payload.captureId || current.deviceId !== payload.deviceId
          || payload.sourceIdentity && current.sourceIdentity && payload.sourceIdentity !== current.sourceIdentity) return;
        batchBuffer.push(payload);
      });
      listen('onLogImportState', value => {
        if (ignoredImports.current.has(value.requestId)) return;
        if (value.requestId !== importRequestRef.current) { if (importFlightRef.current && !importRequestRef.current) pendingImportProgress.current = value; return; }
        setImportState(value);
        if (['cancelled', 'failed'].includes(value.status)) { importFlightRef.current = false; setLoading(false); if (value.error) { setNote(value.error); setNoteType('error'); } }
      });
      listen('onLogArchiveState', value => {
        if (captureSessionRef.current.source !== 'realtime' || value.captureId !== captureSessionRef.current.captureId) return;
        setArchiveState(value);
      });
      logListenersRef.current = listeners;
    }
    setupLogListeners();

    // AI 流式事件监听
    function setupAiListeners() {
      const listeners = [];
      const accept = (payload, bind = false) => {
        const operation = aiRequestRef.current, id = payload?.requestId;
        if (!id) return false;
        if (!operation.active || aiHistoryReadOnlyRef.current || operation.documentId !== latestDocument.current?.documentId
          || operation.sourceIdentity !== (captureSessionRef.current.sourceIdentity || '')) {
          operation.retired.add(id); while (operation.retired.size > 32) operation.retired.delete(operation.retired.values().next().value); return false;
        }
        if (operation.retired.has(id) || operation.id && operation.id !== id) return false;
        if (!operation.id) { if (!bind) return false; operation.id = id; }
        return true;
      };
      if (window.electronAPI && window.electronAPI.onAiStreamStart) {
        const offStart = window.electronAPI.onAiStreamStart((payload) => {
          if (!accept(payload, true)) return;
          setAiAnalyzing(true);
          setAiError('');
          // 重置思考内容（新一轮分析）
          aiReasoningRef.current = '';
        });
        listeners.push(offStart);
      }
      if (window.electronAPI && window.electronAPI.onAiStreamChunk) {
        // 高频节流 + requestAnimationFrame：60ms 间隔刷新，配合 rAF 保证浏览器渲染帧对齐
        let aiFlushTimer = null;
        let aiRafPending = false;
        const offChunk = window.electronAPI.onAiStreamChunk((payload) => {
          if (!accept(payload)) return;
          const streamEpoch = aiStreamEpochRef.current;
          // 收到首个 chunk 说明压缩/分块已完成，清除进度状态
          setMapReduceProgress(null);
          if (payload.type === 'reasoning') {
            aiReasoningRef.current += payload.text;
          } else {
            aiContentRef.current += payload.text;
          }
          if (!aiFlushTimer) {
            aiFlushTimer = setTimeout(() => {
              aiFlushTimer = null;
              if (!aiRafPending) {
                aiRafPending = true;
                requestAnimationFrame(() => {
                  aiRafPending = false;
                  if (streamEpoch !== aiStreamEpochRef.current) return;
                  // 更新当前轮的 reasoning/content
                  const turns = [...aiTurnsRef.current];
                  const last = turns[turns.length - 1];
                  if (last) {
                    last.reasoning = aiReasoningRef.current;
                    last.content = aiContentRef.current;
                  }
                  aiTurnsRef.current = turns;
                  setAiTurns(turns);
                });
              }
            }, 60);
          }
        });
        listeners.push(() => {
          if (aiFlushTimer) { clearTimeout(aiFlushTimer); aiFlushTimer = null; }
          offChunk();
        });
      }
      if (window.electronAPI && window.electronAPI.onAiStreamEnd) {
        const offEnd = window.electronAPI.onAiStreamEnd((payload) => {
          if (!accept(payload)) return;
          // 流结束时 flush 最终内容到当前轮
          const turns = [...aiTurnsRef.current];
          const last = turns[turns.length - 1];
          if (last) {
            last.reasoning = aiReasoningRef.current;
            last.content = aiContentRef.current;
            // 有思考内容则自动折叠
            if (aiReasoningRef.current) last.reasoningExpanded = false;
          }
          aiTurnsRef.current = turns;
          setAiTurns(turns);
          setAiAnalyzing(false);
          aiAnalyzingRef.current = false; aiRequestRef.current.active = false; aiRequestRef.current.retired.add(payload.requestId);
          setMapReduceProgress(null);
          refreshContextUsage();
        });
        listeners.push(offEnd);
      }
      if (window.electronAPI && window.electronAPI.onAiStreamError) {
        const offErr = window.electronAPI.onAiStreamError((payload) => {
          if (!accept(payload)) return;
          setAiError(payload.error || tr("分析失败"));
          setAiAnalyzing(false);
          aiAnalyzingRef.current = false; aiRequestRef.current.active = false; aiRequestRef.current.retired.add(payload.requestId);
          setMapReduceProgress(null);
        });
        listeners.push(offErr);
      }
      if (window.electronAPI && window.electronAPI.onAiMapReduceProgress) {
        const offMr = window.electronAPI.onAiMapReduceProgress((payload) => {
          if (!accept(payload, true)) return;
          setMapReduceProgress(payload);
        });
        listeners.push(offMr);
      }
      aiListenersRef.current = listeners;
    }
    setupAiListeners();

    async function refreshRules() {
      try {
        const result = await window.electronAPI?.autoDiagnoseRulesList?.();
        if (!disposed && result?.ok) { setEnabledRules(result.rules || []); setDiagnosticError(''); }
        else if (!disposed && result) setDiagnosticError(result.error || tr('无法读取诊断规则，请重试。'));
      } catch (failure) { if (!disposed) setDiagnosticError(failure.message); }
    }
    void refreshRules();
    void window.electronAPI?.autoDiagnoseStatus?.().then(value => { if (!disposed && value?.ok) setAutoDiagnoseEnabled(value.enabled === true); }).catch(() => {});
    const offIncomplete = window.electronAPI?.onAutoDiagnoseIncomplete?.(value => {
      if (!disposed) setDiagnosticError(value?.error || value?.message || tr('部分诊断规则未完成，未将未扫描的日志视为正常。'));
    });
    autoDiagnoseListenersRef.current = offIncomplete ? [offIncomplete] : [];

    // 智能日志搜索：监听搜索进度和结果
    function setupSmartSearchListeners() {
      const listeners = [];
      const accept = (payload, bind = false) => {
        const request = smartRequestRef.current, id = payload?.requestId;
        if (!id || !request.active || request.documentId !== latestDocument.current?.documentId || request.sourceIdentity !== (captureSessionRef.current.sourceIdentity || '')) return false;
        if (request.retired.has(id) || request.id && request.id !== id) return false;
        if (!request.id) { if (!bind) return false; request.id = id; }
        return true;
      };
      if (window.electronAPI) {
        if (window.electronAPI.onSmartSearchStart) {
          const off = window.electronAPI.onSmartSearchStart((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的事件，防止"停止→重新搜索"时旧事件污染新搜索
            if (!accept(payload, true)) return;
            setSmartSearching(true);
            setSmartSearchProgress({ completed: 0, total: payload.totalChunks, matchedCount: 0 });
            setSmartSearchResult(null);
            setSmartSearchMatchedIds(new Set());
            setSmartSearchIncremental([]); // 清空增量列表
          });
          listeners.push(off);
        }
        if (window.electronAPI.onSmartSearchProgress) {
          const off = window.electronAPI.onSmartSearchProgress((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的进度事件
            if (!accept(payload)) return;
            setSmartSearchProgress(payload);
          });
          listeners.push(off);
        }
        // 增量推送：每完成一个分块就追加匹配条目，用户能看到结果逐步出现
        if (window.electronAPI.onSmartSearchChunk) {
          const off = window.electronAPI.onSmartSearchChunk((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的分块结果，防止旧结果混入新搜索
            if (!accept(payload)) return;
            setSmartSearchIncremental(prev => appendLogWindow(prev, payload.entries));
          });
          listeners.push(off);
        }
        if (window.electronAPI.onSmartSearchComplete) {
          const off = window.electronAPI.onSmartSearchComplete((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的完成事件
            // 关键修复：旧搜索被停止后仍会发送 complete 事件，若不过滤会错误地
            // 将 smartSearching 置为 false，中断新搜索，并清空增量结果导致"匹配 0 条"
            if (!accept(payload)) return;
            smartRequestRef.current.active = false; smartRequestRef.current.retired.add(payload.requestId);
            smartSearchingRef.current = false;
            setSmartSearching(false);
            setSmartSearchProgress(null);
            setSmartSearchIncremental([]); // 清空增量列表，使用最终结果
            if (payload.ok && !payload.aborted) {
              const bounded = boundLogWindow(payload.matchedEntries || []);
              setSmartSearchResult({ ...payload, matchedEntries: bounded.entries, truncated: payload.truncated === true || bounded.omittedRows > 0 });
              const idSet = new Set(bounded.entries.map(e => e.id));
              setSmartSearchMatchedIds(idSet);
            }
          });
          listeners.push(off);
        }
      }
      smartSearchListenersRef.current = listeners;
    }
    setupSmartSearchListeners();

    refreshDevices();
    loadInitialState();

    return () => {
      disposed = true;
      mountedRef.current = false; aiStreamEpochRef.current++;
      if (refreshLogStateRef.current === loadInitialState) refreshLogStateRef.current = null;
      if (commitResetRef.current === commitReset) commitResetRef.current = null;
      batchBuffer.reset();
      if (logBatchBufferRef.current === batchBuffer) logBatchBufferRef.current = null;
      logListenersRef.current.forEach(off => off && off());
      aiListenersRef.current.forEach(off => off && off());
      autoDiagnoseListenersRef.current.forEach(off => off && off());
      smartSearchListenersRef.current.forEach(off => off && off());
      // H7: 清理可能残留的 onResizeStart 全局监听器（拖拽过程中卸载时）
      if (resizeListenersRef.current) {
        document.removeEventListener('mousemove', resizeListenersRef.current.onMouseMove);
        document.removeEventListener('mouseup', resizeListenersRef.current.onMouseUp);
        resizeListenersRef.current = null;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
      // M8: 清理 filter 防抖定时器
      if (filterDebounceRef.current) {
        clearTimeout(filterDebounceRef.current);
        filterDebounceRef.current = null;
      }
      // H6: 清理 pending raf
      if (colResizeRafRef.current != null) {
        cancelAnimationFrame(colResizeRafRef.current);
        colResizeRafRef.current = null;
      }
      // 虚拟日志列表：清理 pending viewport raf
      if (logViewportRafRef.current != null) {
        cancelAnimationFrame(logViewportRafRef.current);
        logViewportRafRef.current = null;
      }
      if (logAutoScrollRafRef.current != null) {
        cancelAnimationFrame(logAutoScrollRafRef.current);
        logAutoScrollRafRef.current = null;
      }
      // UX1: 清理 note 自动清除定时器
      if (noteTimerRef.current) {
        clearTimeout(noteTimerRef.current);
        noteTimerRef.current = null;
      }
    };
  }, [applyRememberedFilter, readTargetView, setAiTurns, setTargetField]);

  function getSnapshot(scope = 'loaded') {
    const value = latestDocument.current;
    if (!value) throw new Error(tr('日志视图尚未就绪，请稍后再试。'));
    let rows = scope === 'filtered' ? value.filtered : scope === 'issue' ? value.selectedIssue?.context || [] : value.windowRows;
    if (scope === 'loaded' && !value.paused && value.queryBlocked && !rows.length && value.entries.length) rows = value.entries;
    const ids = new Set(rows.map(row => logEntryIdentity(row, value.deviceId)));
    const selectedMarkers = scope === 'loaded' ? value.markers : value.markers.filter(marker => ids.has(logEntryIdentity(marker.entry, value.deviceId)));
    const snapshot = freezeLogSessionSnapshot({ ...value, aiTurns: aiTurnsRef.current, aiRevision: aiContentVersionRef.current.revision, entries: rows, markers: selectedMarkers },
      { rows, name: String(value.name || tr('日志快照')).slice(0, 80) });
    snapshot.uiRevision = logDocumentKey({ ...snapshot, documentId: value.documentId });
    snapshot.sourceIdentity = captureSessionRef.current.sourceIdentity || '';
    return snapshot;
  }
  function sessionSaved(snapshot) {
    if (snapshot.uiRevision && snapshot.uiRevision === latestDocument.current?.documentKey) setSavedDocumentKey(snapshot.uiRevision);
  }
  async function confirmReplacement(title) {
    const reviewed = latestDocument.current;
    if (!reviewed?.hasUnsaved) return true;
    const answer = await showAppMessage({ type: 'warning', title, message: tr('继续会替换当前显示的日志、标记和分析。是否先保存当前快照？'),
      detail: tr('只保存当前已加载的窗口；暂停查看时只保存冻结范围，之后新增的日志可能不包含在快照中。原始归档不会删除。'),
      buttons: [tr('取消'), tr('保存当前并继续'), tr('不保存并继续')], defaultId: 0, cancelId: 0 });
    if (answer.response === 0) return false;
    if (latestDocument.current?.documentId !== reviewed.documentId) { setNote(tr('日志来源已变化，操作已取消，请重新核对。')); return false; }
    if (answer.response === 1) {
      const snapshot = getSnapshot(), response = await window.electronAPI.logSessionSave(snapshot);
      if (!response?.ok) throw new Error(response?.error || tr('会话保存失败，当前内容未替换。'));
      sessionSaved(snapshot);
      if (latestDocument.current?.documentId !== reviewed.documentId) { setNote(tr('快照已保存，但日志来源已变化，未继续替换。')); return false; }
    }
    return true;
  }
  async function refreshDevices() {
    try { const values = await window.electronAPI?.adbListDevices?.(); if (mountedRef.current && Array.isArray(values)) setDevices(values.map(device => ({ ...device, status: 'device', label: device.model ? device.model + ' · ' + device.id : device.id }))); }
    catch (failure) { setNote(failure.message); setNoteType('error'); }
  }
  function changeText(value) {
    filterTouched.current = true; setFilterTextInput(value); clearTimeout(filterDebounceRef.current);
    filterDebounceRef.current = setTimeout(() => setFilter(previous => ({ ...previous, text: value || undefined })), 300);
  }
  function resetFilters() { clearTimeout(filterDebounceRef.current); setFilter(emptyFilter); setFilterTextInput(''); setTimeRange({ kind: 'all' }); }
  function toggleBuffer(id) {
    if (runningRef.current) return;
    const current = buffers.filter(value => LOG_BUFFERS.some(option => option.id === value));
    const next = isHarmonyTarget && id === 'kmsg' ? current.includes(id) ? [] : ['kmsg'] : current.includes(id) ? current.filter(value => value !== id) : [...current.filter(value => !isHarmonyTarget || value !== 'kmsg'), id];
    setBuffers(next); preparedBufferTarget.current = deviceId; setTargetField(deviceId, 'realtime', 'buffers', next);
  }
  const rowFilter = useCallback(action => {
    try { applyLogRowFilter({}, action); setFilter(previous => applyLogRowFilter(previous, action)); setDetailEntry(null); }
    catch { setNote(tr('该字段无法直接筛选，请在高级条件中核对。')); setNoteType('error'); }
  }, [setFilter]);
  const showDetail = useCallback(entry => {
    const value = latestDocument.current, rows = value?.windowRows || [], index = rows.findIndex(row => logEntryIdentity(row, value.deviceId) === logEntryIdentity(entry, value.deviceId));
    setDetailEntry({ entry: { ...entry }, context: index < 0 ? [entry] : rows.slice(Math.max(0, index - 5), index + 6), label: value?.sourceLabel || '', documentId: value?.documentId });
  }, []);
  function aroundEntry(entry) {
    const basis = logEntryTimestamp(entry).value !== null ? 'source' : Number.isFinite(entry.receivedAt) ? 'received' : 'source';
    setTimeRange({ kind: 'around', entryId: entry.id, windowMs: 30000, basis }); setDetailEntry(null);
  }
  function markIssue(group) {
    if (!group.representative || markers.length >= MAX_LOG_MARKERS) return;
    setMarkerDraft({ id: crypto.randomUUID(), note: '', createdAt: Date.now(), entry: { ...group.representative, deviceId: group.representative.deviceId || captureDeviceId },
      context: group.context.map(entry => ({ ...entry, deviceId: entry.deviceId || captureDeviceId })) });
  }
  function latest() {
    setPaused(false); autoScrollRef.current = true; scrollIntentUntil.current = 0; scrollPointerActive.current = false;
    requestAnimationFrame(() => {
      const element = logScrollRef.current; if (!element) return;
      programmaticScroll.current = true; element.scrollTop = element.scrollHeight; syncLogViewport(element.scrollTop, element.clientHeight);
      requestAnimationFrame(() => { programmaticScroll.current = false; });
    });
  }
  function togglePause() { if (paused) latest(); else { autoScrollRef.current = false; setPaused(true); } }
  async function onStart() {
    if (startFlightRef.current || replaceFlightRef.current || importFlightRef.current || aiAnalyzingRef.current || smartSearchingRef.current) return;
    const target = deviceId || (devices.length === 1 ? devices[0].id : '');
    if (!target || !devices.some(device => device.id === target)) { setNote(tr('请明确选择一台在线设备；所选设备离线时不会自动切换到其他设备')); return; }
    replaceFlightRef.current = true;
    try {
      if (!await confirmReplacement(tr('开始新的日志抓取'))) return;
      startFlightRef.current = true; const operation = ++sourceActionEpoch.current;
      setLoading(true); setNote(tr('启动中…'));
      const saved = readTargetView(target, 'realtime'), prepared = preparedContext.current?.deviceId === target ? preparedContext.current : null;
      const sameScope = source === 'realtime' && (!captureDeviceId || captureDeviceId === target);
      const nextFilter = prepared?.filter || (sameScope ? normalizeLogFilter(filter) : saved.hasSavedView ? saved.filter : {});
      const types = compatibleFor(target, prepared?.buffers || (preparedBufferTarget.current === target ? buffers : saved.hasSavedView ? saved.buffers : target.startsWith('hdc:') ? [] : ['main']));
      startingSettings.current = { deviceId: target, filter: nextFilter, buffers: types };
      setTargetField(target, 'realtime', 'buffers', types);
      const request = { deviceId: target, archive: { ...viewPreferences.archive }, ...(target.startsWith('hdc:') ? { types } : { buffers: types }) };
      const response = await window.electronAPI.adbStartLog(request);
      if (!mountedRef.current || operation !== sourceActionEpoch.current) return;
      if (!response?.ok) throw new Error(response?.error || tr('日志启动失败，请检查所选设备连接和调试授权。'));
      const actual = await window.electronAPI.logGetState();
      if (!mountedRef.current || operation !== sourceActionEpoch.current) return;
      if (!actual.running || actual.captureId !== response.captureId || actual.deviceId !== target) throw new Error(actual.captureError || tr('日志采集未能持续运行，请检查所选设备。'));
      captureSessionRef.current = { captureId: response.captureId, deviceId: target, source: 'realtime', sourceIdentity: actual.sourceIdentity || '' };
      setSourceIdentity(actual.sourceIdentity || ''); setRunning(true); runningRef.current = true; setArchiveState(actual.archive || response.archive || null); setNote(undefined);
    } catch (failure) { if (mountedRef.current) { setNote(failure.message); setNoteType('error'); } }
    finally { startFlightRef.current = false; replaceFlightRef.current = false; if (mountedRef.current) setLoading(false); }
  }
  async function stopCapture(expected) {
    if (stopPromiseRef.current) return stopPromiseRef.current;
    if (!runningRef.current && !startFlightRef.current) return;
    const identity = expected && typeof expected === 'object' && typeof expected.sourceIdentity === 'string' ? expected : captureSessionRef.current;
    const args = Object.fromEntries(['captureId', 'deviceId', 'sourceIdentity'].filter(key => typeof identity[key] === 'string' && identity[key]).map(key => [key, identity[key]]));
    sourceActionEpoch.current++;
    const pending = (async () => {
      const response = await window.electronAPI.adbStopLog(args);
      if (response?.ok === false) throw new Error(response.error || tr('停止日志抓取失败，请重试。'));
      logBatchBufferRef.current?.flush(); runningRef.current = false; setRunning(false); setNote(tr('已停止抓取'));
    })();
    stopPromiseRef.current = pending;
    try { await pending; } finally { if (stopPromiseRef.current === pending) stopPromiseRef.current = null; }
  }
  async function onStop() { try { await stopCapture(); } catch (failure) { setNote(failure.message); setNoteType('error'); } }
  async function cancelImport() {
    const requestId = importRequestRef.current; importEpochRef.current++;
    if (!requestId) { importFlightRef.current = false; setLoading(false); return; }
    const response = await window.electronAPI.logCancelImport({ requestId });
    if (response?.ok === false) throw new Error(response.error || tr('取消日志导入失败，请重试。'));
    if (response.cancelled) {
      ignoredImports.current.add(requestId); while (ignoredImports.current.size > 20) ignoredImports.current.delete(ignoredImports.current.values().next().value);
      importRequestRef.current = ''; importFlightRef.current = false; pendingImportReset.current = null; pendingImportProgress.current = null;
      setImportState(previous => ({ ...previous, status: 'cancelled' })); setLoading(false); setNote(tr('已取消导入，原来的日志视图保持不变。'));
    }
  }
  async function stopCaptureAndImport(expected) { await cancelImport(); await stopCapture(expected); }
  async function stopAllAnalysis() { await onAiStop(); if (smartSearchingRef.current) await onSmartSearchStop(); }
  async function onOpenFile() {
    if (runningRef.current || aiAnalyzingRef.current || smartSearchingRef.current || replaceFlightRef.current || importFlightRef.current) return;
    replaceFlightRef.current = true;
    try {
      if (!await confirmReplacement(tr('打开新的日志文件'))) return;
      const ticket = ++importEpochRef.current; importFlightRef.current = true; importRequestRef.current = ''; pendingImportReset.current = null; pendingImportProgress.current = null;
      setLoading(true); setImportState(null); setNote(tr('正在准备读取日志文件…'));
      const response = await window.electronAPI.logOpenFile();
      if (!mountedRef.current || ticket !== importEpochRef.current) return;
      if (!response?.ok) { importFlightRef.current = false; if (!response?.cancelled) throw new Error(response?.error || tr('打开日志文件失败，原来的视图保持不变。')); setNote(undefined); return; }
      importRequestRef.current = response.requestId;
      const progress = pendingImportProgress.current;
      setImportState(progress?.requestId === response.requestId ? progress : { requestId: response.requestId, status: 'reading', readBytes: 0, totalBytes: 0, keptCount: 0 });
      const reset = pendingImportReset.current; pendingImportReset.current = null;
      if (reset?.requestId === response.requestId) commitResetRef.current?.(reset);
    } catch (failure) { importFlightRef.current = false; if (mountedRef.current) { setNote(failure.message); setNoteType('error'); } }
    finally { replaceFlightRef.current = false; if (mountedRef.current) setLoading(false); }
  }
  async function onClear() {
    if (replaceFlightRef.current || aiAnalyzingRef.current || smartSearchingRef.current || importFlightRef.current) return;
    replaceFlightRef.current = true;
    try {
      if (!await confirmReplacement(tr('清空本机显示'))) return;
      const revision = sourceEventRevision.current, identity = { ...captureSessionRef.current };
      const result = await window.electronAPI.logClear({ source: identity.source, deviceId: identity.deviceId || undefined });
      if (result?.ok === false) throw new Error(result.error || tr('清空本机显示失败，原文已保留。'));
      if (revision === sourceEventRevision.current) commitResetRef.current?.({ source: identity.source, captureId: identity.captureId, deviceId: identity.deviceId, sourceIdentity: result.sourceIdentity || identity.sourceIdentity, reason: 'cleared', entries: [] });
      setNote(tr('仅清空本机显示，未清理设备历史；标记和冻结的分析证据仍保留。'));
    } catch (failure) { setNote(failure.message); setNoteType('error'); }
    finally { replaceFlightRef.current = false; }
  }
  async function clearDeviceBuffers() {
    const target = captureDeviceId || deviceId;
    if (!target || !await confirmAppMessage({ type: 'warning', title: tr('清理设备日志缓存'), message: tr('此操作会清理设备 {0} 的系统日志缓存，可能影响其他调试工具。', { 0: target }), detail: tr('本机当前视图、标记和已保存会话不会删除。'), confirmLabel: tr('确认清理设备缓存') })) return;
    try { const response = await window.electronAPI.logClearDevice({ deviceId: target, confirmed: true }); if (!response?.ok) throw new Error(response?.error || tr('设备日志清理失败，本机证据已保留。')); setNote(tr('设备日志缓存已清理，本机当前视图保持不变。')); }
    catch (failure) { setNote(failure.message); setNoteType('error'); }
  }
  function onExport() { if (!queryBlocked && filtered.length) setExportOpen(true); }
  async function onCopyAll() {
    if (copying || queryBlocked) return;
    const rows = filtered, document = latestDocument.current?.documentId; setCopying(true);
    try { const text = await buildLogClipboardText(rows); await navigator.clipboard.writeText(text); if (latestDocument.current?.documentId === document) setNote(tr('已复制 {0} 条原始日志到剪贴板', { 0: rows.length.toLocaleString(getLocale()) })); }
    catch (failure) { if (latestDocument.current?.documentId === document) { setNote(failure.message); setNoteType('error'); } }
    finally { if (mountedRef.current) setCopying(false); }
  }

  async function onToggleMcp() {
    if (!isVip) {
      setNote(tr("MCP 服务为会员专属功能，请在会员中心开通"));
      return;
    }
    if (window.electronAPI && window.electronAPI.mcpStop && window.electronAPI.mcpStart) {
      if (mcpRunning) {
        await window.electronAPI.mcpStop();
        setMcpRunning(false);
      } else {
        const res = await window.electronAPI.mcpStart();
        setMcpRunning(res.running);
      }
    }
  }

  async function resetBackendConversation() {
    const ticket = ++conversationEpoch.current; setConversationReady(false);
    try {
      const response = await window.electronAPI?.aiClearConversation?.();
      if (!response?.ok) throw new Error(response?.error || tr('分析上下文未能重置，请重试；未开始新的 AI 请求。'));
      if (mountedRef.current && ticket === conversationEpoch.current) { setConversationReady(true); return true; }
    } catch (failure) { if (mountedRef.current && ticket === conversationEpoch.current) { setAiError(failure.message); setAiPanelOpen(true); } }
    return false;
  }
  // One explicit local selection, the existing built-in IPC and its unchanged final outbound consent.
  async function onAiAnalyze(promptOverride, selectedRows, expectedDocumentId) {
    if (!isVip) { showVipBlock(tr('AI 深度分析')); return; }
    if (aiAnalyzingRef.current || aiPreparing.current || latestDocument.current?.queryBlocked || !conversationReady) return;
    if (expectedDocumentId && expectedDocumentId !== latestDocument.current?.documentId) { setNote(tr('日志来源已变化，操作已取消，请重新核对。')); return; }
    if (aiHistoryReadOnly) { setAiPanelOpen(true); setNote(tr('恢复的 AI 对话为只读；请先选择“开始新的分析”')); return; }
    const rows = Array.isArray(selectedRows) ? selectedRows : filtered;
    if (!rows.length) { setNoteType('error'); setNote(tr('当前范围没有可分析的日志，请调整筛选条件。')); return; }
    let prepared;
    try {
      prepared = prepareInlineLogAnalysis(rows, { deviceId: captureDeviceId, previousEvidence: evidence, sourceTruncated: snapshotTruncated,
        scopeLabel: sourceLabel || tr('当前显示范围') });
      if (!prepared.selectedEntries.length) throw new Error(tr('所选记录均超过单次分析范围，请查看原文或改用导出。'));
      setAnalysisScope(prepared.scope); setAiPanelOpen(true);
    } catch (failure) { setNoteType('error'); setNote(failure.message); return; }
    const reviewedDocument = latestDocument.current.documentId;
    if (!conversationBound.current) {
      aiPreparing.current = true;
      try { if (!await resetBackendConversation() || latestDocument.current?.documentId !== reviewedDocument) return; conversationBound.current = true; }
      finally { aiPreparing.current = false; }
    }
    setEvidence(prepared.evidence);
    const customPrompt = typeof promptOverride === 'string' ? promptOverride : aiCustomPrompt.trim();
    const evidenceRefs = [...new Set([...aiTurnsRef.current.flatMap(turn => turn.evidenceRefs || []), ...prepared.evidenceRefs])];
    const currentTurn = { header: '[' + new Date().toLocaleTimeString(getLocale()) + '] ' + (customPrompt ? tr('追问') + '：' + customPrompt : tr('分析')),
      reasoning: '', content: '', reasoningExpanded: true, evidenceRefs };
    aiContentRef.current = ''; aiReasoningRef.current = ''; setAiTurns([...aiTurnsRef.current, currentTurn]);
    const operation = aiRequestRef.current;
    operation.active = true; operation.id = ''; operation.documentId = latestDocument.current.documentId; operation.sourceIdentity = captureSessionRef.current.sourceIdentity || '';
    aiAnalyzingRef.current = true; setAiAnalyzing(true); setAiError(''); setMapReduceProgress(null);
    const fingerprint = fingerprintLogLines(prepared.lines), epoch = aiStreamEpochRef.current;
    try {
      const response = await window.electronAPI.aiAnalyzeLog({ lines: [...prepared.lines], filterContext: { ...deferredFilter },
        customPrompt: customPrompt || undefined, logChanged: aiLastLogHashRef.current !== fingerprint, thinkingMode: aiThinkingMode });
      if (!mountedRef.current || epoch !== aiStreamEpochRef.current || operation.documentId !== latestDocument.current?.documentId) return;
      if (!response?.ok) throw new Error(response?.error || tr('启动分析失败'));
      aiLastLogHashRef.current = fingerprint;
      setAiCustomPrompt(previous => previous.trim() === customPrompt ? '' : previous);
    } catch (failure) {
      if (mountedRef.current && epoch === aiStreamEpochRef.current) { setAiError(failure.message); operation.active = false; aiAnalyzingRef.current = false; setAiAnalyzing(false); }
    }
  }
  async function onAiStop() {
    const operation = aiRequestRef.current, active = operation.active || aiAnalyzingRef.current;
    if (operation.id) operation.retired.add(operation.id); operation.active = false;
    while (operation.retired.size > 32) operation.retired.delete(operation.retired.values().next().value);
    aiStreamEpochRef.current++; aiAnalyzingRef.current = false; setAiAnalyzing(false); setMapReduceProgress(null);
    if (active) {
      const turns = [...aiTurnsRef.current], last = turns.at(-1);
      if (last) { last.content = aiContentRef.current; last.reasoning = aiReasoningRef.current; setAiTurns(turns); }
      const response = await window.electronAPI?.aiStopAnalyze?.();
      if (response?.ok === false) throw new Error(response.error || tr('停止分析失败，请重试。'));
    }
  }
  async function onAiClear() {
    if (!aiHistoryReadOnly && aiTurnsRef.current.length && !await confirmAppMessage({ type: 'warning', title: tr('清空分析对话'),
      message: tr('清空当前未保存的分析对话？原始日志、标记和已保存会话不受影响。'), confirmLabel: tr('清空对话') })) return;
    try {
      await onAiStop();
      if (!await resetBackendConversation()) return;
      conversationBound.current = true;
      aiHistoryReadOnlyRef.current = false; setAiHistoryReadOnly(false); setEvidence([]); setAnalysisScope(null);
      aiContentRef.current = ''; aiReasoningRef.current = ''; aiLastLogHashRef.current = ''; setAiTurns([]); setAiError('');
      refreshContextUsage();
    } catch (failure) { setAiError(failure.message); }
  }

  async function refreshContextUsage() {
    if (window.electronAPI && window.electronAPI.aiGetContextUsage) {
      try {
        const res = await window.electronAPI.aiGetContextUsage();
        if (res?.ok && mountedRef.current) setContextUsage(res);
      } catch { /* Context counters are optional; do not interrupt analysis. */ }
    }
  }

  async function onAiExport() {
    if (aiTurns.length === 0) return;
    if (window.electronAPI && window.electronAPI.aiExportResult) {
      const now = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const dateStr = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      // 拼接所有轮次的内容
      const fullContent = aiTurns.map(t => `## ${t.header}\n\n${t.content || ''}`).join('\n\n---\n\n');
      const res = await window.electronAPI.aiExportResult({
        content: tr("# AI 日志助手分析报告\n\n生成时间：{0}\n\n---\n\n{1}", { 0: now.toLocaleString(getLocale()), 1: fullContent }),
        defaultName: `ai_analysis_${dateStr}.md`
      });
      if (res.ok) {
        setNote(tr("AI 分析结果已导出"));
      }
    }
  }

  async function refreshRules() {
    try {
      const result = await window.electronAPI?.autoDiagnoseRulesList?.();
      if (!result?.ok) throw new Error(result?.error || tr('无法读取诊断规则，请重试。'));
      if (mountedRef.current) { setEnabledRules(result.rules || []); setDiagnosticError(''); }
    } catch (failure) { if (mountedRef.current) setDiagnosticError(failure.message); }
  }
  async function onToggleAutoDiagnose() {
    const next = !autoDiagnoseEnabled;
    try {
      const result = await window.electronAPI?.autoDiagnoseToggle?.(next);
      if (result?.ok === false) throw new Error(result.error || tr('诊断设置未能保存，请重试。'));
      setAutoDiagnoseEnabled(next); if (next) await refreshRules();
    } catch (failure) { setDiagnosticError(failure.message); }
  }

  // Semantic search remains explicit and uses the existing built-in consent-protected service.
  async function onSmartSearch() {
    if (!isVip) { showVipBlock(tr('AI 智能搜索')); return; }
    if (!smartSearchQuery.trim() || smartSearchingRef.current || queryBlocked || !filtered.length) return;
    const token = ++searchSessionRef.current; setSearchViewId(token);
    const request = smartRequestRef.current;
    request.active = true; request.id = ''; request.documentId = latestDocument.current.documentId; request.sourceIdentity = captureSessionRef.current.sourceIdentity || '';
    const selectedIds = filtered.map(entry => entry.id);
    smartSearchingRef.current = true; setSmartSearching(true); setPaused(false);
    setSmartSearchProgress({ completed: 0, total: 0, matchedCount: 0 }); setSmartSearchResult(null); setSmartSearchMatchedIds(new Set()); setSmartSearchIncremental([]);
    try {
      const response = await window.electronAPI.smartSearch({ query: smartSearchQuery.trim(), source, entryIds: selectedIds });
      if (!mountedRef.current || token !== searchSessionRef.current || request.documentId !== latestDocument.current?.documentId) return;
      if (!response?.ok) throw new Error(response?.error || tr('智能搜索未完成。'));
    } catch (failure) {
      if (mountedRef.current && token === searchSessionRef.current) {
        request.active = false; smartSearchingRef.current = false; setSmartSearching(false); setSmartSearchProgress(null);
        setSmartSearchResult({ matchedEntries: [], matchedCount: 0, query: smartSearchQuery, failed: true });
        setNote(tr('智能搜索失败：{0}', { 0: failure.message })); setNoteType('error');
      }
    }
  }
  async function onSmartSearchStop() {
    const request = smartRequestRef.current;
    if (!request.active && !smartSearchingRef.current) return;
    if (request.id) request.retired.add(request.id);
    while (request.retired.size > 32) request.retired.delete(request.retired.values().next().value);
    request.active = false; searchSessionRef.current++; smartSearchingRef.current = false;
    const visible = latestDocument.current?.windowRows || [];
    setSmartSearching(false); setSmartSearchProgress(null);
    setSmartSearchResult({ matchedEntries: visible, matchedCount: visible.length, query: smartSearchQuery, aborted: true });
    const response = await window.electronAPI?.smartSearchStop?.();
    if (response?.ok === false) throw new Error(response.error || tr('停止智能搜索失败，请重试。'));
  }
  async function onSmartSearchClear() {
    try { await onSmartSearchStop(); setSmartSearchResult(null); setSmartSearchIncremental([]); setSmartSearchMatchedIds(new Set()); latest(); }
    catch (failure) { setNote(failure.message); setNoteType('error'); }
  }

  // 拖拽调整面板高度
  function onResizeStart(e) {
    e.preventDefault();
    aiResizingRef.current = true;
    const startY = e.clientY;
    const startHeight = aiFullscreen ? window.innerHeight : aiPanelHeight;

    function onMouseMove(ev) {
      if (!aiResizingRef.current) return;
      // 向上拖增大高度
      const delta = startY - ev.clientY;
    const newHeight = Math.round(Math.max(240, Math.min(800, window.innerHeight - 180, startHeight + delta)));
      setAiPanelHeight(newHeight);
    }

    function onMouseUp() {
      aiResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      // H7: 清空 ref，标记监听器已移除
      resizeListenersRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      flushViewPreferences();
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    // H7: 存储监听器引用，组件卸载时可清理残留监听器
    resizeListenersRef.current = { onMouseMove, onMouseUp };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  }

  function onToggleFullscreen() {
    setAiFullscreen(!aiFullscreen);
  }

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-[#202124]' : 'bg-slate-50'}`}>
      <LogWorkbenchToolbar theme={logTheme} isDark={isDark} devices={devices} deviceId={deviceId} source={source}
        filterDevice={devices.find(device => device.id === (captureDeviceId || deviceId)) || (captureDeviceId || deviceId ? { id: captureDeviceId || deviceId, status: 'offline' } : null)}
        onDeviceChange={configureDevice}
        onRefresh={refreshDevices} running={running} busy={loading || importState?.status === 'reading' || Boolean(close.request)} analyzing={aiAnalyzing}
        buffers={LOG_BUFFERS} selectedBuffers={selectedBuffers} onToggleBuffer={toggleBuffer}
        filter={filter} onApplication={value => setFilter(previous => ({ ...previous, pkg: value || undefined }))}
        onStart={onStart} onStop={onStop} onOpenFile={onOpenFile}
        archive={viewPreferences.archive} archiveState={archiveState} onArchiveChange={viewPreferences.setArchive}
        onArchiveFolder={() => window.electronAPI?.logOpenArchiveDirectory?.().then(result => { if (!result?.ok) { setNote(result?.error || tr('无法打开归档目录。')); setNoteType('error'); } }).catch(failure => { setNote(failure.message); setNoteType('error'); })}
        entriesCount={viewEngine.windowRows.length} shownCount={filtered.length} truncated={snapshotTruncated} onExport={onExport}
        moreActions={[
          { id: 'copy', label: copying ? tr('正在准备复制…') : tr('复制当前筛选'), disabled: copying || !filtered.length || queryBlocked, onSelect: onCopyAll },
          { id: 'clear-local', label: tr('清空本机显示'), disabled: !entries.length || aiAnalyzing || smartSearching, onSelect: onClear },
          { id: 'clear-device', label: tr('清理设备日志缓存'), danger: true, disabled: !captureDeviceId && !deviceId, onSelect: clearDeviceBuffers }
        ]}
        sessionControls={<LogSessionManager isDark={isDark} disabled={!initialLogStateLoaded || sourceTransitionBusy || Boolean(close.request) || viewEngine.selectionPending} canRestore={!running && !aiAnalyzing && !smartSearching && importState?.status !== 'reading' && !loading && !close.request}
          getSnapshot={getSnapshot} sourceIdentity={sourceIdentity} onRestore={restoreSession} onSaved={sessionSaved} onMessage={setNote} hasUnsaved={hasUnsaved}
          defaultName={restoredSessionName || tr('日志分析 {0}', { 0: new Date().toLocaleString(getLocale()) })}
          entryCount={viewEngine.windowRows.length} markerCount={markers.length} truncated={snapshotTruncated} />}
        markerControls={<LogMarkers disabled={sourceTransitionBusy || Boolean(close.request)} markers={markers} onChange={setMarkers} draft={markerDraft} onDismissDraft={() => setMarkerDraft(null)} isDark={isDark} onLocate={locateMarker} />}
        text={filterTextInput} onText={changeText} smartQuery={smartSearchQuery} onSmartQuery={setSmartSearchQuery}
        onSmartSearch={onSmartSearch} onSmartStop={() => onSmartSearchStop().catch(failure => { setNote(failure.message); setNoteType('error'); })}
        smartSearching={smartSearching} smartResult={smartSearchResult} onSmartClear={onSmartSearchClear} isVip={isVip}
        onAnalyze={() => onAiAnalyze()} onStopAnalyze={() => onAiStop().catch(failure => setAiError(failure.message))}
        analysisPending={analysisBlocked} historyReadOnly={aiHistoryReadOnly} hasAnalysis={aiTurns.length > 0 || Boolean(aiError) || Boolean(analysisScope)}
        panelOpen={aiPanelOpen} onPanelToggle={() => setAiPanelOpen(previous => !previous)}
        filterOpen={viewPreferences.view.sidebarOpen} onFilterToggle={() => viewPreferences.setField('sidebarOpen', value => !value)}
        filterCount={Object.values(filter).filter(value => value !== undefined && value !== '').length}
        issuesCount={viewEngine.issues.length} onIssuesToggle={() => setIssueOpen(value => !value)}
        paused={paused} pendingCount={viewEngine.pendingCount} onPause={togglePause}
        onLatest={latest} queryPending={queryBlocked}
        advancedControls={<>
          <button type="button" onClick={onToggleAutoDiagnose} className="rounded-lg border border-current/20 px-3 py-2">{tr('自动诊断: ')}{autoDiagnoseEnabled ? 'ON' : 'OFF'}</button>
          <button type="button" onClick={() => setRuleLibraryOpen(true)} className="rounded-lg border border-current/20 px-3 py-2">{tr('规则库')}</button>
          {isVip && <><button type="button" onClick={onToggleMcp} className="rounded-lg border border-current/20 px-3 py-2">{tr('MCP:')}{mcpRunning ? 'ON' : 'OFF'}</button><button type="button" onClick={() => setMcpHelpVisible(true)} className="rounded-lg border border-current/20 px-3 py-2">{tr('查看 MCP 使用说明')}</button></>}
          <LogFilterHandoff rows={filtered} deviceId={captureDeviceId} sourceTruncated={snapshotTruncated} isDark={isDark} label={tr('在完整 AI 工作区继续')} />
        </>} />
      <div className={`flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2 text-xs ${isDark ? 'border-slate-600 text-slate-300' : 'border-slate-200 text-slate-600'}`}>
        <span className="min-w-0 flex-1 break-all">{tr('当前显示来源：{0}', { 0: [sourceLabel || tr('尚未加载日志'), captureDeviceId].filter(Boolean).join(' · ') })}</span>
        {captureDeviceId && deviceId && captureDeviceId !== deviceId && <span className="text-amber-500">{tr('采集设备已更改，当前显示仍属于原来源；开始新抓取前会提示保存。')}</span>}
        <SelectMenu ariaLabel={tr('时间范围')} compact value={timeRange.kind === 'recent' ? String(timeRange.durationMs) : timeRange.kind} onChange={value => { if (value !== 'around') setTimeRange(value === 'all' ? { kind: 'all' } : { kind: 'recent', durationMs: Number(value), basis: timeRange.basis || 'source' }); }} isDark={isDark} className="w-36"
          options={[{ value: 'all', label: tr('全部时间') }, { value: '30000', label: tr('最近30秒') }, { value: '300000', label: tr('最近5分钟') }, ...(timeRange.kind === 'around' ? [{ value: 'around', label: tr('所选日志前后30秒') }] : [])]} />
        {timeRange.kind !== 'all' && <SelectMenu ariaLabel={tr('时间基准')} compact value={timeRange.basis || 'source'} onChange={basis => setTimeRange(previous => ({ ...previous, basis }))} isDark={isDark} className="w-40"
          options={[{ value: 'source', label: tr('日志源时间') }, { value: 'received', label: tr('本机接收时间') }]} />}
        {Object.entries(filter).filter(([, value]) => value !== undefined && value !== '').map(([field, value]) => <button key={field} type="button" title={String(value)} onClick={() => { setFilter(previous => { const next = { ...previous }; delete next[field]; return next; }); if (field === 'text') { clearTimeout(filterDebounceRef.current); setFilterTextInput(''); } }}
          className="max-w-56 truncate rounded-full border border-emerald-500/25 bg-emerald-500/5 px-2.5 py-1 text-emerald-600">{field}: {String(value)} ×</button>)}
        {(Object.values(filter).some(value => value !== undefined && value !== '') || timeRange.kind !== 'all') && <button type="button" onClick={resetFilters} className="rounded px-2 py-1 underline">{tr('重置')}</button>}
      </div>
      {hydrateError && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-red-500/25 p-3 text-xs text-red-500"><span className="min-w-0 flex-1">{tr(hydrateError)}</span><button type="button" onClick={() => refreshLogStateRef.current?.()} className="underline">{tr('重试读取日志状态')}</button></div>}
      {viewPreferences.error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 p-2 text-xs text-amber-500"><span>{tr(viewPreferences.error)}</span><button type="button" onClick={viewPreferences.retry} className="underline">{tr('重试保存偏好')}</button></div>}
      {(importState?.status === 'reading' || importState?.status === 'failed' || importState?.status === 'cancelled' || importState?.omittedLines > 0) && <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-400/20 px-4 py-2 text-xs">
        <span className="min-w-0 flex-1 break-words">{importState.status === 'reading' ? tr('正在导入 {0} · 已读取 {1}/{2} MiB · 已加载 {3} 条；原视图暂时保留。', { 0: importState.fileName || '', 1: ((importState.readBytes || 0) / 1048576).toFixed(1), 2: ((importState.totalBytes || 0) / 1048576).toFixed(1), 3: importState.keptCount || 0 }) : importState.status === 'cancelled' ? tr('已取消导入，原来的日志视图保持不变。') : importState.status === 'failed' ? importState.error || tr('导入失败，原来的日志视图保持不变。') : tr('已跳过 {0} 条超长日志，当前文件视图不完整。', { 0: importState.omittedLines })}</span>
        {importState.status === 'reading' && <button type="button" onClick={() => cancelImport().catch(failure => { setNote(failure.message); setNoteType('error'); })} className="rounded border border-current/25 px-3 py-1">{tr('取消导入')}</button>}
      </div>}
      {viewEngine.selectionPending && <p role="status" className="shrink-0 px-4 py-1 text-xs text-emerald-500">{tr('正在更新筛选范围，旧视图暂时保留。')}</p>}
      {viewEngine.error && <div role="alert" className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-2 text-xs text-amber-500"><span className="min-w-0 flex-1">{viewEngine.error}</span><button type="button" onClick={viewEngine.retry} className="underline">{tr('重试')}</button></div>}
      {viewEngine.timeWarnings.map(code => <p key={code} role="status" className="shrink-0 px-4 py-1 text-xs text-amber-500">{logTimeWarningText(code)}</p>)}
      {diagnosticError && <p role="status" className="shrink-0 px-4 py-1 text-xs text-amber-500">{tr(diagnosticError)}</p>}
      {note && <p role="status" className={`shrink-0 break-words px-4 py-2 text-xs ${noteType === 'error' ? 'text-red-500' : logTheme.textMuted}`}>{note}</p>}

      {/* Main Content */}
      {worksetMemory.error && <div role="alert" className={`flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs ${isDark ? 'border-red-500/25 bg-red-500/10 text-red-300' : 'border-red-200 bg-red-50 text-red-700'}`}><span className="min-w-0 flex-1 break-words">{tr(worksetMemory.error)}</span><button type="button" disabled={worksetMemory.saving} onClick={worksetMemory.retry} className="inline-flex items-center gap-2 rounded border border-current px-2 py-1 disabled:opacity-40">{worksetMemory.saving && <Loader2 size={12} className="animate-spin" />}{tr('重试保存日志配置')}</button></div>}
      {pendingLogContext && <div className={`flex flex-wrap items-center gap-3 border-b px-4 py-2 text-xs ${isDark ? 'border-[#3E4145] bg-amber-500/10 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-800'}`}><span className="flex-1">{tr('工作集配置等待应用；不会切换正在采集的设备。')}</span><button type="button" disabled={running || aiAnalyzing} onClick={() => applyContext(pendingLogContext)} className="rounded border border-current px-2 py-1 disabled:opacity-40">{tr('应用待恢复配置')}</button><button type="button" onClick={() => setPendingLogContext(null)} className="rounded px-2 py-1">{tr('取消')}</button></div>}
      {restoredSessionName && <div className={`border-b px-4 py-2 text-xs ${isDark ? 'bg-amber-500/10 text-amber-300 border-[#3E4145]' : 'bg-amber-50 text-amber-800 border-amber-200'}`}>{tr("已恢复：")}{restoredSessionName} · {entries.length.toLocaleString(getLocale())}{tr(" 条原始日志 · ")}{sourceLabel || tr("已保存来源")} · {aiHistoryReadOnly ? tr("历史 AI 对话只读，未自动采集或请求 AI") : tr("当前可手动开始新分析")}
      </div>}
      <div className="flex-1 flex overflow-hidden">
        {(viewPreferences.view.sidebarOpen || issueOpen) && <aside aria-label={tr('日志筛选与问题')} className={`w-[min(22rem,44vw)] shrink-0 space-y-3 overflow-y-auto border-r p-3 ${isDark ? 'border-slate-600 bg-[#202124]' : 'border-slate-200 bg-slate-50'}`}>
          {issueOpen && <LogIssueInbox groups={viewEngine.issues} selectedId={selectedIssue?.id} busy={analysisBlocked || aiAnalyzing || aiHistoryReadOnly}
            ungroupedIssueCount={viewEngine.ungroupedIssueCount} theme={logTheme}
            onSelect={group => { setSelectedIssue({ ...group, documentId }); setDetailEntry({ entry: group.representative, context: group.context, label: sourceLabel, documentId }); }}
            onMark={markIssue} onAnalyze={group => onAiAnalyze(tr('请核对所选问题的原始日志，区分事实、推测与验证步骤。'), group.context, documentId)} />}
          {viewPreferences.view.sidebarOpen && <section className={`space-y-3 rounded-xl border p-3 ${logTheme.card}`}>
            <header className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold">{tr('高级过滤')}</h2><button type="button" onClick={resetFilters} className="text-xs underline">{tr('重置')}</button></header>
            <LogFilterPresets filter={{ ...filter, text: filterTextInput || undefined }} buffers={buffers} onApply={applyFilterPreset} isDark={isDark} />
            {[
              ['excludeText', tr('排除'), tr('排除文本')],
              ['regex', tr('正则'), tr('例如: (ActivityManager|WindowManager)')],
              ['pkg', isHarmonyLog ? tr('应用 / 进程名') : tr('包名'), tr('例如: com.example.app')],
              ['tag', tr('Tag'), tr('例如: ActivityTaskManager')],
              ...(isHarmonyLog ? [['domain', tr('日志域（Domain）'), 'A03200']] : []),
              ['pid', 'PID', tr('例如: 12345')]
            ].map(([field, label, placeholder]) => <label key={field} className="block space-y-1 text-xs"><span>{label}</span>
              <input aria-label={label} value={filter[field] ?? ''} maxLength={5000} placeholder={placeholder}
                onChange={event => { const value = event.target.value; setFilter(previous => ({ ...previous, [field]: field === 'pid' ? value.trim() && /^[0-9]+$/.test(value.trim()) ? Number.isSafeInteger(Number(value)) && Number(value) <= 2147483647 ? Number(value) : undefined : undefined : value || undefined })); }}
                className={`w-full min-w-0 rounded-lg border px-3 py-2 text-xs ${logTheme.input}`} /></label>)}
            <div className="space-y-1"><span className="text-xs">{tr('最小级别')}</span><SelectMenu ariaLabel={tr('最小级别')} value={filter.minLevel || ''} onChange={value => setFilter(previous => ({ ...previous, minLevel: value || undefined }))} isDark={isDark} compact
              options={[{ value: '', label: tr('不过滤') }, ...levels.map(level => ({ value: level.v, label: level.label }))]} /></div>
            <div className="flex flex-wrap gap-1">{Object.entries(counts).map(([level, count]) => <span key={level} className={`rounded border px-2 py-1 text-xs ${levelBgColors[level]}`}><span className={levelColors[level]}>{level}</span> {count.toLocaleString(getLocale())}</span>)}</div>
          </section>}
        </aside>}

        {/* Right Panel - Log Viewer */}
        <div className={`min-w-0 min-h-0 flex-1 flex flex-col ${isDark ? 'bg-[#202124]' : 'bg-white'}`}>
          <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
            <span className={`text-sm font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
              {smartSearching && smartSearchIncremental.length > 0
                ? <span className="flex items-center gap-2">
                    <Loader2 size={14} className="text-violet-500 animate-spin" />{tr("搜索中…已匹配 ")}{smartSearchIncremental.length}{tr(" 条")}</span>
                : (smartSearchResult && !smartSearching
                  ? <span className="flex items-center gap-2">
                      <Brain size={14} className="text-violet-500" />{tr("搜索结果：\"")}{smartSearchResult.query}"（{smartSearchResult.matchedCount}{tr(" 条）")}</span>
                  : (source === 'realtime' ? tr("实时日志") : tr("文件日志")))
              }
            </span>
            <span className={`text-xs ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>{tr('单击日志查看原文；点击包名或 Tag 快速筛选。')}</span>
          </div>

          <div
            className={`flex items-center px-4 py-1.5 border-b text-xs font-bold ${isDark ? 'bg-[#2A2C2F] border-[#3E4145] text-[#9AA0A6]' : 'bg-slate-50 border-slate-200 text-slate-500'}`}
            style={{ display: 'grid', gridTemplateColumns: `${colWidths.ts}px ${colWidths.level}px ${colWidths.pkg}px ${colWidths.tag}px 1fr`, gap: '8px' }}
          >
            <span className="relative">{tr("时间")}<span
                onMouseDown={(e) => onColResizeStart(e, 'ts')}
                className={`absolute top-1/2 -right-1 -translate-y-1/2 w-1.5 h-4 cursor-col-resize rounded ${isDark ? 'hover:bg-cyan-500/50' : 'hover:bg-cyan-500/40'}`}
                title={tr("拖拽调整时间列宽度")}
              />
            </span>
            <span className="text-center">{tr("级别")}</span>
            <span className="relative truncate">{isHarmonyLog ? tr('应用 / 进程名') : tr("包名")}<span
                onMouseDown={(e) => onColResizeStart(e, 'pkg')}
                className={`absolute top-1/2 -right-1 -translate-y-1/2 w-1.5 h-4 cursor-col-resize rounded ${isDark ? 'hover:bg-cyan-500/50' : 'hover:bg-cyan-500/40'}`}
                title={tr("拖拽调整包名列宽度")}
              />
            </span>
            <span className="relative truncate">{tr("Tag")}<span
                onMouseDown={(e) => onColResizeStart(e, 'tag')}
                className={`absolute top-1/2 -right-1 -translate-y-1/2 w-1.5 h-4 cursor-col-resize rounded ${isDark ? 'hover:bg-cyan-500/50' : 'hover:bg-cyan-500/40'}`}
                title={tr("拖拽调整 Tag 列宽度")}
              />
            </span>
            <span>{tr("消息")}</span>
          </div>

          <div
            ref={logScrollRef}
            className="flex-1 overflow-y-auto font-mono text-xs"
            onWheel={() => { scrollIntentUntil.current = performance.now() + 500; }}
            onTouchMove={() => { scrollIntentUntil.current = performance.now() + 500; }}
            onPointerDown={() => { scrollPointerActive.current = true; }}
            onPointerUp={() => { scrollPointerActive.current = false; scrollIntentUntil.current = performance.now() + 100; }}
            onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Tab', ' '].includes(event.key)) scrollIntentUntil.current = performance.now() + 500; }}
            // L1: 检测用户是否在底部，更新 autoScrollRef
            onScroll={(e) => {
              const el = e.currentTarget;
              const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
              if (!programmaticScroll.current && (scrollPointerActive.current || performance.now() < scrollIntentUntil.current)) {
                autoScrollRef.current = atBottom; if (runningRef.current) setPaused(!atBottom);
              }
              syncLogViewport(el.scrollTop, el.clientHeight);
            }}
          >
            {!initialLogStateLoaded && !hydrateError ? (
              <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
                <Loader2 size={32} className="mb-3 animate-spin" />
                <p className="font-bold">{tr("正在读取日志文件…")}</p>
                <p className="text-xs mt-2 opacity-60">{tr("文件较大时可能需要数秒，请稍候")}</p>
              </div>
            ) : smartSearching && smartSearchIncremental.length === 0 ? (
              <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>
                <Loader2 size={32} className="mb-3 animate-spin" />
                <p className="font-bold">{tr("正在智能搜索…")}</p>
                <p className="text-xs mt-1">{tr("查询：\"{0}\"", { 0: smartSearchQuery })}</p>
                {smartSearchProgress && (
                  <p className="text-xs mt-2">{tr("已搜索 ")}{smartSearchProgress.completed}/{smartSearchProgress.total}{tr(" 块")}{smartSearchProgress.matchedCount > 0 && tr("，已匹配 {0} 条", { 0: smartSearchProgress.matchedCount })}
                  </p>
                )}
                <p className="text-xs mt-3 opacity-60">{tr("AI 正在分块分析日志，结果将逐步显示…")}</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                <Terminal size={32} className="mb-3 opacity-50" />
                <p>{viewSource.length ? tr('没有符合当前条件的日志') : smartSearchResult ? tr('本次搜索没有匹配记录') : tr('暂无日志')}</p>
                <p className="text-xs mt-1">{viewSource.length || smartSearchResult ? tr('可修改或重置筛选；原始日志没有被删除。') : tr('可点击"开始抓取"或"打开 .log"')}</p>
              </div>
            ) : (
              <div className="relative" style={{ height: `${virtualLogRows.totalHeight}px`, transitionProperty: 'none' }}>
                <div
                  className="divide-y divide-slate-800/30"
                  style={{ transform: `translateY(${virtualLogRows.topOffset}px)`, transitionProperty: 'none' }}
                >
                  {virtualLogRows.entries.map((entry) => (
                    <LogRow
                      key={entry.id}
                      entry={entry}
                      isDark={isDark}
                      colWidths={colWidths}
                      highlighted={smartSearchMatchedIds.has(entry.id) || (locatedMarkerIdentity && markerEntryIds.has(entry.id) && locatedMarkerIdentity === logEntryIdentity(entry, captureDeviceId))}
                      marked={markerEntryIds.has(entry.id) && markerIdentities.has(logEntryIdentity(entry, captureDeviceId))}
                      onMark={addMarker}
                      onDetail={showDetail}
                      onFilter={rowFilter}
                      disabled={queryBlocked}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {aiPanelOpen && (
        <>
          {/* 全屏遮罩 */}
          {aiFullscreen && (
            <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setAiFullscreen(false)} />
          )}

          <div
            className={`${aiFullscreen ? 'fixed inset-0 z-50' : 'relative'} flex flex-col ${aiFullscreen ? '' : 'border-t'} ${isDark ? 'bg-[#202124]/95 border-[#3E4145]' : 'bg-white border-slate-200'}`}
            style={aiFullscreen ? {} : { height: `${aiPanelHeight}px` }}
          >
            {/* 拖拽调整高度的把手 */}
            {!aiFullscreen && (
              <div
                onMouseDown={onResizeStart}
                className={`h-1.5 cursor-ns-resize flex items-center justify-center group ${isDark ? 'hover:bg-purple-500/20 bg-[#2D2F33]' : 'hover:bg-purple-200 bg-slate-100'}`}
              >
                <div className={`w-12 h-0.5 rounded-full ${isDark ? 'bg-slate-600 group-hover:bg-purple-400' : 'bg-slate-300 group-hover:bg-purple-500'}`} />
              </div>
            )}

            {/* AI Panel Header */}
            <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-[#3E4145] bg-[#2A2C2F]' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles size={16} className={`shrink-0 ${isDark ? 'text-purple-400' : 'text-purple-500'}`} />
                <span className={`text-sm font-bold shrink-0 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{tr('日志对话')}</span>
                {aiAnalyzing && (
                  <span className="flex items-center gap-1 text-xs text-purple-400 shrink-0">
                    <Loader2 size={12} className="animate-spin" />
                    {mapReduceProgress
                      ? mapReduceProgress.phase === 'map'
                        ? tr("分块分析 {0}/{1}{2}", { 0: mapReduceProgress.current, 1: mapReduceProgress.total, 2: mapReduceProgress.lineRange ? tr("（第 {0} 行）", { 0: mapReduceProgress.lineRange }) : '' })
                        : mapReduceProgress.phase === 'compress'
                          ? tr("正在压缩上下文…")
                          : tr("汇总分析中…")
                      : tr("分析中…")}
                  </span>
                )}
                <span className={`text-xs shrink-0 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>{tr("({0} 条日志)", { 0: filtered.length.toLocaleString(getLocale()) })}</span>
                {(() => {
                  const usage = contextUsage || { usedTokens: 0, maxTokens: 524288, percent: 0, messageCount: 0 };
                  const pct = usage.percent;
                  const ringColor = pct >= 90 ? '#EF4444' : pct >= 70 ? '#F59E0B' : '#3B82F6';
                  const size = 22;
                  const r = 8;
                  const c = 2 * Math.PI * r;
                  const offset = c - (pct / 100) * c;
                  const fmt = (n) => n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n);
                  return (
                    <div className="relative group/ctx flex items-center justify-center shrink-0 w-[22px] h-[22px]" title={tr("上下文使用量")}>
                      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                        <circle cx="11" cy="11" r={r} fill="none" strokeWidth="2.5"
                          className={isDark ? 'stroke-[#3E4145]' : 'stroke-slate-200'} />
                        <circle cx="11" cy="11" r={r} fill="none" strokeWidth="2.5"
                          stroke={ringColor} strokeDasharray={c} strokeDashoffset={offset}
                          strokeLinecap="round" transform="rotate(-90 11 11)"
                          className="transition-all duration-500" />
                      </svg>
                      <span className={`absolute inset-0 flex items-center justify-center text-[8px] font-bold leading-none ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>
                        {pct}
                      </span>
                      {/* Tooltip */}
                      <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 rounded-lg text-xs whitespace-nowrap opacity-0 group-hover/ctx:opacity-100 transition-opacity pointer-events-none z-50 ${isDark ? 'bg-[#2A2C2F] border border-[#3E4145] text-[#E8EAED]' : 'bg-white border border-slate-200 text-slate-700 shadow-lg'}`}>
                        <div className="font-bold mb-0.5">{tr("{0}% 已用（剩余 {1}%）", { 0: pct, 1: 100 - pct })}</div>
                        <div className={isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}>{tr("已用 {0} / {1} tokens", { 0: fmt(usage.usedTokens), 1: fmt(usage.maxTokens) })}</div>
                        <div className={`text-[10px] mt-0.5 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>{tr("{0} 条对话消息", { 0: usage.messageCount })}</div>
                      </div>
                    </div>
                  );
                })()}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {aiTurns.length > 0 && !aiAnalyzing && (
                  <>
                    <button
                      onClick={onAiExport}
                      className={`flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors ${isDark ? 'text-[#9AA0A6] hover:text-[#E8EAED] hover:bg-[#3E4145]' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                      title={tr("导出为 .md 文件")}
                    >
                      <FileDown size={13} />{tr("导出")}</button>
                    <button
                      onClick={onAiClear}
                      disabled={aiAnalyzing}
                      className={`text-xs px-2 py-1 rounded transition-colors ${isDark ? 'text-[#9AA0A6] hover:text-[#E8EAED] hover:bg-[#3E4145]' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                    >{tr("清空")}</button>
                  </>
                )}
                <button
                  onClick={onToggleFullscreen}
                  className={`p-1 rounded-lg transition-colors ${isDark ? 'hover:bg-[#3E4145] text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  title={aiFullscreen ? tr("退出全屏") : tr("全屏查看")}
                >
                  {aiFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
                <button
                  onClick={() => { setAiPanelOpen(false); setAiFullscreen(false); }}
                  className={`p-1 rounded-lg transition-colors ${isDark ? 'hover:bg-[#3E4145] text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                >
                  <X size={16} />
                </button>
              </div>
            </div>

            {analysisScope && <div className="shrink-0 px-4 pt-2"><LogInlineAnalysisScope scope={analysisScope} isDark={isDark} /></div>}
            {/* AI Content Area */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {aiError ? (
                <div className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                  <span className="font-bold">{tr("错误：")}</span>{tr(aiError)}
                  {!conversationReady && <button type="button" onClick={resetBackendConversation} className="ml-2 rounded border border-current px-2 py-1 text-xs">{tr('重试重置分析上下文')}</button>}
                </div>
              ) : aiTurns.length > 0 ? (
                <div className="space-y-4">
                  {aiTurns.map((turn, idx) => {
                    const isLastTurn = idx === aiTurns.length - 1;
                    const showThinking = isLastTurn ? aiAnalyzing : false;
                    return (
                      <div key={idx}>
                        {/* 轮次标题 */}
                        <div className={`text-xs font-bold mb-2 ${isDark ? 'text-purple-400' : 'text-purple-600'}`}>
                          {turn.header}
                        </div>
                        {/* 本轮思考面板 */}
                        {turn.reasoning && (
                          <div className={`mb-2 rounded-lg border overflow-hidden ${isDark ? 'border-[#3E4145] bg-[#1A1B1D]' : 'border-slate-200 bg-slate-50'}`}>
                            <button
                              onClick={() => {
                                const turns = [...aiTurns];
                                turns[idx].reasoningExpanded = !turns[idx].reasoningExpanded;
                                setAiTurns(turns);
                              }}
                              className={`flex items-center gap-2 w-full px-3 py-1.5 text-xs font-medium transition-colors ${isDark ? 'text-[#9AA0A6] hover:text-[#E8EAED]' : 'text-slate-500 hover:text-slate-700'}`}
                            >
                              {showThinking ? (
                                <Loader2 size={12} className="animate-spin text-purple-400" />
                              ) : (
                                <span className="text-purple-400">&#128294;</span>
                              )}
                              <span>{showThinking ? tr("思考中…") : tr("已完成思考")}</span>
                              <span className={`ml-auto transition-transform ${turn.reasoningExpanded ? 'rotate-180' : ''}`}>
                                <ChevronDown size={12} />
                              </span>
                            </button>
                            {turn.reasoningExpanded && (
                              <div className={`px-3 pb-2 text-xs leading-relaxed whitespace-pre-wrap max-h-60 overflow-y-auto ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                                {turn.reasoning}
                                {showThinking && <span className="inline-block w-1.5 h-3 ml-0.5 bg-purple-400/60 animate-pulse align-middle" />}
                              </div>
                            )}
                          </div>
                        )}
                        {/* 本轮回答内容 */}
                        {turn.content ? (
                          <div className={`text-sm leading-relaxed ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>
                            <LogInlineAnalysisResult content={turn.content} allowedRefs={turn.evidenceRefs} evidence={evidenceByRef} isDark={isDark} renderMarkdown={content => <AiMarkdownRender content={content} isDark={isDark} />} />
                            {showThinking && (
                              <span className="inline-block w-2 h-4 ml-0.5 bg-purple-400 animate-pulse align-middle" />
                            )}
                          </div>
                        ) : showThinking && !turn.reasoning ? (
                          <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                            <Loader2 size={14} className="animate-spin text-purple-400" />{tr("AI 正在分析日志…")}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : aiAnalyzing ? (
                <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  <Loader2 size={32} className="mb-3 animate-spin text-purple-400" />
                  <p className="text-sm">{tr("AI 正在分析日志，请稍候…")}</p>
                  <p className="text-xs mt-1">{tr("正在向 Agent AI 发送 {0} 条日志", { 0: filtered.length.toLocaleString(getLocale()) })}</p>
                </div>
              ) : (
                <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  <Sparkles size={28} className="mb-2 opacity-50" />
                  <p className="text-sm">{tr("点击下方\"开始分析\"让 AI 帮你诊断日志")}</p>
                  <p className="text-xs mt-1">{tr("将基于当前 {0} 条过滤后日志进行分析", { 0: filtered.length.toLocaleString(getLocale()) })}</p>
                </div>
              )}
            </div>

            {/* AI Input Bar */}
            {aiHistoryReadOnly && <div className={`border-t px-4 py-3 text-xs ${isDark ? 'border-[#3E4145] bg-amber-500/10 text-amber-300' : 'border-amber-200 bg-amber-50 text-amber-800'}`}>{tr("历史对话仅供查阅，不会作为新请求的上下文。开始新分析会清空当前对话视图，不影响已保存会话。")}<button type="button" onClick={onAiClear} className="ml-3 rounded border border-current px-2 py-1">{tr("开始新的分析")}</button>
            </div>}
            <div className={`flex items-center gap-2 px-4 py-2 border-t ${isDark ? 'border-[#3E4145] bg-[#2A2C2F]' : 'border-slate-200 bg-slate-50'}`}>
              {/* 快速/思考模式切换 */}
              <button
                onClick={() => setAiThinkingMode(!aiThinkingMode)}
                disabled={aiAnalyzing}
                className={`flex items-center gap-1 px-2.5 py-2 text-xs rounded-lg border transition-all disabled:opacity-50 ${
                  aiThinkingMode
                    ? (isDark ? 'border-purple-500/40 bg-purple-500/15 text-purple-400' : 'border-purple-300 bg-purple-50 text-purple-600')
                    : (isDark ? 'border-[#5F6368] bg-[#3E4145] text-[#9AA0A6]' : 'border-slate-200 bg-white text-slate-500')
                }`}
                title={aiThinkingMode ? tr("思考模式：AI 会先进行推理再回答") : tr("快速模式：AI 直接回答，速度更快")}
              >
                {aiThinkingMode ? <Brain size={13} /> : <Zap size={13} />}
                {aiThinkingMode ? tr("思考") : tr("快速")}
              </button>
              <input
                type="text"
                value={aiCustomPrompt}
                disabled={aiHistoryReadOnly}
                onChange={(e) => setAiCustomPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.isComposing && !aiAnalyzing && !analysisBlocked && filtered.length > 0) {
                    e.preventDefault();
                    onAiAnalyze();
                  }
                }}
                placeholder={tr("附加分析要求（可选，如：重点关注内存泄漏）")}
                className={`flex-1 text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-purple-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-white border-slate-200 text-slate-700 placeholder-slate-400'}`}
              />
              {aiAnalyzing ? (
                <button
                  onClick={onAiStop}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
                >
                  <StopCircle size={14} />{tr("停止")}</button>
              ) : (
                <button
                  onClick={() => onAiAnalyze()}
                  disabled={filtered.length === 0 || aiHistoryReadOnly || analysisBlocked}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-purple-500 hover:bg-purple-600 text-white transition-colors disabled:opacity-50"
                >
                  <Send size={14} />{tr("开始分析")}</button>
              )}
            </div>
          </div>
        </>
      )}

      {mcpHelpVisible && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
          onClick={() => setMcpHelpVisible(false)}
        >
          <div
            className={`w-[640px] max-h-[85vh] rounded-2xl border shadow-2xl overflow-hidden flex flex-col ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'}`}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className={`flex items-center justify-between px-6 py-4 border-b ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-gradient-to-r from-cyan-50 to-blue-50'}`}>
              <div className="flex items-center gap-3">
                <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${isDark ? 'bg-cyan-500/20 text-cyan-400' : 'bg-cyan-500/10 text-cyan-600'}`}>
                  <Radio size={20} />
                </div>
                <div>
                  <div className={`text-base font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{tr("MCP 服务使用说明")}</div>
                  <div className={`text-xs ${isDark ? 'text-[#80868B]' : 'text-slate-500'}`}>{tr("Model Context Protocol · AI 工具集成接口")}</div>
                </div>
              </div>
              <button
                onClick={() => setMcpHelpVisible(false)}
                className={`p-1.5 rounded-lg transition-colors ${isDark ? 'hover:bg-[#3E4145] text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
              >
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div className="px-6 py-5 overflow-y-auto flex-1 space-y-5">
              {/* Intro */}
              <div className={`text-xs leading-relaxed ${isDark ? 'text-[#9AA0A6]' : 'text-slate-600'}`}>{tr("MCP 服务让 AI 工具（Claude CLI、Cursor、Trae 等）能够直接读取和控制本应用的日志、应用包、性能采样和设备巡检能力，无需手动复制粘贴结果。")}</div>

              {/* Tool Groups */}
              {[
                {
                  title: tr("设备与日志控制"),
                  icon: '🎮',
                  color: isDark ? 'emerald' : 'emerald',
                  tools: [
                    { name: 'device_list', desc: tr("列出所有 ADB 连接的设备") },
                    { name: 'capture_start', desc: tr("选择设备并开始抓取日志"), extra: tr("可选 buffers 指定缓冲区：main / system / radio / events / crash / kernel") },
                    { name: 'capture_stop', desc: tr("停止当前抓取") },
                    { name: 'log_clear', desc: tr("清空日志") },
                  ],
                },
                {
                  title: tr("应用包管理"),
                  icon: '📦',
                  color: 'amber',
                  tools: [
                    { name: 'package_list', desc: tr("列出指定设备已安装应用"), extra: tr("默认返回用户应用；showSystem=true 时包含系统应用") },
                    { name: 'package_detail', desc: tr("读取应用版本、路径、安装时间、启停状态和权限摘要") },
                  ],
                },
                {
                  title: tr("性能与巡检"),
                  icon: '📊',
                  color: 'rose',
                  tools: [
                    { name: 'perf_snapshot', desc: tr("执行一次性能采样"), extra: tr("返回 CPU、内存、存储空间、电池、温度、FPS 和告警") },
                    { name: 'inspection_run', desc: tr("执行标准设备巡检并导出报告与证据包"), extra: tr("支持 includeBugreport、includeAiSummary 和 outputBaseDir") },
                  ],
                },
                {
                  title: tr("日志查询（只读）"),
                  icon: '🔍',
                  color: 'blue',
                  tools: [
                    { name: 'log_sources', desc: tr("查看日志源条数") },
                    { name: 'log_get', desc: tr("读取原始日志（分页）") },
                    { name: 'log_filter', desc: tr("按级别/关键词/Tag/PID/包名/正则过滤") },
                    { name: 'log_stats', desc: tr("统计各级别数量") },
                    { name: 'log_watch', desc: tr("等待特定关键词出现") },
                  ],
                },
                {
                  title: tr("AI 分析"),
                  icon: '🤖',
                  color: 'violet',
                  tools: [
                    { name: 'ai_analyze', desc: tr("启动 AI 日志分析（非流式，等待完整结果）"), extra: tr("参数：source(realtime/file)、filter、customPrompt、timeoutMs") },
                    { name: 'ai_get_result', desc: tr("获取最近一次 AI 分析结果（Markdown 格式）") },
                    { name: 'ai_clear', desc: tr("清空 AI 分析结果和对话上下文") },
                  ],
                },
              ].map((group) => (
                <div key={group.title}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm">{group.icon}</span>
                    <span className={`text-xs font-bold uppercase tracking-wide ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>{group.title}</span>
                    <div className={`flex-1 h-px ${isDark ? 'bg-[#3E4145]' : 'bg-slate-200'}`} />
                  </div>
                  <div className="space-y-1.5">
                    {group.tools.map((tool) => (
                      <div
                        key={tool.name}
                        className={`flex items-start gap-3 px-3 py-2 rounded-lg ${isDark ? 'bg-slate-700/40' : 'bg-slate-50'}`}
                      >
                        <code className={`shrink-0 px-2 py-0.5 rounded text-[11px] font-mono font-semibold ${isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-100 text-cyan-700'}`}>
                          {tool.name}
                        </code>
                        <div className="flex-1 min-w-0">
                          <div className={`text-xs ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>{tool.desc}</div>
                          {tool.extra && (
                            <div className={`text-[11px] mt-0.5 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>{tool.extra}</div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              {/* Config */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm">⚙️</span>
                  <span className={`text-xs font-bold uppercase tracking-wide ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>{tr("配置方法")}</span>
                  <div className={`flex-1 h-px ${isDark ? 'bg-[#3E4145]' : 'bg-slate-200'}`} />
                </div>

                {/* Config Tabs */}
                <div className={`flex gap-1 mb-2 p-1 rounded-lg ${isDark ? 'bg-slate-700/50' : 'bg-slate-100'}`}>
                  {[
                    { id: 'trae', label: 'Trae / Cursor' },
                    { id: 'claude', label: 'Claude Code' },
                    { id: 'codex', label: 'Codex' },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setMcpConfigTab(tab.id)}
                      className={`flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md transition-all ${
                        mcpConfigTab === tab.id
                          ? (isDark ? 'bg-[#2D2F33] text-cyan-300 shadow' : 'bg-white text-cyan-600 shadow-sm')
                          : (isDark ? 'text-[#9AA0A6] hover:text-[#E8EAED]' : 'text-slate-500 hover:text-slate-700')
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>

                {/* Config Content with Copy */}
                <div className="relative">
                  <button
                    onClick={() => {
                      let config = '';
                      if (mcpConfigTab === 'trae') {
                        config = JSON.stringify({
                          mcpServers: {
                            'Android Log Analyzer MCP': {
                              url: `http://127.0.0.1:${mcpPort}/mcp`,
                              headers: {},
                            },
                          },
                        }, null, 2);
                      } else if (mcpConfigTab === 'claude') {
                        config = `claude mcp add --transport http android-log-analyzer http://127.0.0.1:${mcpPort}/mcp`;
                      } else if (mcpConfigTab === 'codex') {
                        config = `# ~/.codex/config.toml\n[mcp_servers.android-log-analyzer]\ntransport = "http"\nurl = "http://127.0.0.1:${mcpPort}/mcp"`;
                      }
                      navigator.clipboard.writeText(config);
                    }}
                    className={`absolute top-2 right-2 z-10 flex items-center gap-1 px-2 py-1 text-[11px] rounded transition-colors ${isDark ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED]' : 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED]'}`}
                  >
                    <Copy size={11} />{tr(" 复制")}</button>
                  <pre className={`px-3 py-3 pr-16 rounded-lg text-[11px] leading-relaxed font-mono overflow-x-auto ${isDark ? 'bg-slate-900 text-emerald-300 border border-[#3E4145]' : 'bg-slate-900 text-emerald-300'}`}>
{mcpConfigTab === 'trae' ? `{
  "mcpServers": {
    "Android Log Analyzer MCP": {
      "url": "http://127.0.0.1:${mcpPort}/mcp",
      "headers": {}
    }
  }
}` : mcpConfigTab === 'claude' ? tr("# 方式一：CLI 命令（推荐）\nclaude mcp add --transport http android-log-analyzer http://127.0.0.1:{0}/mcp\n\n# 方式二：编辑 ~/.claude.json 或项目根目录 .mcp.json\n{\n  \"mcpServers\": {\n    \"android-log-analyzer\": {\n      \"type\": \"streamable-http\",\n      \"url\": \"http://127.0.0.1:{1}/mcp\"\n    }\n  }\n}", { 0: mcpPort, 1: mcpPort }) : `# ~/.codex/config.toml
[mcp_servers.android-log-analyzer]
transport = "http"
url = "http://127.0.0.1:${mcpPort}/mcp"`}
                  </pre>
                </div>

                {/* Config file path hint */}
                <div className={`mt-1.5 text-[11px] ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  {mcpConfigTab === 'trae' && tr("配置文件：Trae 的 mcp.json / Cursor 的 settings.json")}
                  {mcpConfigTab === 'claude' && tr("CLI 命令直接添加，或编辑 ~/.claude.json / .mcp.json")}
                  {mcpConfigTab === 'codex' && tr("配置文件：~/.codex/config.toml")}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className={`flex items-center justify-between px-6 py-3 border-t ${isDark ? 'border-[#3E4145] bg-[#2A2C2F]' : 'border-slate-200 bg-slate-50'}`}>
              <div className={`text-[11px] ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>{tr("当前端口：")}<span className={`font-mono font-semibold ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{mcpPort}</span>
              </div>
              <button
                onClick={() => setMcpHelpVisible(false)}
                className={`px-4 py-1.5 text-xs rounded-lg transition-colors ${isDark ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED]' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'}`}
              >{tr("关闭")}</button>
            </div>
          </div>
        </div>
      )}

      {/* 日志诊断规则库弹窗 */}
      {detailEntry && <LogEntryDetail key={detailEntry.documentId + ':' + detailEntry.entry.id} entry={detailEntry.entry} context={detailEntry.context} scopeLabel={detailEntry.label} theme={logTheme}
        wrap={viewPreferences.view.detailWrap} onWrapChange={value => viewPreferences.setField('detailWrap', value)}
        onClose={() => setDetailEntry(null)} onFilter={rowFilter} onTimeWindow={aroundEntry} busy={analysisBlocked || aiAnalyzing || aiHistoryReadOnly}
        onAnalyze={rows => { const expected = detailEntry.documentId; setDetailEntry(null); void onAiAnalyze(tr('请核对所选上下文中的日志事实与待验证线索。'), rows, expected); }}
        onMark={entry => { if (detailEntry.documentId === latestDocument.current?.documentId) markIssue({ representative: entry, context: detailEntry.context }); }} />}
      <LogExportDialog open={exportOpen} isDark={isDark} onClose={() => setExportOpen(false)} onMessage={setNote} getSnapshot={getSnapshot}
        scopes={[{ id: 'filtered', label: tr('当前筛选（{0} 条）', { 0: filtered.length }), count: filtered.length }, { id: 'loaded', label: tr('已加载窗口（{0} 条）', { 0: viewEngine.windowRows.length }), count: viewEngine.windowRows.length },
          ...(selectedIssue?.context?.length ? [{ id: 'issue', label: tr('所选问题上下文（{0} 条）', { 0: selectedIssue.context.length }), count: selectedIssue.context.length }] : [])]} />
      {close.request && <LogClosePrompt key={close.request.requestId} request={close.request} onSave={close.save} onResolve={close.resolve} approved={close.approved} isDark={isDark} />}
      <AppMessageDialogHost theme={logTheme} isDark={isDark} />
      <DiagnosticRuleLibrary
        theme={t}
        open={ruleLibraryOpen}
        onClose={() => { setRuleLibraryOpen(false); void refreshRules(); }}
        isVip={isVip}
        onVipRequired={showVipBlock}
      />

      {vipBlockMsg && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50">
          <div className="p-6 rounded-xl shadow-2xl max-w-sm w-full mx-4 bg-[#2D2F33] border border-[#3E4145]">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center">
                <Lock size={20} className="text-amber-400" />
              </div>
              <div>
                <h4 className="text-base font-semibold text-[#E8EAED]">{tr("会员专属功能")}</h4>
                <p className="text-xs text-[#9AA0A6] mt-0.5">{tr("{0} 仅会员可用", { 0: vipBlockMsg })}</p>
              </div>
            </div>
            <p className="text-sm text-[#9AA0A6] mb-5">{tr("当前为基础版，开通会员即可解锁全部 AI 能力与 MCP 服务。")}</p>
            <div className="flex justify-end gap-2">
              <button onClick={dismissVipBlock} className="px-4 py-2 text-sm rounded-lg bg-[#3E4145] text-[#E8EAED] hover:bg-slate-600 transition-colors">{tr("知道了")}</button>
              <button
                onClick={() => {
                  dismissVipBlock();
                  if (window.electronAPI?.logAnalyzerClose) window.electronAPI.logAnalyzerClose();
                }}
                className="px-4 py-2 text-sm rounded-lg bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white font-medium transition-all"
              >{tr("去开通")}</button>
            </div>
          </div>
        </div>
      )}
      <AiOutboundPreviewHost isDark={isDark} />
    </div>
  );
}

// H5: 使用 React.memo 避免不必要的重渲染（仅当 props 变化时才重新渲染）
const LogRow = memo(function LogRow({ entry, isDark, colWidths, highlighted, marked, onMark, onDetail, onFilter, disabled }) {
  useLocale();
  const level = entry.level || 'V', pkg = entry.pkg || entry.processName || '', tag = entry.domain ? entry.domain + '/' + (entry.tag || '') : entry.tag || '';
  const rawPreview = logListPreview(entry.raw), message = logListPreview(entry.message ?? entry.raw), packagePreview = logListPreview(pkg), tagPreview = logListPreview(tag);
  const sourceTime = logEntryTimestamp(entry), time = sourceTime.value !== null ? fmtTs(sourceTime.value) : Number.isFinite(entry.receivedAt) ? tr('接收 {0}', { 0: fmtTs(entry.receivedAt) }) : '--';
  const grid = colWidths ? colWidths.ts + 'px ' + colWidths.level + 'px ' + colWidths.pkg + 'px ' + colWidths.tag + 'px minmax(0,1fr)' : '140px 28px 100px 100px minmax(0,1fr)';
  const title = rawPreview.text + (rawPreview.truncated ? '\\n' + tr('列表仅为短预览，点击查看完整原文。') : '');
  return <div data-log-id={String(entry.id)} className={`grid gap-2 select-text border-l-2 px-4 py-1.5 ${highlighted ? isDark ? 'border-violet-400 bg-violet-500/10' : 'border-violet-500 bg-violet-50' : isDark ? 'border-transparent border-b border-white/5 hover:bg-white/5' : 'border-transparent border-b border-slate-100 hover:bg-slate-50'}`}
    style={{ gridTemplateColumns: grid, height: LOG_ROW_HEIGHT }} title={title} onClick={() => onDetail(entry)}>
    <span className={`flex min-w-0 items-center gap-1 ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
      <button type="button" disabled={disabled} aria-label={tr('标记日志 {0}', { 0: time })} title={marked ? tr('已标记，可添加另一条备注') : tr('标记问题发生的位置')} onClick={event => { event.stopPropagation(); onMark(entry); }} className={`shrink-0 rounded p-0.5 disabled:opacity-40 hover:bg-emerald-500/15 ${marked ? 'text-emerald-500' : ''}`}><BookmarkPlus size={12} /></button><span className="truncate" title={time}>{time}</span>
    </span>
    <span className={`rounded px-1 text-center text-xs font-bold ${levelBgColors[level]} ${levelColors[level]}`}>{level}</span>
    <button type="button" disabled={disabled || !pkg} className={`min-w-0 truncate text-left disabled:cursor-default ${isDark ? 'text-emerald-400/80' : 'text-emerald-600'}`} title={packagePreview.text} onClick={event => { event.stopPropagation(); onFilter({ field: 'pkg', value: pkg, mode: 'include' }); }}>{packagePreview.text}</button>
    <button type="button" disabled={disabled || !entry.tag} className={`min-w-0 truncate text-left disabled:cursor-default ${isDark ? 'text-cyan-400/80' : 'text-cyan-600'}`} title={tagPreview.text} onClick={event => { event.stopPropagation(); onFilter({ field: 'tag', value: entry.tag, mode: 'include' }); }}>{tagPreview.text}</button>
    <button type="button" className={`min-w-0 truncate text-left ${isDark ? 'text-slate-200' : 'text-slate-700'}`} aria-label={tr('查看日志详情 {0}', { 0: message.text.slice(0, 80) })} title={message.text} onClick={event => { event.stopPropagation(); onDetail(entry); }}>{message.text}</button>
  </div>;
});

// 轻量 Markdown 渲染组件（用于 AI 分析结果展示）
// 使用增量解析 + useDeferredValue 避免长文本时 UI 卡死
function AiMarkdownRender({ content, isDark }) {
  const locale = useLocale();
  // useDeferredValue: 让 React 在空闲时才渲染 Markdown，不阻塞用户交互
  const deferredContent = useDeferredValue(content);
  // M10: parseMarkdown 缓存优化 - useMemo 本身已提供基于 deferredContent 的 memoization，
  // 内容相同时不会重新解析；useDeferredValue 进一步确保只在空闲时更新。
  // 注：不使用 ref 缓存，因为 React 19 不允许在 render 阶段（useMemo 内）访问 refs。
  const blocks = useMemo(() => { void locale; return parseMarkdown(deferredContent); }, [deferredContent, locale]);
  const endRef = useRef(null);
  const isStale = content !== deferredContent;

  useEffect(() => {
    if (endRef.current && !isStale) {
      endRef.current.scrollIntoView({ behavior: 'auto' });
    }
  }, [deferredContent, isStale]);

  return (
    <div className={`space-y-2 transition-opacity ${isStale ? 'opacity-60' : 'opacity-100'}`}>
      {blocks.map((block, i) => {
        if (block.type === 'heading') {
          const sizes = { 1: 'text-xl', 2: 'text-lg', 3: 'text-base', 4: 'text-sm', 5: 'text-sm', 6: 'text-xs' };
          const colors = { 1: isDark ? 'text-purple-200' : 'text-purple-900', 2: isDark ? 'text-purple-300' : 'text-purple-800', 3: isDark ? 'text-purple-400' : 'text-purple-700', 4: isDark ? 'text-purple-400' : 'text-purple-600', 5: isDark ? 'text-purple-500' : 'text-purple-500', 6: isDark ? 'text-purple-500' : 'text-purple-500' };
          const borders = { 1: 'border-b border-purple-500/40 pb-1', 2: 'border-b border-purple-500/30 pb-1', 3: 'border-b border-purple-500/20 pb-0.5' };
          return (
            <div key={i} className={`${sizes[block.level] || 'text-xs'} font-bold ${colors[block.level]} ${borders[block.level] || ''}`}
              dangerouslySetInnerHTML={{ __html: renderInline(block.text, isDark) }} />
          );
        }
        if (block.type === 'hr') {
          return (
            <hr key={i} className={`border-t ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`} />
          );
        }
        if (block.type === 'quote') {
          return (
            <blockquote key={i} className={`pl-3 py-1 border-l-2 text-xs ${isDark ? 'border-purple-600 bg-[#2A2C2F] text-[#9AA0A6]' : 'border-purple-400 bg-slate-50 text-slate-500'}`}
              dangerouslySetInnerHTML={{ __html: renderInline(block.text, isDark) }} />
          );
        }
        if (block.type === 'table') {
          return (
            <div key={i} className="overflow-x-auto">
              <table className={`w-full text-xs border-collapse ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
                <thead>
                  <tr className={isDark ? 'bg-[#2D2F33]' : 'bg-slate-100'}>
                    {block.headers.map((h, j) => (
                      <th key={j} className={`px-3 py-2 text-left font-bold border ${isDark ? 'border-[#3E4145] text-purple-300' : 'border-slate-200 text-purple-700'}`}
                        dangerouslySetInnerHTML={{ __html: renderInline(h, isDark) }} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, ri) => (
                    <tr key={ri} className={isDark ? (ri % 2 ? 'bg-slate-800/30' : '') : (ri % 2 ? 'bg-slate-50' : '')}>
                      {row.map((cell, ci) => (
                        <td key={ci} className={`px-3 py-2 border ${isDark ? 'border-[#3E4145] text-[#E8EAED]' : 'border-slate-200 text-slate-600'}`}
                          dangerouslySetInnerHTML={{ __html: renderInline(cell, isDark) }} />
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (block.type === 'code') {
          return (
            <pre key={i} className={`text-xs p-3 rounded-lg overflow-x-auto font-mono ${isDark ? 'bg-[#2D2F33] text-emerald-300 border border-[#3E4145]' : 'bg-slate-100 text-emerald-700 border border-slate-200'}`}>
              {block.text}
            </pre>
          );
        }
        if (block.type === 'list') {
          return (
            <ul key={i} className="space-y-1 pl-1">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2">
                  <span className={isDark ? 'text-purple-400' : 'text-purple-500'}>•</span>
                  <span className="flex-1" dangerouslySetInnerHTML={{ __html: renderInline(item, isDark) }} />
                </li>
              ))}
            </ul>
          );
        }
        if (block.type === 'ordered') {
          const start = block.start || 1;
          return (
            <ol key={i} className="space-y-1 pl-1">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2">
                  <span className={`font-bold ${isDark ? 'text-purple-400' : 'text-purple-500'} w-6 text-right shrink-0`}>{start + j}.</span>
                  <span className="flex-1" dangerouslySetInnerHTML={{ __html: renderInline(item, isDark) }} />
                </li>
              ))}
            </ol>
          );
        }
        // paragraph
        return (
          <p key={i} dangerouslySetInnerHTML={{ __html: renderInline(block.text, isDark) }} />
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderInline(text, isDark) {
  let html = escapeHtml(text);
  // bold
  html = html.replace(/\*\*(.+?)\*\*/g, `<strong class="${isDark ? 'text-purple-300' : 'text-purple-700'}">$1</strong>`);
  // inline code
  html = html.replace(/`([^`]+)`/g, `<code class="px-1 py-0.5 rounded text-xs font-mono ${isDark ? 'bg-[#3E4145] text-emerald-300' : 'bg-slate-100 text-emerald-700'}">$1</code>`);
  return html;
}

// 预编译正则表达式，避免循环中反复创建
const RE_HEADING = /^(#{1,6})\s+(.+)$/;
const RE_HR_DASH = /^---+\s*$/;
const RE_HR_STAR = /^\*\*\*+\s*$/;
const RE_HR_UNDER = /^___+\s*$/;
const RE_TABLE_SEP = /^\|?[\s:]*-{2,}[\s:|-]*\|/;
const RE_UL = /^[-*]\s+/;
const RE_OL = /^(\d+)\.\s+/;
const RE_QUOTE = /^>\s*/;

function parseMarkdown(content) {
  const lines = content.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // code block
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', text: codeLines.join('\n') });
      continue;
    }

    // heading
    const headingMatch = line.match(RE_HEADING);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    // horizontal rule
    const trimmedLine = line.trim();
    if (RE_HR_DASH.test(trimmedLine) || RE_HR_STAR.test(trimmedLine) || RE_HR_UNDER.test(trimmedLine)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // table: 表头行 | --- | 分隔行 | 数据行
    if (line.includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1].trim())) {
      const tableLines = [];
      while (i < lines.length && lines[i].trim().includes('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }
      // 解析表格
      const rows = tableLines.map(l => {
        let cleaned = l.trim();
        if (cleaned.startsWith('|')) cleaned = cleaned.slice(1);
        if (cleaned.endsWith('|')) cleaned = cleaned.slice(0, -1);
        return cleaned.split('|').map(c => c.trim());
      });
      // 第一行是表头，第二行是分隔符（跳过），其余是数据
      if (rows.length >= 2) {
        blocks.push({ type: 'table', headers: rows[0], rows: rows.slice(2) });
      }
      continue;
    }

    // unordered list
    if (RE_UL.test(trimmedLine)) {
      const items = [];
      while (i < lines.length && RE_UL.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(RE_UL, ''));
        i++;
      }
      blocks.push({ type: 'list', items });
      continue;
    }

    // ordered list
    if (RE_OL.test(trimmedLine)) {
      const items = [];
      let start = 1;
      const firstMatch = trimmedLine.match(RE_OL);
      if (firstMatch) {
        const parsed = parseInt(firstMatch[1], 10);
        if (!isNaN(parsed)) start = parsed;
      }
      while (i < lines.length && RE_OL.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(RE_OL, ''));
        i++;
      }
      blocks.push({ type: 'ordered', items, start });
      continue;
    }

    // blockquote
    if (RE_QUOTE.test(line.trim())) {
      const quoteLines = [];
      while (i < lines.length && RE_QUOTE.test(lines[i].trim())) {
        quoteLines.push(lines[i].trim().replace(RE_QUOTE, ''));
        i++;
      }
      blocks.push({ type: 'quote', text: quoteLines.join(' ') });
      continue;
    }

    // skip empty lines
    if (line.trim() === '') {
      i++;
      continue;
    }

    // paragraph - collect consecutive non-empty lines
    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().startsWith('```') && !RE_HEADING.test(lines[i]) && !RE_UL.test(lines[i].trim()) && !RE_OL.test(lines[i].trim()) && !RE_QUOTE.test(lines[i].trim()) && !(lines[i].includes('|') && i + 1 < lines.length && RE_TABLE_SEP.test(lines[i + 1].trim()))) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
    }
  }

  return blocks;
}
