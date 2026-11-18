import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Copy, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { formatHex } from '../shared/serialFormat.js';
import { ipDirection, ipMode, ipTransport } from '../shared/ipTrafficRecord.js';
import { trapAppMessageFocus } from '../shared/appMessageDialog.js';

export default function IpControlRecordDetail({ record, clock, theme, trigger, fallback, onClose }) {
  const locale = useLocale(), id = useId(), dialog = useRef(null);
  const [copyStatus, setCopyStatus] = useState(''), { row } = record;
  const hex = useMemo(() => formatHex(row.hex), [row.hex]);
  useEffect(() => {
    const node = dialog.current, original = trigger.current, list = fallback.current;
    node.showModal();
    return () => { node.close(); (original?.isConnected ? original : list)?.focus({ preventScroll: true }); };
  }, [trigger, fallback]);
  async function copy() {
    try { await navigator.clipboard.writeText(hex); setCopyStatus('ok'); }
    catch { setCopyStatus('failed'); }
  }
  return <dialog ref={dialog} aria-labelledby={id} onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); onClose(); }}
    className={`m-auto w-[min(760px,calc(100vw-32px))] max-h-[80vh] overflow-auto rounded-xl border p-4 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <header className="flex items-center justify-between gap-3"><h3 id={id} className="font-semibold">{tr('网络收发记录详情')}</h3>
      <button type="button" autoFocus aria-label={tr('关闭记录详情')} className={`rounded-lg p-2 ${theme.button.secondary}`} onClick={onClose}><X size={16}/></button></header>
    <p className={`mt-2 break-all text-xs leading-5 ${theme.textMuted}`}>{ipDirection(row.direction)} · {record.endpoint || tr('未知')} · {new Date(row.at).toLocaleDateString(locale)} {clock.format(row.at)} · {row.hex.length / 2} B · {ipTransport(record.mode)}
      <br/>{tr('会话：')}{record.sessionId}<br/>{tr('网络模式')}：{ipMode(record.mode)}
      {record.listener ? <> · {tr('本机监听 IP')}：{record.listener}</> : record.localPort > 0 ? <> · {tr('本地端口')}：{record.localPort}</> : null}
    </p>
    {row.protocol === 'xbh' && <p className="mt-2 text-xs text-emerald-500">{tr('本条 FE / XBHCMD 报文的长度、固定标识与包尾已校验，为完整报文。')}</p>}
    {row.protocol === 'ab' && <p className="mt-2 text-xs text-emerald-500">{tr('本条 AB 响应的长度与 CRC 已校验，为完整报文。')}</p>}
    {!row.protocol && record.mode !== 'udp' && <p className={`mt-2 text-xs ${theme.textMuted}`}>{tr('TCP 按字节流传输，这条记录不一定是一条完整的协议报文。')}</p>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm">{tr('HEX 原始字节')}</h4>
      <button type="button" disabled={!hex} onClick={copy} className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs disabled:opacity-50 ${theme.button.secondary}`}><Copy size={13}/>{tr('复制完整内容')}</button></div>
    <pre className={`mt-2 max-h-80 select-text overflow-auto whitespace-pre-wrap break-all rounded-lg border p-3 font-mono text-xs ${theme.input}`}>{hex || tr('空数据报（0 B）')}</pre>
    {copyStatus && <p role="status" className={`mt-2 text-xs ${theme.textMuted}`}>{copyStatus === 'ok' ? tr('已复制') : tr('复制失败，请选择内容后手动复制')}</p>}
  </dialog>;
}
