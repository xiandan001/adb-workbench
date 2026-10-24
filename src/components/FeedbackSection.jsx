import { tr, useLocale, getLocale } from '../shared/i18n';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { CheckCircle2, Copy, FileText, KeyRound, Loader2, MessageSquare, ShieldAlert, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { isDarkTheme } from '../shared/theme';
import { trapAppMessageFocus } from '../shared/appMessageDialog';
import { FEEDBACK_CATEGORIES, canSubmitFeedback, createFeedbackState, createFeedbackReportSession, feedbackEnvironmentRows, feedbackResponse, pollFeedbackAuthorization, publicFeedbackAuth } from '../shared/feedbackUi';

const REPOSITORY = 'xiandan001/adb-workbench';
function Authorization({ auth, busy, error, copied, submitting, theme, onAction, onCopy }) {
  useLocale();
  const button = `inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  return <section aria-label={tr("GitHub 反馈授权")} className="rounded-xl border border-slate-400/20 p-3">
    <div className="flex flex-wrap items-center gap-2"><KeyRound size={16} /><span className="min-w-0 flex-1 text-sm font-medium">{auth?.authenticated ? auth.login ? tr("已授权 @{0}", { 0: auth.login }) : tr("GitHub 已授权") : tr("GitHub 授权")}</span>
      {auth?.configured && !auth.pending && <button type="button" disabled={Boolean(busy) || submitting} onClick={() => onAction('start')} className={button}>{busy === 'start' && <Loader2 size={13} className="animate-spin" />}{auth.authenticated ? tr("重新授权 GitHub") : tr("授权 GitHub")}</button>}
      {auth?.pending && <button type="button" disabled={Boolean(busy) || submitting} onClick={() => onAction('cancel')} className={button}>{tr("取消授权")}</button>}
      {auth?.authenticated && !auth.pending && <button type="button" disabled={Boolean(busy) || submitting} onClick={() => onAction('logout')} className={button}>{tr("退出 GitHub 授权")}</button>}
    </div>
    {!auth ? <p className={`mt-2 text-xs ${theme.textMuted}`}>{tr("正在读取授权状态…")}</p> : !auth.configured ? <p className="mt-2 text-xs leading-5 text-amber-500">{tr("GitHub 反馈授权尚未配置，当前无法提交。可以先填写和预览报告，内容不会发送。")}</p>
      : auth.pending ? <div className="mt-2 space-y-2"><p className={`text-xs leading-5 ${theme.textMuted}`}>{tr("请在已打开的 GitHub 授权页面输入以下验证码，授权后会自动更新状态。")}</p><div className="flex items-center gap-3"><code aria-label={tr("GitHub 授权验证码")} className="select-all rounded-lg bg-slate-400/10 px-3 py-2 font-mono text-lg font-semibold tracking-wider">{auth.userCode || tr("正在准备验证码…")}</code><button type="button" disabled={!auth.userCode} onClick={onCopy} className={button}><Copy size={13} />{tr("复制验证码")}</button></div><p className={`break-all text-[11px] ${theme.textMuted}`}>https://github.com/login/device{auth.expiresAt ? tr(" · 有效期至 {0}", { 0: new Date(auth.expiresAt).toLocaleTimeString(getLocale()) }) : ''}</p>{copied && <p role="status" className="text-xs text-emerald-500">{tr("验证码已复制")}</p>}</div>
        : <p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{auth.authenticated ? auth.persistent ? tr("授权已加密保存在本机，可随时退出授权。") : tr("当前仅保存本次会话授权，退出应用后需要重新授权。") : tr("首次提交前需要在浏览器授权 GitHub；不使用开发者的发布凭据。")}</p>}
    {(error || auth?.error) && <p role="alert" className="mt-2 break-words text-xs leading-5 text-amber-500">{error || auth.error}</p>}
  </section>;
}

function EnvironmentPreview({ environment, included, theme }) {
  useLocale();
  return <details className="rounded-lg border border-slate-400/15 px-3 py-2"><summary className={`cursor-pointer text-xs ${theme.textMuted}`}>{tr("自动采集的环境信息")}{included ? tr("（将随报告发送）") : tr("（不随报告发送）")}</summary><dl className="mt-3 grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">{feedbackEnvironmentRows(environment).map(row => <div key={row.label} className="contents"><dt className={theme.textMuted}>{row.label}</dt><dd className="min-w-0 break-words">{row.value}</dd></div>)}</dl><p className={`mt-3 text-[11px] leading-5 ${theme.textMuted}`}>{tr("不包含主机名、MAC、IP 或设备序列号；无法获取的信息会标为不可用。最终内容以提交前预览为准。")}</p></details>;
}

function ReportFields({ report, session, environment, theme, isDark, formId, categoryId }) {
  useLocale();
  const input = `mt-1 w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`;
  const set = (field, value) => session.change(field, value);
  return <form id={formId} onSubmit={event => { event.preventDefault(); void session.preview(); }} className="space-y-3">
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
      <div className="min-w-0"><label htmlFor={`${formId}-title`} className="block text-xs leading-5">{tr("问题标题 ")}<span className="text-red-500">*</span></label><input id={`${formId}-title`} aria-label={tr("问题标题")} required maxLength={120} value={report.draft.title} onChange={event => set('title', event.target.value)} className={`${input} h-10`} placeholder={tr("一句话说明遇到的问题")} /></div>
      <div className="min-w-0"><label htmlFor={categoryId} className="block text-xs leading-5">{tr("问题分类")}</label><SelectMenu id={categoryId} value={report.draft.category} options={FEEDBACK_CATEGORIES} onChange={value => set('category', value)} isDark={isDark} className="mt-1 [&>button]:h-10" /></div>
    </div>
    <label className="block text-xs">{tr("问题描述 ")}<span className="text-red-500">*</span><textarea aria-label={tr("问题描述")} required maxLength={4000} rows={4} value={report.draft.description} onChange={event => set('description', event.target.value)} className={`${input} resize-y`} placeholder={tr("发生了什么？是否稳定复现？请勿填写密码或密钥。")} /></label>
    <div className="grid gap-3 sm:grid-cols-2"><label className="block text-xs">{tr("复现步骤（可选）")}<textarea aria-label={tr("复现步骤")} maxLength={4000} rows={3} value={report.draft.steps} onChange={event => set('steps', event.target.value)} className={`${input} resize-y`} placeholder={tr("1. 打开…\n2. 点击…")} /></label><label className="block text-xs">{tr("预期结果（可选）")}<textarea aria-label={tr("预期结果")} maxLength={2000} rows={3} value={report.draft.expected} onChange={event => set('expected', event.target.value)} className={`${input} resize-y`} placeholder={tr("你期望软件怎样运行？")} /></label></div>
    <div className="space-y-2 rounded-lg border border-slate-400/20 p-3"><label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={report.draft.includeEnvironment} onChange={event => set('includeEnvironment', event.target.checked)} className="mt-1 accent-emerald-500" />{tr("包含电脑和系统信息")}</label><label className="flex items-start gap-2 text-xs leading-5"><input type="checkbox" checked={report.draft.includeLogs} onChange={event => set('includeLogs', event.target.checked)} className="mt-1 accent-emerald-500" />{tr("附带卓控台诊断日志")}</label><p className={`pl-5 text-[11px] leading-5 ${theme.textMuted}`}>{tr("日志默认不勾选。勾选后自动收集本软件的安全日志尾部，最多 16 KiB；不读取设备、串口或 SSH 日志，不需要选择文件。日志将作为 Issue 正文中的折叠文本公开。")}</p></div>
    <EnvironmentPreview environment={environment} included={report.draft.includeEnvironment} theme={theme} />
  </form>;
}

export function FeedbackDialog({ theme, currentPage, onClose }) {
  useLocale();
  const api = window.electronAPI; const isDark = isDarkTheme(theme); const id = useId(); const dialogRef = useRef(null);
  const [report, setReport] = useState(() => createFeedbackState(currentPage));
  const [session] = useState(() => createFeedbackReportSession({ api, initialState: report, onChange: setReport }));
  const [context, setContext] = useState(null); const [loading, setLoading] = useState(true); const [contextError, setContextError] = useState('');
  const [auth, setAuth] = useState(null); const [authBusy, setAuthBusy] = useState(''); const [authError, setAuthError] = useState(''); const [copied, setCopied] = useState(false);
  const alive = useRef(true); const contextTicket = useRef(0); const authTicket = useRef(0); const authRef = useRef(null); const authAction = useRef(''); const closeCancelled = useRef(false);
  const acceptAuth = useCallback(value => { const next = publicFeedbackAuth(value); authRef.current = next; setAuth(next); return next; }, []);
  const loadContext = useCallback(async () => {
    const ticket = ++contextTicket.current; const authEpoch = authTicket.current; setLoading(true); setContextError('');
    try {
      if (typeof api?.feedbackContext !== 'function') throw new Error(tr("反馈接口尚未连接，请使用新版桌面应用并重启后重试"));
      const result = feedbackResponse(await api.feedbackContext());
      if (alive.current && ticket === contextTicket.current) { setContext({ environment: result.environment }); if (authEpoch === authTicket.current) acceptAuth(result.auth); }
    } catch (failure) { if (alive.current && ticket === contextTicket.current) setContextError(failure.message || tr("无法读取反馈信息")); }
    finally { if (alive.current && ticket === contextTicket.current) setLoading(false); }
  }, [api, acceptAuth]);
  const cancelPendingAuth = useCallback(() => {
    if (closeCancelled.current || !authRef.current?.pending && authAction.current !== 'start') return;
    closeCancelled.current = true;
    try { Promise.resolve(api?.feedbackAuthCancel?.()).catch(() => {}); } catch { /* Closing never logs out an existing account. */ }
  }, [api]);
  useEffect(() => {
    alive.current = true; session.activate(); const previous = document.activeElement; const node = dialogRef.current;
    node.showModal(); node.querySelector('input[required]')?.focus({ preventScroll: true }); void loadContext();
    return () => {
      alive.current = false; session.deactivate(); cancelPendingAuth(); node.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [session, loadContext, cancelPendingAuth]);
  useEffect(() => {
    if (!auth?.pending || authBusy) return undefined;
    const ticket = authTicket.current;
    return pollFeedbackAuthorization({ read: () => api.feedbackAuthStatus(),
      onAuth: value => { if (alive.current && ticket === authTicket.current) { authRef.current = value; setAuth(value); setAuthError(''); } },
      onError: message => { if (alive.current && ticket === authTicket.current) setAuthError(message); },
    });
  }, [api, auth?.pending, authBusy]);
  const close = () => {
    if (session.snapshot().busy === 'submit') return;
    alive.current = false; contextTicket.current++; authTicket.current++; session.deactivate(); cancelPendingAuth(); onClose();
  };
  const authorization = async action => {
    if (authAction.current || session.snapshot().busy === 'submit') return;
    const method = { start: 'feedbackAuthStart', cancel: 'feedbackAuthCancel', logout: 'feedbackAuthLogout' }[action];
    if (!method) return;
    const ticket = ++authTicket.current; authAction.current = action; setAuthBusy(action); setAuthError(''); setCopied(false); closeCancelled.current = false;
    try {
      if (typeof api?.[method] !== 'function') throw new Error(tr("GitHub 授权接口尚未连接，请重启应用后重试"));
      const result = feedbackResponse(await api[method]()); if (alive.current && ticket === authTicket.current) acceptAuth(result.auth);
    } catch (failure) { if (alive.current && ticket === authTicket.current) setAuthError(failure.message || tr("授权操作未完成")); }
    finally { if (ticket === authTicket.current) { authAction.current = ''; if (alive.current) setAuthBusy(''); } }
  };
  const copyCode = async () => {
    const code = authRef.current?.userCode; if (!code) return;
    try { await navigator.clipboard.writeText(code); if (alive.current && authRef.current?.pending && authRef.current.userCode === code) setCopied(true); }
    catch { if (alive.current) setAuthError(tr("复制失败，请手动选择验证码复制")); }
  };
  const submitting = report.busy === 'submit'; const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`;
  return <dialog ref={dialogRef} aria-labelledby={`${id}-title`} onKeyDown={trapAppMessageFocus} onCancel={event => { event.preventDefault(); close(); }} className={`m-auto max-h-[calc(100vh-32px)] w-[min(760px,calc(100vw-32px))] overflow-hidden rounded-2xl border p-0 shadow-2xl backdrop:bg-black/55 open:flex open:flex-col ${isDark ? 'border-[#3E4145] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800'}`}>
    <div className="flex shrink-0 items-center gap-3 border-b border-slate-400/15 px-5 py-4"><MessageSquare size={20} className="text-emerald-500" /><h2 id={`${id}-title`} className="min-w-0 flex-1 text-base font-semibold">{tr("反馈问题")}</h2><button type="button" aria-label={tr("关闭反馈问题")} disabled={submitting} onClick={close} className={`rounded-lg p-1.5 disabled:opacity-40 ${theme.button.secondary}`}><X size={18} /></button></div>
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-5 py-4">
      {report.view !== 'success' && <><p className={`flex items-start gap-2 text-xs leading-5 ${theme.textMuted}`}><ShieldAlert size={15} className="mt-0.5 shrink-0 text-amber-500" /><span>{tr("报告将发布到公开仓库 {0}。请勿填写密码、密钥或个人隐私；提交前请核对完整预览。", { 0: REPOSITORY })}</span></p><Authorization auth={auth} busy={authBusy} error={authError} copied={copied} submitting={submitting} theme={theme} onAction={authorization} onCopy={copyCode} /></>}
      {contextError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-500"><span className="min-w-0 flex-1 break-words">{tr(contextError)}</span><button type="button" disabled={loading || submitting} onClick={loadContext} className={button}>{tr("重新读取状态")}</button></div>}
      {report.view === 'edit' && <ReportFields report={report} session={session} environment={context?.environment} theme={theme} isDark={isDark} formId={`${id}-form`} categoryId={`${id}-category`} />}
      {report.view === 'preview' && <section aria-label={tr("提交前预览")} className="space-y-3"><div><h3 className="break-words text-sm font-semibold">{report.preview.title}</h3><p className={`mt-1 text-[11px] leading-5 ${theme.textMuted}`}>{report.preview.log.included ? tr("已附带日志：{0} 字节 · {1} 行{2}", { 0: report.preview.log.bytes, 1: report.preview.log.lines, 2: report.preview.log.truncated ? tr(" · 已截取末尾内容") : '' }) : tr("未附带诊断日志")}{tr(" · 预览有效期至 ")}{new Date(report.preview.expiresAt).toLocaleTimeString(getLocale())}</p></div><p className={`text-xs ${theme.textMuted}`}>{tr("以下是将发送的完整正文（纯文本显示，不会执行 HTML 或 Markdown）：")}</p><pre aria-label={tr("反馈报告预览")} className={`max-h-[45vh] select-text overflow-auto whitespace-pre-wrap break-words rounded-xl border p-3 font-mono text-xs leading-5 [overflow-wrap:anywhere] ${theme.input}`}>{report.preview.body}</pre>{report.uncertain && <p role="status" className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-5 text-amber-500">{tr("结果尚未确认。请使用“检查提交结果”核对原提交，不要重复新建报告；检查不会重新生成报告预览。")}</p>}</section>}
      {report.view === 'success' && <section aria-label={tr("反馈提交成功")} className="py-6 text-center"><CheckCircle2 size={38} className="mx-auto text-emerald-500" /><h3 className="mt-3 text-lg font-semibold">{tr("问题已提交 · #{0}", { 0: report.issue.number })}</h3><p className={`mt-2 text-xs leading-5 ${theme.textMuted}`}>{tr("感谢你的反馈，我们会认真查看。")}</p></section>}
      {report.error && <p role="alert" className="break-words rounded-lg border border-red-500/25 bg-red-500/5 p-3 text-xs leading-5 text-red-500">{tr(report.error)}</p>}
    </div>
    <div className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-slate-400/15 px-5 py-4">
      <button type="button" disabled={submitting} onClick={close} className={button}>{report.view === 'success' ? tr("完成") : tr("取消")}</button>
      {report.view === 'edit' && <button type="submit" form={`${id}-form`} disabled={!context || loading || Boolean(report.busy)} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>{report.busy === 'preview' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />}{tr("生成报告预览")}</button>}
      {report.view === 'preview' && <><button type="button" disabled={submitting || report.uncertain} onClick={() => session.back()} className={button}>{tr("返回修改")}</button><button type="button" disabled={submitting || !canSubmitFeedback(auth, authBusy)} onClick={() => { void session.submit(); }} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>{submitting && <Loader2 size={14} className="animate-spin" />}{submitting ? report.uncertain ? tr("检查中…") : tr("提交中…") : report.uncertain ? tr("检查提交结果") : tr("提交")}</button></>}
    </div>
  </dialog>;
}

export default function FeedbackSection({ theme, onOpen }) {
  useLocale();
  return <section aria-label={tr("问题反馈")} className={`rounded-xl border p-4 ${theme.card}`}><div className="flex flex-wrap items-center gap-3"><MessageSquare size={19} className="text-emerald-500" /><div className="min-w-0 flex-1"><h3 className={`text-sm font-semibold ${theme.text}`}>{tr("问题反馈")}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr("填写问题并核对预览，确认后提交到 GitHub。诊断日志仅在你勾选时附带。")}</p></div><button type="button" onClick={onOpen} className={`rounded-lg px-4 py-2 text-sm ${theme.button.secondary}`}>{tr("反馈问题")}</button></div></section>;
}
