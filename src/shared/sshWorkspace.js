export const SSH_LAYOUT_KEY = 'adb-workbench.ssh-layout.v1';
export const MAX_SSH_DOCUMENTS = 12;
const MAX_OPEN_BYTES = 64 * 1024 * 1024;
export const DEFAULT_SSH_LAYOUT = Object.freeze({ version: 1, files: 0.27, editor: 0.48, transfersOpen: false, appearance: 'current' });
const initialSession = () => ({ documents: [], activeDocumentId: '', activeTerminalId: '', directory: '', directoryRevision: 0 });
export const emptySshView = () => ({ selectedSessionId: '', sessions: {} });

export function sshWorkspaceReducer(state, action) {
  if (action.type === 'select-session') return { ...state, selectedSessionId: action.sessionId || '' };
  if (!action.sessionId || typeof action.sessionId !== 'string') return state;
  const current = state.sessions[action.sessionId] || initialSession();
  let next = current;
  if (action.type === 'open-document' || action.type === 'replace-document') {
    const source = action.document;
    if (source?.sessionId !== action.sessionId || !source.documentId || !source.path) return state;
    const index = current.documents.findIndex(item => item.path === source.path);
    if (index >= 0 && action.type !== 'replace-document') next = { ...current, activeDocumentId: current.documents[index].documentId };
    else {
      if (index < 0 && current.documents.length >= MAX_SSH_DOCUMENTS) throw new Error(`每个 SSH 会话最多打开 ${MAX_SSH_DOCUMENTS} 个文件，请先关闭不需要的标签`);
      const heldBytes = Object.values(state.sessions).flatMap(item => item.documents).reduce((total, item) => total + (item.text?.length || 0) * 2 + (item.dataUrl?.length || 0), 0);
      if (heldBytes + (source.text?.length || 0) * 2 + (source.dataUrl?.length || 0) > MAX_OPEN_BYTES) throw new Error('打开的 SSH 文件已达到内存上限，请关闭部分预览后重试');
      const document = { ...source, draft: source.text || '', savedText: source.text || '', dirty: false, saving: false, error: '', errorCode: '' };
      const documents = [...current.documents];
      if (index < 0) documents.push(document); else documents[index] = document;
      next = { ...current, documents, activeDocumentId: document.documentId };
    }
  } else if (action.type === 'select-document') next = { ...current, activeDocumentId: action.documentId };
  else if (action.type === 'select-terminal') next = { ...current, activeTerminalId: action.terminalId };
  else if (action.type === 'directory') {
    if (action.revision !== undefined && action.revision !== (current.directoryRevision || 0)) return state;
    next = { ...current, directory: action.path };
  } else if (action.type === 'reveal-directory') {
    if (typeof action.path !== 'string' || !action.path.startsWith('/') || action.path.includes('\0')) return state;
    next = { ...current, directory: action.path, directoryRevision: (current.directoryRevision || 0) + 1 };
    return { ...state, selectedSessionId: action.sessionId, sessions: { ...state.sessions, [action.sessionId]: next } };
  }
  else if (action.type === 'move-path') {
    if (typeof action.source !== 'string' || !action.source || typeof action.path !== 'string' || !action.path) return state;
    next = { ...current, documents: current.documents.map(document => document.path === action.source || document.path.startsWith(`${action.source}/`)
      ? { ...document, path: action.path + document.path.slice(action.source.length) } : document) };
  } else if (action.type === 'delete-path') {
    if (typeof action.path !== 'string' || !action.path) return state;
    next = { ...current, documents: current.documents.map(document => document.path === action.path || document.path.startsWith(`${action.path}/`)
      ? { ...document, remoteMissing: true } : document) };
  }
  else if (action.type === 'remove-session') {
    if (!action.discard && current.documents.some(item => item.dirty)) return state;
    const sessions = { ...state.sessions }; delete sessions[action.sessionId];
    return { ...state, sessions, selectedSessionId: state.selectedSessionId === action.sessionId ? '' : state.selectedSessionId };
  } else if (action.type === 'close-document') {
    const document = current.documents.find(item => item.documentId === action.documentId);
    if (!document || document.saving || (document.dirty && !action.discard)) return state;
    const documents = current.documents.filter(item => item !== document);
    next = { ...current, documents, activeDocumentId: current.activeDocumentId === document.documentId ? documents.at(-1)?.documentId || '' : current.activeDocumentId };
  } else if (['edit-document', 'save-started', 'save-succeeded', 'save-failed'].includes(action.type)) {
    next = { ...current, documents: current.documents.map(document => {
      if (document.documentId !== action.documentId) return document;
      if (action.type === 'edit-document') return document.readOnly || document.kind !== 'text' ? document
        : { ...document, draft: action.text, dirty: action.text !== document.savedText };
      if (action.type === 'save-started') return { ...document, saving: true, error: '', errorCode: '' };
      if (action.type === 'save-succeeded') return { ...document, saving: false, savedText: action.text, revision: action.revision, dirty: document.draft !== action.text, error: '', errorCode: '' };
      return { ...document, saving: false, error: action.error, errorCode: action.code || '' };
    }) };
  } else return state;
  return { ...state, sessions: { ...state.sessions, [action.sessionId]: next } };
}

export function dirtySshPaths(session) { return (session?.documents || []).filter(item => item.dirty).map(item => item.path); }

export function normalizeSshLayout(value) {
  if (!value || value.version !== 1 || !Number.isFinite(value.files) || !Number.isFinite(value.editor) || typeof value.transfersOpen !== 'boolean') throw new Error('SSH 布局数据无效');
  const appearance = value.appearance === undefined ? 'current' : value.appearance;
  if (!['current', 'classic'].includes(appearance)) throw new Error('SSH 布局主题无效');
  return { version: 1, files: Math.max(0.18, Math.min(0.45, value.files)), editor: Math.max(0.25, Math.min(0.75, value.editor)), transfersOpen: value.transfersOpen, appearance };
}

export function readSshLayout(storage = globalThis.localStorage) {
  const raw = storage.getItem(SSH_LAYOUT_KEY);
  if (raw === null || raw === undefined) return { ...DEFAULT_SSH_LAYOUT };
  try { return normalizeSshLayout(JSON.parse(raw)); } catch { throw new Error('SSH 布局数据异常，原内容已保留'); }
}

export function saveSshLayout(value, storage = globalThis.localStorage) {
  const next = normalizeSshLayout(value);
  readSshLayout(storage);
  storage.setItem(SSH_LAYOUT_KEY, JSON.stringify(next));
  return next;
}

export function remoteParent(path) {
  const value = String(path || '/').replace(/\/+$/, '') || '/';
  return value.slice(0, value.lastIndexOf('/')) || '/';
}

export function remoteChild(parent, name) {
  if (typeof name !== 'string' || !name || ['.', '..'].includes(name) || name.includes('/') || name.includes('\0')) throw new Error('远端名称无效');
  return `${String(parent || '/').replace(/\/+$/, '')}/${name}`;
}

export function reconcileSshSelection(selected, previousRoot, nextRoot, entries) {
  if (!selected || previousRoot !== nextRoot) return null;
  if (remoteParent(selected.path) !== nextRoot) return selected;
  const current = entries.find(item => item.name === selected.name);
  return current ? { ...current, path: selected.path } : null;
}

export function createSshDirectoryRequests() {
  let revision = 0;
  const pending = new Map();
  return {
    begin(path, asRoot) {
      if (!asRoot && pending.has(path)) return null;
      if (asRoot) { revision++; pending.clear(); }
      const request = { path, revision };
      pending.set(path, request);
      return request;
    },
    isCurrent(request) { return request.revision === revision && pending.get(request.path) === request; },
    finish(request) { if (pending.get(request.path) === request) pending.delete(request.path); },
    invalidate() { revision++; pending.clear(); },
  };
}

export function clearSshDirectoryLoading(nodes) {
  if (!Object.values(nodes).some(node => node.loading)) return nodes;
  return Object.fromEntries(Object.entries(nodes).map(([path, node]) => [path, node.loading
    ? { ...node, loading: false, loaded: false, cursor: undefined, truncated: false } : node]));
}

export function sshResult(result, fallback = 'SSH 操作未完成') {
  if (!result?.success) throw Object.assign(new Error(result?.error || fallback), { code: result?.code || '' });
  return result;
}

export function formatSshBytes(size) {
  if (!Number.isFinite(size)) return '—';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}
