import { tr, useLocale } from '../../shared/i18n.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, TerminalSquare, X } from 'lucide-react';
import SshFileTree from './SshFileTree';
import SshEditorTabs from './SshEditorTabs';
import SshTerminal from './SshTerminal';
import SshSplitPanels from './SshSplitPanels';
import { MAX_SSH_DOCUMENTS, sshResult } from '../../shared/sshWorkspace';
import { confirmAppMessage } from '../../shared/appMessageDialog';

const EMPTY_VIEW = { documents: [], activeDocumentId: '', activeTerminalId: '', directory: '' };
export default function SshSessionWorkspace({ session, view = EMPTY_VIEW, active, layout, onLayout, onCommitLayout, onAction, fileRevision, historyRevision, theme, isDark, showToast }) {
  useLocale();
  const alive = useRef(true); const stateRef = useRef(view); const opening = useRef(new Set()); const saving = useRef(new Set());
  const [loading, setLoading] = useState(false); const [error, setError] = useState(''); const [terminalBusy, setTerminalBusy] = useState('');
  const selectedTerminal = session.terminals?.find(item => item.id === view.activeTerminalId) || session.terminals?.[0];
  useEffect(() => { stateRef.current = view; }, [view]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const directoryChanged = useCallback((path, revision) => onAction({ type: 'directory', sessionId: session.id, path, revision }), [onAction, session.id]);
  const closeToken = async documentId => { try { await window.electronAPI.sshCloseDocument({ sessionId: session.id, documentId }); } catch { /* Session disposal already releases its tokens. */ } };
  const openFile = async (path, replace = false) => {
    const existing = stateRef.current.documents.find(item => item.path === path);
    if (existing && !replace) { onAction({ type: 'select-document', sessionId: session.id, documentId: existing.documentId }); return; }
    if (opening.current.has(path)) return;
    if (!existing && stateRef.current.documents.length >= MAX_SSH_DOCUMENTS) { setError(tr("请先关闭部分文件，每个会话最多打开 {0} 个文件", { 0: MAX_SSH_DOCUMENTS })); return; }
    opening.current.add(path); setLoading(true); setError(''); let opened;
    try {
      opened = sshResult(await window.electronAPI.sshOpenDocument({ sessionId: session.id, path }));
      if (opened.sessionId !== session.id) throw new Error(tr("文件所属 SSH 会话不匹配"));
      if (!alive.current) { await closeToken(opened.documentId); return; }
      const current = stateRef.current.documents.find(item => item.path === path);
      if (replace && current?.draft !== existing?.draft) throw new Error(tr("读取期间又有新修改，已保留当前草稿；请复制后重新读取"));
      onAction({ type: replace ? 'replace-document' : 'open-document', sessionId: session.id, document: opened });
      if (replace && existing && existing.documentId !== opened.documentId) void closeToken(existing.documentId);
    } catch (failure) { if (opened?.documentId) void closeToken(opened.documentId); if (alive.current) setError(failure.message); }
    finally { opening.current.delete(path); if (alive.current) setLoading(opening.current.size > 0); }
  };
  const saveFile = async document => {
    if (session.status !== 'connected' || !document.dirty || document.readOnly || document.remoteMissing || saving.current.has(document.documentId)) return;
    saving.current.add(document.documentId); const text = document.draft;
    onAction({ type: 'save-started', sessionId: session.id, documentId: document.documentId, text });
    try {
      const result = sshResult(await window.electronAPI.sshSaveDocument({ sessionId: session.id, documentId: document.documentId, revision: document.revision, text }));
      if (alive.current) { onAction({ type: 'save-succeeded', sessionId: session.id, documentId: document.documentId, revision: result.revision, text }); showToast?.(tr("已保存到 {0}：{1}", { 0: session.name, 1: document.path })); }
    } catch (failure) { if (alive.current) onAction({ type: 'save-failed', sessionId: session.id, documentId: document.documentId, error: failure.message, code: failure.code }); }
    finally { saving.current.delete(document.documentId); }
  };
  const closeFile = async document => {
    if (document.saving) return;
    if (document.dirty && !await confirmAppMessage({ type: 'warning', title: tr("放弃未保存修改？"), message: document.path, detail: tr("关闭文件会放弃本地未保存内容，不会写回远端。"), confirmLabel: tr("放弃修改并关闭") })) return;
    const current = stateRef.current.documents.find(item => item.documentId === document.documentId);
    if (!alive.current || !current || current.saving || current.draft !== document.draft) { if (alive.current) setError(tr("文件状态已变化，已保留当前草稿，请重新确认。")); return; }
    onAction({ type: 'close-document', sessionId: session.id, documentId: document.documentId, discard: true }); void closeToken(document.documentId);
  };
  const reload = async document => {
    if (document.dirty && !await confirmAppMessage({ type: 'warning', title: tr("重新读取远端文件？"), message: document.path, detail: tr("重新读取会放弃本地未保存修改。"), confirmLabel: tr("放弃修改并重新读取") })) return;
    const current = stateRef.current.documents.find(item => item.documentId === document.documentId);
    if (!alive.current || !current || current.saving || current.draft !== document.draft) { if (alive.current) setError(tr("文件状态已变化，已保留当前草稿，请重新确认。")); return; }
    void openFile(document.path, true);
  };
  const terminalAction = async terminalId => {
    if (terminalBusy) return; setTerminalBusy(terminalId || 'new'); setError('');
    try {
      const result = sshResult(await window.electronAPI[terminalId ? 'sshCloseTerminal' : 'sshOpenTerminal']({ sessionId: session.id, ...(terminalId ? { terminalId } : { cols: 80, rows: 24 }) }));
      if (!terminalId && result.terminalId && alive.current) onAction({ type: 'select-terminal', sessionId: session.id, terminalId: result.terminalId });
    } catch (failure) { if (alive.current) setError(failure.message); }
    finally { if (alive.current) setTerminalBusy(''); }
  };
  const terminalPane = <section aria-label={tr("SSH 多终端")} className={`flex h-full min-h-0 min-w-0 flex-col rounded-lg border ${theme.card}`}>
    <div className="flex shrink-0 items-center border-b border-slate-400/20"><div role="tablist" aria-label={tr("SSH 终端标签")} className="flex min-w-0 flex-1 overflow-x-auto">{(session.terminals || []).map(item => <div key={item.id} className={`flex shrink-0 items-center ${selectedTerminal?.id === item.id ? 'bg-emerald-500/10' : ''}`}><button type="button" role="tab" aria-selected={selectedTerminal?.id === item.id} onClick={() => onAction({ type: 'select-terminal', sessionId: session.id, terminalId: item.id })} className="flex items-center gap-1.5 px-2 py-2 text-xs"><TerminalSquare size={12} />{tr(item.title) || tr("终端")}{item.status === 'closed' ? tr("（已结束）") : ''}</button><button type="button" aria-label={tr("关闭 SSH 终端 {0}", { 0: tr(item.title) || item.id })} title={tr("只关闭该终端，不影响文件传输")} disabled={Boolean(terminalBusy)} onClick={() => terminalAction(item.id)} className="mr-1 rounded p-1 disabled:opacity-40"><X size={12} /></button></div>)}</div><button type="button" aria-label={tr("新建 SSH 终端")} title={tr("在当前主机新建终端")} disabled={session.status !== 'connected' || Boolean(terminalBusy)} onClick={() => terminalAction()} className="shrink-0 rounded p-2 disabled:opacity-40"><Plus size={15} /></button></div>
    <div className="min-h-0 flex-1 p-2">{(session.terminals || []).map(item => <div key={item.id} hidden={selectedTerminal?.id !== item.id} className="h-full min-h-0"><SshTerminal session={session} terminal={item} historyRevision={historyRevision} onNewTerminal={() => terminalAction()} active={active && selectedTerminal?.id === item.id} theme={theme} isDark={isDark} showToast={showToast} /></div>)}{!session.terminals?.length && <p className={`p-5 text-center text-xs ${theme.textMuted}`}>{tr("暂无终端，点击 + 新建。文件区仍可使用。")}</p>}</div>
  </section>;
  return <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">{error && <p role="alert" className="max-h-16 shrink-0 overflow-auto break-words text-xs text-red-500">{tr(error)}</p>}<div className="min-h-0 flex-1"><SshSplitPanels layout={layout} onChange={onLayout} onCommit={onCommitLayout}
    left={<SshFileTree session={session} active={active} path={view.directory} directoryRevision={view.directoryRevision || 0} onPath={directoryChanged} onOpen={openFile} onMoved={({ source, path }) => onAction({ type: 'move-path', sessionId: session.id, source, path })} onDeleted={path => onAction({ type: 'delete-path', sessionId: session.id, path })} refreshKey={fileRevision} theme={theme} showToast={showToast} />}
    top={<SshEditorTabs session={session} documents={view.documents} activeDocumentId={view.activeDocumentId} onSelect={documentId => onAction({ type: 'select-document', sessionId: session.id, documentId })} onEdit={(documentId, text) => onAction({ type: 'edit-document', sessionId: session.id, documentId, text })} onSave={saveFile} onClose={closeFile} onReload={reload} loading={loading} theme={theme} showToast={showToast} />}
    bottom={terminalPane} /></div></div>;
}
