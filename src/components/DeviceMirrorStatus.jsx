import { Loader2, RotateCcw, FileText, Check, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';

export default function DeviceMirrorStatus({ session, device, theme, onRetry, onDiagnostics, onRemember, onForget }) {
  useLocale();
  if (!session || session.deviceId !== device.id || Number.isSafeInteger(device.generation) && session.generation !== device.generation) return null;
  const active = ['starting', 'unconfirmed', 'running'].includes(session.phase), online = device.status === 'device';
  const failed = session.phase === 'failed' || session.phase === 'exited' && session.exitCode !== undefined && session.exitCode !== 0;
  const title = session.phase === 'starting' ? tr('正在准备投屏…') : session.phase === 'unconfirmed' ? tr('投屏进程已启动，尚未确认画面')
    : session.phase === 'running' ? session.pictureConfirmed ? tr('投屏画面已确认') : tr('投屏进程运行中，请核对画面') : failed ? tr('投屏已异常结束') : tr('投屏已结束');
  const button = `inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  const profileText = {
    available: tr('本次使用上次确认可用的安全配置。'), saved: tr('已记住此设备的安全投屏配置。'), changed: tr('全局投屏设置已更改，本次使用新设置。'),
    unavailable: tr('无法可靠识别设备，未套用或保存其他设备的配置。'), error: tr('配置未能读取或保存；原配置保留，当前投屏不受影响。'), saving: tr('正在核对设备身份并保存安全配置…')
  }[session.profileStatus];
  return <section aria-label={tr('投屏会话')} className={`mb-3 space-y-2 rounded-lg border px-3 py-2.5 text-xs ${failed ? 'border-red-500/25 bg-red-500/5' : 'border-emerald-500/20 bg-emerald-500/5'}`}>
    <p role="status" className={`flex items-start gap-2 ${failed ? 'text-red-500' : theme.text}`}>
      {session.phase === 'starting' && <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin" />}<span className="min-w-0 break-words">{title}{session.exitCode !== undefined && tr(' · 退出码 {0}', { 0: session.exitCode })}</span>
    </p>
    {profileText && <p className={`break-words leading-5 ${theme.textMuted}`}>{profileText}</p>}
    <div className="flex flex-wrap gap-2">
      {!active && onRetry && <button type="button" disabled={!online} onClick={() => onRetry('remembered')} className={button}><RotateCcw size={13} />{tr('重试投屏')}</button>}
      {!active && onRetry && ['saved', 'available', 'error'].includes(session.profileStatus) && <button type="button" disabled={!online} onClick={() => onRetry('global')} className={button}>{tr('使用全局设置重试')}</button>}
      {active && session.phase !== 'starting' && session.profileStatus !== 'saved' && onRemember && <button type="button" disabled={!online || session.profileStatus === 'saving'} onClick={onRemember} className={button}><Check size={13} />{tr('画面正常，记住配置')}</button>}
      {active && ['saved', 'available'].includes(session.profileStatus) && onForget && <button type="button" onClick={onForget} className={button}><X size={13} />{tr('忘记配置')}</button>}
      {onDiagnostics && <button type="button" onClick={onDiagnostics} className={button}><FileText size={13} />{tr('查看全局诊断')}</button>}
    </div>
  </section>;
}
