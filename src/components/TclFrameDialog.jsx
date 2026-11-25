import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, Code2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { trapAppMessageFocus } from '../shared/appMessageDialog.js';
import { previewManualTclHex } from '../shared/tclFactoryProtocol.js';

const example = 'AA 06 10 01';
const maxInput = 2048;

export default function TclFrameDialog({ theme, isDark, initialValue = '', onClose, onUse }) {
  useLocale();
  const id = useId();
  const dialog = useRef(null), input = useRef(null), alive = useRef(true), submitting = useRef(false), restoreFocus = useRef(true);
  const [content, setContent] = useState(() => initialValue.length <= maxInput ? initialValue : '');
  const [using, setUsing] = useState(false);
  const [error, setError] = useState('');
  const frame = useMemo(() => previewManualTclHex(content), [content]);
  const invalid = Boolean(content.trim() && !frame);
  const crcMismatch = frame?.crcProvided && frame.crcValid === false;
  const line = 'border-slate-400/20';
  const accent = isDark ? 'text-emerald-300' : 'text-emerald-700';
  const warning = isDark ? 'text-amber-300' : 'text-amber-700';
  const button = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50';

  useEffect(() => {
    alive.current = true;
    const node = dialog.current;
    const previous = node.ownerDocument.activeElement;
    node.showModal();
    input.current?.focus({ preventScroll: true });
    return () => {
      alive.current = false;
      node.close();
      if (restoreFocus.current && previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const close = () => { if (!submitting.current) onClose(); };
  const fill = async () => {
    if (!frame || submitting.current || !alive.current) return;
    submitting.current = true;
    restoreFocus.current = false;
    setUsing(true);
    setError('');
    try {
      if (await onUse({ hex: frame.hex }, tr('TCL 报文生成器')) === true) return;
      if (alive.current) setError(tr('未能更新发送区，请检查配置保存提示；尚未发送。'));
      restoreFocus.current = true;
    } catch (failure) {
      restoreFocus.current = true;
      if (alive.current) setError(failure.message || tr('未能更新发送区，请检查配置保存提示；尚未发送。'));
    } finally {
      submitting.current = false;
      if (alive.current) setUsing(false);
    }
  };

  return <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-intro`}
    onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); close(); }}
    className={`m-auto max-h-[90vh] w-[min(49rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border p-0 shadow-2xl open:flex backdrop:bg-black/60 ${theme.card} ${theme.text}`}>
    <header className={`flex shrink-0 items-start gap-3 border-b px-5 py-4 ${line}`}>
      <span className={`shrink-0 rounded-xl bg-emerald-500/10 p-2.5 ${accent}`}><Code2 size={21} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1">
        <h2 id={`${id}-title`} className="text-base font-semibold">{tr('TCL 报文生成器')}</h2>
        <p id={`${id}-intro`} className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>
          {tr('输入一条以 AA 开头的 TCL 短帧，可省略 CRC 或使用 CRC1 CRC2 占位。')}
        </p>
      </div>
      <button type="button" disabled={using} onClick={close} aria-label={tr('关闭')} className="rounded-lg p-2 disabled:opacity-50">
        <X size={18} aria-hidden="true" />
      </button>
    </header>
    <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
      <div className="grid items-start gap-3 md:grid-cols-2">
        <div className={`min-w-0 space-y-2 rounded-xl border p-3 ${line}`}>
          <label htmlFor={`${id}-hex`} className="block text-sm font-medium">{tr('输入 HEX 数据')}</label>
          <textarea ref={input} id={`${id}-hex`} value={content} rows={4} maxLength={maxInput} spellCheck={false} autoCapitalize="off" disabled={using}
            aria-label={tr('输入 HEX 数据')} aria-describedby={`${id}-example`} aria-invalid={invalid}
            onChange={event => { if (!submitting.current && event.target.value.length <= maxInput) { setContent(event.target.value); setError(''); } }}
            placeholder={example} className={`w-full resize-y rounded-lg border px-3 py-2 font-mono text-sm leading-6 outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`} />
          <p id={`${id}-example`} className={`flex flex-wrap items-center gap-2 text-xs ${theme.textMuted}`}>
            <span>{tr('输入示例')}</span><code>{example}</code>
          </p>
          {invalid && <p className={`text-xs leading-5 ${warning}`}>
            {tr('无法生成报文，请核对长度、HEX 数据和 CRC；长帧请使用协议面板。')}
          </p>}
        </div>
        <section aria-label={tr('完整报文')} className={`min-w-0 space-y-3 rounded-xl border p-3 ${line} ${frame ? (crcMismatch ? 'bg-amber-500/5' : 'bg-emerald-500/5') : ''}`}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
            <h3>{tr('完整报文')}</h3>
            {frame && <span className={`text-xs ${theme.textMuted}`}>{tr('{0} 字节', { 0: frame.hex.split(' ').length })}</span>}
          </div>
          {frame ? <>
            <pre className={`max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-lg border p-2.5 font-mono text-sm leading-6 ${crcMismatch ? `border-amber-500/30 ${warning}` : `border-emerald-500/20 ${accent}`}`}>{frame.hex}</pre>
            <div className={`flex flex-wrap items-center gap-2 text-xs ${theme.textMuted}`}>
              <span>{'CRC1 / CRC2'}</span><code className={`rounded-md px-2 py-1 ${crcMismatch ? `bg-amber-500/10 ${warning}` : `bg-emerald-500/10 ${accent}`}`}>{frame.crc}</code>
            </div>
            {frame.crcProvided && <p role="status" className={`text-xs leading-5 ${crcMismatch ? warning : theme.textMuted}`}>
              {crcMismatch ? tr('已输入的 CRC 校验不匹配，原字节未改动。') : tr('已输入 CRC，保留原字节。')}
            </p>}
          </> : <p className={`rounded-lg border border-dashed p-3 text-xs leading-5 ${line} ${theme.textMuted}`}>{tr('填写有效参数后显示完整 HEX。')}</p>}
        </section>
      </div>
      {error && <p role="alert" className={`mt-3 break-words text-xs ${warning}`}>{error}</p>}
    </div>
    <footer className={`flex shrink-0 flex-wrap items-center justify-end gap-2 border-t px-5 py-3 ${line}`}>
      <p className={`mr-auto text-xs leading-5 ${theme.textMuted}`}>{tr('仅填入发送区，不会自动发送。')}</p>
      <button type="button" disabled={using} onClick={close} className={`${button} ${theme.button.secondary}`}>{tr('关闭')}</button>
      <button type="button" disabled={!frame || using} onClick={fill} className={`${button} ${theme.button.primary}`}>
        <ArrowDownToLine size={15} aria-hidden="true" />{using ? tr('正在填入…') : tr('填入发送区')}
      </button>
    </footer>
  </dialog>;
}
