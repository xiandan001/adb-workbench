// H5: 导入 memo 用于 LogRow 性能优化
import { useCallback, useEffect, useMemo, useState, useDeferredValue, useRef, memo } from 'react';
import { FolderOpen, Play, Square, Trash2, Download, Copy, RefreshCw, Terminal, Filter, BarChart3, HelpCircle, Radio, X, Sparkles, Loader2, Send, StopCircle, Maximize2, Minimize2, FileDown, AlertTriangle, Zap, ShieldCheck, Search, Brain, CheckCircle, Layers, ChevronDown, Smartphone, Lock } from 'lucide-react';
import { filterEntries, countByLevel } from '../shared/filter';
// 日志诊断规则库面板
import DiagnosticRuleLibrary from './DiagnosticRuleLibrary';

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

// 级别圆点颜色（用于下拉框指示）
const levelDotColors = {
  V: 'bg-slate-400',
  D: 'bg-blue-400',
  I: 'bg-emerald-400',
  W: 'bg-amber-400',
  E: 'bg-red-400',
  F: 'bg-red-500',
  A: 'bg-white'
};
function levelColorDot(v) {
  return levelDotColors[v] || 'bg-slate-400';
}

function fmtTs(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${mm}-${dd} ${hh}:${mi}:${ss}.${ms}`;
}

export default function LogAnalyzer({ theme, vipStatus }) {
  const t = theme || {
    primary: 'tech',
    button: {
      primary: 'bg-emerald-500 hover:bg-emerald-600 text-white'
    }
  };
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
  const [source, setSource] = useState('realtime');
  const [entries, setEntries] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState(emptyFilter);
  const [note, setNote] = useState(undefined);
  const [noteType, setNoteType] = useState('info');
  const [mcpRunning, setMcpRunning] = useState(false);
  const [mcpPort, setMcpPort] = useState(49321);
  const [mcpHelpVisible, setMcpHelpVisible] = useState(false);
  const [mcpConfigTab, setMcpConfigTab] = useState('trae');
  // AI 分析状态
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiAnalyzing, setAiAnalyzing] = useState(false);
  const [aiContent, setAiContent] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiReasoning, setAiReasoning] = useState(''); // 当前轮思考内容（用于流式追加）
  const [aiReasoningExpanded, setAiReasoningExpanded] = useState(true); // 当前轮思考面板展开/折叠
  const [aiTurns, setAiTurns] = useState([]); // 对话轮次数组: [{ header, reasoning, content, reasoningExpanded }]
  const [aiThinkingMode, setAiThinkingMode] = useState(false); // 思考模式开关（默认快速模式）
  const [mapReduceProgress, setMapReduceProgress] = useState(null); // { phase, current, total, lineRange }
  const [contextUsage, setContextUsage] = useState(null); // { usedTokens, maxTokens, percent, messageCount }
  const [aiCustomPrompt, setAiCustomPrompt] = useState('');
  const [aiFullscreen, setAiFullscreen] = useState(false);
  const [aiPanelHeight, setAiPanelHeight] = useState(440);
  const aiListenersRef = useRef([]);
  const aiContentRef = useRef('');
  const aiReasoningRef = useRef('');
  const aiTurnsRef = useRef([]); // 对话轮次 ref
  const aiResizingRef = useRef(false);
  // 记录上次发送给 AI 的日志指纹（用于判断追问时日志是否变化）
  const aiLastLogHashRef = useRef('');
  // AI 自动诊断状态
  const [autoDiagnoseEnabled, setAutoDiagnoseEnabled] = useState(true);
  const [autoDiagnoseAlert, setAutoDiagnoseAlert] = useState(null); // { issues, summary, timestamp }
  // 日志诊断规则库弹窗状态
  const [ruleLibraryOpen, setRuleLibraryOpen] = useState(false);
  const autoDiagnoseListenersRef = useRef([]);
  // 缓存最后一次检测到异常的 alert，用于"展开监控"时恢复显示（而非显示空状态）
  const lastAutoDiagnoseAlertRef = useRef(null);
  // 智能日志搜索状态
  const [smartSearchQuery, setSmartSearchQuery] = useState('');
  const [smartSearching, setSmartSearching] = useState(false);
  const [smartSearchProgress, setSmartSearchProgress] = useState(null); // { completed, total, matchedCount }
  const [smartSearchResult, setSmartSearchResult] = useState(null); // { matchedEntries, analysis, query, matchedCount }
  const [smartSearchMatchedIds, setSmartSearchMatchedIds] = useState(new Set()); // 匹配的 entry ID 集合
  const [smartSearchIncremental, setSmartSearchIncremental] = useState([]); // 增量累积的匹配条目（流式显示）
  const smartSearchListenersRef = useRef([]);
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
  const [exporting, setExporting] = useState(false);
  // M13: 加载状态
  const [loading, setLoading] = useState(false);
  // L1: 智能滚动 - 仅在用户已滚动到底部时自动跟随
  const autoScrollRef = useRef(true);
  // UX1: note 自动清除定时器
  const noteTimerRef = useRef(null);
  // 多缓冲区抓取：默认仅 main（与原行为一致）
  // 可选项：main / system / radio / events / crash / kernel
  const LOG_BUFFERS = [
    { id: 'main', label: '主日志', desc: '应用与大部分系统日志（默认）' },
    { id: 'system', label: '系统日志', desc: 'SystemServer、系统服务' },
    { id: 'radio', label: '通信日志', desc: 'Telephony / Wi-Fi / Bluetooth' },
    { id: 'events', label: '事件日志', desc: '二进制事件统计' },
    { id: 'crash', label: '崩溃日志', desc: '应用 crash 栈' },
    { id: 'kernel', label: '内核日志', desc: 'Linux kernel 日志' }
  ];
  const [buffers, setBuffers] = useState(['main']);
  const [bufferDropdownOpen, setBufferDropdownOpen] = useState(false);
  // 下拉外部点击关闭用的 ref
  const bufferDropdownRef = useRef(null);
  // 设备选择自定义下拉
  const [deviceDropdownOpen, setDeviceDropdownOpen] = useState(false);
  const deviceDropdownRef = useRef(null);
  // 最小级别自定义下拉
  const [levelDropdownOpen, setLevelDropdownOpen] = useState(false);
  const levelDropdownRef = useRef(null);

  // 日志列表列宽可拖拽调整（每列有 min/max 限制）
  // 列顺序：时间 | 级别 | 包名 | Tag | 消息
  const [colWidths, setColWidths] = useState({
    ts: 140,     // 时间列（min:100, max:220）
    level: 28,   // 级别列（固定，不可拖拽）
    pkg: 100,    // 包名列（min:60, max:200）
    tag: 100,    // Tag列（min:50, max:200）
    // msg 列自适应剩余空间，不需要固定宽度
  });
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

  // 下拉菜单外部点击关闭（buffers 下拉 + device 下拉 + level 下拉）
  useEffect(() => {
    if (!bufferDropdownOpen && !deviceDropdownOpen && !levelDropdownOpen) return;
    function onDocClick(ev) {
      const target = ev.target;
      if (bufferDropdownOpen && bufferDropdownRef.current && !bufferDropdownRef.current.contains(target)) {
        setBufferDropdownOpen(false);
      }
      if (deviceDropdownOpen && deviceDropdownRef.current && !deviceDropdownRef.current.contains(target)) {
        setDeviceDropdownOpen(false);
      }
      if (levelDropdownOpen && levelDropdownRef.current && !levelDropdownRef.current.contains(target)) {
        setLevelDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [bufferDropdownOpen, deviceDropdownOpen, levelDropdownOpen]);

  useEffect(() => {
    function onMouseMove(ev) {
      if (!colResizeRef.current) return;
      const { col, startX, startWidth } = colResizeRef.current;
      const delta = ev.clientX - startX;
      let newWidth = startWidth + delta;
      // 应用 min/max 限制
      const limits = { ts: [100, 220], pkg: [60, 200], tag: [50, 200] };
      const [min, max] = limits[col] || [50, 300];
      newWidth = Math.max(min, Math.min(max, newWidth));
      // H6: 使用 requestAnimationFrame 节流，避免每次 mousemove 都触发 setColWidths 重渲染
      if (colResizeRafRef.current != null) return;
      colResizeRafRef.current = requestAnimationFrame(() => {
        colResizeRafRef.current = null;
        setColWidths(prev => ({ ...prev, [col]: newWidth }));
      });
    }
    function onMouseUp() {
      if (colResizeRef.current) {
        // H6: 取消 pending raf，确保最终状态正确
        if (colResizeRafRef.current != null) {
          cancelAnimationFrame(colResizeRafRef.current);
          colResizeRafRef.current = null;
        }
        colResizeRef.current = null;
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const filtered = useMemo(() => {
    // 智能搜索模式：搜索中显示增量结果，搜索完成显示最终结果
    if (smartSearching && smartSearchIncremental.length > 0) {
      return smartSearchIncremental;
    }
    if (smartSearchResult && smartSearchResult.matchedEntries.length > 0) {
      return smartSearchResult.matchedEntries;
    }
    return filterEntries(entries, deferredFilter);
  }, [entries, deferredFilter, smartSearchResult, smartSearching, smartSearchIncremental]);

  const counts = useMemo(() => countByLevel(filtered), [filtered]);

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
  }, [filtered, logViewport]);

  useEffect(() => {
    // L1: 仅在用户已处于底部时自动滚动，避免打断用户浏览；直接滚容器减少虚拟列表额外 DOM。
    if (!autoScrollRef.current || !logScrollRef.current) return;
    if (logAutoScrollRafRef.current != null) {
      cancelAnimationFrame(logAutoScrollRafRef.current);
    }
    logAutoScrollRafRef.current = requestAnimationFrame(() => {
      logAutoScrollRafRef.current = null;
      const el = logScrollRef.current;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      syncLogViewport(el.scrollTop, el.clientHeight);
    });
  }, [filtered.length, syncLogViewport]);

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
    async function refreshDevices() {
      if (window.electronAPI && window.electronAPI.adbListDevices) {
        try {
          const ds = await window.electronAPI.adbListDevices();
          setDevices(ds.map((d) => ({
            id: d.id,
            label: `${d.id}${d.model ? ` (${d.model})` : ''}`
          })));
        } catch (e) {
          console.error('Failed to list devices:', e);
        }
      }
    }

    async function loadInitialState() {
      if (window.electronAPI && window.electronAPI.logGetState) {
        try {
          const s = await window.electronAPI.logGetState();
          setSource(s.source);
          setEntries(s.entries || []);
          setTruncated(s.truncated);
          setupLogListeners();
        } catch (e) {
          console.error('Failed to load log state:', e);
        }
      }
      if (window.electronAPI && window.electronAPI.mcpGetInfo) {
        try {
          const info = await window.electronAPI.mcpGetInfo();
          setMcpRunning(info.running);
          setMcpPort(info.port);
        } catch (e) {
          console.error('Failed to get MCP info:', e);
        }
      }
      // 拉取 VIP 状态（独立窗口场景）
      try {
        if (window.electronAPI?.vipGetStatus) {
          const vs = await window.electronAPI.vipGetStatus();
          setVipStatusState(vs);
        }
      } catch { /* 静默 */ }
    }

    function setupLogListeners() {
      const listeners = [];
      if (window.electronAPI && window.electronAPI.onLogReset) {
        const offReset = window.electronAPI.onLogReset((payload) => {
          setSource(payload.source);
          setEntries(payload.entries || []);
          setTruncated(!!payload.truncated);
          setNote(undefined);
          // 日志重置（开始抓取/清空/加载文件）时重置自动滚动标志，
          // 确保新日志到来时自动跟随到底部
          autoScrollRef.current = true;
        });
        listeners.push(offReset);
      }
      if (window.electronAPI && window.electronAPI.onLogAppendBatch) {
        const offAppend = window.electronAPI.onLogAppendBatch((batch) => {
          setEntries((prev) => {
            const next = prev.length + batch.length > 50000
              ? prev.slice(Math.max(0, prev.length + batch.length - 50000)).concat(batch)
              : prev.concat(batch);
            return next;
          });
        });
        listeners.push(offAppend);
      }
      logListenersRef.current = listeners;
    }

    // AI 流式事件监听
    function setupAiListeners() {
      const listeners = [];
      if (window.electronAPI && window.electronAPI.onAiStreamStart) {
        const offStart = window.electronAPI.onAiStreamStart(() => {
          setAiAnalyzing(true);
          setAiError('');
          // 重置思考内容（新一轮分析）
          aiReasoningRef.current = '';
          setAiReasoning('');
          setAiReasoningExpanded(true);
        });
        listeners.push(offStart);
      }
      if (window.electronAPI && window.electronAPI.onAiStreamChunk) {
        // 高频节流 + requestAnimationFrame：60ms 间隔刷新，配合 rAF 保证浏览器渲染帧对齐
        let aiFlushTimer = null;
        let aiRafPending = false;
        const offChunk = window.electronAPI.onAiStreamChunk((payload) => {
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
                  // 更新当前轮的 reasoning/content
                  const turns = [...aiTurnsRef.current];
                  const last = turns[turns.length - 1];
                  if (last) {
                    last.reasoning = aiReasoningRef.current;
                    last.content = aiContentRef.current;
                  }
                  aiTurnsRef.current = turns;
                  setAiTurns(turns);
                  setAiContent(aiContentRef.current);
                  setAiReasoning(aiReasoningRef.current);
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
        const offEnd = window.electronAPI.onAiStreamEnd(() => {
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
          setAiContent(aiContentRef.current);
          setAiReasoning(aiReasoningRef.current);
          setAiAnalyzing(false);
          setMapReduceProgress(null);
          if (aiReasoningRef.current) setAiReasoningExpanded(false);
          refreshContextUsage();
        });
        listeners.push(offEnd);
      }
      if (window.electronAPI && window.electronAPI.onAiStreamError) {
        const offErr = window.electronAPI.onAiStreamError((payload) => {
          setAiError(payload.error || '分析失败');
          setAiAnalyzing(false);
          setMapReduceProgress(null);
        });
        listeners.push(offErr);
      }
      if (window.electronAPI && window.electronAPI.onAiMapReduceProgress) {
        const offMr = window.electronAPI.onAiMapReduceProgress((payload) => {
          setMapReduceProgress(payload);
        });
        listeners.push(offMr);
      }
      aiListenersRef.current = listeners;
    }
    setupAiListeners();

    // AI 自动诊断事件监听
    function setupAutoDiagnoseListeners() {
      const listeners = [];
      // 加载初始状态：开启时立即显示"监控中"提示
      if (window.electronAPI && window.electronAPI.autoDiagnoseStatus) {
        window.electronAPI.autoDiagnoseStatus().then(res => {
          if (res?.ok) {
            setAutoDiagnoseEnabled(res.enabled);
            if (res.enabled) {
              // 开启自动诊断时，立即显示"监控中，暂未发现问题"的常驻提示
              setAutoDiagnoseAlert({
                issues: [],
                summary: { total: 0 },
                timestamp: Date.now(),
                monitoring: true
              });
            }
          }
        }).catch(() => {});
      }
      // 监听检测到的问题
      if (window.electronAPI && window.electronAPI.onAutoDiagnose) {
        const offDetected = window.electronAPI.onAutoDiagnose((payload) => {
          console.log('[AutoDiagnose] 收到检测事件:', payload);
          // 追加新问题到现有 alert（而非替换），实现"常显示"
          setAutoDiagnoseAlert((prev) => {
            const prevIssues = (prev && !prev.monitoring) ? prev.issues : [];
            const prevSummary = (prev && !prev.monitoring) ? prev.summary : { total: 0 };
            const mergedIssues = [...prevIssues, ...payload.issues];
            // M7: issues 添加上限 50 个，超过时丢弃最旧的
            if (mergedIssues.length > 50) mergedIssues.splice(0, mergedIssues.length - 50);
            const mergedSummary = { ...prevSummary };
            for (const [k, v] of Object.entries(payload.summary)) {
              mergedSummary[k] = (mergedSummary[k] || 0) + v;
            }
            mergedSummary.total = mergedIssues.length;
            const nextAlert = {
              issues: mergedIssues,
              summary: mergedSummary,
              timestamp: payload.timestamp,
              monitoring: false
            };
            // 缓存最后一次检测到异常的 alert，用于"展开监控"恢复显示
            if (mergedIssues.length > 0) {
              lastAutoDiagnoseAlertRef.current = nextAlert;
            }
            return nextAlert;
          });
        });
        listeners.push(offDetected);
      }
      // 监听扫描完成事件：扫描结束后若无问题且非实时捕获，从"监控中"切换到"扫描完成（无异常）"
      if (window.electronAPI && window.electronAPI.onAutoDiagnoseScanComplete) {
        const offScanComplete = window.electronAPI.onAutoDiagnoseScanComplete((payload) => {
          if (payload.issueCount === 0 && !runningRef.current) {
            setAutoDiagnoseAlert((prev) => {
              // 仅当当前处于"监控中"状态时才切换到 clean，避免覆盖已检测到的问题
              if (prev && prev.monitoring) {
                return {
                  issues: [],
                  summary: { total: 0 },
                  timestamp: Date.now(),
                  monitoring: false
                };
              }
              return prev;
            });
          }
        });
        listeners.push(offScanComplete);
      }
      autoDiagnoseListenersRef.current = listeners;
    }
    setupAutoDiagnoseListeners();

    // 智能日志搜索：监听搜索进度和结果
    function setupSmartSearchListeners() {
      const listeners = [];
      if (window.electronAPI) {
        if (window.electronAPI.onSmartSearchStart) {
          const off = window.electronAPI.onSmartSearchStart((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的事件，防止"停止→重新搜索"时旧事件污染新搜索
            if (payload.sessionId !== searchSessionRef.current) return;
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
            if (payload.sessionId !== searchSessionRef.current) return;
            setSmartSearchProgress(payload);
          });
          listeners.push(off);
        }
        // 增量推送：每完成一个分块就追加匹配条目，用户能看到结果逐步出现
        if (window.electronAPI.onSmartSearchChunk) {
          const off = window.electronAPI.onSmartSearchChunk((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的分块结果，防止旧结果混入新搜索
            if (payload.sessionId !== searchSessionRef.current) return;
            // M6: 增量结果添加上限 5000 条，超过时丢弃最旧的
            setSmartSearchIncremental((prev) => {
              const merged = [...prev, ...payload.entries];
              if (merged.length > 5000) return merged.slice(merged.length - 5000);
              return merged;
            });
          });
          listeners.push(off);
        }
        if (window.electronAPI.onSmartSearchComplete) {
          const off = window.electronAPI.onSmartSearchComplete((payload) => {
            // 会话 ID 过滤：忽略旧搜索会话的完成事件
            // 关键修复：旧搜索被停止后仍会发送 complete 事件，若不过滤会错误地
            // 将 smartSearching 置为 false，中断新搜索，并清空增量结果导致"匹配 0 条"
            if (payload.sessionId !== searchSessionRef.current) return;
            setSmartSearching(false);
            setSmartSearchProgress(null);
            setSmartSearchIncremental([]); // 清空增量列表，使用最终结果
            if (payload.ok && !payload.aborted) {
              setSmartSearchResult(payload);
              const idSet = new Set(payload.matchedEntries.map(e => e.id));
              setSmartSearchMatchedIds(idSet);
              // 搜索完成后同步重新扫描自动诊断，保持与显示区域一致
              rescanAutoDiagnose(payload.matchedEntries, 'search');
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
  }, []);

  async function onStart() {
    // M13: 加载状态
    setLoading(true);
    setNote('启动中…');
    if (window.electronAPI && window.electronAPI.adbStartLog) {
      try {
        // 传递用户选择的缓冲区（默认 ['main']）
        const startArgs = { deviceId: deviceId || undefined };
        if (buffers && buffers.length > 0) {
          startArgs.buffers = buffers;
        }
        const res = await window.electronAPI.adbStartLog(startArgs);
        if (res.ok) {
          setRunning(true);
          setSource('realtime');
          setNote(undefined);
          // 开始抓取时重置自动滚动，确保新日志自动跟随到底部
          autoScrollRef.current = true;
          // 开始抓取时切换到"监控中"状态（实时监控 incoming logs）
          if (autoDiagnoseEnabled) {
            setAutoDiagnoseAlert({
              issues: [],
              summary: { total: 0 },
              timestamp: Date.now(),
              monitoring: true
            });
          }
        } else {
          setNote('启动失败（请确认已安装 adb 且设备已授权）');
        }
      } catch (e) {
        setNote('启动失败: ' + e.message);
      }
    }
    // M13: 加载状态
    setLoading(false);
  }

  async function onStop() {
    if (window.electronAPI && window.electronAPI.adbStopLog) {
      await window.electronAPI.adbStopLog();
    }
    setRunning(false);
    // UX1: 操作反馈，3 秒后自动清除
    setNote('已停止抓取');
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNote(undefined), 3000);
    // 停止抓取后：若当前处于"监控中"（无问题），切换到"扫描完成（无异常）"状态
    // 若已检测到问题，保持问题窗口不变
    if (autoDiagnoseEnabled) {
      setAutoDiagnoseAlert((prev) => {
        if (prev && prev.monitoring) {
          return {
            issues: [],
            summary: { total: 0 },
            timestamp: Date.now(),
            monitoring: false
          };
        }
        return prev;
      });
    }
  }

  async function onOpenFile() {
    // M13: 加载状态
    setLoading(true);
    setRunning(false);
    setNote('读取文件中…');
    if (window.electronAPI && window.electronAPI.logOpenFile) {
      try {
        const res = await window.electronAPI.logOpenFile();
        if (res && res.ok) {
          setSource('file');
          setNote(`已加载：${res.shown?.toLocaleString?.() ?? ''}/${res.total?.toLocaleString?.() ?? ''}`);
          // 文件加载完成：切换到"监控中"（主进程会扫描文件，扫描完成后通过
          // scan-complete 事件自动切换到"扫描完成（无异常）"或"检测到问题"）
          if (autoDiagnoseEnabled) {
            setAutoDiagnoseAlert({
              issues: [],
              summary: { total: 0 },
              timestamp: Date.now(),
              monitoring: true
            });
          }
        } else {
          setNote(undefined);
        }
      } catch (e) {
        setNote('打开文件失败: ' + e.message);
      }
    }
    // M13: 加载状态
    setLoading(false);
  }

  async function onClear() {
    if (window.electronAPI && window.electronAPI.logClear) {
      await window.electronAPI.logClear({ source });
    }
    setEntries([]);
    // UX1: 操作反馈，3 秒后自动清除
    setNote('已清空日志');
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => setNote(undefined), 3000);
    // UX2: 清空日志后同步重置自动诊断状态，避免 toast 残留旧诊断结果
    setAutoDiagnoseAlert(null);
    // 清空日志时清除缓存的异常 alert，避免"展开监控"恢复已失效的旧诊断
    lastAutoDiagnoseAlertRef.current = null;
  }

  function formatEntry(e) {
    const ts = new Date(e.ts);
    const mm = String(ts.getMonth() + 1).padStart(2, '0');
    const dd = String(ts.getDate()).padStart(2, '0');
    const hh = String(ts.getHours()).padStart(2, '0');
    const mi = String(ts.getMinutes()).padStart(2, '0');
    const ss = String(ts.getSeconds()).padStart(2, '0');
    const ms = String(ts.getMilliseconds()).padStart(3, '0');
    const lvl = e.level ?? 'V';
    const pid = e.pid ?? 0;
    const tid = e.tid ?? pid;
    const tag = e.tag ?? '';
    const msg = e.message ?? e.raw;
    const pkgMeta = e.pkg ? ` [pkg:${e.pkg}]` : '';
    return `${mm}-${dd} ${hh}:${mi}:${ss}.${ms} ${pid} ${tid} ${lvl} ${tag}: ${msg}${pkgMeta}`;
  }

  async function onExport() {
    // M9: 分批处理避免大日志同步格式化卡顿，每 5000 条 yield 一次让出主线程
    setExporting(true);
    try {
      const total = filtered.length;
      const parts = [];
      const BATCH = 5000;
      for (let i = 0; i < total; i += BATCH) {
        const slice = filtered.slice(i, i + BATCH);
        parts.push(slice.map((e) => formatEntry(e)).join('\n'));
        // 每 5000 条 yield 一次，让出主线程避免卡顿
        if (i + BATCH < total) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      const lines = parts.join('\n');
      if (window.electronAPI && window.electronAPI.logExportToFile) {
        const res = await window.electronAPI.logExportToFile({ content: lines, defaultName: `log_export_${source}.txt` });
        if (res.ok) {
          setNote(`已导出 ${total.toLocaleString()} 条日志`);
        }
      }
    } finally {
      setExporting(false);
    }
  }

  async function onCopyAll() {
    const lines = filtered.map((e) => formatEntry(e)).join('\n');
    await navigator.clipboard.writeText(lines);
    setNote(`已复制 ${filtered.length.toLocaleString()} 条日志到剪贴板`);
  }

  async function onToggleMcp() {
    if (!isVip) {
      setNote('MCP 服务为会员专属功能，请在会员中心开通');
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

  // AI 日志分析
  async function onAiAnalyze() {
    if (filtered.length === 0) {
      setNoteType('error');
      setNote('请先抓取或加载日志，再使用 AI 分析');
      return;
    }

    // 如果正在分析，先停止前一次（防止流式监听冲突导致卡死）
    if (aiAnalyzing) {
      if (window.electronAPI && window.electronAPI.aiStopAnalyze) {
        await window.electronAPI.aiStopAnalyze();
      }
      setAiAnalyzing(false);
    }

    setAiPanelOpen(true);
    setAiAnalyzing(true);
    setAiError('');
    setMapReduceProgress(null);

    // 创建本轮对话 turn
    const turnHeader = `[${new Date().toLocaleTimeString('zh-CN')}] ${aiCustomPrompt.trim() ? '追问' : '分析'}${aiCustomPrompt.trim() ? `：${aiCustomPrompt.trim()}` : ''}`;
    const currentTurn = {
      header: turnHeader,
      reasoning: '',
      content: '',
      reasoningExpanded: true
    };
    aiTurnsRef.current = [...aiTurnsRef.current, currentTurn];
    aiContentRef.current = ''; // 当前轮 content
    aiReasoningRef.current = ''; // 当前轮 reasoning
    setAiTurns([...aiTurnsRef.current]);
    setAiContent('');
    setAiReasoning('');
    setAiReasoningExpanded(true);

    const lines = filtered.map((e) => formatEntry(e));
    const filterContext = { ...deferredFilter };

    // 计算日志指纹：用行数 + 前 100 行 + 后 100 行的 hash 判断日志是否变化
    const logFingerprint = `${lines.length}:${lines.slice(0, 100).join('').length}:${lines.slice(-100).join('').length}`;
    const logChanged = aiLastLogHashRef.current !== logFingerprint;
    aiLastLogHashRef.current = logFingerprint;

    try {
      const res = await window.electronAPI.aiAnalyzeLog({
        lines,
        filterContext,
        customPrompt: aiCustomPrompt.trim() || undefined,
        logChanged,
        thinkingMode: aiThinkingMode
      });
      if (!res.ok) {
        setAiError(res.error || '启动分析失败');
        setAiAnalyzing(false);
      }
    } catch (e) {
      setAiError(e.message);
      setAiAnalyzing(false);
    }
  }

  async function onAiStop() {
    if (window.electronAPI && window.electronAPI.aiStopAnalyze) {
      await window.electronAPI.aiStopAnalyze();
    }
    setAiAnalyzing(false);
    setMapReduceProgress(null);
  }

  async function onAiClear() {
    aiContentRef.current = '';
    aiReasoningRef.current = '';
    aiTurnsRef.current = [];
    setAiContent('');
    setAiReasoning('');
    setAiTurns([]);
    setAiError('');
    aiLastLogHashRef.current = '';
    // 清空主进程对话上下文
    if (window.electronAPI && window.electronAPI.aiClearConversation) {
      await window.electronAPI.aiClearConversation();
    }
    refreshContextUsage();
  }

  async function refreshContextUsage() {
    if (window.electronAPI && window.electronAPI.aiGetContextUsage) {
      try {
        const res = await window.electronAPI.aiGetContextUsage();
        if (res?.ok) setContextUsage(res);
      } catch {}
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
        content: `# AI 日志助手分析报告\n\n生成时间：${now.toLocaleString('zh-CN')}\n\n---\n\n${fullContent}`,
        defaultName: `ai_analysis_${dateStr}.md`
      });
      if (res.ok) {
        setNote('AI 分析结果已导出');
      }
    }
  }

  // AI 自动诊断处理
  async function onAutoDiagnoseConfirm() {
    if (!autoDiagnoseAlert) return;
    // 打开 AI 面板准备接收流式输出
    setAiPanelOpen(true);
    setAiAnalyzing(true);
    setAiError('');

    // 多轮对话分隔
    if (aiContentRef.current) {
      const codeBlockCount = (aiContentRef.current.match(/```/g) || []).length;
      if (codeBlockCount % 2 !== 0) {
        aiContentRef.current += '\n```\n';
      }
    }
    const turnHeader = `\n\n---\n\n**[${new Date().toLocaleTimeString('zh-CN')}] 自动诊断**：检测到 ${autoDiagnoseAlert.summary.total} 个问题\n\n`;
    if (aiContentRef.current) {
      aiContentRef.current += turnHeader;
    } else {
      aiContentRef.current = turnHeader.startsWith('\n\n') ? turnHeader.slice(2) : turnHeader;
    }
    setAiContent(aiContentRef.current);

    try {
      const res = await window.electronAPI.autoDiagnoseAnalyze({
        issues: autoDiagnoseAlert.issues,
        summary: autoDiagnoseAlert.summary
      });
      if (!res.ok) {
        setAiError(res.error || '自动诊断分析失败');
        setAiAnalyzing(false);
      }
    } catch (e) {
      setAiError(e.message);
      setAiAnalyzing(false);
    }
    // 分析启动后，保持弹窗显示（不关闭，不重置），用户可继续查看问题或点击忽略
  }

  function onAutoDiagnoseDismiss() {
    // 点击"隐藏"/"忽略"/X 后，仅隐藏窗口（可通过顶部"展开监控"按钮恢复）
    setAutoDiagnoseAlert(null);
  }

  async function onToggleAutoDiagnose() {
    const newEnabled = !autoDiagnoseEnabled;
    setAutoDiagnoseEnabled(newEnabled);
    if (window.electronAPI && window.electronAPI.autoDiagnoseToggle) {
      await window.electronAPI.autoDiagnoseToggle(newEnabled);
    }
    if (newEnabled) {
      // 开启时：先显示"监控中"（主进程会重新扫描已有日志，检测到问题后会自动替换）
      setAutoDiagnoseAlert({
        issues: [],
        summary: { total: 0 },
        timestamp: Date.now(),
        monitoring: true
      });
    } else {
      // 关闭时清除提示和缓存的异常 alert
      setAutoDiagnoseAlert(null);
      lastAutoDiagnoseAlertRef.current = null;
    }
  }

  // 智能日志搜索：发起搜索 / 中止搜索 / 清除结果
  async function onSmartSearch() {
    if (!smartSearchQuery.trim()) return;
    if (entries.length === 0) {
      setNote('请先抓取或加载日志，再使用智能搜索');
      return;
    }
    if (window.electronAPI && window.electronAPI.smartSearch) {
      // 递增会话 ID，使旧搜索会话的事件失效
      searchSessionRef.current += 1;
      setSmartSearching(true);
      setSmartSearchProgress({ completed: 0, total: 0, matchedCount: 0 });
      setSmartSearchResult(null);
      setSmartSearchMatchedIds(new Set());
      setSmartSearchIncremental([]);
      // 点击搜索时立即重置自动诊断为"监控中"状态，不等搜索完成
      // 搜索完成后会通过 onSmartSearchComplete 用搜索结果重新扫描
      if (autoDiagnoseEnabled) {
        setAutoDiagnoseAlert({
          issues: [],
          summary: { total: 0 },
          timestamp: Date.now(),
          monitoring: true
        });
      }
      try {
        await window.electronAPI.smartSearch({ query: smartSearchQuery.trim(), source });
      } catch (e) {
        setSmartSearching(false);
        setSmartSearchProgress(null);
        setNote('智能搜索失败：' + (e.message || '未知错误'));
        // 搜索失败，显示区域回到原日志，重新扫描恢复诊断
        rescanAutoDiagnose(null, source);
      }
    }
  }

  async function onSmartSearchStop() {
    if (window.electronAPI && window.electronAPI.smartSearchStop) {
      await window.electronAPI.smartSearchStop();
    }
    setSmartSearching(false);
    setSmartSearchProgress(null);
    // 搜索中止后显示区域返回原日志，同步重新扫描自动诊断
    rescanAutoDiagnose(null, source);
  }

  // 日志显示区域变更时重新扫描自动诊断（搜索完成 / 返回原日志）
  // entriesToScan: 要扫描的条目数组；为 null 时主进程使用 logStore
  // logSource: 日志源标识（'search' | 'realtime' | 'file'）
  async function rescanAutoDiagnose(entriesToScan, logSource) {
    if (!window.electronAPI || !window.electronAPI.autoDiagnoseRescan) return;
    try {
      const res = await window.electronAPI.autoDiagnoseRescan({
        entries: entriesToScan,
        source: logSource
      });
      if (res?.ok) {
        // 主进程已开始扫描，重置 UI 到 "监控中" 状态
        // 检测到问题后会通过 onAutoDiagnose 事件自动替换
        setAutoDiagnoseAlert({
          issues: [],
          summary: { total: 0 },
          timestamp: Date.now(),
          monitoring: true
        });
      }
    } catch (e) {
      console.error('[AutoDiagnose] 重新扫描请求失败:', e.message);
    }
  }

  function onSmartSearchClear() {
    // 退出搜索模式，返回原日志列表
    setSmartSearchResult(null);
    setSmartSearchMatchedIds(new Set());
    // 返回原日志时同步重新扫描自动诊断，保持与显示区域一致
    rescanAutoDiagnose(null, source);
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
      const newHeight = Math.max(150, Math.min(window.innerHeight - 80, startHeight + delta));
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

  const isDark = t.primary === 'tech' || t.primary === 'cyan' || t.primary === 'blue';

  return (
    <div className={`flex flex-col h-full ${isDark ? 'bg-[#202124]' : 'bg-slate-50'}`}>
      {/* Top Bar - 两行布局：第一行核心抓取，第二行分析/搜索 */}
      <div className={`flex flex-col gap-2 px-4 py-2.5 border-b ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
        {/* 第一行：标题 + 设备 + 缓冲区 + 抓取控制 + 加载文件 + 统计 */}
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 mr-2">
            <Terminal size={18} className={isDark ? 'text-cyan-400' : 'text-emerald-500'} />
            <div>
              <div className={`text-sm font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>Android Log Analyzer</div>
              <div className={`text-xs ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>实时抓取 ADB Logcat · 文件加载 · MCP 服务</div>
            </div>
          </div>

          <button
            onClick={async () => {
              if (window.electronAPI && window.electronAPI.adbListDevices) {
                try {
                  const ds = await window.electronAPI.adbListDevices();
                  setDevices(ds.map((d) => ({
                    id: d.id,
                    label: `${d.id}${d.model ? ` (${d.model})` : ''}`
                  })));
                } catch (e) {
                  console.error('Failed to list devices:', e);
                }
              }
            }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-all ${isDark ? 'border-slate-500 hover:bg-[#3E4145] text-[#E8EAED] active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-700 active:scale-95 shadow-sm'}`}
            title="刷新设备列表"
          >
            <RefreshCw size={14} />
          </button>

          {devices.length === 0 && !running ? (
            <span className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-600 border border-red-200'}`}>
              无设备连接
            </span>
          ) : (
            // 设备选择自定义下拉（替代原生 select，风格与缓冲区下拉一致）
            <div className="relative" ref={deviceDropdownRef}>
              <button
                onClick={() => setDeviceDropdownOpen((v) => !v)}
                disabled={running}
                className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-all disabled:opacity-50 ${deviceDropdownOpen ? (isDark ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400' : 'border-cyan-400 bg-cyan-50 text-cyan-600') : (isDark ? 'border-slate-500 hover:bg-[#3E4145] text-[#E8EAED] active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-700 active:scale-95 shadow-sm')}`}
                title={running ? '抓取中无法切换设备' : '选择 ADB 设备'}
              >
                <Smartphone size={14} />
                <span className="max-w-[140px] truncate">
                  {deviceId ? (devices.find((d) => d.id === deviceId)?.label || '默认设备') : '默认设备'}
                </span>
                <ChevronDown size={12} className={deviceDropdownOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
              </button>
              {deviceDropdownOpen && (
                <div className={`absolute top-full left-0 mt-1 w-56 rounded-lg border shadow-xl z-50 overflow-hidden ${isDark ? 'bg-[#2D2F33] border-[#5F6368]' : 'bg-white border-slate-200'}`}>
                  <button
                    onClick={() => { setDeviceId(''); setDeviceDropdownOpen(false); }}
                    className={`flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors ${!deviceId ? (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-700') : (isDark ? 'hover:bg-[#3E4145] text-[#E8EAED]' : 'hover:bg-slate-50 text-slate-700')}`}
                  >
                    <Smartphone size={14} className="shrink-0 opacity-60" />
                    <span className="flex-1">默认设备</span>
                    {!deviceId && <CheckCircle size={12} className="text-cyan-400" />}
                  </button>
                  {devices.map((d) => (
                    <button
                      key={d.id}
                      onClick={() => { setDeviceId(d.id); setDeviceDropdownOpen(false); }}
                      className={`flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors ${deviceId === d.id ? (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-700') : (isDark ? 'hover:bg-[#3E4145] text-[#E8EAED]' : 'hover:bg-slate-50 text-slate-700')}`}
                    >
                      <Smartphone size={14} className="shrink-0 opacity-60" />
                      <span className="flex-1 truncate">{d.label}</span>
                      {deviceId === d.id && <CheckCircle size={12} className="text-cyan-400" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 日志缓冲区多选下拉：默认 main，可选 system/radio/events/crash/kernel */}
          <div className="relative" ref={bufferDropdownRef}>
            <button
              onClick={() => setBufferDropdownOpen((v) => !v)}
              disabled={running}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-all disabled:opacity-50 ${bufferDropdownOpen ? (isDark ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400' : 'border-cyan-400 bg-cyan-50 text-cyan-600') : (isDark ? 'border-slate-500 hover:bg-[#3E4145] text-[#E8EAED] active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-700 active:scale-95 shadow-sm')}`}
              title={running ? '抓取中无法切换缓冲区' : '选择要抓取的日志缓冲区'}
            >
              <Layers size={14} />
              <span>日志类型</span>
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${isDark ? 'bg-[#3E4145] text-cyan-400' : 'bg-slate-100 text-cyan-600'}`}>
                {buffers.length}
              </span>
              <ChevronDown size={12} className={bufferDropdownOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
            </button>
            {bufferDropdownOpen && (
              <div className={`absolute top-full left-0 mt-1 w-72 rounded-xl border shadow-xl z-50 ${isDark ? 'bg-[#2D2F33] border-[#5F6368]' : 'bg-white border-slate-200'}`}>
                <div className={`px-3 py-2 text-xs font-semibold border-b ${isDark ? 'text-[#E8EAED] border-[#3E4145]' : 'text-slate-700 border-slate-100'}`}>
                  选择日志类型（可多选）
                </div>
                <div className="max-h-72 overflow-y-auto py-1">
                  {LOG_BUFFERS.map((b) => {
                    const checked = buffers.includes(b.id);
                    return (
                      <button
                        key={b.id}
                        onClick={() => {
                          setBuffers((prev) => {
                            if (prev.includes(b.id)) {
                              // 至少保留一个
                              if (prev.length === 1) return prev;
                              return prev.filter((x) => x !== b.id);
                            }
                            return [...prev, b.id];
                          });
                        }}
                        className={`w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors ${isDark ? 'hover:bg-slate-700/60' : 'hover:bg-slate-50'}`}
                      >
                        <span className={`mt-0.5 flex-shrink-0 w-4 h-4 rounded border flex items-center justify-center ${checked ? (isDark ? 'bg-cyan-500 border-cyan-500' : 'bg-cyan-500 border-cyan-500') : (isDark ? 'border-slate-500' : 'border-slate-300')}`}>
                          {checked && <CheckCircle size={12} className="text-white" />}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className={`text-xs font-medium ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>{b.label} <span className={`font-mono ${isDark ? 'text-slate-500' : 'text-slate-400'}`}>({b.id})</span></div>
                          <div className={`text-[11px] mt-0.5 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>{b.desc}</div>
                        </div>
                      </button>
                    );
                  })}
                </div>
                <div className={`px-3 py-2 border-t flex items-center justify-between ${isDark ? 'border-[#3E4145]' : 'border-slate-100'}`}>
                  <span className={`text-[11px] ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>已选 {buffers.length} 个</span>
                  <button
                    onClick={() => setBuffers(['main'])}
                    className={`text-[11px] px-2 py-0.5 rounded ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`}
                  >
                    重置为默认
                  </button>
                </div>
              </div>
            )}
          </div>

          {!running ? (
            <button
              onClick={onStart}
              // M13: 加载中禁用
              disabled={(devices.length === 0 && !running) || loading}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg transition-all disabled:opacity-50 active:scale-95 shadow-sm ${t.button.primary}`}
            >
              <Play size={14} />
              开始抓取
            </button>
          ) : (
            <button
              onClick={onStop}
              // M13: 加载中禁用
              disabled={loading}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all disabled:opacity-50 active:scale-95 shadow-sm"
            >
              <Square size={14} />
              停止抓取
            </button>
          )}

          <button
            onClick={onOpenFile}
            // M13: 加载中禁用
            disabled={loading}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 ${isDark ? 'border-slate-500 hover:bg-[#3E4145] text-[#E8EAED] active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-700 active:scale-95 shadow-sm'}`}
            title="打开 .log 日志文件"
          >
            <FolderOpen size={16} />
          </button>

          {/* 次要操作按钮：导出 / 复制 / 清空（清空为红色警示），紧跟打开日志文件按钮右侧 */}
          <button
            onClick={onExport}
            disabled={filtered.length === 0 || exporting}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 ${isDark ? 'border-slate-500 hover:bg-[#3E4145] text-[#E8EAED] active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-700 active:scale-95 shadow-sm'}`}
            title="导出日志到文件"
          >
            <Download size={14} />
          </button>

          <button
            onClick={onCopyAll}
            disabled={filtered.length === 0}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors disabled:opacity-50 ${isDark ? 'border-slate-500 hover:bg-[#3E4145] text-[#E8EAED] active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-700 active:scale-95 shadow-sm'}`}
            title="复制全部日志到剪贴板"
          >
            <Copy size={14} />
          </button>

          <button
            onClick={onClear}
            disabled={filtered.length === 0 || loading}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-all disabled:opacity-50 ${isDark ? 'border-slate-500 hover:bg-red-500/20 text-red-400 active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-red-50 text-red-600 active:scale-95 shadow-sm'}`}
            title="清空当前日志"
          >
            <Trash2 size={14} />
          </button>

          <div className="flex-1" />

          <div className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-[#3E4145] text-[#E8EAED]' : 'bg-slate-100 text-slate-600'}`}>
            {filtered.length.toLocaleString()} 条
          </div>

          <div className={`text-xs px-2 py-1 rounded-full ${isDark ? 'bg-[#3E4145] text-[#E8EAED]' : 'bg-slate-100 text-slate-600'}`}>
            Source: {source === 'realtime' ? '实时抓取' : source === 'file' ? '日志文件' : source}
          </div>
        </div>

        {/* 第二行：智能搜索 + AI 分析 + 自动诊断 + MCP + 更多菜单 */}
        <div className="flex items-center gap-4 flex-wrap">
          {/* 智能日志搜索（会员专属，非会员隐藏） */}
          {isVip ? (
          <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg border ${isDark ? 'border-violet-500/30 bg-violet-500/10' : 'border-violet-300 bg-violet-50'}`}>
            <Brain size={14} className={isDark ? 'text-violet-400' : 'text-violet-600'} />
            <input
              type="text"
              value={smartSearchQuery}
              onChange={(e) => setSmartSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !smartSearching) {
                  e.preventDefault();
                  onSmartSearch();
                }
              }}
              placeholder="自然语言搜索日志，如「所有内存相关的错误」"
              className={`w-70 bg-transparent text-xs outline-none placeholder:text-[#9AA0A6] ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}
              disabled={smartSearching}
            />
            {/* 清除查询按钮（在搜索按钮左边） */}
            {smartSearchQuery && !smartSearching && (
              <button
                onClick={() => setSmartSearchQuery('')}
                className={`px-1.5 py-0.5 text-xs rounded transition-colors ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-200'}`}
                title="清空查询"
              >
                <X size={12} />
              </button>
            )}
            {smartSearching ? (
              <button
                onClick={onSmartSearchStop}
                className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                title="中止搜索"
              >
                <StopCircle size={12} />
                中止
              </button>
            ) : (
              <button
                onClick={onSmartSearch}
                disabled={!smartSearchQuery.trim() || entries.length === 0}
                className={`flex items-center gap-1 px-2 py-0.5 text-xs rounded transition-colors ${(smartSearchQuery.trim() && entries.length > 0) ? (isDark ? 'bg-violet-500/20 text-violet-400 hover:bg-violet-500/30' : 'bg-violet-200 text-violet-700 hover:bg-violet-300') : (isDark ? 'bg-[#3E4145] text-[#9AA0A6] cursor-not-allowed' : 'bg-slate-200 text-slate-400 cursor-not-allowed')}`}
                title="开始智能搜索 (Enter)"
              >
                <Search size={12} />
                搜索
              </button>
            )}
          </div>
          ) : null}

          {/* 搜索进度 */}
          {smartSearching && smartSearchProgress && (
            <div className={`flex items-center gap-1.5 text-xs ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>
              <Loader2 size={12} className="animate-spin" />
              {smartSearchProgress.completed}/{smartSearchProgress.total} 块，匹配 {smartSearchProgress.matchedCount} 条
            </div>
          )}

          {/* 搜索结果模式：显示返回按钮 */}
          {smartSearchResult && !smartSearching && (
            <button
              onClick={onSmartSearchClear}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${isDark ? 'border-violet-500/40 bg-violet-500/10 text-violet-400 hover:bg-violet-500/20' : 'border-violet-400 bg-violet-50 text-violet-600 hover:bg-violet-100'}`}
              title="退出搜索，返回原日志列表"
            >
              <RefreshCw size={14} />
              返回原日志（{smartSearchResult.matchedCount} 条）
            </button>
          )}

          {/* AI 分析按钮 */}
          <button
            onClick={() => {
              if (!isVip) { showVipBlock('AI 深度分析'); return; }
              if (filtered.length === 0) {
                setNoteType('error');
                setNote('请先抓取或加载日志，再使用 AI 分析');
                return;
              }
              setAiPanelOpen(!aiPanelOpen);
            }}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${aiPanelOpen ? 'bg-purple-500/20 border-purple-500/30 text-purple-400' : isDark ? 'border-slate-500 hover:bg-[#3E4145] text-cyan-400 active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-emerald-600 active:scale-95 shadow-sm'}`}
            title="使用 AI 分析当前过滤后的日志"
          >
            <Sparkles size={14} />
            AI 分析
          </button>

          {/* AI 自动诊断开关 */}
          <button
            onClick={onToggleAutoDiagnose}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${autoDiagnoseEnabled ? 'bg-amber-500/20 border-amber-500/30 text-amber-400' : isDark ? 'border-slate-500 hover:bg-[#3E4145] text-slate-500 active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-400 active:scale-95 shadow-sm'}`}
            title={autoDiagnoseEnabled ? '自动诊断已开启：实时检测崩溃/ANR/OOM 等问题' : '自动诊断已关闭'}
          >
            {autoDiagnoseEnabled ? <Zap size={14} /> : <ShieldCheck size={14} />}
            自动诊断: {autoDiagnoseEnabled ? 'ON' : 'OFF'}
          </button>

          {/* 日志诊断规则库入口 */}
          <button
            onClick={() => setRuleLibraryOpen(true)}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${ruleLibraryOpen ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : isDark ? 'border-slate-500 hover:bg-[#3E4145] text-slate-400 active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-500 active:scale-95 shadow-sm'}`}
            title="诊断规则库"
          >
            <Layers size={14} />
            规则库
          </button>

          {/* 自动诊断已开启但监控窗口被隐藏时，显示"展开监控"按钮 */}
          {autoDiagnoseEnabled && !autoDiagnoseAlert && (
            <button
              // 恢复监控窗口：优先恢复缓存的异常诊断；无缓存时显示"监控中"/"扫描完成（无异常）"
              onClick={() => {
                if (lastAutoDiagnoseAlertRef.current) {
                  // 恢复之前检测到的异常（保留原始 timestamp 以便用户识别）
                  setAutoDiagnoseAlert(lastAutoDiagnoseAlertRef.current);
                } else {
                  setAutoDiagnoseAlert({
                    issues: [],
                    summary: { total: 0 },
                    timestamp: Date.now(),
                    monitoring: running
                  });
                }
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-colors ${isDark ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20' : 'border-emerald-400 bg-emerald-50 text-emerald-600 hover:bg-emerald-100'}`}
              title="展开自动诊断监控窗口"
            >
              <AlertTriangle size={14} />
              展开监控
            </button>
          )}

          {/* 状态提示：读取文件中 / 已停止抓取 等，紧跟自动诊断右侧 */}
          {note && (
            <div className={`text-xs px-2 py-1 rounded-full whitespace-nowrap ${noteType === 'error' ? (isDark ? 'bg-red-500/10 text-red-400 border border-red-500/20' : 'bg-red-50 text-red-600 border border-red-200') : (isDark ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20' : 'bg-blue-50 text-blue-600 border border-blue-200')}`}>
              {note}
            </div>
          )}

          <div className="flex-1" />

          {isVip ? (<>
          <button
            onClick={() => setMcpHelpVisible(true)}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-all ${isDark ? 'border-slate-500 hover:bg-[#3E4145] text-slate-400 active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-500 active:scale-95 shadow-sm'}`}
            title="查看 MCP 使用说明"
          >
            <HelpCircle size={14} />
          </button>

          <button
            onClick={onToggleMcp}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border transition-all ${mcpRunning ? 'bg-emerald-500/20 border-emerald-500/30 text-emerald-400' : isDark ? 'border-slate-500 hover:bg-[#3E4145] text-slate-400 active:scale-95 shadow-sm' : 'border-slate-300 hover:bg-slate-100 text-slate-500 active:scale-95 shadow-sm'}`}
            title={mcpRunning ? '点击关闭 MCP 服务' : '点击开启 MCP 服务'}
          >
            <Radio size={14} />
            MCP: {mcpRunning ? 'ON' : 'OFF'}
          </button>
          </>) : null}
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Filter & Stats */}
        <div className={`w-80 flex flex-col gap-4 p-4 overflow-y-auto border-r ${isDark ? 'bg-[#202124]/50 border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
          {/* Filter Panel */}
          <div className={`rounded-xl border p-4 ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <Filter size={16} className={isDark ? 'text-cyan-400' : 'text-emerald-500'} />
                <span className={`text-sm font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>过滤</span>
              </div>
              <button
                onClick={() => {
                  setFilter(emptyFilter);
                  // M8: 同步重置本地输入状态
                  setFilterTextInput('');
                  if (filterDebounceRef.current) {
                    clearTimeout(filterDebounceRef.current);
                    filterDebounceRef.current = null;
                  }
                }}
                className={`text-xs px-2 py-1 rounded transition-colors ${isDark ? 'text-[#9AA0A6] hover:text-[#E8EAED] hover:bg-[#3E4145]' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
              >
                重置
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>关键字</label>
                <input
                  type="text"
                  value={filterTextInput}
                  placeholder="包含文本"
                  onChange={(e) => {
                    // M8: 本地状态立即更新保持输入响应，setFilter 防抖 300ms
                    const val = e.target.value;
                    setFilterTextInput(val);
                    clearTimeout(filterDebounceRef.current);
                    filterDebounceRef.current = setTimeout(() => {
                      setFilter((prev) => ({ ...prev, text: val || undefined }));
                    }, 300);
                  }}
                  className={`w-full text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                />
              </div>

              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>排除</label>
                <input
                  type="text"
                  value={filter.excludeText ?? ''}
                  placeholder="排除文本"
                  onChange={(e) => setFilter({ ...filter, excludeText: e.target.value || undefined })}
                  className={`w-full text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                />
              </div>

              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>正则</label>
                <input
                  type="text"
                  value={filter.regex ?? ''}
                  placeholder="例如: (ActivityManager|WindowManager)"
                  onChange={(e) => setFilter({ ...filter, regex: e.target.value || undefined })}
                  className={`w-full text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                />
              </div>

              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>包名</label>
                <input
                  type="text"
                  value={filter.pkg ?? ''}
                  placeholder="例如: com.example.app"
                  onChange={(e) => setFilter({ ...filter, pkg: e.target.value || undefined })}
                  className={`w-full text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                />
              </div>

              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>Tag</label>
                <input
                  type="text"
                  value={filter.tag ?? ''}
                  placeholder="例如: ActivityTaskManager"
                  onChange={(e) => setFilter({ ...filter, tag: e.target.value || undefined })}
                  className={`w-full text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                />
              </div>

              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>PID</label>
                <input
                  type="text"
                  value={typeof filter.pid === 'number' ? String(filter.pid) : ''}
                  placeholder="例如: 12345"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    const pid = raw ? Number(raw) : undefined;
                    setFilter({ ...filter, pid: Number.isFinite(pid) ? pid : undefined });
                  }}
                  className={`w-full text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-emerald-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-slate-50 border-slate-200 text-slate-700'}`}
                />
              </div>

              <div>
                <label className={`block text-xs mb-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>最小级别</label>
                {/* 自定义下拉框，参考设备/缓冲区下拉风格，带级别颜色 */}
                <div className="relative" ref={levelDropdownRef}>
                  <button
                    onClick={() => setLevelDropdownOpen((v) => !v)}
                    className={`flex items-center justify-between w-full px-3 py-2 text-xs rounded-lg border transition-all ${levelDropdownOpen ? (isDark ? 'border-cyan-500/50 bg-cyan-500/10 text-cyan-400' : 'border-cyan-400 bg-cyan-50 text-cyan-600') : (isDark ? 'border-[#5F6368] hover:border-[#9AA0A6] bg-[#3E4145] text-[#E8EAED]' : 'border-slate-200 hover:border-slate-400 bg-slate-50 text-slate-700')}`}
                  >
                    <span className="flex items-center gap-1.5">
                      {filter.minLevel ? (
                        <>
                          <span className={`inline-block w-2 h-2 rounded-full ${levelColorDot(filter.minLevel)}`} />
                          <span className="font-mono font-bold">{filter.minLevel}</span>
                          <span className={isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}>{levels.find(l => l.v === filter.minLevel)?.label}</span>
                        </>
                      ) : (
                        <span>不过滤</span>
                      )}
                    </span>
                    <ChevronDown size={12} className={levelDropdownOpen ? 'rotate-180 transition-transform' : 'transition-transform'} />
                  </button>
                  {levelDropdownOpen && (
                    <div className={`absolute top-full left-0 mt-1 w-full rounded-lg border shadow-xl z-50 overflow-hidden ${isDark ? 'bg-[#2D2F33] border-[#5F6368]' : 'bg-white border-slate-200'}`}>
                      <button
                        onClick={() => { setFilter({ ...filter, minLevel: undefined }); setLevelDropdownOpen(false); }}
                        className={`flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors ${!filter.minLevel ? (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-700') : (isDark ? 'hover:bg-[#3E4145] text-[#E8EAED]' : 'hover:bg-slate-50 text-slate-700')}`}
                      >
                        <span className="inline-block w-2 h-2 rounded-full bg-slate-400" />
                        <span className="flex-1">不过滤</span>
                        {!filter.minLevel && <CheckCircle size={12} className="text-cyan-400" />}
                      </button>
                      {levels.map((l) => (
                        <button
                          key={l.v}
                          onClick={() => { setFilter({ ...filter, minLevel: l.v }); setLevelDropdownOpen(false); }}
                          className={`flex items-center gap-2 w-full px-3 py-2 text-xs text-left transition-colors ${filter.minLevel === l.v ? (isDark ? 'bg-cyan-500/20 text-cyan-300' : 'bg-cyan-50 text-cyan-700') : (isDark ? 'hover:bg-[#3E4145] text-[#E8EAED]' : 'hover:bg-slate-50 text-slate-700')}`}
                        >
                          <span className={`inline-block w-2 h-2 rounded-full ${levelColorDot(l.v)}`} />
                          <span className="font-mono font-bold w-4">{l.v}</span>
                          <span className={`flex-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>{l.label}</span>
                          {filter.minLevel === l.v && <CheckCircle size={12} className="text-cyan-400" />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className={`text-xs ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                当前窗口总计：{entries.length.toLocaleString()}，过滤后：{filtered.length.toLocaleString()}
                {truncated ? '（仅显示末尾 50k 条）' : ''}
              </div>
            </div>
          </div>

          {/* Stats Panel */}
          <div className={`rounded-xl border p-4 ${isDark ? 'bg-[#2D2F33] border-[#3E4145]' : 'bg-white border-slate-200'}`}>
            <div className="flex items-center gap-2 mb-3">
              <BarChart3 size={16} className={isDark ? 'text-cyan-400' : 'text-emerald-500'} />
              <span className={`text-sm font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>统计</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {Object.entries(counts).map(([level, count]) => (
                <div key={level} className={`text-xs px-2 py-1 rounded-lg border ${levelBgColors[level] || ''}`}>
                  <span className={levelColors[level] || ''}>{level}</span>
                  <span className={`ml-1 ${isDark ? 'text-[#E8EAED]' : 'text-slate-600'}`}>{count}</span>
                </div>
              ))}
            </div>
            <div className={`text-xs mt-3 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
              提示：双击日志行复制整行，也可用鼠标选中文本复制。
            </div>
          </div>
        </div>

        {/* Right Panel - Log Viewer */}
        <div className={`flex-1 flex flex-col ${isDark ? 'bg-[#202124]' : 'bg-white'}`}>
          <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
            <span className={`text-sm font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
              {smartSearching && smartSearchIncremental.length > 0
                ? <span className="flex items-center gap-2">
                    <Loader2 size={14} className="text-violet-500 animate-spin" />
                    搜索中…已匹配 {smartSearchIncremental.length} 条
                  </span>
                : (smartSearchResult && !smartSearching
                  ? <span className="flex items-center gap-2">
                      <Brain size={14} className="text-violet-500" />
                      搜索结果："{smartSearchResult.query}"（{smartSearchResult.matchedCount} 条）
                    </span>
                  : (source === 'realtime' ? '实时日志' : '文件日志'))
              }
            </span>
            <span className={`text-xs ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
              双击一行即可复制 · 悬停可查看完整消息 · 拖拽列边界调整宽度
            </span>
          </div>

          <div
            className={`flex items-center px-4 py-1.5 border-b text-xs font-bold ${isDark ? 'bg-[#2A2C2F] border-[#3E4145] text-[#9AA0A6]' : 'bg-slate-50 border-slate-200 text-slate-500'}`}
            style={{ display: 'grid', gridTemplateColumns: `${colWidths.ts}px ${colWidths.level}px ${colWidths.pkg}px ${colWidths.tag}px 1fr`, gap: '8px' }}
          >
            <span className="relative">时间
              <span
                onMouseDown={(e) => onColResizeStart(e, 'ts')}
                className={`absolute top-1/2 -right-1 -translate-y-1/2 w-1.5 h-4 cursor-col-resize rounded ${isDark ? 'hover:bg-cyan-500/50' : 'hover:bg-cyan-500/40'}`}
                title="拖拽调整时间列宽度"
              />
            </span>
            <span className="text-center">级别</span>
            <span className="relative truncate">包名
              <span
                onMouseDown={(e) => onColResizeStart(e, 'pkg')}
                className={`absolute top-1/2 -right-1 -translate-y-1/2 w-1.5 h-4 cursor-col-resize rounded ${isDark ? 'hover:bg-cyan-500/50' : 'hover:bg-cyan-500/40'}`}
                title="拖拽调整包名列宽度"
              />
            </span>
            <span className="relative truncate">Tag
              <span
                onMouseDown={(e) => onColResizeStart(e, 'tag')}
                className={`absolute top-1/2 -right-1 -translate-y-1/2 w-1.5 h-4 cursor-col-resize rounded ${isDark ? 'hover:bg-cyan-500/50' : 'hover:bg-cyan-500/40'}`}
                title="拖拽调整 Tag 列宽度"
              />
            </span>
            <span>消息</span>
          </div>

          <div
            ref={logScrollRef}
            className="flex-1 overflow-y-auto font-mono text-xs"
            // L1: 检测用户是否在底部，更新 autoScrollRef
            onScroll={(e) => {
              const el = e.currentTarget;
              autoScrollRef.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
              syncLogViewport(el.scrollTop, el.clientHeight);
            }}
          >
            {loading ? (
              <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>
                <Loader2 size={32} className="mb-3 animate-spin" />
                <p className="font-bold">正在读取日志文件…</p>
                <p className="text-xs mt-2 opacity-60">文件较大时可能需要数秒，请稍候</p>
              </div>
            ) : smartSearching && smartSearchIncremental.length === 0 ? (
              <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-violet-400' : 'text-violet-600'}`}>
                <Loader2 size={32} className="mb-3 animate-spin" />
                <p className="font-bold">正在智能搜索…</p>
                <p className="text-xs mt-1">查询："{smartSearchQuery}"</p>
                {smartSearchProgress && (
                  <p className="text-xs mt-2">
                    已搜索 {smartSearchProgress.completed}/{smartSearchProgress.total} 块
                    {smartSearchProgress.matchedCount > 0 && `，已匹配 ${smartSearchProgress.matchedCount} 条`}
                  </p>
                )}
                <p className="text-xs mt-3 opacity-60">AI 正在分块分析日志，结果将逐步显示…</p>
              </div>
            ) : filtered.length === 0 ? (
              <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                <Terminal size={32} className="mb-3 opacity-50" />
                <p>暂无日志</p>
                <p className="text-xs mt-1">可点击"开始抓取"或"打开 .log"</p>
              </div>
            ) : (
              <div className="relative" style={{ height: `${virtualLogRows.totalHeight}px` }}>
                <div
                  className="divide-y divide-slate-800/30"
                  style={{ transform: `translateY(${virtualLogRows.topOffset}px)` }}
                >
                  {virtualLogRows.entries.map((entry) => (
                    <LogRow
                      key={entry.id}
                      entry={entry}
                      isDark={isDark}
                      colWidths={colWidths}
                      highlighted={smartSearchMatchedIds.has(entry.id)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {autoDiagnoseAlert && (
        (() => {
          // 三态判定：monitoring（实时监控中）/ clean（扫描完成无异常）/ issues（检测到问题）
          const isMonitoring = autoDiagnoseAlert.monitoring;
          const hasIssues = !isMonitoring && autoDiagnoseAlert.summary.total > 0;
          const isClean = !isMonitoring && autoDiagnoseAlert.summary.total === 0;
          return (
        <div
          className={`max-w-md animate-in fade-in slide-in-from-bottom-2 ${
            aiPanelOpen && aiFullscreen
              ? 'fixed bottom-4 right-4 z-30'  // AI 全屏时：位于 AI 面板下一层（z-30 < z-50），被全屏面板遮挡
              : aiPanelOpen
                ? 'fixed z-[60]'               // AI 面板打开非全屏：浮在 AI 面板上方（z-60 > z-50）
                : 'fixed bottom-6 right-6 z-[60]' // 默认：固定在窗口右下角
          }`}
          style={
            aiPanelOpen && !aiFullscreen
              ? { bottom: `${aiPanelHeight + 16}px`, right: '1rem' }
              : undefined
          }
        >
          <div className={`rounded-xl border shadow-2xl overflow-hidden ${
            // 三态配色：monitoring/clean=emerald，issues=amber
            (isMonitoring || isClean)
              ? (isDark ? 'bg-[#2D2F33] border-emerald-500/40' : 'bg-white border-emerald-400')
              : (isDark ? 'bg-[#2D2F33] border-amber-500/40' : 'bg-white border-amber-400')
          }`}>
            <div className="flex items-start gap-3 p-4">
              <div className="flex-shrink-0 mt-0.5">
                <div className={`w-9 h-9 rounded-full flex items-center justify-center ${
                  (isMonitoring || isClean)
                    ? (isDark ? 'bg-emerald-500/20' : 'bg-emerald-100')
                    : (isDark ? 'bg-amber-500/20' : 'bg-amber-100')
                }`}>
                  {isMonitoring ? (
                    <Loader2 size={18} className="text-emerald-500 animate-spin" />
                  ) : isClean ? (
                    <CheckCircle size={18} className="text-emerald-500" />
                  ) : (
                    <AlertTriangle size={18} className="text-amber-500" />
                  )}
                </div>
              </div>
              <div className="flex-1 min-w-0">
                <div className={`text-sm font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>
                  {isMonitoring
                    ? '自动诊断监控中'
                    : isClean
                      ? '当前没有检测到异常'
                      : `检测到 ${autoDiagnoseAlert.summary.total} 个关键问题`
                  }
                </div>
                {isMonitoring ? (
                  <div className={`text-xs mt-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                    正在实时监控崩溃 / ANR / OOM / Native Crash 等关键问题，暂未发现问题
                  </div>
                ) : isClean ? (
                  <div className={`text-xs mt-1 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                    扫描完成，未发现崩溃 / ANR / OOM / Native Crash 等关键问题
                  </div>
                ) : (
                  <div className={`text-xs mt-1 flex flex-wrap gap-1.5 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
                    {autoDiagnoseAlert.summary.crash > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-red-500/15 text-red-400">Crash ×{autoDiagnoseAlert.summary.crash}</span>
                    )}
                    {autoDiagnoseAlert.summary.anr > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400">ANR ×{autoDiagnoseAlert.summary.anr}</span>
                    )}
                    {autoDiagnoseAlert.summary.native_crash > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-pink-500/15 text-pink-400">Native ×{autoDiagnoseAlert.summary.native_crash}</span>
                    )}
                    {autoDiagnoseAlert.summary.oom > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-purple-500/15 text-purple-400">OOM ×{autoDiagnoseAlert.summary.oom}</span>
                    )}
                    {autoDiagnoseAlert.summary.watchdog > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-400">Watchdog ×{autoDiagnoseAlert.summary.watchdog}</span>
                    )}
                    {autoDiagnoseAlert.summary.kernel_panic > 0 && (
                      <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-400">Kernel ×{autoDiagnoseAlert.summary.kernel_panic}</span>
                    )}
                  </div>
                )}
                <div className="flex items-center gap-2 mt-3">
                  {hasIssues && (
                    <button
                      onClick={() => {
                        if (!isVip) { showVipBlock('AI 深度分析'); return; }
                        onAutoDiagnoseConfirm();
                      }}
                      disabled={aiAnalyzing}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-white transition-colors font-medium ${aiAnalyzing ? 'bg-amber-500/40 cursor-not-allowed' : 'bg-amber-500 hover:bg-amber-600'}`}
                    >
                      {aiAnalyzing ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
                      {aiAnalyzing ? '分析中…' : 'AI 分析'}
                    </button>
                  )}
                  <button
                    onClick={onAutoDiagnoseDismiss}
                    className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${isDark ? 'text-[#9AA0A6] hover:bg-[#3E4145]' : 'text-slate-500 hover:bg-slate-100'}`}
                  >
                    {isMonitoring ? '隐藏' : '忽略'}
                  </button>
                </div>
              </div>
              <button
                onClick={onAutoDiagnoseDismiss}
                className={`flex-shrink-0 p-1 rounded transition-colors ${isDark ? 'text-[#80868B] hover:bg-[#3E4145]' : 'text-slate-400 hover:bg-slate-100'}`}
              >
                <X size={14} />
              </button>
            </div>
          </div>
        </div>
          );
        })()
      )}

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
                <span className={`text-sm font-bold shrink-0 ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>AI 日志助手</span>
                {aiAnalyzing && (
                  <span className="flex items-center gap-1 text-xs text-purple-400 shrink-0">
                    <Loader2 size={12} className="animate-spin" />
                    {mapReduceProgress
                      ? mapReduceProgress.phase === 'map'
                        ? `分块分析 ${mapReduceProgress.current}/${mapReduceProgress.total}${mapReduceProgress.lineRange ? `（第 ${mapReduceProgress.lineRange} 行）` : ''}`
                        : mapReduceProgress.phase === 'compress'
                          ? '正在压缩上下文…'
                          : '汇总分析中…'
                      : '分析中…'}
                  </span>
                )}
                <span className={`text-xs shrink-0 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  ({filtered.length.toLocaleString()} 条日志)
                </span>
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
                    <div className="relative group/ctx flex items-center justify-center shrink-0 w-[22px] h-[22px]" title="上下文使用量">
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
                        <div className="font-bold mb-0.5">{pct}% 已用（剩余 {100 - pct}%）</div>
                        <div className={isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}>
                          已用 {fmt(usage.usedTokens)} / {fmt(usage.maxTokens)} tokens
                        </div>
                        <div className={`text-[10px] mt-0.5 ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                          {usage.messageCount} 条对话消息
                        </div>
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
                      title="导出为 .md 文件"
                    >
                      <FileDown size={13} />
                      导出
                    </button>
                    <button
                      onClick={onAiClear}
                      className={`text-xs px-2 py-1 rounded transition-colors ${isDark ? 'text-[#9AA0A6] hover:text-[#E8EAED] hover:bg-[#3E4145]' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'}`}
                    >
                      清空
                    </button>
                  </>
                )}
                <button
                  onClick={onToggleFullscreen}
                  className={`p-1 rounded-lg transition-colors ${isDark ? 'hover:bg-[#3E4145] text-slate-400' : 'hover:bg-slate-100 text-slate-500'}`}
                  title={aiFullscreen ? '退出全屏' : '全屏查看'}
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

            {/* AI Content Area */}
            <div className="flex-1 overflow-y-auto px-4 py-3">
              {aiError ? (
                <div className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                  <span className="font-bold">错误：</span>{aiError}
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
                              <span>{showThinking ? '思考中…' : '已完成思考'}</span>
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
                            <AiMarkdownRender content={turn.content} isDark={isDark} />
                            {showThinking && (
                              <span className="inline-block w-2 h-4 ml-0.5 bg-purple-400 animate-pulse align-middle" />
                            )}
                          </div>
                        ) : showThinking && !turn.reasoning ? (
                          <div className={`flex items-center gap-2 text-sm ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                            <Loader2 size={14} className="animate-spin text-purple-400" />
                            AI 正在分析日志…
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : aiAnalyzing ? (
                <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  <Loader2 size={32} className="mb-3 animate-spin text-purple-400" />
                  <p className="text-sm">AI 正在分析日志，请稍候…</p>
                  <p className="text-xs mt-1">正在向 Agent AI 发送 {filtered.length.toLocaleString()} 条日志</p>
                </div>
              ) : (
                <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  <Sparkles size={28} className="mb-2 opacity-50" />
                  <p className="text-sm">点击下方"开始分析"让 AI 帮你诊断日志</p>
                  <p className="text-xs mt-1">将基于当前 {filtered.length.toLocaleString()} 条过滤后日志进行分析</p>
                </div>
              )}
            </div>

            {/* AI Input Bar */}
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
                title={aiThinkingMode ? '思考模式：AI 会先进行推理再回答' : '快速模式：AI 直接回答，速度更快'}
              >
                {aiThinkingMode ? <Brain size={13} /> : <Zap size={13} />}
                {aiThinkingMode ? '思考' : '快速'}
              </button>
              <input
                type="text"
                value={aiCustomPrompt}
                onChange={(e) => setAiCustomPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !aiAnalyzing && filtered.length > 0) {
                    onAiAnalyze();
                    setAiCustomPrompt('');
                  }
                }}
                placeholder="附加分析要求（可选，如：重点关注内存泄漏）"
                className={`flex-1 text-xs px-3 py-2 rounded-lg border outline-none focus:ring-2 focus:ring-purple-500 ${isDark ? 'bg-[#3E4145] border-[#5F6368] text-[#E8EAED] placeholder-slate-500' : 'bg-white border-slate-200 text-slate-700 placeholder-slate-400'}`}
              />
              {aiAnalyzing ? (
                <button
                  onClick={onAiStop}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
                >
                  <StopCircle size={14} />
                  停止
                </button>
              ) : (
                <button
                  onClick={() => { onAiAnalyze(); setAiCustomPrompt(''); }}
                  disabled={filtered.length === 0}
                  className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg bg-purple-500 hover:bg-purple-600 text-white transition-colors disabled:opacity-50"
                >
                  <Send size={14} />
                  开始分析
                </button>
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
                  <div className={`text-base font-bold ${isDark ? 'text-[#E8EAED]' : 'text-slate-800'}`}>MCP 服务使用说明</div>
                  <div className={`text-xs ${isDark ? 'text-[#80868B]' : 'text-slate-500'}`}>Model Context Protocol · AI 工具集成接口</div>
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
              <div className={`text-xs leading-relaxed ${isDark ? 'text-[#9AA0A6]' : 'text-slate-600'}`}>
                MCP 服务让 AI 工具（Claude CLI、Cursor、Trae 等）能够直接读取和控制本应用的日志、应用包、性能采样和设备巡检能力，无需手动复制粘贴结果。
              </div>

              {/* Tool Groups */}
              {[
                {
                  title: '设备与日志控制',
                  icon: '🎮',
                  color: isDark ? 'emerald' : 'emerald',
                  tools: [
                    { name: 'device_list', desc: '列出所有 ADB 连接的设备' },
                    { name: 'capture_start', desc: '选择设备并开始抓取日志', extra: '可选 buffers 指定缓冲区：main / system / radio / events / crash / kernel' },
                    { name: 'capture_stop', desc: '停止当前抓取' },
                    { name: 'log_clear', desc: '清空日志' },
                  ],
                },
                {
                  title: '应用包管理',
                  icon: '📦',
                  color: 'amber',
                  tools: [
                    { name: 'package_list', desc: '列出指定设备已安装应用', extra: '默认返回用户应用；showSystem=true 时包含系统应用' },
                    { name: 'package_detail', desc: '读取应用版本、路径、安装时间、启停状态和权限摘要' },
                  ],
                },
                {
                  title: '性能与巡检',
                  icon: '📊',
                  color: 'rose',
                  tools: [
                    { name: 'perf_snapshot', desc: '执行一次性能采样', extra: '返回 CPU、内存、存储空间、电池、温度、FPS 和告警' },
                    { name: 'inspection_run', desc: '执行标准设备巡检并导出报告与证据包', extra: '支持 includeBugreport、includeAiSummary 和 outputBaseDir' },
                  ],
                },
                {
                  title: '日志查询（只读）',
                  icon: '🔍',
                  color: 'blue',
                  tools: [
                    { name: 'log_sources', desc: '查看日志源条数' },
                    { name: 'log_get', desc: '读取原始日志（分页）' },
                    { name: 'log_filter', desc: '按级别/关键词/Tag/PID/包名/正则过滤' },
                    { name: 'log_stats', desc: '统计各级别数量' },
                    { name: 'log_watch', desc: '等待特定关键词出现' },
                  ],
                },
                {
                  title: 'AI 分析',
                  icon: '🤖',
                  color: 'violet',
                  tools: [
                    { name: 'ai_analyze', desc: '启动 AI 日志分析（非流式，等待完整结果）', extra: '参数：source(realtime/file)、filter、customPrompt、timeoutMs' },
                    { name: 'ai_get_result', desc: '获取最近一次 AI 分析结果（Markdown 格式）' },
                    { name: 'ai_clear', desc: '清空 AI 分析结果和对话上下文' },
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
                  <span className={`text-xs font-bold uppercase tracking-wide ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`}>配置方法</span>
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
                    <Copy size={11} /> 复制
                  </button>
                  <pre className={`px-3 py-3 pr-16 rounded-lg text-[11px] leading-relaxed font-mono overflow-x-auto ${isDark ? 'bg-slate-900 text-emerald-300 border border-[#3E4145]' : 'bg-slate-900 text-emerald-300'}`}>
{mcpConfigTab === 'trae' ? `{
  "mcpServers": {
    "Android Log Analyzer MCP": {
      "url": "http://127.0.0.1:${mcpPort}/mcp",
      "headers": {}
    }
  }
}` : mcpConfigTab === 'claude' ? `# 方式一：CLI 命令（推荐）
claude mcp add --transport http android-log-analyzer http://127.0.0.1:${mcpPort}/mcp

# 方式二：编辑 ~/.claude.json 或项目根目录 .mcp.json
{
  "mcpServers": {
    "android-log-analyzer": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:${mcpPort}/mcp"
    }
  }
}` : `# ~/.codex/config.toml
[mcp_servers.android-log-analyzer]
transport = "http"
url = "http://127.0.0.1:${mcpPort}/mcp"`}
                  </pre>
                </div>

                {/* Config file path hint */}
                <div className={`mt-1.5 text-[11px] ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                  {mcpConfigTab === 'trae' && '配置文件：Trae 的 mcp.json / Cursor 的 settings.json'}
                  {mcpConfigTab === 'claude' && 'CLI 命令直接添加，或编辑 ~/.claude.json / .mcp.json'}
                  {mcpConfigTab === 'codex' && '配置文件：~/.codex/config.toml'}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className={`flex items-center justify-between px-6 py-3 border-t ${isDark ? 'border-[#3E4145] bg-[#2A2C2F]' : 'border-slate-200 bg-slate-50'}`}>
              <div className={`text-[11px] ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
                当前端口：<span className={`font-mono font-semibold ${isDark ? 'text-cyan-400' : 'text-cyan-600'}`}>{mcpPort}</span>
              </div>
              <button
                onClick={() => setMcpHelpVisible(false)}
                className={`px-4 py-1.5 text-xs rounded-lg transition-colors ${isDark ? 'bg-[#3E4145] hover:bg-slate-600 text-[#E8EAED]' : 'bg-slate-200 hover:bg-slate-300 text-slate-700'}`}
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 日志诊断规则库弹窗 */}
      <DiagnosticRuleLibrary
        theme={t}
        open={ruleLibraryOpen}
        onClose={() => setRuleLibraryOpen(false)}
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
                <h4 className="text-base font-semibold text-[#E8EAED]">会员专属功能</h4>
                <p className="text-xs text-[#9AA0A6] mt-0.5">{vipBlockMsg} 仅会员可用</p>
              </div>
            </div>
            <p className="text-sm text-[#9AA0A6] mb-5">当前为基础版，开通会员即可解锁全部 AI 能力与 MCP 服务。</p>
            <div className="flex justify-end gap-2">
              <button onClick={dismissVipBlock} className="px-4 py-2 text-sm rounded-lg bg-[#3E4145] text-[#E8EAED] hover:bg-slate-600 transition-colors">知道了</button>
              <button
                onClick={() => {
                  dismissVipBlock();
                  if (window.electronAPI?.logAnalyzerClose) window.electronAPI.logAnalyzerClose();
                }}
                className="px-4 py-2 text-sm rounded-lg bg-gradient-to-r from-amber-500 to-yellow-500 hover:from-amber-600 hover:to-yellow-600 text-white font-medium transition-all"
              >
                去开通
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// H5: 使用 React.memo 避免不必要的重渲染（仅当 props 变化时才重新渲染）
const LogRow = memo(function LogRow({ entry, isDark, colWidths, highlighted }) {
  const lvl = entry.level ?? 'V';
  const tag = entry.tag ?? '';
  const pkg = entry.pkg ?? '';
  const msg = entry.message ?? entry.raw;

  // 使用动态列宽（与表头保持一致），消息列自适应剩余空间
  const gridTemplate = colWidths
    ? `${colWidths.ts}px ${colWidths.level}px ${colWidths.pkg}px ${colWidths.tag}px 1fr`
    : '140px 28px minmax(60px,120px) minmax(50px,120px) 1fr';

  return (
    <div
      className={`grid gap-2 px-4 py-1.5 transition-colors select-text border-l-2 ${
        highlighted
          ? (isDark ? 'bg-violet-500/10 border-violet-400' : 'bg-violet-50 border-violet-500')
          : (isDark ? 'hover:bg-white/5 border-b border-white/5 border-transparent' : 'hover:bg-slate-50 border-b border-slate-100 border-transparent')
      }`}
      style={{ gridTemplateColumns: gridTemplate, height: `${LOG_ROW_HEIGHT}px` }}
      onDoubleClick={() => navigator.clipboard.writeText(entry.raw)}
      title={entry.raw}
    >
      <span className={`truncate ${isDark ? 'text-[#80868B]' : 'text-slate-400'}`}>
        {fmtTs(entry.ts)}
      </span>
      <span className={`text-center font-bold text-xs rounded px-1 ${levelBgColors[lvl]} ${levelColors[lvl]}`}>
        {lvl}
      </span>
      <span className={`truncate ${isDark ? 'text-emerald-400/80' : 'text-emerald-600'}`} title={pkg}>
        {pkg || ''}
      </span>
      <span className={`truncate ${isDark ? 'text-cyan-400/80' : 'text-cyan-600'}`} title={tag}>
        {tag}
      </span>
      <span className={`truncate ${isDark ? 'text-[#E8EAED]' : 'text-slate-700'}`} title={msg}>
        {msg}
      </span>
    </div>
  );
});

// 轻量 Markdown 渲染组件（用于 AI 分析结果展示）
// 使用增量解析 + useDeferredValue 避免长文本时 UI 卡死
function AiMarkdownRender({ content, isDark }) {
  // useDeferredValue: 让 React 在空闲时才渲染 Markdown，不阻塞用户交互
  const deferredContent = useDeferredValue(content);
  // M10: parseMarkdown 缓存优化 - useMemo 本身已提供基于 deferredContent 的 memoization，
  // 内容相同时不会重新解析；useDeferredValue 进一步确保只在空闲时更新。
  // 注：不使用 ref 缓存，因为 React 19 不允许在 render 阶段（useMemo 内）访问 refs。
  const blocks = useMemo(() => parseMarkdown(deferredContent), [deferredContent]);
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
