import { useEffect, useRef, useState } from 'react';
import { Copy, Download, FileCode2, Loader2, RefreshCw, Save, X } from 'lucide-react';
import { formatSshBytes, sshResult } from '../../shared/sshWorkspace';

export default function SshEditorTabs({ session, documents, activeDocumentId, onSelect, onEdit, onSave, onClose, onReload, loading, theme, showToast }) {
  const document = documents.find(item => item.documentId === activeDocumentId) || documents[0];
  const [pages, setPages] = useState({});
  const [pageLoading, setPageLoading] = useState('');
  const alive = useRef(true);
  const connected = session.status === 'connected';
  const button = `inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs disabled:opacity-40 ${theme.button.secondary}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const preview = document && (pages[document.documentId]?.current || document);
  const copy = async () => {
    try { await navigator.clipboard.writeText(document.readOnly ? preview.text || '' : document.draft); showToast?.('文件内容已复制'); }
    catch { showToast?.('复制失败，请手动选择内容复制'); }
  };
  const page = async next => {
    if (pageLoading || !document) return;
    const captured = document;
    const history = pages[captured.documentId]?.history || [0];
    const offset = next ? preview.nextOffset : history.at(-2) || 0;
    setPageLoading(captured.documentId);
    try {
      const result = sshResult(await window.electronAPI.sshPreview({ sessionId: session.id, path: captured.path, offset, limit: 256 * 1024 }));
      if (result.sessionId !== session.id) throw new Error('预览所属 SSH 会话不匹配');
      if (alive.current) setPages(previous => ({ ...previous, [captured.documentId]: { current: result, history: next ? [...history, offset] : history.slice(0, -1) } }));
    } catch (error) { showToast?.(error.message); }
    finally { if (alive.current) setPageLoading(''); }
  };

  return <section aria-label="SSH 文件编辑器" className={`flex h-full min-h-0 min-w-0 flex-col rounded-lg border ${theme.card}`}>
    <div role="tablist" aria-label="SSH 文件标签" className="flex min-h-9 shrink-0 overflow-x-auto border-b border-slate-400/20">
      {documents.map(item => <div key={item.documentId} className={`flex min-w-0 max-w-56 shrink-0 items-center border-r border-slate-400/15 ${item.documentId === document?.documentId ? 'bg-emerald-500/10' : ''}`}><button type="button" role="tab" aria-selected={item.documentId === document?.documentId} onClick={() => onSelect(item.documentId)} title={item.path} className="flex min-w-0 items-center gap-1.5 px-3 py-2 text-xs"><FileCode2 size={13} className="shrink-0" /><span className="truncate">{item.path.split('/').at(-1) || item.path}{item.dirty ? ' ●' : ''}</span></button><button type="button" aria-label={`关闭文件 ${item.path}`} disabled={item.saving} onClick={() => onClose(item)} className="mr-1 rounded p-1 disabled:opacity-30"><X size={12} /></button></div>)}
      {!documents.length && <span className={`px-3 py-2 text-xs ${theme.textMuted}`}>文件预览 / 编辑</span>}
    </div>
    {loading && <p className={`flex items-center gap-2 px-3 py-2 text-xs ${theme.textMuted}`}><Loader2 size={13} className="animate-spin" />正在打开远端文件…</p>}
    {!document ? <div className={`flex min-h-0 flex-1 items-center justify-center p-5 text-center text-xs leading-6 ${theme.textMuted}`}>从左侧选择文件即可查看或编辑<br />文件区和终端可同时操作</div> : <>
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-400/15 px-2 py-1.5"><span className={`min-w-0 flex-1 truncate text-[11px] ${theme.textMuted}`} title={document.path}>{document.path}</span><button type="button" onClick={copy} disabled={document.kind !== 'text'} className={button} title="复制当前内容"><Copy size={12} /></button><button type="button" aria-label="重新读取 SSH 文件" title="重新读取远端文件" disabled={!connected || document.saving} onClick={() => onReload(document)} className={button}><RefreshCw size={12} /></button><button type="button" aria-label="下载当前 SSH 文件" title="下载当前文件" disabled={!connected} onClick={async () => { try { sshResult(await window.electronAPI.sshDownload({ sessionId: session.id, sources: [document.path] })); } catch (error) { showToast?.(error.message); } }} className={button}><Download size={12} /></button><button type="button" onClick={() => onSave(document)} disabled={!connected || document.readOnly || document.remoteMissing || document.kind !== 'text' || !document.dirty || document.saving} className={button}><Save size={12} />{document.saving ? '保存中…' : '保存到远端'}</button></div>
      {document.remoteMissing && <div role="alert" className="shrink-0 break-words px-3 py-2 text-xs text-amber-500"><p>{document.kind === 'text' ? '远端文件已删除，本地内容仍保留，可复制' : '远端文件已删除，本地预览仍保留'}</p>{document.kind === 'text' && <button type="button" onClick={copy} className={`mt-1 ${button}`}><Copy size={12} />复制草稿</button>}</div>}
      {document.error && !document.remoteMissing && <div role="alert" className="shrink-0 break-words px-3 py-2 text-xs text-red-500"><p>{document.error}{document.errorCode.includes('CONFLICT') ? '。请先复制当前修改，再重新读取远端文件后合并；不会强制覆盖。' : ''}</p>{document.kind === 'text' && !document.readOnly && <button type="button" onClick={copy} className={`mt-1 ${button}`}><Copy size={12} />复制草稿</button>}</div>}
      {document.kind === 'text' ? <textarea aria-label="SSH 文件编辑内容" value={document.readOnly ? preview.text || '' : document.draft} readOnly={document.readOnly} spellCheck={false} maxLength={2 * 1024 * 1024} onChange={event => onEdit(document.documentId, event.target.value)} onKeyDown={event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (connected && !document.readOnly && !document.remoteMissing && document.dirty && !document.saving) onSave(document); }
        if (event.key === 'Tab' && !event.ctrlKey && !event.altKey && !event.metaKey && !document.readOnly) { event.preventDefault(); const target = event.currentTarget; const start = target.selectionStart; const end = target.selectionEnd; onEdit(document.documentId, document.draft.slice(0, start) + '\t' + document.draft.slice(end)); requestAnimationFrame(() => target.setSelectionRange(start + 1, start + 1)); }
      }} className={`min-h-0 w-full flex-1 resize-none border-0 p-3 font-mono text-xs leading-5 outline-none ${theme.input}`} />
        : document.kind === 'image' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(document.dataUrl || '') ? <div className="min-h-0 flex-1 overflow-auto p-3"><img src={document.dataUrl} alt={document.path.split('/').at(-1)} className="mx-auto max-h-full max-w-full object-contain" /></div>
          : <div className={`flex flex-1 items-center justify-center p-5 text-center text-xs ${theme.textMuted}`}>此文件不支持直接编辑，请下载后查看。</div>}
      <div className={`flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-400/20 px-3 py-1.5 text-[11px] ${theme.textMuted}`}><span>{formatSshBytes(document.size)} · {document.readOnly ? '只读预览' : document.dirty ? '有未保存修改 · Ctrl+S 保存' : '与已读取 / 保存版本一致'}{!connected ? ' · 已断开，保留本地编辑' : ''}</span>{document.readOnly && document.kind === 'text' && <div className="flex items-center gap-2"><button type="button" disabled={!connected || Boolean(pageLoading) || !(pages[document.documentId]?.history.length > 1)} onClick={() => page(false)} className="disabled:opacity-40">上一页</button><span>{formatSshBytes(preview.offset || 0)}</span><button type="button" disabled={!connected || Boolean(pageLoading) || !preview.hasMore} onClick={() => page(true)} className="disabled:opacity-40">下一页</button></div>}</div>
    </>}
  </section>;
}
