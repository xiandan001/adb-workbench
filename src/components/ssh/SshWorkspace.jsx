import { tr, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Loader2, Pencil, Plug, Plus, RotateCcw, Search, Server, Trash2, Unplug, X } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import SshConnectionDialog from './SshConnectionDialog';
import SshSessionWorkspace from './SshSessionWorkspace';
import SshTransferQueue from './SshTransferQueue';
import { DEFAULT_SSH_LAYOUT, dirtySshPaths, emptySshView, normalizeSshLayout, readSshLayout, saveSshLayout, sshResult, sshWorkspaceReducer } from '../../shared/sshWorkspace';
import { isDarkTheme } from '../../shared/theme';
import { resolveSshReconnectProfile } from '../../shared/sshReconnect.js';
import { defaultSshConnectionMemory, filterSshProfiles, readSshConnectionMemory, saveSshConnectionMemory, selectSshProfile } from '../../shared/connectionPreferences.js';


const CLASSIC_THEME = Object.freeze({ isDark: true, card: 'bg-[#161b22] border-[#3E4145]', text: 'text-[#E8EAED]', textMuted: 'text-[#9AA0A6]', input: 'border-[#5F6368] bg-[#0D0E10] text-[#E8EAED]',
  button: { primary: 'bg-emerald-600 hover:bg-emerald-500 text-white', secondary: 'bg-[#2D2F33] hover:bg-[#3E4145] text-[#E8EAED]' } });
export default function SshWorkspace({ active = true, theme: appTheme, showToast, worksetRequest, onWorksetContext }) {
  useLocale();
  const STATUS = { connecting: tr("连接中"), 'verifying-host': tr("等待主机验证"), connected: tr("已连接"), disconnecting: tr("断开中"), disconnected: tr("已断开"), error: tr("连接失败") };
  const id = useId();
  const [initialMemory] = useState(() => { try { return { value: readSshConnectionMemory(), error: '' }; } catch (failure) { return { value: defaultSshConnectionMemory(), error: failure.message }; } });
  const [memory, setMemory] = useState(initialMemory.value);
  const handledWorkset = useRef('');
  const reportedProfile = useRef(undefined);
  const [snapshot, setSnapshot] = useState({ revision: -1, profiles: [], sessions: [], transfers: [], fileRevisions: {}, historyRevisions: {} });
  const [view, setView] = useState(emptySshView); const viewRef = useRef(view);
  const [layout, setLayout] = useState(() => { try { return readSshLayout(); } catch { return { ...DEFAULT_SSH_LAYOUT }; } });
  const theme = layout.appearance === 'classic' ? CLASSIC_THEME : appTheme;
  const isDark = isDarkTheme(theme);
  const [selectedProfile, setSelectedProfile] = useState(initialMemory.value.profileId); const [dialog, setDialog] = useState(null);
  const [error, setError] = useState(initialMemory.error); const [connecting, setConnecting] = useState(false); const [busy, setBusy] = useState({});
  const [worksetNotice, setWorksetNotice] = useState('');
  const [closed, setClosed] = useState([]); const alive = useRef(true); const activeRef = useRef(active); const refreshRef = useRef(null);
  const draftPending = useRef(new Map()); const draftSignatures = useRef(new Map());
  const sessions = snapshot.sessions.filter(session => !closed.includes(session.id));
  const current = sessions.find(session => session.id === view.selectedSessionId) || sessions[0];
  const visibleProfiles = filterSshProfiles(snapshot.profiles, memory);
  const profile = visibleProfiles.find(item => item.id === selectedProfile);
  const button = `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:cursor-not-allowed disabled:opacity-40 ${theme.button.secondary}`;

  const onAction = useCallback(action => {
    const next = sshWorkspaceReducer(viewRef.current, action); viewRef.current = next; setView(next);
    if (action.sessionId && action.type !== 'remove-session') {
      const paths = dirtySshPaths(next.sessions[action.sessionId]); const signature = JSON.stringify(paths);
      if (draftSignatures.current.get(action.sessionId) !== signature) {
        draftSignatures.current.set(action.sessionId, signature);
        const pending = Promise.resolve(window.electronAPI.sshSetDrafts({ sessionId: action.sessionId, paths })).then(result => sshResult(result));
        draftPending.current.set(action.sessionId, pending);
        pending.catch(failure => { if (alive.current) setError(tr("未保存编辑保护登记失败：{0}", { 0: failure.message })); });
      }
    }
    return next;
  }, []);
  useEffect(() => {
    alive.current = true; let disposed = false; let loading = null; let requestedAgain = false;
    const accept = data => {
      if (disposed || !data || !Array.isArray(data.sessions) || !Array.isArray(data.profiles) || !Array.isArray(data.transfers)) return;
      setSnapshot(previous => Number.isFinite(data.revision) && data.revision < previous.revision ? previous : { ...previous, ...data });
    };
    const refresh = () => {
      if (disposed) return;
      if (loading) { requestedAgain = true; return loading; }
      loading = (async () => { try { accept(sshResult(await window.electronAPI.sshSnapshot())); } catch (failure) { if (!disposed) setError(failure.message); } })().finally(() => { loading = null; if (requestedAgain) { requestedAgain = false; void refresh(); } });
      return loading;
    };
    const off = window.electronAPI?.onSshChanged?.(accept);
    refreshRef.current = refresh; void refresh();
    const focus = () => { if (activeRef.current && !document.hidden) void refresh(); };
    window.addEventListener('focus', focus);
    return () => { disposed = true; alive.current = false; off?.(); window.removeEventListener('focus', focus); refreshRef.current = null; void window.electronAPI?.sshSubscribe?.({ active: false }).catch(() => {}); };
  }, []);
  useEffect(() => {
    activeRef.current = active; let disposed = false;
    const sync = async () => { try { sshResult(await window.electronAPI.sshSubscribe({ active: active && !document.hidden })); if (!disposed && active && !document.hidden) void refreshRef.current?.(); } catch (failure) { if (!disposed) setError(failure.message); } };
    void sync(); document.addEventListener('visibilitychange', sync);
    return () => { disposed = true; document.removeEventListener('visibilitychange', sync); };
  }, [active]);

  const remember = value => {
    setMemory(value);
    try { saveSshConnectionMemory(value); }
    catch (failure) { setError(failure.message); }
  };
  const selectProfile = profileId => {
    if (profileId && !snapshot.profiles.some(item => item.id === profileId)) return;
    setSelectedProfile(profileId);
    setWorksetNotice('');
    remember(selectSshProfile(memory, profileId));
  };
  useEffect(() => {
    if (snapshot.revision < 0 || !worksetRequest?.requestId || handledWorkset.current === worksetRequest.requestId) return;
    const reference = worksetRequest.ssh;
    if (!reference) { handledWorkset.current = worksetRequest.requestId; setWorksetNotice(''); return; }
    if (connecting) { setWorksetNotice(tr('SSH 正在连接，完成后仅恢复配置选择，不会另建连接。')); return; }
    handledWorkset.current = worksetRequest.requestId;
    if (!snapshot.profiles.some(item => item.id === reference.profileId)) { setWorksetNotice(''); setError(tr('工作集中的 SSH 配置已不存在，请重新选择配置；未连接其他主机。')); return; }
    setSelectedProfile(reference.profileId);
    const next = selectSshProfile({ ...memory, search: '' }, reference.profileId);
    setMemory(next);
    try { saveSshConnectionMemory(next); } catch (failure) { setError(failure.message); }
    setWorksetNotice(tr('已选中工作集的 SSH 配置，未自动连接。'));
  }, [worksetRequest, snapshot.revision, snapshot.profiles, connecting, memory]);
  useEffect(() => {
    if (snapshot.revision >= 0 && selectedProfile && !snapshot.profiles.some(item => item.id === selectedProfile)) setSelectedProfile('');
  }, [snapshot.revision, snapshot.profiles, selectedProfile]);
  useEffect(() => {
    if (snapshot.revision < 0) return;
    const profileId = profile?.id || '';
    if (reportedProfile.current === profileId) return;
    reportedProfile.current = profileId;
    onWorksetContext?.({ part: 'ssh', value: profileId ? { profileId } : null });
  }, [snapshot.revision, profile?.id, onWorksetContext]);

  const commitLayout = value => { try { const next = saveSshLayout(value); setLayout(next); } catch (failure) { setError(failure.message); } };
  const connectSaved = async () => {
    if (!profile || connecting) return;
    if (!profile.hasSavedCredential) { setDialog({ profile }); return; }
    setConnecting(true); setError('');
    try { const result = sshResult(await window.electronAPI.sshConnect({ profileId: profile.id })); if (result.sessionId) onAction({ type: 'select-session', sessionId: result.sessionId }); void refreshRef.current?.(); }
    catch (failure) { setError(failure.message); }
    finally { if (alive.current) setConnecting(false); }
  };
  const actSession = async session => {
    if (busy[session.id]) return; setBusy(previous => ({ ...previous, [session.id]: true })); setError('');
    try {
      await draftPending.current.get(session.id);
      const result = sshResult(await window.electronAPI.sshCloseSession({ sessionId: session.id }));
      if (result.cancelled) return;
      setClosed(previous => [...previous, session.id]); onAction({ type: 'remove-session', sessionId: session.id, discard: true }); draftSignatures.current.delete(session.id); draftPending.current.delete(session.id);
      void refreshRef.current?.();
    } catch (failure) { setError(failure.message); }
    finally { if (alive.current) setBusy(previous => ({ ...previous, [session.id]: false })); }
  };
  const reconnectSession = async session => {
    if (busy[session.id]) return;
    setError('');
    try {
      const ownProfile = resolveSshReconnectProfile(session, snapshot.profiles);
      if (!ownProfile.hasSavedCredential) { setDialog({ profile: ownProfile, reconnectSessionId: session.id }); return; }
      setBusy(previous => ({ ...previous, [session.id]: true }));
      const result = sshResult(await window.electronAPI.sshReconnect({ sessionId: session.id }));
      if (!alive.current || result.cancelled) return;
      if (result.sessionId) onAction({ type: 'select-session', sessionId: result.sessionId });
      void refreshRef.current?.();
      showToast?.(tr('已建立新连接；旧输出和未保存编辑保留在原会话，不会重放命令'));
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setBusy(previous => ({ ...previous, [session.id]: false })); }
  };
  const deleteProfile = async () => {
    if (!profile) return; setError('');
    try { sshResult(await window.electronAPI.sshDeleteProfile({ profileId: profile.id })); selectProfile(''); void refreshRef.current?.(); }
    catch (failure) { setError(failure.message); }
  };
  const revealTransferLocation = async (location, isCurrent) => {
    if (location.kind !== 'remote' || !activeRef.current || !isCurrent()) return;
    const latest = sshResult(await window.electronAPI.sshSnapshot());
    if (!alive.current || !activeRef.current || !isCurrent()) return;
    if (!latest.sessions.some(session => session.id === location.sessionId && session.status === 'connected')) throw new Error(tr("此 SSH 会话已断开，无法定位远端目录"));
    setSnapshot(previous => latest.revision < previous.revision ? previous : { ...previous, ...latest });
    onAction({ type: 'reveal-directory', sessionId: location.sessionId, path: location.path });
  };

  return <section aria-label={tr("SSH 工作区")} className={`flex min-w-0 flex-col gap-3 ${layout.appearance === 'classic' ? 'rounded-xl bg-[#0d1117] p-3' : ''} ${theme.text}`} style={{ minHeight: 'max(620px, calc(100vh - 170px))' }}>
    <div className={`flex shrink-0 flex-wrap items-center gap-2 rounded-xl border p-3 ${theme.card}`}><Server size={18} className="text-emerald-500" />
      <label className="relative min-w-40 flex-1"><span className="sr-only">{tr('搜索 SSH 名称或主机')}</span><Search size={13} className={`pointer-events-none absolute left-2.5 top-2.5 ${theme.textMuted}`} /><input value={memory.search} maxLength={200} onChange={event => remember({ ...memory, search: event.target.value })} placeholder={tr('搜索 SSH 名称或主机')} className={`w-full rounded-lg border py-2 pl-8 pr-3 text-xs ${theme.input}`} /></label>
      <label className="sr-only" htmlFor={`${id}-profile`}>{tr("已保存 SSH 连接")}</label><SelectMenu id={`${id}-profile`} value={selectedProfile} isDark={isDark} onChange={selectProfile} options={visibleProfiles.map(item => ({ value: item.id, label: `${memory.recentIds.includes(item.id) ? tr('最近') + ' · ' : ''}${item.name} · ${item.username}@${item.host}:${item.port}` }))} placeholder={tr("选择已保存的连接")} emptyText={memory.search.trim() ? tr('没有匹配的 SSH 连接') : tr("暂无连接，点击新建连接")} className="min-w-48 flex-1" /><button type="button" onClick={connectSaved} disabled={!profile || connecting} className={button}>{connecting ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}{tr("连接")}</button><button type="button" onClick={() => setDialog({ profile: null })} className={button}><Plus size={14} />{tr("新建连接")}</button><button type="button" aria-label={tr("编辑已保存 SSH 连接")} onClick={() => setDialog({ profile })} disabled={!profile} className={button}><Pencil size={14} /></button><button type="button" aria-label={tr("删除已保存 SSH 连接")} onClick={deleteProfile} disabled={!profile} className={button}><Trash2 size={14} /></button><label className="sr-only" htmlFor={`${id}-appearance`}>{tr("SSH 工作区样式")}</label><SelectMenu id={`${id}-appearance`} compact isDark={isDark} value={layout.appearance} onChange={appearance => commitLayout({ ...layout, appearance })} options={[{ value: 'current', label: tr("当前软件主题") }, { value: 'classic', label: tr("经典深色") }]} className="w-32" /></div>
    {error && <p role="alert" className="shrink-0 break-words text-xs text-red-500">{tr(error)}</p>}
    {worksetNotice && <p role="status" className={`shrink-0 text-xs ${theme.textMuted}`}>{worksetNotice}</p>}
    <div className="flex shrink-0 items-center gap-2"><div role="tablist" aria-label={tr("SSH 会话标签")} className="flex min-w-0 flex-1 overflow-x-auto">{sessions.map(session => <div key={session.id} className={`mr-1 flex shrink-0 items-center rounded-lg border ${current?.id === session.id ? 'border-emerald-500 bg-emerald-500/10' : 'border-slate-400/25'}`}><button type="button" role="tab" aria-selected={current?.id === session.id} onClick={() => onAction({ type: 'select-session', sessionId: session.id })} title={`${session.username}@${session.host}:${session.port}`} className="px-3 py-2 text-left text-xs"><span>{session.name}</span><span className={`ml-2 text-[10px] ${session.status === 'connected' ? 'text-emerald-500' : theme.textMuted}`}>{STATUS[session.status] || session.status}</span>{dirtySshPaths(view.sessions[session.id]).length > 0 && <span className="ml-1 text-amber-500">●</span>}</button><button type="button" aria-label={tr("关闭 SSH 会话 {0}", { 0: session.name })} onClick={() => actSession(session)} disabled={Boolean(busy[session.id])} className="mr-1 rounded p-1 disabled:opacity-40"><X size={13} /></button></div>)}</div>{current && <button type="button" onClick={() => actSession(current)} disabled={Boolean(busy[current.id])} className={button}><Unplug size={13} />{tr("断开当前主机")}</button>}</div>
    {current?.error && <p role="alert" className="shrink-0 break-words text-xs text-amber-500">{tr(current.error)}</p>}
    {current && ['disconnected', 'error'].includes(current.status) && <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-amber-500/25 px-3 py-2">
      <button type="button" onClick={() => reconnectSession(current)} disabled={Boolean(busy[current.id])} className={button}>{busy[current.id] ? <Loader2 size={13} className="animate-spin" /> : <RotateCcw size={13} />}{tr('重新连接此主机')}</button>
      <p className={'min-w-0 text-xs ' + theme.textMuted}>{current.username}@{current.host}:{current.port} · {tr('新建独立连接，原输出和草稿保留，不重放命令')}</p>
    </div>}
    <div className="min-h-[480px] min-w-0 shrink-0" style={{ height: layout.transfersOpen ? 'max(480px, calc(100vh - 440px))' : 'max(480px, calc(100vh - 300px))' }}>{sessions.map(session => <div key={session.id} hidden={current?.id !== session.id} className="h-full min-h-0 min-w-0"><SshSessionWorkspace session={session} view={view.sessions[session.id]} active={active && current?.id === session.id} layout={layout} onLayout={value => setLayout(normalizeSshLayout(value))} onCommitLayout={commitLayout} onAction={onAction} fileRevision={snapshot.fileRevisions?.[session.id] || 0} historyRevision={snapshot.historyRevisions?.[session.id] || 0} theme={theme} isDark={isDark} showToast={showToast} /></div>)}{!sessions.length && <div className={`flex h-full items-center justify-center rounded-xl border p-6 text-center ${theme.card}`}><div><Server size={34} className="mx-auto mb-3 text-emerald-500" /><h2 className="text-lg font-semibold">{tr("连接 SSH，文件与终端同时操作")}</h2><p className={`mt-2 text-sm leading-6 ${theme.textMuted}`}>{tr("左侧浏览远端文件，右上预览或编辑，右下运行终端。")}<br />{tr("每个主机和终端独立，切换页面不影响后台连接与传输。")}</p><button type="button" onClick={() => setDialog({ profile: null })} className={`mt-5 rounded-lg px-5 py-2 text-sm ${theme.button.primary}`}>{tr("新建 SSH 连接")}</button></div></div>}</div>
    <SshTransferQueue transfers={snapshot.transfers} sessions={snapshot.sessions} expanded={layout.transfersOpen} onExpanded={transfersOpen => commitLayout({ ...layout, transfersOpen })} onRevealLocation={revealTransferLocation} onRefresh={() => refreshRef.current?.()} theme={theme} showToast={showToast} />
    {active && dialog && <SshConnectionDialog key={dialog.reconnectSessionId || dialog.profile?.id || 'new'} profile={dialog.profile} reconnectSessionId={dialog.reconnectSessionId} theme={theme} isDark={isDark} onClose={() => setDialog(null)} onSaved={profiles => { if (profiles) setSnapshot(previous => ({ ...previous, profiles })); void refreshRef.current?.(); }} onConnected={sessionId => { if (sessionId) onAction({ type: 'select-session', sessionId }); void refreshRef.current?.(); if (dialog.reconnectSessionId) showToast?.(tr('已建立新连接；旧输出和未保存编辑保留在原会话，不会重放命令')); }} />}
  </section>;
}
