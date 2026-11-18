import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Save, Trash2 } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

// Remounted with the owning session and record epoch by IpControlPanel.
export default function IpControlRecordControls({ view, disabled, theme, onCleared, showToast, paused, onTogglePause }) {
  useLocale();
  const [confirming, setConfirming] = useState(false), [pending, setPending] = useState(''), [warning, setWarning] = useState('');
  const mounted = useRef(false), lock = useRef(false), confirmation = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; confirmation.current = null; };
  }, []);
  const unavailable = disabled || !view?.sessionId;
  const scope = () => ({ sessionId: view.sessionId, recordEpoch: view.recordEpoch ?? 0 });
  function confirm() {
    if (unavailable || !mounted.current || lock.current || confirmation.current) return;
    confirmation.current = scope(); setWarning(''); setConfirming(true);
  }
  async function act(kind) {
    if (unavailable || !mounted.current || lock.current || (kind === 'save' && confirmation.current)) return;
    const ref = kind === 'clear' ? confirmation.current : scope();
    if (!ref) return;
    lock.current = true; setPending(kind); setWarning('');
    try {
      const api = window.electronAPI;
      const result = kind === 'clear' ? await api.ipControlClearRecords(ref) : await api.ipControlSaveRecords(ref);
      if (!mounted.current) return;
      if (!result?.ok) {
        setWarning(['STALE_SESSION', 'STALE_RECORDS', 'EMPTY_RECORDS'].includes(result?.code) ? 'changed' : kind);
      } else if (kind === 'clear') {
        onCleared(ref, result.recordEpoch);
      } else if (!result.cancelled) showToast?.(tr('当前网络会话的收发记录已保存。'));
    } catch { if (mounted.current) setWarning(kind); }
    finally {
      lock.current = false; confirmation.current = null;
      if (mounted.current) { setPending(''); setConfirming(false); }
    }
  }
  const button = `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-45 ${theme.button.secondary}`;
  return <>
    <div className="ml-auto inline-flex max-w-full flex-wrap items-center justify-end gap-1.5">
      <button type="button" aria-pressed={Boolean(paused)} onClick={onTogglePause} className={button}>{paused ? <Play size={13}/> : <Pause size={13}/>}{paused ? tr('跟随最新') : tr('暂停滚动')}</button>
      <button type="button" disabled={unavailable || Boolean(pending) || confirming} onClick={() => void act('save')}
        title={tr('保存当前网络会话缓存中的全部收发记录')} className={button}><Save size={13} />{pending === 'save' ? tr('保存中…') : tr('保存当前记录')}</button>
      <button type="button" disabled={unavailable || Boolean(pending) || confirming} onClick={confirm} className={button}><Trash2 size={13} />{tr('清空记录')}</button>
    </div>
    {confirming && <div role="alert" className="flex basis-full flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
      <span className="min-w-0 flex-1 basis-64">{tr('仅清空当前网络会话的收发记录，不影响连接、串口记录或发送历史。')}</span>
      <button type="button" disabled={unavailable || Boolean(pending)} onClick={() => void act('clear')} className="rounded bg-amber-600 px-3 py-1.5 text-white disabled:opacity-45">{tr('确认清空')}</button>
      <button type="button" disabled={Boolean(pending)} onClick={() => { confirmation.current = null; setConfirming(false); }} className={button}>{tr('取消')}</button>
    </div>}
    {warning && <p role="alert" className="basis-full text-xs text-amber-600">{warning === 'changed' ? tr('收发记录已变化，请核对当前会话后重试。')
      : warning === 'save' ? tr('未能保存当前网络会话的记录，请检查保存位置后重试。') : tr('未能清空当前网络会话的记录，请重试。')}</p>}
  </>;
}
