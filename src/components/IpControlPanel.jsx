import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, CircleAlert, Code2, Loader2, Network, Plug, Send, Unplug } from 'lucide-react';
import { formatHex } from '../shared/serialFormat.js';
import { tr, useLocale } from '../shared/i18n.js';
import { inspectHex, ipControlError, mergeIpRead, readEndpoint, saveEndpoint, validateModeEndpoint, IP_CONTROL_MODES } from '../shared/ipControlModel.js';

const ProtocolPanel = lazy(() => import('./Rs232ProtocolPanel.jsx'));
const memoryScope = { workspace: 'rs232', schemeId: 'ip-control' };
const modeName = mode => mode === 'tcp-server' ? tr('TCP Server') : mode === 'udp' ? tr('UDP') : tr('TCP Client');
const displayAddress = (host, port) => host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
const activeStatuses = new Set(['connected', 'connecting', 'listening', 'ready']);

function TrafficRow({ row, theme, locale }) {
  const [open, setOpen] = useState(false);
  const long = row.hex.length > 128, tx = row.direction === 'TX';
  return <li className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-slate-400/10 px-3 py-2 last:border-0">
    <span className={`inline-flex w-11 shrink-0 items-center gap-1 font-semibold ${tx ? 'text-sky-500' : 'text-emerald-500'}`}>{tx ? <ArrowUpRight size={13} /> : <ArrowDownLeft size={13} />}{row.direction}</span>
    <time className={`shrink-0 tabular-nums ${theme.textMuted}`}>{new Date(row.at).toLocaleTimeString(locale)}</time>
    {row.peerHost && <span className={`min-w-0 break-all font-mono ${theme.textMuted}`}>{displayAddress(row.peerHost, row.peerPort)}</span>}
    {long ? <button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)} className="min-w-0 flex-1 basis-40 whitespace-pre-wrap break-all text-left font-mono leading-relaxed">{formatHex(open ? row.hex : row.hex.slice(0, 128))}{!open && ` … (${row.hex.length / 2} B)`}</button>
      : <code className="min-w-0 flex-1 basis-40 whitespace-pre-wrap break-all">{formatHex(row.hex)}</code>}
  </li>;
}

export default function IpControlPanel({ theme, isDark, showToast }) {
  const locale = useLocale(), [endpoints, setEndpoints] = useState(() => Object.fromEntries(IP_CONTROL_MODES.map(mode => [mode, readEndpoint(undefined, mode)])));
  const [selectedMode, setSelectedMode] = useState('tcp-client'), [view, setView] = useState(null);
  const [draft, setDraft] = useState(''), [protocolOpen, setProtocolOpen] = useState(false), [action, setAction] = useState('');
  const [error, setError] = useState(''), [readError, setReadError] = useState(''), [prefError, setPrefError] = useState(false);
  const [dismissedError, setDismissedError] = useState(''), [invalidField, setInvalidField] = useState('');
  const hostInput = useRef(null), portInput = useRef(null), localInput = useRef(null), sendInput = useRef(null);
  const owner = useRef(null), lock = useRef(null), refresh = useRef(null);
  const live = activeStatuses.has(view?.status);
  const mode = live && IP_CONTROL_MODES.includes(view.mode) ? view.mode : selectedMode;
  const server = mode === 'tcp-server', udp = mode === 'udp', endpoint = endpoints[mode];
  const validated = useMemo(() => inspectHex(draft, mode), [draft, mode]);
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
  function connect(event) {
    event.preventDefault(); if (live || busy || unavailable) return;
    const code = validateModeEndpoint(mode, endpoint);
    if (code) { setError(code); setInvalidField(code); (code === 'INVALID_IP' ? hostInput : code === 'INVALID_LOCAL_PORT' ? localInput : portInput).current?.focus(); return; }
    const target = { mode, host: endpoint.host.trim(), port: Number(endpoint.port), ...(udp ? { localPort: Number(endpoint.localPort || 0) } : {}) };
    remember(); setDismissedError(viewErrorKey);
    void invoke('connect', () => window.electronAPI.ipControlConnect(target));
  }
  function send() {
    if (validated.code || !canSend || !view.sessionId || busy || view.sending || unavailable) return;
    void invoke('send', () => window.electronAPI.ipControlSend({ sessionId: view.sessionId, hex: draft, ...(server ? { peerId: view.peerId } : {}) }));
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
    </div>
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2"><label htmlFor="ip-control-send" className="text-sm font-semibold">{tr('发送数据')}</label><span className={`text-xs ${theme.textMuted}`}>HEX</span></div>
      <textarea id="ip-control-send" ref={sendInput} rows={2} spellCheck={false} value={draft} placeholder={tr('输入 HEX 数据')} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} className={`${field} resize-y font-mono`} />
      {draft && validated.code && <p className="text-xs text-amber-600 dark:text-amber-400" role="status">{ipControlError(validated.code)}</p>}
      <div className="flex flex-wrap items-center justify-between gap-2"><button type="button" onClick={() => setProtocolOpen(true)} className={`${button} border border-emerald-500/35 bg-emerald-500/10 ${isDark ? 'text-emerald-300' : 'text-emerald-800'}`}><Code2 size={16} />{tr('RS232 协议面板')}</button>
        <div className="ml-auto flex items-center gap-3"><span className={`text-xs tabular-nums ${theme.textMuted}`}>{validated.bytes} B</span><button type="button" onClick={send} disabled={!canSend || busy || view?.sending || Boolean(validated.code) || unavailable} className={`${button} ${theme.button.primary}`}><Send size={16} />{tr('发送')}</button></div></div>
    </div>
    <section className="min-w-0 space-y-2 border-t border-slate-400/20 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{tr('收发记录')}</h3><span className={`text-xs ${theme.textMuted}`}>{tr('最近 {0} 条 · HEX', { 0: entries.length })}</span></div>
      <p className={`text-xs ${theme.textMuted}`}>{tr('写入成功不代表设备已执行；收到的数据按原始字节显示。')}{relevant && view?.omitted && ' ' + tr('较早的记录未显示。')}</p>
      {entries.length ? <ul className="max-h-80 overflow-y-auto rounded-lg border border-slate-400/20 text-xs">{entries.slice().reverse().map(row => <TrafficRow key={`${view.sessionId}:${row.id}`} row={row} theme={theme} locale={locale} />)}</ul>
        : <p className={`rounded-lg border border-dashed border-slate-400/25 py-5 text-center text-xs ${theme.textMuted}`}>{tr('暂无收发记录')}</p>}
    </section>
    {protocolOpen && <Suspense fallback={<p role="status">{tr('正在打开协议面板…')}</p>}><ProtocolPanel theme={theme} isDark={isDark} memoryScope={memoryScope} onClose={() => setProtocolOpen(false)} onUse={frame => {
      if (!owner.current || inspectHex(frame?.hex).code) return false;
      setDraft(frame.hex); setProtocolOpen(false); showToast?.(tr('已填入发送区，尚未发送'));
      requestAnimationFrame(() => { if (owner.current) sendInput.current?.focus(); }); return true;
    }} /></Suspense>}
  </div>;
}
