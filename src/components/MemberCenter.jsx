import { useId, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Copy, Crown, KeyRound, Loader2, Lock, RefreshCw } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import { canUseMembershipFeature } from '../shared/membershipEntitlements';
import ActivationRecordsPanel from './ActivationRecordsPanel';
import MembershipBenefits from './MembershipBenefits';

const primaryButton = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-amber-500 to-yellow-500 px-4 py-2 text-sm font-medium text-slate-950 hover:from-amber-400 hover:to-yellow-400 focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-50';

function activationErrorMessage(error) {
  switch (error) {
    case 'bad_signature': return tr('激活码无效（签名校验失败），请检查是否复制完整');
    case 'machine_mismatch': return tr('机器码不匹配，请复制本机机器码联系开发者重新签发');
    case 'expired': return tr('激活码已过期，请联系开发者续费');
    case 'bad_format': return tr('激活码格式错误，请检查是否复制完整');
    case 'bad_payload': return tr('激活码内容无效，请检查是否复制完整');
    case 'token_empty': return tr('请粘贴激活码');
    case 'machine_id_failed': return tr('机器码暂不可用，请重试。');
    case 'write_failed': return tr('激活码未能保存，请重试。');
    case 'status_unverified': return tr('授权尚未生效，请重新读取会员状态。');
    case 'feature_locked': return tr('此授权已验证，但未解锁当前功能。可继续输入适用的激活码。');
    default: return tr('激活失败，请重试。');
  }
}

function getMembershipStatus(status, locale) {
  if (status.reason === 'loading') return { title: tr('正在加载会员信息…') };
  if (['vip_status_failed', 'status_unavailable', 'machine_id_failed', 'not_ready'].includes(status.reason)) {
    return { unavailable: true, title: tr('会员状态暂不可用'), detail: tr('无法读取本机授权，请重试。') };
  }
  if (status.activated) {
    if (status.scope === 'free') {
      return { title: tr('已验证基础授权'), detail: tr('旧版基础授权保留已有权益。需要完整会员授权的功能仍需升级。') };
    }
    const expirationDate = status.expiresAt > 0 ? new Date(status.expiresAt * 1000) : null;
    const expiry = expirationDate && Number.isFinite(+expirationDate)
      ? tr('有效期至 {0}', { 0: expirationDate.toLocaleDateString(locale) })
      : tr('订阅授权');
    return {
      active: true,
      title: tr('会员版'),
      detail: status.type === 'lifetime' ? tr('永久有效，感谢您的支持') : expiry,
    };
  }
  if (status.reason === 'expired') {
    return { expired: true, title: tr('会员授权已到期'), detail: tr('续期后可继续使用会员权益。') };
  }
  const detail = status.reason && status.reason !== 'no_token'
    ? activationErrorMessage(status.reason)
    : tr('升级会员后解锁多设备、完整产物和深度分析能力');
  return { title: tr('基础版'), detail };
}

export default function MemberCenter({ theme, vipStatus, capability, onActivated, onReturn, onRetry, showToast }) {
  const locale = useLocale();
  const dark = isDarkTheme(theme);
  const status = getMembershipStatus(vipStatus, locale);
  const loading = vipStatus.reason === 'loading';
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [supportError, setSupportError] = useState(false);
  const [copiedMachineId, setCopiedMachineId] = useState('');
  const [recordsOpen, setRecordsOpen] = useState(false);
  const [recordsRefresh, setRecordsRefresh] = useState(0);
  const activationPending = useRef(false);
  const tokenInput = useRef(null);
  const benefits = useRef(null);
  const tokenId = useId();
  const manualId = useId();
  const recordsId = useId();
  const muted = dark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const heading = dark ? 'text-[#E8EAED]' : 'text-slate-800';
  const card = `rounded-xl border shadow-sm ${dark ? 'bg-slate-800/80 border-[#3E4145]' : 'bg-white border-slate-200'}`;
  const panel = dark ? 'bg-[#2D2F33]/70 border-[#3E4145]' : 'bg-slate-50 border-slate-200';
  const secondary = `inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-50 ${dark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`;

  async function activate(event) {
    event.preventDefault();
    const value = token.trim();
    if (!value || activationPending.current) return;
    activationPending.current = true;
    setBusy(true);
    setError('');
    let result;
    try {
      result = await window.electronAPI.vipActivate(value);
    } catch {
      setError('activation_failed');
      return;
    } finally {
      activationPending.current = false;
      setBusy(false);
    }
    if (result?.success !== true || result.status?.activated !== true) {
      setError(result?.error || 'status_unverified');
      return;
    }
    setToken('');
    setManualOpen(false);
    setRecordsRefresh(previous => previous + 1);
    if (capability && !canUseMembershipFeature(result.status, capability)) setError('feature_locked');
    else showToast?.(result.status.scope === 'free' ? tr('已验证基础授权') : tr('会员激活成功，感谢支持！'));
    onActivated?.(result.status);
  }

  async function retryStatus() {
    setRetrying(true);
    try {
      await onRetry?.();
    } finally {
      setRetrying(false);
    }
  }

  async function copyMachineId() {
    const { machineId } = vipStatus;
    if (!machineId) return;
    try {
      await navigator.clipboard.writeText(machineId);
    } catch {
      showToast?.(tr('复制失败'));
      return;
    }
    setCopiedMachineId(machineId);
    showToast?.(tr('机器码已复制'));
    try {
      await window.electronAPI?.vipAddCopyHistory?.({ kind: 'machineId', value: machineId });
      setRecordsRefresh(previous => previous + 1);
    } catch {
      // Copy history does not determine whether the clipboard write succeeded.
    }
  }

  async function openSupport() {
    setSupportError(false);
    try {
      await window.electronAPI.vipOpenSupport();
    } catch {
      setSupportError(true);
    }
  }

  function viewBenefits() {
    benefits.current?.focus({ preventScroll: true });
    benefits.current?.scrollIntoView({ block: 'start' });
  }

  const copyButton = (
    <button type="button" className={secondary} onClick={copyMachineId} disabled={!vipStatus.machineId}>
      <Copy size={15} className="shrink-0" />
      <span aria-live="polite">{copiedMachineId && copiedMachineId === vipStatus.machineId ? tr('已复制') : tr('复制机器码')}</span>
    </button>
  );

  return (
    <div className="w-full min-w-0 space-y-4">
      <section className={`p-4 sm:p-6 ${card} ${status.active ? 'border-amber-500/40' : ''}`} aria-busy={loading || retrying || busy}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${status.active ? 'bg-amber-500/20 text-amber-500' : panel + ' border ' + muted}`}>
              {loading || retrying ? <Loader2 size={22} className="animate-spin" /> : status.active ? <Crown size={22} /> : <Lock size={19} />}
            </div>
            <div className="min-w-0">
              <h3 className={`break-words text-xl font-semibold ${heading}`}>{status.title}</h3>
              {status.detail && <p className={`mt-1 break-words text-sm ${muted}`}>{status.detail}</p>}
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap gap-2">
            {status.active && <button type="button" onClick={viewBenefits} className={secondary}>{tr('查看会员权益')}</button>}
            {status.unavailable && <button type="button" onClick={retryStatus} disabled={retrying || !onRetry} className={secondary}><RefreshCw size={15} className={retrying ? 'animate-spin' : ''} />{tr('重试')}</button>}
            {onReturn && <button type="button" data-membership-return onClick={onReturn} disabled={busy} className={secondary}><ArrowLeft size={15} className="shrink-0" />{tr('返回原操作')}</button>}
          </div>
        </div>

        {!loading && !status.active && (
          <div className={`mt-5 rounded-xl border p-3 sm:p-4 ${panel}`}>
            <form onSubmit={activate} className="space-y-2">
              <label htmlFor={tokenId} className={`block text-sm font-medium ${heading}`}>{tr('已有激活码')}</label>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                <textarea
                  id={tokenId}
                  ref={tokenInput}
                  value={token}
                  onChange={event => { setToken(event.target.value); if (error) setError(''); }}
                  placeholder={tr('在此粘贴激活码…')}
                  disabled={busy}
                  aria-invalid={!!error}
                  aria-describedby={error ? `${tokenId}-error` : undefined}
                  autoComplete="off"
                  spellCheck={false}
                  rows={2}
                  className={`w-full min-w-0 resize-y rounded-lg border px-3 py-2 font-mono text-sm focus-visible:ring-2 focus-visible:ring-amber-400 ${dark ? 'border-[#5F6368] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-700'}`}
                />
                <button type="submit" disabled={busy || !token.trim()} className={`shrink-0 ${primaryButton}`}>
                  {busy ? <Loader2 size={16} className="shrink-0 animate-spin" /> : <KeyRound size={16} className="shrink-0" />}
                  {busy ? tr('正在激活…') : tr('激活会员')}
                </button>
              </div>
              {error && <p id={`${tokenId}-error`} role="alert" className={`text-sm ${dark ? 'text-red-300' : 'text-red-700'}`}>{activationErrorMessage(error)}</p>}
            </form>

            <button type="button" aria-controls={manualId} aria-expanded={manualOpen} onClick={() => setManualOpen(open => !open)} className={`mt-3 ${secondary}`}>
              {status.expired ? tr('续期方式') : tr('开通方式')}
              <ChevronDown size={15} className={`shrink-0 ${manualOpen ? 'rotate-180' : ''}`} />
            </button>
            <div id={manualId} hidden={!manualOpen} className="mt-4">
              <h4 className={`text-sm font-semibold ${heading}`}>{tr('人工开通')} · {tr('终身买断')} · ¥99</h4>
              <ol className={`mt-3 list-decimal space-y-3 pl-5 text-sm ${muted}`}>
                <li><span className={heading}>{tr('复制本机信息')}</span><div className="mt-1">{copyButton}</div></li>
                <li>
                  <span className={heading}>{tr('联系开发者获取激活码')}</span>
                  <p className="mt-1">{tr('请通过私下沟通发送机器码，获取绑定本机的激活码。')}</p>
                  <p className="mt-1">{tr('在项目反馈中询问开通联系方式。请勿公开机器码或激活码。')}</p>
                  <button type="button" className={`mt-2 ${secondary}`} onClick={openSupport}>{tr('打开项目反馈')}</button>
                  {supportError && <p className={`mt-1 ${dark ? 'text-red-300' : 'text-red-700'}`} role="alert">{tr('未能打开项目反馈。')}</p>}
                </li>
                <li><button type="button" onClick={() => tokenInput.current?.focus()} disabled={busy} className={`${heading} underline underline-offset-2 disabled:opacity-50`}>{tr('粘贴激活码')}</button><p className="mt-1">{tr('获取后在上方粘贴激活码，再提交确认。')}</p></li>
              </ol>
              {!vipStatus.machineId && <p className={`mt-3 text-sm ${muted}`}>{tr('机器码暂不可用，请重试。')}</p>}
            </div>
          </div>
        )}
      </section>

      <section ref={benefits} tabIndex={-1} aria-label={tr('查看会员权益')} className="scroll-mt-4 focus-visible:outline-amber-400">
        <MembershipBenefits theme={theme} />
      </section>

      {!loading && (
        <section className={card}>
          <button type="button" aria-expanded={recordsOpen} aria-controls={recordsId} onClick={() => setRecordsOpen(open => !open)} className={`flex w-full items-center justify-between gap-3 rounded-xl p-4 text-left text-sm font-semibold focus-visible:ring-2 focus-visible:ring-amber-400 ${heading}`}>
            {tr('会员记录与重签')}
            <ChevronDown size={16} className={`shrink-0 ${recordsOpen ? 'rotate-180' : ''}`} />
          </button>
          <div id={recordsId} hidden={!recordsOpen} className="space-y-3 px-4 pb-4">
            <div className={`rounded-lg border p-3 ${panel}`}>
              <h4 className={`text-sm font-medium ${heading}`}>{tr('本机机器码')}</h4>
              <p className={`mt-1 text-xs ${muted}`}>{tr('如需重签，请复制机器码并联系开发者。')}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className={`min-w-0 break-all text-xs ${heading}`}>{vipStatus.machineId || tr('机器码暂不可用，请重试。')}</code>
                {copyButton}
              </div>
            </div>
            {recordsOpen && <ActivationRecordsPanel theme={theme} showToast={showToast} refreshKey={recordsRefresh} />}
          </div>
        </section>
      )}
    </div>
  );
}
