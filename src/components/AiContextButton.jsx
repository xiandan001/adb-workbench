import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { bringAiContext } from '../shared/aiHandoff';

export default function AiContextButton({ context, disabled = false, className = '', onCreated, label }) {
  useLocale();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function bring() {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await bringAiContext(context); onCreated?.(result); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  }
  return <span className="inline-flex min-w-0 flex-wrap items-center gap-1"><button type="button" disabled={disabled || busy} onClick={bring}
    title={tr('带上当前选择，在 AI 工作区核对后继续。')}
    className={`inline-flex items-center gap-1 rounded-lg border border-emerald-500/35 px-2 py-1 text-xs text-emerald-500 disabled:opacity-40 ${className}`}>
    {busy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}{label || tr('准备 AI 分析')}</button>{error && <span role="alert" className="max-w-sm break-words text-xs text-red-500">{error}</span>}</span>;
}
