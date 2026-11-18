import { useEffect, useRef, useState } from 'react';
import { CircleAlert, Loader2, Network, Plug, Unplug } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { ipControlError, mergeIpRead, readEndpoint, saveEndpoint, validateModeEndpoint, IP_CONTROL_MODES } from '../shared/ipControlModel.js';
import { appendIpSendHistory } from '../shared/ipControlCommands.js';
import IpControlComposer from './IpControlComposer.jsx';
import IpControlTraffic from './IpControlTraffic.jsx';
import IpControlHistory from './IpControlHistory.jsx';
import AiContextButton from './AiContextButton.jsx';

const modeName = mode => mode === 'tcp-server' ? tr('TCP Server') : mode === 'udp' ? tr('UDP') : tr('TCP Client');
const displayAddress = (host, port) => host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
const activeStatuses = new Set(['connected', 'connecting', 'listening', 'ready']);

export default function IpControlPanel({ theme, isDark, showToast }) {
  useLocale();
  const [endpoints, setEndpoints] = useState(() => Object.fromEntries(IP_CONTROL_MODES.map(mode => [mode, readEndpoint(undefined, mode)])));
  const [selectedMode, setSelectedMode] = useState('tcp-client'), [view, setView] = useState(null);
  const [action, setAction] = useState(''), [commandRevision, setCommandRevision] = useState(0), [commandWarning, setCommandWarning] = useState(false);
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [prefError, setPrefError] = useState(false);
  const [dismissedError, setDismissedError] = useState(''), [invalidField, setInvalidField] = useState('');
  const hostInput = useRef(null), portInput = useRef(null), localInput = useRef(null);
  const owner = useRef(null), lock = useRef(null), refresh = useRef(null);
  const live = activeStatuses.has(view?.status);
  const mode = live && IP_CONTROL_MODES.includes(view.mode) ? view.mode : selectedMode;
  const server = mode === 'tcp-server', udp = mode === 'udp', endpoint = endpoints[mode];
  useEffect(() => {
    const token = {}; owner.current = token; let current = null, inFlight, timer;
    const api = window.electronAPI;
    const poll = () => {
      if (owner.current !== token || document.hidden) return;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          if (!api?.ipControlRead) { setReadError('UNAVAILABLE'); return; }
          let replace = !current || current.hasMore;
          let result = await api.ipControlRead(replace ? {} : { after: current.nextAfter, sessionId: current.sessionId });
          if (owner.current !== token) return;
          if (result?.code === 'INVALID_CURSOR') {
            replace = true; result = await api.ipControlRead({});
            if (owner.current !== token) return;
          }
          if (!result?.ok) { setReadError(result?.code || 'UNAVAILABLE'); return; }
          current = mergeIpRead(current, result, replace);
          if (activeStatuses.has(current.status) && IP_CONTROL_MODES.includes(current.mode)) setSelectedMode(current.mode);
          setReadError(''); setView(current);
        } catch { if (owner.current === token) setReadError('UNAVAILABLE'); }
      })().finally(() => { inFlight = null; });
      return inFlight;
    };
    refresh.current = poll; void poll(); timer = setInterval(poll, 350);
    document.addEventListener('visibilitychange', poll);
    return () => { owner.current = null; lock.current = null; refresh.current = null; clearInterval(timer); document.removeEventListener('visibilitychange', poll); };
  }, []);

  const connecting = view?.status === 'connecting' || action === 'connect';
  const canSend = udp ? view?.status === 'ready' : view?.status === 'connected' && (!server || Boolean(view.peerId));
  const busy = Boolean(action), unavailable = !view || Boolean(readError);
  const shown = live ? { host: view.host, port: String(view.port), localPort: String(view.localPort ?? 0) } : endpoint;
  const viewErrorKey = view ? `${view.sessionId}:${view.code}` : '';
  const relevant = (view?.mode || 'tcp-client') === mode;
  const message = ipControlError(readError || error || (relevant && viewErrorKey !== dismissedError ? view?.code : '') || '');
  const entries = relevant ? view?.entries || [] : [];
  const label = connecting ? tr('连接中') : view?.status === 'listening' ? tr('等待客户端') : view?.status === 'ready' ? tr('UDP 就绪') : view?.status === 'connected' ? tr('已连接') : server || udp ? tr('未启用') : tr('未连接');
  const field = `w-full min-w-0 rounded-lg border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-70 ${theme.input}`;
  const button = 'inline-flex min-h-10 shrink-0 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium focus-visible:outline-2 disabled:opacity-50';

  function edit(key, value) {
    setEndpoints(current => ({ ...current, [mode]: { ...current[mode], [key]: value } })); setError(''); setInvalidField(''); setDismissedError(viewErrorKey);
  }
  function remember() {
    if (!live && !validateModeEndpoint(mode, endpoint)) setPrefError(!saveEndpoint(endpoint, undefined, mode));
  }
  function changeMode(next) {
    if (live || busy || !IP_CONTROL_MODES.includes(next)) return;
    setSelectedMode(next); setPrefError(false); setInvalidField(''); setError(''); setDismissedError(viewErrorKey);
  }
  function connectHistory(entry) {
    if (!IP_CONTROL_MODES.includes(entry.mode)) return false;
    const fields = { host: entry.host, port: String(entry.port), ...(entry.mode === 'udp' ? { localPort: String(entry.localPort ?? 0) } : {}) };
    return startEndpoint(entry.mode, fields, true);
  }
  async function invoke(kind, operation) {
    if (!owner.current || lock.current && !(kind === 'disconnect' && lock.current.kind === 'connect')) return;
    const request = { kind }, token = owner.current; lock.current = request; setAction(kind); setError(''); setInvalidField('');
    try {
      const result = await operation();
      if (owner.current !== token || lock.current !== request) return;
      if (!result?.ok) setError(result?.code || 'SOCKET_ERROR');
      await refresh.current?.();
    } catch { if (owner.current === token && lock.current === request) setError('UNAVAILABLE'); }
    finally { if (owner.current === token && lock.current === request) { lock.current = null; setAction(''); } }
  }
  function startEndpoint(kind, fields, fromHistory = false) {
    if (!owner.current || live || busy || unavailable || lock.current) return false;
    const code = validateModeEndpoint(kind, fields);
    if (code) { setError(code); setInvalidField(code); (code === 'INVALID_IP' ? hostInput : code === 'INVALID_LOCAL_PORT' ? localInput : portInput).current?.focus(); return false; }
    if (fromHistory) {
      setSelectedMode(kind);
      setEndpoints(current => ({ ...current, [kind]: fields }));
    }
    const target = { mode: kind, host: fields.host.trim(), port: Number(fields.port), ...(kind === 'udp' ? { localPort: Number(fields.localPort || 0) } : {}) };
    setPrefError(!saveEndpoint(fields, undefined, kind)); setDismissedError(viewErrorKey);
    void invoke('connect', () => window.electronAPI.ipControlConnect(target)); return true;
  }
  function connect(event) {
    event.preventDefault(); startEndpoint(mode, endpoint);
  }
  function send(hex) {
    if (!canSend || !view.sessionId || busy || view.sending || unavailable) return;
    const target = { mode, host: server ? view.peerHost : view.host, port: server ? view.peerPort : view.port, hex };
    const ownerToken = owner.current;
    void invoke('send', async () => {
      const result = await window.electronAPI.ipControlSend({ sessionId: view.sessionId, hex, ...(server ? { peerId: view.peerId } : {}) });
      if (result?.ok) {
        try { appendIpSendHistory(target); if (ownerToken === owner.current) { setCommandRevision(n => n + 1); setCommandWarning(false); } }
        catch { if (ownerToken === owner.current) setCommandWarning(true); }
      }
      return result;
    });
  }
  return <div className="min-w-0 space-y-4 border-t border-slate-400/20 p-4">
    <div className={`space-y-3 rounded-xl border border-slate-400/20 p-4 ${theme.card}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5"><span className="rounded-lg bg-emerald-500/10 p-2 text-emerald-500"><Network size={18} /></span><div className="min-w-0"><h3 className="font-semibold">{tr('网络模式')}</h3>
          <div role="group" aria-label={tr('网络模式')} className="mt-1.5 inline-flex max-w-full flex-wrap gap-1 rounded-lg bg-slate-400/10 p-1">{IP_CONTROL_MODES.map(item => <button type="button" key={item} disabled={live || busy} aria-pressed={mode === item} onClick={() => changeMode(item)} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-2 ${mode === item ? 'bg-emerald-500 text-white' : theme.textMuted}`}>{modeName(item)}</button>)}</div>
        </div></div>
        <span role="status" className={`rounded-full border border-current/15 px-2.5 py-1 text-xs ${canSend || view?.status === 'listening' ? 'text-emerald-500' : theme.textMuted}`}>{label}</span>
      </div>
      <p className={`text-xs leading-5 ${theme.textMuted}`}>{server ? tr('默认仅允许本机连接；需要局域网客户端时，请填写本机的局域网 IP。') : udp ? tr('每次发送一个数据报。就绪只表示本机已打开 UDP，不能确认对端在线。') : tr('通过网络直接收发十六进制字节，无需连接串口。')}</p>
      <form noValidate onSubmit={connect} className="flex flex-wrap items-end gap-2.5">
        <label className="min-w-0 flex-1 basis-48 space-y-1"><span className={`block text-xs ${theme.textMuted}`}>{server ? tr('本机监听 IP') : tr('远端 IP')}</span><input ref={hostInput} value={shown.host} onChange={e => edit('host', e.target.value)} onBlur={remember} maxLength={64} spellCheck={false} autoComplete="off" disabled={live || busy} aria-invalid={invalidField === 'INVALID_IP'} className={field} /></label>
        <label className="min-w-24 basis-28 space-y-1"><span className={`block text-xs ${theme.textMuted}`}>{server ? tr('监听端口') : tr('远端端口')}</span><input ref={portInput} value={shown.port} onChange={e => edit('port', e.target.value)} onBlur={remember} inputMode="numeric" autoComplete="off" disabled={live || busy} aria-invalid={invalidField === 'INVALID_PORT'} className={field} /></label>
        {udp && <label className="min-w-24 basis-28 space-y-1"><span className={`block text-xs ${theme.textMuted}`}>{tr('本地端口')}</span><input ref={localInput} value={shown.localPort} onChange={e => edit('localPort', e.target.value)} onBlur={remember} inputMode="numeric" placeholder="0" disabled={live || busy} aria-invalid={invalidField === 'INVALID_LOCAL_PORT'} className={field} /></label>}
        {live || connecting ? <button type="button" disabled={!view?.sessionId || !live || action === 'disconnect'} onClick={() => void invoke('disconnect', () => window.electronAPI.ipControlDisconnect({ sessionId: view.sessionId }))} className={`${button} ${theme.button.secondary}`}>{connecting ? <Loader2 size={16} className="animate-spin" /> : <Unplug size={16} />}{connecting ? tr('取消连接') : server ? tr('停止监听') : udp ? tr('停止 UDP') : tr('断开连接')}</button>
          : <button type="submit" disabled={busy || unavailable} className={`${button} ${theme.button.primary}`}><Plug size={16} />{server ? tr('开始监听') : udp ? tr('启用 UDP') : tr('连接')}</button>}
      </form>
      {live && <p className={`text-xs ${theme.textMuted}`}>{tr('当前会话使用中，请先停止再切换模式。')}{server && view.peerHost && <span className="ml-2 break-all font-mono">{tr('当前客户端：{0}', { 0: displayAddress(view.peerHost, view.peerPort) })}</span>}</p>}
      {udp && !live && <p className={`text-xs ${theme.textMuted}`}>{tr('本地端口填 0 或留空将自动分配。')}</p>}
      {message && <p role="alert" className={`flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-5 ${isDark ? 'text-amber-300' : 'text-amber-800'}`}><CircleAlert size={15} className="mt-0.5 shrink-0" />{message}</p>}
      {prefError && <p role="status" className={`text-xs ${theme.textMuted}`}>{tr('仅本次使用此地址，未能保存到本机。')}</p>}
      <IpControlHistory theme={theme} locked={live || busy || unavailable} revision={view?.historyRevision ?? 0} modeName={modeName} displayAddress={displayAddress} onConnect={connectHistory} />
    </div>
    <AiContextButton disabled={unavailable || !relevant || !view?.sessionId || !entries.length}
      context={{ reference: { kind: 'ip-control', sessionId: view?.sessionId || '' } }} />
    <IpControlTraffic key={mode + ':' + (view?.sessionId || '')} theme={theme} view={relevant ? view : null} entries={entries} omitted={relevant && view?.omitted} />
    {commandWarning && <p role="status" className="text-xs text-amber-600">{tr('网络数据已写入，但未能保存发送历史。')}</p>}
    <IpControlComposer theme={theme} isDark={isDark} showToast={showToast} mode={mode} canSend={canSend && !busy && !unavailable} sending={action === 'send' || view?.sending} onSend={send} commandRevision={commandRevision} />
  </div>;
}
