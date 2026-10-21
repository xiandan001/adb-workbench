import { useEffect, useId, useRef, useState } from 'react';
import { Cable } from 'lucide-react';
import SerialConnectionSettings from './SerialConnectionSettings';
import SerialDataView from './SerialDataView';
import SerialSendPanel from './SerialSendPanel';
import { appendSerialHistory, defaultSerialPreferences, normalizePreferences, readSerialHistory, readSerialPreferences, saveSerialPreferences } from '../shared/serialSettings';
import { applySerialDelta, applySerialSnapshot, createSerialDiscovery, emptySerialSnapshot, readSerialWorkspace, updateSerialWorkspace } from '../shared/serialWorkspace';
import { isDarkTheme } from '../shared/theme';

function initialSettings() {
  let preferences = defaultSerialPreferences();
  let history = [];
  const errors = [];
  try { preferences = readSerialPreferences(); } catch (error) { errors.push(error.message); }
  try { history = readSerialHistory(); } catch (error) { errors.push(error.message); }
  return { preferences, history, error: errors.join('；') };
}

export default function SerialPanel({ theme, showToast }) {
  const id = useId();
  const [settings] = useState(initialSettings);
  const [preferences, setPreferences] = useState(settings.preferences);
  const [history, setHistory] = useState(settings.history);
  const [persistenceError, setPersistenceError] = useState(settings.error);
  const [workspace, setWorkspace] = useState(readSerialWorkspace);
  const [snapshot, setSnapshot] = useState(emptySerialSnapshot);
  const [ports, setPorts] = useState([]);
  const [discoveryError, setDiscoveryError] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const actionRef = useRef(false);
  const aliveRef = useRef(false);
  const refreshRef = useRef(null);
  const snapshotRef = useRef(null);
  const preferencesRef = useRef(preferences);
  const isDark = isDarkTheme(theme);

  const updateWorkspace = changes => {
    updateSerialWorkspace(changes);
    setWorkspace(previous => ({ ...previous, ...changes }));
  };

  useEffect(() => {
    aliveRef.current = true;
    let disposed = false;
    let timer;
    let subscriptionGeneration = 0;
    let snapshotPending;
    let snapshotAgain = false;
    const api = window.electronAPI;
    const apply = value => { if (!disposed && value) setSnapshot(current => applySerialSnapshot(current, value)); };
    const fetchSnapshot = () => {
      if (disposed || document.hidden) return snapshotPending;
      if (snapshotPending) { snapshotAgain = true; return snapshotPending; }
      snapshotPending = (async () => {
        try {
          if (!api?.serialSnapshot) throw new Error('串口服务不可用，请使用桌面版本并重启后重试');
          const result = await api.serialSnapshot();
          if (!result?.success) throw new Error(result?.error || '读取串口状态失败');
          apply(result.snapshot);
        } catch (failure) { if (!disposed) setError(failure.message); }
      })().finally(() => {
        snapshotPending = null;
        if (snapshotAgain) { snapshotAgain = false; void fetchSnapshot(); }
      });
      return snapshotPending;
    };
    const discovery = createSerialDiscovery({ list: async () => {
      if (!api?.serialListPorts) throw new Error('串口服务不可用，请使用桌面版本');
      return api.serialListPorts();
    }, onResult: result => {
      if (result.ports) {
        setPorts(result.ports);
        setWorkspace(previous => {
          if (previous.selectedPath || result.ports.length !== 1) return previous;
          updateSerialWorkspace({ selectedPath: result.ports[0].path });
          return { ...previous, selectedPath: result.ports[0].path };
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
      setSnapshot(current => applySerialDelta(current, delta));
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
          apply(result.snapshot);
        }
      } catch (failure) { if (!disposed && active) setError(failure.message); }
    };
    const focus = () => { if (!document.hidden) { void refresh(); void fetchSnapshot(); } };
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
    if (snapshot.needsSnapshot) void snapshotRef.current?.();
  }, [snapshot.needsSnapshot, snapshot.revision]);

  const changePreferences = changes => {
    let normalized;
    try { normalized = normalizePreferences({ ...preferencesRef.current, ...changes }); }
    catch (failure) { setPersistenceError(failure.message); return false; }
    preferencesRef.current = normalized;
    setPreferences(normalized);
    try { saveSerialPreferences(normalized); setPersistenceError(''); return true; }
    catch (failure) { setPersistenceError(`当前设置仅本次有效，未能保存：${failure.message}`); return false; }
  };

  const act = async (kind, operation) => {
    if (actionRef.current && !(kind === 'disconnect' && ['connect', 'send'].includes(actionRef.current.kind))) return null;
    const action = { kind };
    actionRef.current = action;
    setPending(kind);
    setError('');
    try {
      const result = await operation();
      if (!aliveRef.current) return result;
      if (result?.snapshot) setSnapshot(current => applySerialSnapshot(current, result.snapshot));
      if (!result?.success && !result?.cancelled) throw new Error(result?.error || '串口操作未完成');
      return result;
    } catch (failure) {
      if (aliveRef.current && actionRef.current === action) { setError(failure.message || '串口操作未完成'); void snapshotRef.current?.(); }
      return null;
    } finally {
      if (actionRef.current === action) {
        actionRef.current = false;
        if (aliveRef.current) setPending('');
      }
    }
  };

  const send = async message => {
    if (snapshot.status !== 'connected' || !snapshot.sessionId || snapshot.sending || actionRef.current) return;
    const result = await act('send', () => window.electronAPI.serialSend({ ...message, sessionId: snapshot.sessionId }));
    if (!result?.success) return;
    try {
      const nextHistory = appendSerialHistory(message);
      if (aliveRef.current) setHistory(nextHistory);
      window.dispatchEvent(new Event('serial-history-changed'));
    } catch (failure) {
      if (aliveRef.current) setPersistenceError(`已写入串口，但发送历史未保存：${failure.message}`);
    }
    if (aliveRef.current) showToast?.('已写入串口，不代表设备已执行或回应');
  };
  const save = async () => {
    const result = await act('save', () => window.electronAPI.serialSave());
    if (result?.success && !result.cancelled && aliveRef.current) { showToast?.('串口当前记录已保存'); void snapshotRef.current?.(); }
  };
  const connected = snapshot.status === 'connected';
  const summary = connected ? `已连接 · ${snapshot.path} · ${snapshot.config?.baudRate || preferences.config.baudRate}`
    : snapshot.status === 'connecting' ? `连接中 · ${snapshot.path}` : snapshot.status === 'disconnecting' ? '正在断开'
      : snapshot.status === 'error' ? '连接错误' : `发现 ${ports.length} 个串口`;

  return <section aria-label="串口 / RS232" className={`mb-4 rounded-xl border shadow-sm ${theme.card} ${theme.text}`}>
    <div className="flex w-full flex-wrap items-center gap-2.5 rounded-xl px-4 py-3 text-left">
      <Cable size={18} className={connected ? 'text-emerald-500' : theme.textMuted} /><h2 id={`${id}-title`} className="text-sm font-semibold">串口 / RS232</h2><span role="status" className={`ml-auto min-w-0 text-xs ${connected ? 'text-emerald-500' : theme.textMuted}`}>{summary}{snapshot.unsaved ? ' · 有未保存记录' : ''}</span>
    </div>
    <div className="space-y-4 border-t border-slate-400/20 p-4">
      <SerialConnectionSettings theme={theme} isDark={isDark} ports={ports} selectedPath={connected ? snapshot.path : workspace.selectedPath} onSelectPath={selectedPath => updateWorkspace({ selectedPath })} config={connected ? snapshot.config : preferences.config} onConfig={config => changePreferences({ config })} status={snapshot.status} activePath={snapshot.path} pending={Boolean(pending) && pending !== 'send'} connectingRequest={pending === 'connect'} cancelling={pending === 'disconnect'} refreshing={refreshing} onRefresh={() => refreshRef.current?.(true)} onConnect={() => act('connect', () => window.electronAPI.serialConnect({ path: workspace.selectedPath, config: preferences.config }))} onDisconnect={() => act('disconnect', () => window.electronAPI.serialDisconnect())} advanced={workspace.advanced} onAdvanced={advanced => updateWorkspace({ advanced })} />
      {discoveryError ? <p role="alert" className="text-xs text-amber-500">{discoveryError}。已保留上次列表，可点击刷新重试。</p> : !ports.length && <p className={`text-xs ${theme.textMuted}`}>未发现串口，请连接串口线并检查驱动。串口工具独立于 ADB 设备连接。</p>}
      {(error || snapshot.error) && <p role="alert" className="break-words rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">{error || snapshot.error}</p>}
      {persistenceError && <p role="alert" className="break-words text-xs text-amber-500">{persistenceError}</p>}
      <SerialDataView theme={theme} isDark={isDark} snapshot={snapshot} receiveMode={preferences.receiveMode} onMode={receiveMode => changePreferences({ receiveMode })} following={workspace.following} onFollowing={following => updateWorkspace({ following })} onSave={save} onClear={() => act('clear', () => window.electronAPI.serialClear())} saving={pending === 'save'} busy={Boolean(pending)} showToast={showToast} />
      <SerialSendPanel theme={theme} isDark={isDark} preferences={preferences} onPreferences={changePreferences} draft={workspace.draft} onDraft={draft => updateWorkspace({ draft })} commandsOpen={workspace.commandsOpen} onCommandsOpen={commandsOpen => updateWorkspace({ commandsOpen })} connected={connected} sending={snapshot.sending || Boolean(pending)} onSend={send} history={history} />
    </div>
  </section>;
}
