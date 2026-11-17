import { Loader2, RotateCcw, Play, ShieldCheck } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function ConnectionAttemptNotice({ result, theme, busy = false, onRetry, onEnvironment, onUse, onCast }) {
  useLocale();
  if (!result) return null;
  const failed = result.status === 'error', success = result.status === 'success';
  const detail = String(result.message || ''), code = String(result.code || '');
  const hint = /AUTH|unauthorized|authoriz|授权|授權|認証|인증/i.test(code + ' ' + detail)
    ? tr('请在目标设备上确认调试授权后重试；不会自动改用其他设备。')
    : /TIMEOUT|timed?\s*out|timeout|超时|逾時|タイムアウト|시간\s*초과/i.test(code + ' ' + detail)
      ? tr('请核对地址、端口和网络，再使用保留的地址重试。')
      : /INVALID|valid.*address|有效.*地址|IP.*端口|address.*port/i.test(code + ' ' + detail)
        ? tr('请核对地址格式；Android 未填端口时默认使用 5555。') : tr('可重试连接或查看当前目标的环境自检。');
  const button = `inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  return <section aria-label={tr('本次连接结果')} className={`mt-3 space-y-2 rounded-lg border px-3 py-2.5 text-xs ${failed ? 'border-red-500/25 bg-red-500/5' : 'border-emerald-500/25 bg-emerald-500/5'}`}>
    <p className={`break-all font-mono ${theme.textMuted}`}>{result.address}</p>
    <p role={failed ? 'alert' : 'status'} className={`flex items-start gap-2 break-words ${failed ? 'text-red-500' : theme.text}`}>
      {result.status === 'loading' && <Loader2 size={14} className="shrink-0 animate-spin" />}<span>{detail}</span>
    </p>
    {failed && <p className={`break-words leading-5 ${theme.textMuted}`}>{hint}</p>}
    <div className="flex flex-wrap gap-2">
      {failed && onRetry && <button type="button" disabled={busy} onClick={onRetry} className={button}><RotateCcw size={13} />{tr('重试连接')}</button>}
      {failed && onEnvironment && <button type="button" disabled={busy} onClick={onEnvironment} className={button}><ShieldCheck size={13} />{tr('查看连接自检')}</button>}
      {success && result.deviceId && onUse && <button type="button" disabled={busy} onClick={() => onUse(result.deviceId)} className={button}>{tr('设为当前设备')}</button>}
      {success && result.deviceId && onCast && <button type="button" disabled={busy} onClick={() => onCast(result.deviceId)} className={button}><Play size={13} />{tr('设为当前并投屏')}</button>}
    </div>
  </section>;
}
