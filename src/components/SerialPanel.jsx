import { lazy, Suspense, useEffect, useId, useRef, useState } from 'react';
import { Cable } from 'lucide-react';
import SerialConnectionSettings from './SerialConnectionSettings';
import SerialDataView from './SerialDataView';
import SerialSendPanel from './SerialSendPanel';
import SelectMenu from './SelectMenu';
import { appendSerialHistory, defaultSerialPreferences, normalizePreferences, readSerialHistory, readSerialPreferences, saveSerialPreferences } from '../shared/serialSettings';
import { applySerialWorkspaceDelta, applySerialWorkspaceSnapshot, createSerialDiscovery, emptySerialWorkspaces, readSerialWorkspace, SERIAL_WORKSPACES, updateSerialWorkspace } from '../shared/serialWorkspace';
import { isDarkTheme } from '../shared/theme';
import { readSerialTerminalStyle, saveSerialTerminalStyle } from '../shared/serialTerminalStyle';

const SerialTerminal = lazy(() => import('./SerialTerminal'));
const WORKSPACE_LABELS = { rs232: 'RS232调试', terminal: '串口终端' };
const STATUS_LABELS = { disconnected: '未连接', connecting: '连接中', connected: '已连接', disconnecting: '断开中', error: '连接错误' };

function initialSettings() {
  let preferences = defaultSerialPreferences();
  let history = [];
  const workspace = readSerialWorkspace();
  let terminalStyleError = '';
  const errors = [];
  try { preferences = readSerialPreferences(); } catch (error) { errors.push(error.message); }
  try { history = readSerialHistory(); } catch (error) { errors.push(error.message); }
  try { workspace.terminal.style = readSerialTerminalStyle(); } catch (error) { terminalStyleError = error.message; }
  return { preferences, history, workspace, terminalStyleError, error: errors.join('；') };
}

export default function SerialPanel({ theme, showToast }) {
  const id = useId();
  const [settings] = useState(initialSettings);
  const [preferences, setPreferences] = useState(settings.preferences);
  const [history, setHistory] = useState(settings.history);
  const [persistenceError, setPersistenceError] = useState(settings.error);
  const [terminalStyleError, setTerminalStyleError] = useState(settings.terminalStyleError);
  const [workspace, setWorkspace] = useState(settings.workspace);
  const [snapshots, setSnapshots] = useState(emptySerialWorkspaces);
  const [terminalOpened, setTerminalOpened] = useState(workspace.mode === 'terminal');
  const [ports, setPorts] = useState([]);
  const [discoveryError, setDiscoveryError] = useState('');
  const [errors, setErrors] = useState({ rs232: '', terminal: '' });
  const [pending, setPending] = useState({ rs232: '', terminal: '' });
  const [refreshing, setRefreshing] = useState(false);
  const actionRef = useRef({ rs232: null, terminal: null });
  const aliveRef = useRef(false);
  const refreshRef = useRef(null);
  const snapshotRef = useRef(null);
  const preferencesRef = useRef(preferences);
  const isDark = isDarkTheme(theme);
  const mode = workspace.mode;
  const snapshot = snapshots[mode];
  const currentPending = pending[mode];
  const error = errors[mode];
  const otherMode = mode === 'rs232' ? 'terminal' : 'rs232';
  const otherSnapshot = snapshots[otherMode];
  const selectedPath = mode === 'terminal' ? workspace.terminalSelectedPath : workspace.selectedPath;
  const config = mode === 'terminal' ? preferences.terminalConfig : preferences.config;

  const updateWorkspace = changes => {
    if (changes.mode === 'terminal') setTerminalOpened(true);
    updateSerialWorkspace(changes);
    setWorkspace(previous => ({ ...previous, ...changes }));
  };

  const changeTerminalSettings = changes => {
    if (Object.hasOwn(changes, 'style')) {
      try { saveSerialTerminalStyle(changes.style); setTerminalStyleError(''); }
      catch (failure) { setTerminalStyleError(`终端样式未能保存，已保留原样式：${failure.message}`); return false; }
    }
    updateWorkspace({ terminal: { ...workspace.terminal, ...changes } });
    return true;
  };

  useEffect(() => {
    aliveRef.current = true;
    let disposed = false;
    let timer;
    let subscriptionGeneration = 0;
    const snapshotPending = { rs232: null, terminal: null };
    const snapshotAgain = { rs232: false, terminal: false };
    const api = window.electronAPI;
    const apply = value => { if (!disposed && value) setSnapshots(current => applySerialWorkspaceSnapshot(current, value)); };
    const fetchSnapshot = target => {
      if (disposed || document.hidden || !SERIAL_WORKSPACES.includes(target)) return;
      if (snapshotPending[target]) { snapshotAgain[target] = true; return snapshotPending[target]; }
      snapshotPending[target] = (async () => {
        try {
          if (!api?.serialSnapshot) throw new Error('串口服务不可用，请使用桌面版本并重启后重试');
          const result = await api.serialSnapshot({ workspace: target });
          if (!result?.success) throw new Error(result?.error || '读取串口状态失败');
          if (result.snapshot?.workspace !== target) throw new Error('串口状态来源不匹配，请重试');
          apply(result.snapshot);
        } catch (failure) { if (!disposed) setErrors(current => ({ ...current, [target]: failure.message })); }
      })().finally(() => {
        snapshotPending[target] = null;
        if (snapshotAgain[target]) { snapshotAgain[target] = false; void fetchSnapshot(target); }
      });
      return snapshotPending[target];
    };
    const discovery = createSerialDiscovery({ list: async () => {
      if (!api?.serialListPorts) throw new Error('串口服务不可用，请使用桌面版本');
      return api.serialListPorts();
    }, onResult: result => {
      if (result.ports) {
        setPorts(result.ports);
        setWorkspace(previous => {
          const field = previous.mode === 'terminal' ? 'terminalSelectedPath' : 'selectedPath';
          if (previous[field] || result.ports.length !== 1) return previous;
          updateSerialWorkspace({ [field]: result.ports[0].path });
          return { ...previous, [field]: result.ports[0].path };
        });
      }
      setDiscoveryError(result.error);
    } });
    const refresh = async (manual = false) => {
      if (disposed || document.hidden) return;
      if (manual) setRefreshing(true);
      await discovery.refresh();
      if (!disposed && manual) setRefreshing(false);
    };
    const off = api?.onSerialChanged?.(delta => {
      if (disposed || document.hidden) return;
      setSnapshots(current => applySerialWorkspaceDelta(current, delta));
    });
    const syncVisibility = async () => {
      const generation = ++subscriptionGeneration;
      clearInterval(timer);
      const active = !document.hidden;
      if (active) { void refresh(); timer = setInterval(() => { void refresh(); }, 2000); }
      try {
        if (!api?.serialSubscribe) throw new Error('串口服务不可用，请使用桌面版本');
        const result = await api.serialSubscribe({ active });
        if (!disposed && generation === subscriptionGeneration && active) {
          if (!result?.success) throw new Error(result?.error || '串口状态订阅失败');
          for (const target of SERIAL_WORKSPACES) {
            if (result.snapshots?.[target]?.workspace !== target) throw new Error('串口状态来源不匹配，请重试');
            apply(result.snapshots[target]);
          }
        }
      } catch (failure) { if (!disposed && active) setErrors({ rs232: failure.message, terminal: failure.message }); }
    };
    const focus = () => { if (!document.hidden) { void refresh(); SERIAL_WORKSPACES.forEach(target => { void fetchSnapshot(target); }); } };
    const refreshHistory = () => {
      if (disposed) return;
      try { setHistory(readSerialHistory()); } catch (failure) { setPersistenceError(failure.message); }
    };
    refreshRef.current = refresh;
    snapshotRef.current = fetchSnapshot;
    void syncVisibility();
    window.addEventListener('focus', focus);
    window.addEventListener('serial-history-changed', refreshHistory);
    document.addEventListener('visibilitychange', syncVisibility);
    return () => {
      disposed = true;
      aliveRef.current = false;
      subscriptionGeneration++;
      clearInterval(timer);
      discovery.dispose();
      off?.();
      window.removeEventListener('focus', focus);
      window.removeEventListener('serial-history-changed', refreshHistory);
      document.removeEventListener('visibilitychange', syncVisibility);
      refreshRef.current = null;
      snapshotRef.current = null;
      void api?.serialSubscribe?.({ active: false }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (snapshots.rs232.needsSnapshot) void snapshotRef.current?.('rs232');
    if (snapshots.terminal.needsSnapshot) void snapshotRef.current?.('terminal');
  }, [snapshots.rs232.needsSnapshot, snapshots.rs232.revision, snapshots.terminal.needsSnapshot, snapshots.terminal.revision]);

  const changePreferences = changes => {
    let normalized;
    try { normalized = normalizePreferences({ ...preferencesRef.current, ...changes }); }
    catch (failure) { setPersistenceError(failure.message); return false; }
    preferencesRef.current = normalized;
    setPreferences(normalized);
    try { saveSerialPreferences(normalized); setPersistenceError(''); return true; }
    catch (failure) { setPersistenceError(`当前设置仅本次有效，未能保存：${failure.message}`); return false; }
  };

  const act = async (target, kind, operation) => {
    if (actionRef.current[target] && !(kind === 'disconnect' && ['connect', 'send'].includes(actionRef.current[target].kind))) return null;
    const action = { kind };
    actionRef.current[target] = action;
    setPending(current => ({ ...current, [target]: kind }));
    setErrors(current => ({ ...current, [target]: '' }));
    try {
      const result = await operation();
      if (!aliveRef.current) return result;
      if (result?.snapshot) {
        if (result.snapshot.workspace !== target) throw new Error('串口操作返回了不同来源的状态，请刷新后重试');
        setSnapshots(current => applySerialWorkspaceSnapshot(current, result.snapshot));
      }
      if (!result?.success && !result?.cancelled) throw new Error(result?.error || '串口操作未完成');
      return result;
    } catch (failure) {
      if (aliveRef.current && actionRef.current[target] === action) { setErrors(current => ({ ...current, [target]: failure.message || '串口操作未完成' })); void snapshotRef.current?.(target); }
      return null;
    } finally {
      if (actionRef.current[target] === action) {
        actionRef.current[target] = null;
        if (aliveRef.current) setPending(current => ({ ...current, [target]: '' }));
      }
    }
  };

  const send = async message => {
    const target = snapshots.rs232;
    if (target.status !== 'connected' || !target.sessionId || target.sending || actionRef.current.rs232) return;
    const result = await act('rs232', 'send', () => window.electronAPI.serialSend({ workspace: 'rs232', ...message, sessionId: target.sessionId }));
    if (!result?.success) return;
    try {
      const nextHistory = appendSerialHistory(message);
      if (aliveRef.current) setHistory(nextHistory);
      window.dispatchEvent(new Event('serial-history-changed'));
    } catch (failure) {
      if (aliveRef.current) setPersistenceError(`已写入串口，但发送历史未保存：${failure.message}`);
    }
    if (aliveRef.current) showToast?.('RS232：已写入串口，不代表设备已执行或回应');
  };
  const save = async target => {
    const result = await act(target, 'save', () => window.electronAPI.serialSave({ workspace: target }));
    if (result?.success && !result.cancelled && aliveRef.current) { showToast?.(`${WORKSPACE_LABELS[target]}当前记录已保存`); void snapshotRef.current?.(target); }
  };
  const connected = snapshot.status === 'connected';
  const summary = snapshot.revision < 0 ? '正在读取状态…' : connected ? `已连接 · ${snapshot.path} · ${snapshot.config?.baudRate || config.baudRate}`
    : snapshot.status === 'connecting' ? `连接中 · ${snapshot.path}` : snapshot.status === 'disconnecting' ? '正在断开'
      : snapshot.status === 'error' ? '连接错误' : `发现 ${ports.length} 个串口`;
  const otherSelected = otherMode === 'terminal' ? workspace.terminalSelectedPath : workspace.selectedPath;
  const otherOccupied = otherSnapshot.reservedPort || (pending[otherMode] === 'connect' ? otherSelected
    : ['connected', 'connecting', 'disconnecting'].includes(otherSnapshot.status) ? otherSnapshot.path : '');
  const selectedOccupied = selectedPath && otherOccupied && selectedPath.toLowerCase() === otherOccupied.toLowerCase();

  return <section aria-label="串口 / RS232" className={`mb-4 rounded-xl border shadow-sm ${theme.card} ${theme.text}`}>
    <div className="flex w-full flex-wrap items-center gap-2.5 rounded-xl px-4 py-3 text-left">
      <Cable size={18} className={connected ? 'text-emerald-500' : theme.textMuted} /><h2 id={`${id}-title`} className="text-sm font-semibold">串口 / RS232</h2><label className="sr-only" htmlFor={`${id}-mode`}>工作模式</label><SelectMenu id={`${id}-mode`} isDark={isDark} compact value={workspace.mode} onChange={mode => updateWorkspace({ mode })} options={[{ value: 'rs232', label: 'RS232调试' }, { value: 'terminal', label: '串口终端' }]} className="w-36" /><span role="status" className={`ml-auto min-w-0 text-xs ${connected ? 'text-emerald-500' : theme.textMuted}`}>{summary}{snapshot.unsaved ? ' · 有未保存记录' : ''}</span>
      <p className={`w-full text-right text-[11px] ${theme.textMuted}`} aria-label="另一串口连接状态">{WORKSPACE_LABELS[otherMode]}：{otherSnapshot.revision < 0 ? '读取中' : STATUS_LABELS[otherSnapshot.status]}{otherSnapshot.path ? ` · ${otherSnapshot.path}` : ''}{otherSnapshot.unsaved ? ' · 有未保存记录' : ''}</p>
    </div>
    <div className="space-y-4 border-t border-slate-400/20 p-4">
      <p className={`text-xs leading-5 ${theme.textMuted}`}>两路独立，可同时连接不同 COM。切换只改变界面，不会断开另一侧连接或停止后台接收。{mode === 'terminal' ? '连接后点击终端，用键盘操作设备 Shell。' : '连接后选择格式，查看或发送数据。'}</p>
      <SerialConnectionSettings key={mode} theme={theme} isDark={isDark} ports={ports} selectedPath={connected ? snapshot.path : selectedPath} onSelectPath={value => updateWorkspace({ [mode === 'terminal' ? 'terminalSelectedPath' : 'selectedPath']: value })} config={connected ? snapshot.config : config} onConfig={value => changePreferences({ [mode === 'terminal' ? 'terminalConfig' : 'config']: value })} status={snapshot.status} activePath={snapshot.path} pending={snapshot.revision < 0 || (Boolean(currentPending) && currentPending !== 'send')} connectingRequest={currentPending === 'connect'} cancelling={currentPending === 'disconnect'} refreshing={refreshing} onRefresh={() => refreshRef.current?.(true)} onConnect={() => act(mode, 'connect', () => window.electronAPI.serialConnect({ workspace: mode, path: selectedPath, config }))} onDisconnect={() => act(mode, 'disconnect', () => window.electronAPI.serialDisconnect({ workspace: mode }))} advanced={mode === 'terminal' ? workspace.terminalAdvanced : workspace.advanced} onAdvanced={advanced => updateWorkspace({ [mode === 'terminal' ? 'terminalAdvanced' : 'advanced']: advanced })} />
      {selectedOccupied && <p role="status" className="text-xs text-amber-500">{selectedPath} 正由{WORKSPACE_LABELS[otherMode]}使用，请为当前界面选择另一个串口。</p>}
      {discoveryError ? <p role="alert" className="text-xs text-amber-500">{discoveryError}。已保留上次列表，可点击刷新重试。</p> : !ports.length && <p className={`text-xs ${theme.textMuted}`}>未发现串口，请连接串口线并检查驱动。串口工具独立于 ADB 设备连接。</p>}
      {(error || snapshot.error) && <p role="alert" className="break-words rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error || snapshot.error}</p>}
      {persistenceError && <p role="alert" className="break-words text-xs text-amber-500">{persistenceError}</p>}
      {terminalStyleError && <p role="alert" className="break-words text-xs text-amber-500">{terminalStyleError}</p>}
      {terminalOpened && <div hidden={mode !== 'terminal'}><Suspense fallback={<p className={`py-8 text-center text-sm ${theme.textMuted}`}>正在打开串口终端…</p>}><SerialTerminal key={snapshots.terminal.sessionId || 'unconnected'} active={mode === 'terminal'} theme={theme} isDark={isDark} snapshot={snapshots.terminal} settings={workspace.terminal} onSettings={changeTerminalSettings} onSave={() => save('terminal')} saving={pending.terminal === 'save'} busy={Boolean(pending.terminal)} showToast={showToast} /></Suspense></div>}
      {mode === 'rs232' && <>
        <SerialDataView theme={theme} isDark={isDark} snapshot={snapshots.rs232} receiveMode={preferences.receiveMode} onMode={receiveMode => changePreferences({ receiveMode })} following={workspace.following} onFollowing={following => updateWorkspace({ following })} onSave={() => save('rs232')} onClear={() => act('rs232', 'clear', () => window.electronAPI.serialClear({ workspace: 'rs232' }))} saving={pending.rs232 === 'save'} busy={Boolean(pending.rs232)} showToast={showToast} />
        <SerialSendPanel theme={theme} isDark={isDark} preferences={preferences} onPreferences={changePreferences} draft={workspace.draft} onDraft={draft => updateWorkspace({ draft })} commandsOpen={workspace.commandsOpen} onCommandsOpen={commandsOpen => updateWorkspace({ commandsOpen })} connected={snapshots.rs232.status === 'connected'} sending={snapshots.rs232.sending || pending.rs232 === 'send'} busy={Boolean(pending.rs232)} onSend={send} history={history} showToast={showToast} />
      </>}
    </div>
  </section>;
}
