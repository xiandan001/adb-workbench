import { tr, useLocale } from '../../shared/i18n.js';
import { useEffect, useId, useRef, useState } from 'react';
import { KeyRound, Loader2, X } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import { sshResult } from '../../shared/sshWorkspace';

export default function SshConnectionDialog({ profile, theme, isDark, onClose, onSaved, onConnected }) {
  useLocale();
  const dialogRef = useRef(null);
  const id = useId();
  const alive = useRef(true);
  const [form, setForm] = useState(() => ({ name: profile?.name || '', host: profile?.host || '', port: String(profile?.port || 22), username: profile?.username || '', authType: profile?.authType || 'password' }));
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [keyFile, setKeyFile] = useState(null);
  const [saveProfile, setSaveProfile] = useState(true);
  const [rememberCredentials, setRememberCredentials] = useState(Boolean(profile?.hasSavedCredential));
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const reusable = profile?.hasSavedCredential && profile.authType === form.authType && profile.host === form.host.trim()
    && profile.username === form.username.trim() && profile.port === Number(form.port);
  const field = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${theme.input}`;
  const update = (key, value) => setForm(previous => ({ ...previous, [key]: value }));

  useEffect(() => {
    const dialog = dialogRef.current;
    alive.current = true;
    dialog.showModal();
    return () => { alive.current = false; dialog.close(); };
  }, []);

  const selectKey = async () => {
    setError('');
    try {
      const result = sshResult(await window.electronAPI.sshSelectKey(), tr("无法选择私钥"));
      if (!result.cancelled && result.keyToken && alive.current) setKeyFile({ token: result.keyToken, name: result.name });
    } catch (failure) { if (alive.current) setError(failure.message); }
  };
  const submit = async kind => {
    if (busy) return;
    setError('');
    try {
      const port = Number(form.port);
      if (!form.host.trim() || !form.username.trim() || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error(tr("请填写主机、用户名及 1–65535 的端口"));
      if (kind === 'connect' && !reusable && form.authType === 'password' && !password) throw new Error(tr("请输入登录密码"));
      if (kind === 'connect' && !reusable && form.authType === 'key' && !keyFile) throw new Error(tr("请选择用于登录的私钥"));
      if (rememberCredentials && (kind === 'save' || saveProfile) && !reusable
        && (form.authType === 'password' ? !password : !keyFile)) throw new Error(tr("请填写要保存的登录凭据，或取消安全保存凭据；更换主机或用户名后不会自动复用旧凭据"));
      const auth = form.authType === 'password' ? (password ? { password } : {})
        : { ...(keyFile ? { keyToken: keyFile.token } : {}), ...(passphrase ? { passphrase } : {}) };
      const request = { profile: { ...(profile?.id ? { id: profile.id } : {}), ...form, host: form.host.trim(), username: form.username.trim(), name: form.name.trim() || form.host.trim(), port },
        ...(Object.keys(auth).length ? { auth } : {}), saveProfile: kind === 'save' || saveProfile, rememberCredentials: (kind === 'save' || saveProfile) && rememberCredentials };
      setBusy(kind);
      const result = sshResult(await window.electronAPI[kind === 'save' ? 'sshSaveProfile' : 'sshConnect'](request));
      if (!alive.current || result.cancelled) return;
      setPassword(''); setPassphrase(''); setKeyFile(null);
      if (kind === 'save') onSaved(result.profiles); else onConnected(result.sessionId);
      onClose();
    } catch (failure) { if (alive.current) setError(failure.message || tr("SSH 操作未完成")); }
    finally { if (alive.current) setBusy(''); }
  };

  return <dialog ref={dialogRef} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className={`m-auto max-h-[90vh] w-[min(620px,calc(100vw-32px))] overflow-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <div className="flex items-center justify-between gap-3"><h2 id={`${id}-title`} className="font-semibold">{profile ? tr("编辑 SSH 连接") : tr("新建 SSH 连接")}</h2><button type="button" disabled={Boolean(busy)} onClick={onClose} aria-label={tr("关闭 SSH 连接设置")} className="rounded p-1 disabled:opacity-40"><X size={18} /></button></div>
    <form className="mt-4 space-y-3" onSubmit={event => { event.preventDefault(); void submit('connect'); }}>
      <fieldset disabled={Boolean(busy)} className="space-y-3 disabled:opacity-60">
        <label className="block space-y-1 text-xs">{tr("连接名称")}<input aria-label={tr("SSH 连接名称")} value={form.name} maxLength={80} onChange={event => update('name', event.target.value)} placeholder={tr("例如：测试服务器")} className={field} /></label>
        <div className="grid grid-cols-[minmax(0,1fr)_100px] gap-3"><label className="space-y-1 text-xs">{tr("主机")}<input aria-label={tr("SSH 主机")} value={form.host} maxLength={255} onChange={event => update('host', event.target.value)} placeholder={tr("IP 或主机名")} className={field} /></label><label className="space-y-1 text-xs">{tr("端口")}<input aria-label={tr("SSH 端口")} type="number" min="1" max="65535" value={form.port} onChange={event => update('port', event.target.value)} className={field} /></label></div>
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-xs">{tr("用户名")}<input aria-label={tr("SSH 用户名")} value={form.username} autoComplete="username" maxLength={128} onChange={event => update('username', event.target.value)} className={field} /></label><div className="space-y-1 text-xs"><label htmlFor={`${id}-auth`}>{tr("认证方式")}</label><SelectMenu id={`${id}-auth`} isDark={isDark} value={form.authType} disabled={Boolean(busy)} onChange={value => update('authType', value)} options={[{ value: 'password', label: tr("密码登录") }, { value: 'key', label: tr("私钥登录") }]} /></div></div>
        {form.authType === 'password' ? <label className="block space-y-1 text-xs">{tr("密码")}<input aria-label={tr("SSH 密码")} type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} placeholder={reusable ? tr("留空使用已保存凭据") : tr("登录密码")} className={field} /></label> : <div className="space-y-3"><div className="flex items-center gap-2"><button type="button" onClick={selectKey} className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}><KeyRound size={14} />{tr("选择私钥文件")}</button><span className={`min-w-0 truncate text-xs ${theme.textMuted}`}>{keyFile?.name || (reusable ? tr("留空使用已保存私钥") : tr("尚未选择私钥"))}</span></div><label className="block space-y-1 text-xs">{tr("私钥口令（如有）")}<input aria-label={tr("SSH 私钥口令")} type="password" autoComplete="off" value={passphrase} onChange={event => setPassphrase(event.target.value)} className={field} /></label></div>}
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={saveProfile} onChange={event => setSaveProfile(event.target.checked)} />{tr("保存连接信息")}</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={rememberCredentials} disabled={!saveProfile} onChange={event => setRememberCredentials(event.target.checked)} />{tr("安全保存登录凭据")}</label>
        <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr("主机指纹由系统对话框确认。密码和私钥不会放入浏览器本地存储；未保存的凭据仅用于本次操作。")}</p>
        {profile?.hasSavedCredential && saveProfile && !rememberCredentials && <p className="text-xs text-amber-500">{tr("保存后将移除这条连接已保存的登录凭据，下次需要重新输入。")}</p>}
      </fieldset>
      {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
      <div className="flex flex-wrap justify-end gap-2 pt-2"><button type="button" disabled={Boolean(busy)} onClick={onClose} className={`rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}>{tr("取消")}</button>{saveProfile && <button type="button" disabled={Boolean(busy)} onClick={() => submit('save')} className={`rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`}>{tr("仅保存连接")}</button>}<button type="submit" disabled={Boolean(busy)} className={`inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}>{busy && <Loader2 size={14} className="animate-spin" />}{busy === 'connect' ? tr("正在连接…") : tr("连接 SSH")}</button></div>
    </form>
  </dialog>;
}
