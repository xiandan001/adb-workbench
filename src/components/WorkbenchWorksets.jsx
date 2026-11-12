import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import { confirmAppMessage } from '../shared/appMessageDialog.js';
import SelectMenu from './SelectMenu';

const PAGE_LABELS = () => ({ devices: tr('设备列表'), serial: tr('串口 / RS232'), ssh: tr('SSH 工作区'), troubleshoot: tr('问题排查'),
  quality: tr('质量中心'), tasks: tr('任务中心'), performance: tr('性能监控'), 'ai-workspace': tr('AI 工作区') });
export default function WorkbenchWorksets({ theme, devices, deviceId, packageName = '', page, onRestore }) {
  useLocale();
  const [open, setOpen] = useState(false), [data, setData] = useState({ items: [], context: {} });
  const [name, setName] = useState(''), [target, setTarget] = useState(''), [application, setApplication] = useState('');
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const dialog = useRef(null), mounted = useRef(false), epoch = useRef(0), loadTicket = useRef(0), targetEdited = useRef(false);
  const dark = isDarkTheme(theme), pages = PAGE_LABELS();
  const input = `w-full min-w-0 rounded-lg border px-3 py-2 text-sm ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm disabled:opacity-40 ${theme.button.secondary}`;
  async function load() {
    const request = epoch.current, ticket = ++loadTicket.current;
    const result = await window.electronAPI?.worksetList?.();
    if (!result?.ok) throw new Error(result?.error || tr('工作集读取失败，请重试。'));
    if (mounted.current && request === epoch.current && ticket === loadTicket.current) setData(result);
    return result;
  }
  async function action(operation, run) {
    if (busy) return;
    setBusy(operation); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(''); }
  }
  useEffect(() => {
    if (!open) return;
    mounted.current = true; const request = ++epoch.current, previous = document.activeElement, element = dialog.current;
    element?.showModal(); targetEdited.current = false; setTarget(deviceId || ''); setApplication(packageName || ''); setName(''); setError(''); setNotice(''); setBusy('');
    const ticket = loadTicket.current + 1;
    void load().then(result => { if (mounted.current && request === epoch.current && ticket === loadTicket.current && !targetEdited.current && !packageName && result.context?.application?.deviceId === deviceId) setApplication(result.context.application.packageName); })
      .catch(failure => { if (mounted.current && request === epoch.current && ticket === loadTicket.current) setError(failure.message); });
    return () => { mounted.current = false; epoch.current = request + 1; element?.close(); previous?.focus?.(); };
    // Freeze the selected target when opening: a background discovery refresh must not retarget this form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  async function save(existing) {
    await action('save', async () => {
      const title = name.trim() || existing?.name || '';
      if (!title) throw new Error(tr('请输入工作集名称。'));
      if (existing && !await confirmAppMessage({ title: tr('更新工作集'), message: tr('用当前配置更新“{0}”？', { 0: existing.name }),
        detail: tr('只替换保存的配置，不连接设备或执行命令。'), confirmLabel: tr('更新') })) return;
      loadTicket.current++;
      const result = await window.electronAPI?.worksetSave?.({ ...(existing ? { id: existing.id } : {}), name: title, deviceId: target,
        packageName: application.trim(), page: Object.hasOwn(pages, page) ? page : 'devices' });
      if (!result?.ok) throw new Error(result?.error || tr('工作集保存失败，填写内容已保留。'));
      if (mounted.current) { setData(result); setNotice(tr('工作集已保存，下次可直接恢复配置。')); }
    });
  }
  async function restore(item) {
    await action('restore', async () => {
      const current = await load(), selected = current.items.find(value => value.id === item.id);
      if (!selected) throw new Error(tr('工作集已不存在，请刷新后重试。'));
      await onRestore(selected);
      if (mounted.current) setOpen(false);
    });
  }
  async function remove(item) {
    await action('remove', async () => {
      if (!await confirmAppMessage({ title: tr('删除工作集'), message: tr('删除“{0}”？', { 0: item.name }), detail: tr('只删除这个工作集，不删除设备、连接方案或日志。'), confirmLabel: tr('删除') })) return;
      loadTicket.current++;
      const result = await window.electronAPI?.worksetRemove?.({ id: item.id });
      if (!result?.ok) throw new Error(result?.error || tr('工作集删除失败，请重试。'));
      if (mounted.current) setData(result);
    });
  }
  const selectedContext = data.context || {};
  return <>
    <button type="button" onClick={() => setOpen(true)} className={button} title={tr('保存或恢复设备、应用和调试配置')}><FolderOpen size={16} /><span className="hidden sm:inline">{tr('工作集')}</span></button>
    {open && <dialog ref={dialog} onCancel={event => { event.preventDefault(); if (!busy) setOpen(false); }} aria-label={tr('调试工作集')}
      className={`fixed m-auto max-h-[90vh] w-[min(58rem,calc(100vw-2rem))] rounded-2xl border p-0 shadow-2xl backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
      <header className="flex items-start justify-between gap-3 border-b border-current/10 p-4"><div><h3 className="font-semibold">{tr('调试工作集')}</h3><p className={`mt-1 text-xs leading-5 ${theme.textMuted}`}>{tr('恢复配置不会连接设备、执行命令、开始采集或调用 AI。')}</p></div><button type="button" disabled={Boolean(busy)} onClick={() => setOpen(false)} autoFocus aria-label={tr('关闭')} className="rounded-lg p-2 hover:bg-slate-500/10 disabled:opacity-40"><X size={18} /></button></header>
      <div className="grid max-h-[70vh] gap-5 overflow-y-auto p-4 md:grid-cols-2">
        <section className="min-w-0 space-y-3"><div className="flex items-center justify-between gap-2"><h4 className="text-sm font-semibold">{tr('继续上次工作')}</h4><button type="button" disabled={Boolean(busy)} onClick={() => action('refresh', load)} aria-label={tr('刷新工作集')} className={button}><RefreshCw size={14} /></button></div>
          {!data.items.length && <p className={`rounded-lg border border-dashed p-5 text-xs ${theme.textMuted}`}>{tr('尚未保存工作集，先保存右侧的当前配置。')}</p>}
          {data.items.map(item => <article key={item.id} className={`min-w-0 space-y-2 rounded-xl border p-3 ${theme.input}`}><p className="break-words text-sm font-medium">{item.name}</p><p className={`break-all text-xs leading-5 ${theme.textMuted}`}>{item.deviceId || tr('未指定设备')}{item.packageName ? ` · ${item.packageName}` : ''}</p><p className={`text-xs ${theme.textMuted}`}>{pages[item.page]}</p><div className="flex flex-wrap gap-2"><button type="button" disabled={Boolean(busy)} onClick={() => restore(item)} className={button}>{tr('恢复配置')}</button><button type="button" disabled={Boolean(busy)} onClick={() => save(item)} className={button}>{tr('用当前配置更新')}</button><button type="button" disabled={Boolean(busy)} onClick={() => remove(item)} aria-label={tr('删除工作集')} className="rounded-lg p-2 text-red-500 hover:bg-red-500/10 disabled:opacity-40"><Trash2 size={14} /></button></div></article>)}
        </section>
        <section className="min-w-0 space-y-3"><h4 className="text-sm font-semibold">{tr('保存当前配置')}</h4><label className="block space-y-1 text-xs">{tr('工作集名称')}<input value={name} maxLength={80} disabled={Boolean(busy)} onChange={event => setName(event.target.value)} className={input} /></label>
          <label className="block space-y-1 text-xs">{tr('目标设备')}<SelectMenu value={target} ariaLabel={tr('工作集目标设备')} disabled={Boolean(busy)} isDark={dark} className="w-full" onChange={value => { targetEdited.current = true; setTarget(value); if (value !== target) setApplication(''); }} options={[{ value: '', label: tr('未指定设备') }, ...(target && !devices.some(item => item.id === target) ? [{ value: target, label: `${target} · ${tr('离线')}` }] : []), ...devices.map(item => ({ value: item.id, label: `${item.model || item.id} · ${item.id}` }))]} /></label>
          <label className="block space-y-1 text-xs">{tr('目标应用（可选）')}<input value={application} maxLength={256} disabled={Boolean(busy)} onChange={event => { targetEdited.current = true; setApplication(event.target.value); }} className={input} /></label>
          <div className={`space-y-1 rounded-lg border p-3 text-xs leading-5 ${theme.input}`}><p>{tr('当前页面：{0}', { 0: pages[page] || pages.devices })}</p>
            <p>{tr('日志过滤：{0}', { 0: selectedContext.logs?.deviceId === target ? tr('包含当前设备的过滤配置') : tr('不包含其他设备的过滤配置') })}</p>
            <p>{tr('SSH 配置引用：{0}', { 0: selectedContext.ssh ? tr('已选择') : tr('未选择') })}</p><p>{tr('串口方案引用：{0}', { 0: selectedContext.serial ? tr('已选择') : tr('未选择') })}</p></div>
          <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr('只保存参数和配置引用，不保存密码、命令、终端输出或 AI 材料。最多保存 20 个工作集。')}</p>
          <button type="button" disabled={Boolean(busy) || !name.trim()} onClick={() => save()} className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm disabled:opacity-40 ${theme.button.primary}`}><Save size={15} />{tr('保存工作集')}</button>
        </section>
      </div>
      {(busy || error || notice) && <footer className="flex flex-wrap items-center gap-2 border-t border-current/10 p-4 text-xs">{busy && <Loader2 size={14} className="animate-spin" />}{error && <p role="alert" className="min-w-0 break-words text-red-500">{tr(error)}</p>}{notice && <p role="status" className="text-emerald-500">{notice}</p>}</footer>}
    </dialog>}
  </>;
}
