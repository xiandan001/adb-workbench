import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowUp, ChevronRight, File, FilePlus2, Folder, FolderPlus, Home, Link2, Loader2, MoveRight, Pencil, RefreshCw, Trash2, Upload } from 'lucide-react';
import SelectMenu from '../SelectMenu';
import SshFileContextMenu from './SshFileContextMenu';
import { clearSshDirectoryLoading, createSshDirectoryRequests, formatSshBytes, reconcileSshSelection, remoteChild, remoteParent, sshResult } from '../../shared/sshWorkspace';
import { isDarkTheme } from '../../shared/theme';

function NameDialog({ operation, theme, onSubmit, onClose }) {
  const ref = useRef(null);
  const id = useId();
  const [name, setName] = useState(operation.name || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { const dialog = ref.current; dialog.showModal(); return () => dialog.close(); }, []);
  const submit = async event => {
    event.preventDefault(); if (busy) return; setError(''); setBusy(true);
    try { await onSubmit(name); onClose(); } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };
  return <dialog ref={ref} aria-labelledby={id} onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} className={`m-auto w-[min(480px,calc(100vw-32px))] rounded-xl border p-4 backdrop:bg-black/50 ${theme.card} ${theme.text}`}>
    <h3 id={id} className="font-semibold">{operation.type === 'createfile' ? '新建远端文件' : operation.type === 'mkdir' ? '新建远端目录' : operation.type === 'move' ? '移动远端项' : '重命名远端项'}</h3><p className={`mt-2 break-all text-xs ${theme.textMuted}`}>{operation.path}</p>
    <form onSubmit={submit} className="mt-3 space-y-3"><label className="block space-y-1 text-xs">{operation.type === 'move' ? '目标绝对路径' : '远端名称'}<input aria-label={operation.type === 'move' ? '远端目标路径' : '远端名称'} autoFocus value={name} maxLength={operation.type === 'move' ? 4096 : 255} onChange={event => setName(event.target.value)} disabled={busy} className={`w-full rounded-lg border px-3 py-2 text-sm ${theme.input}`} /></label>{error && <p role="alert" className="text-xs text-red-500">{error}</p>}<div className="flex justify-end gap-2"><button type="button" disabled={busy} onClick={onClose} className={`rounded-lg px-3 py-2 text-xs ${theme.button.secondary}`}>取消</button><button type="submit" disabled={busy || !name} className={`rounded-lg px-3 py-2 text-xs ${theme.button.primary}`}>{busy ? '处理中…' : '确认'}</button></div></form>
  </dialog>;
}

export default function SshFileTree({ session, active, path, directoryRevision = 0, onPath, onOpen, onMoved, onDeleted, refreshKey, theme, showToast }) {
  const [rootPath, setRootPath] = useState(path || '');
  const [pathInput, setPathInput] = useState(path || '');
  const [nodes, setNodes] = useState({});
  const [expanded, setExpanded] = useState({});
  const [visible, setVisible] = useState({});
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [operation, setOperation] = useState(null);
  const [menu, setMenu] = useState(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState('name');
  const sortId = useId();
  const requests = useRef(createSshDirectoryRequests());
  const navigationRevision = useRef(directoryRevision);
  const nodesRef = useRef(nodes);
  const loadRef = useRef(null);
  const rootRef = useRef(rootPath);
  const connected = session.status === 'connected';
  const button = `rounded p-1.5 disabled:opacity-35 ${theme.button.secondary}`;
  useEffect(() => { nodesRef.current = nodes; }, [nodes]);
  useLayoutEffect(() => {
    requests.current.invalidate(); navigationRevision.current = directoryRevision;
    setNodes(clearSshDirectoryLoading);
    const nextPath = path || '';
    if (rootRef.current !== nextPath) setSelected(null);
    rootRef.current = nextPath; setRootPath(nextPath); setPathInput(nextPath); setMenu(null);
  }, [directoryRevision, path, connected]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!active) Promise.resolve().then(() => { if (alive.current) setMenu(null); }); }, [active]);

  const load = useCallback(async (directory, { asRoot = false, more = false, force = false } = {}) => {
    if (!connected || !alive.current) return;
    const key = directory || '.';
    const known = nodesRef.current[directory];
    const append = more && Boolean(known?.cursor);
    if (!asRoot && known?.loaded && !force && !more) { setExpanded(previous => ({ ...previous, [directory]: !previous[directory] })); return; }
    const request = requests.current.begin(key, asRoot);
    if (!request) return;
    const requestedNavigation = navigationRevision.current;
    setError('');
    setNodes(previous => {
      const next = asRoot ? clearSshDirectoryLoading(previous) : previous;
      return { ...next, [directory]: { ...next[directory], loading: true, error: '' } };
    });
    try {
      const result = sshResult(await window.electronAPI.sshList({ sessionId: session.id, path: directory, ...(append ? { cursor: known.cursor } : {}) }), '无法读取远端目录');
      if (result.sessionId !== session.id) throw new Error('目录所属 SSH 会话不匹配');
      if (!alive.current || !requests.current.isCurrent(request)) return;
      const entries = [...(append ? known?.entries || [] : []), ...(result.entries || [])];
      const unique = [...new Map(entries.map(item => [item.name, item])).values()];
      setNodes(previous => ({ ...previous, [directory]: { ...previous[directory], loading: false }, [result.path]: { entries: unique, loaded: true, loading: false, cursor: result.cursor, truncated: result.truncated } }));
      setExpanded(previous => ({ ...previous, [result.path]: true }));
      if (asRoot) {
        const previousRoot = rootRef.current;
        rootRef.current = result.path;
        setRootPath(result.path); setPathInput(result.path); onPath(result.path, requestedNavigation);
        setSelected(previous => reconcileSshSelection(previous, previousRoot, result.path, unique));
      }
    } catch (failure) {
      if (alive.current && requests.current.isCurrent(request)) { setError(failure.message); setNodes(previous => ({ ...previous, [directory]: { ...previous[directory], loading: false, error: failure.message } })); }
    } finally { requests.current.finish(request); }
  }, [connected, onPath, session.id]);
  useEffect(() => { loadRef.current = load; }, [load]);
  useEffect(() => {
    if (active && connected) void loadRef.current?.(rootRef.current, { asRoot: true, force: true });
  }, [active, connected, refreshKey, directoryRevision]);

  const run = async action => {
    if (busy || !connected) return;
    setBusy(true); setError('');
    try { const result = sshResult(await action()); if (!result.cancelled) { showToast?.('SSH 文件操作已提交'); await load(rootPath, { asRoot: true, force: true }); } }
    catch (failure) { setError(failure.message); }
    finally { if (alive.current) setBusy(false); }
  };
  const destination = selected?.type === 'directory' ? selected.path : selected?.path ? remoteParent(selected.path) : rootPath;
  const nameSubmit = async name => {
    if (operation.type === 'move' && (!name.startsWith('/') || name.includes('\0'))) throw new Error('请输入远端目标绝对路径');
    const target = operation.type === 'move' ? name : remoteChild(['mkdir', 'createfile'].includes(operation.type) ? operation.path : remoteParent(operation.path), name);
    const result = operation.type === 'mkdir'
      ? await window.electronAPI.sshMkdir({ sessionId: session.id, parent: operation.path, name })
      : operation.type === 'createfile' ? await window.electronAPI.sshCreateFile({ sessionId: session.id, parent: operation.path, name })
        : await window.electronAPI.sshMove({ sessionId: session.id, source: operation.path, destination: target });
    sshResult(result);
    if (!result.cancelled) {
      if (['rename', 'move'].includes(operation.type)) {
        const source = result.source || operation.path; const path = result.path || target;
        onMoved?.({ source, path });
        setSelected(previous => {
          if (!previous || (previous.path !== source && !previous.path.startsWith(`${source}/`))) return previous;
          const nextPath = path + previous.path.slice(source.length);
          return { ...previous, path: nextPath, name: nextPath.split('/').at(-1) };
        });
      }
      await load(rootPath, { asRoot: true, force: true });
      if (operation.type === 'createfile') onOpen(result.path || target);
    }
  };
  const fileAction = (action, item = selected, basePath = rootPath) => {
    const parent = item?.type === 'directory' ? item.path : item?.path ? remoteParent(item.path) : basePath;
    if (action === 'properties') { setSelected(item); return; }
    if (action === 'copyPath') { void navigator.clipboard.writeText(item?.path || basePath).then(() => showToast?.('远端路径已复制'), () => showToast?.('复制失败，请手动复制路径')); return; }
    if (!connected) return;
    if (action === 'open') { if (item?.type === 'directory') void load(item.path, { asRoot: true, force: true }); else if (item?.type === 'file') onOpen(item.path); }
    else if (action === 'refresh') void load(basePath, { asRoot: true, force: true });
    else if (action === 'uploadFiles' || action === 'uploadDirectory') void run(() => window.electronAPI.sshUpload({ sessionId: session.id, destination: parent, kind: action === 'uploadFiles' ? 'files' : 'directory' }));
    else if (action === 'download' && item) void run(() => window.electronAPI.sshDownload({ sessionId: session.id, sources: [item.path] }));
    else if (action === 'mkdir' || action === 'createfile') setOperation({ type: action, path: parent, name: '' });
    else if (action === 'rename' && item) setOperation({ type: 'rename', path: item.path, name: item.name });
    else if (action === 'move' && item) setOperation({ type: 'move', path: item.path, name: item.path });
    else if (action === 'delete' && item) void run(async () => {
      const result = await window.electronAPI.sshDelete({ sessionId: session.id, path: item.path });
      if (result?.success && !result.cancelled) onDeleted?.(item.path);
      return result;
    });
  };
  const openMenu = (event, item) => {
    event.preventDefault(); event.stopPropagation(); setSelected(item);
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ x: event.clientX || rect.left + 16, y: event.clientY || rect.bottom, item, rootPath, sessionId: session.id });
  };
  const menuItems = menu ? [
    ...(menu.item && menu.item.type !== 'symlink' ? [{ id: 'open', label: menu.item.type === 'directory' ? '打开目录' : '打开 / 编辑', disabled: !connected }] : []),
    { id: 'uploadFiles', label: '上传文件…', disabled: !connected || busy || !menu.rootPath }, { id: 'uploadDirectory', label: '上传文件夹…', disabled: !connected || busy || !menu.rootPath },
    ...(menu.item ? [{ id: 'download', label: '下载…', disabled: !connected || busy }] : []),
    { id: 'createfile', label: '新建文件…', separator: true, disabled: !connected || busy || !menu.rootPath }, { id: 'mkdir', label: '新建目录…', disabled: !connected || busy || !menu.rootPath },
    ...(menu.item ? [{ id: 'rename', label: '重命名…', disabled: !connected || busy }, { id: 'move', label: '移动…', disabled: !connected || busy }] : []),
    { id: 'copyPath', label: '复制路径', separator: true, disabled: !menu.rootPath }, { id: 'refresh', label: '刷新', disabled: !connected },
    ...(menu.item ? [{ id: 'properties', label: '属性' }, { id: 'delete', label: '删除…', danger: true, separator: true, disabled: !connected || busy }] : []),
  ] : [];
  const keyboard = event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const buttons = [...event.currentTarget.closest('[role="tree"]').querySelectorAll('[role="treeitem"]')];
    const index = buttons.indexOf(event.currentTarget);
    buttons[index + (event.key === 'ArrowDown' ? 1 : -1)]?.focus();
    event.preventDefault();
  };
  const branch = (directory, depth = 0) => {
    if (depth > 24) return <p className={`px-2 py-1 text-xs ${theme.textMuted}`}>层级较深，请在路径栏打开该目录</p>;
    const node = nodes[directory];
    const count = visible[directory] || 200;
    const entries = (node?.entries || []).filter(item => showHidden || !item.name.startsWith('.')).sort((a, b) => {
      const directories = Number(b.type === 'directory') - Number(a.type === 'directory');
      if (directories) return directories;
      if (sort === 'size' && a.size !== b.size) return (b.size || 0) - (a.size || 0);
      if (sort === 'mtime' && a.mtime !== b.mtime) return (b.mtime || 0) - (a.mtime || 0);
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    return <div key={directory}>
      {entries.slice(0, count).map(item => {
        const itemPath = remoteChild(directory, item.name);
        const isDirectory = item.type === 'directory';
        return <div key={itemPath}><button type="button" role="treeitem" aria-level={depth + 1} aria-selected={selected?.path === itemPath} aria-expanded={isDirectory ? Boolean(expanded[itemPath]) : undefined} title={itemPath} onContextMenu={event => openMenu(event, { ...item, path: itemPath })} onKeyDown={event => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event, { ...item, path: itemPath }); else keyboard(event); }}
          onClick={() => { setSelected({ ...item, path: itemPath }); if (isDirectory) void load(itemPath); else if (item.type === 'file') onOpen(itemPath); }}
          style={{ paddingLeft: 8 + depth * 14 }} className={`flex w-full min-w-0 items-center gap-1.5 rounded py-1.5 pr-2 text-left text-xs ${selected?.path === itemPath ? 'bg-emerald-500/15' : 'hover:bg-slate-400/10'}`}>
          {isDirectory ? <ChevronRight size={12} className={`shrink-0 ${expanded[itemPath] ? 'rotate-90' : ''}`} /> : <span className="w-3 shrink-0" />}{isDirectory ? <Folder size={14} className="shrink-0 text-amber-500" /> : item.type === 'symlink' ? <Link2 size={14} className="shrink-0" /> : <File size={14} className="shrink-0" />}<span className="min-w-0 truncate">{item.name}</span>{nodes[itemPath]?.loading && <Loader2 size={12} className="ml-auto shrink-0 animate-spin" />}
        </button>{isDirectory && expanded[itemPath] && branch(itemPath, depth + 1)}</div>;
      })}
      {node?.loading && <p className={`px-3 py-2 text-xs ${theme.textMuted}`}>正在读取目录…</p>}
      {node?.loaded && !entries.length && <p className={`px-3 py-2 text-xs ${theme.textMuted}`}>{node.entries.length ? '隐藏项已折叠' : '空目录'}</p>}
      {entries.length > count && <button type="button" onClick={() => setVisible(previous => ({ ...previous, [directory]: count + 200 }))} className={`px-3 py-2 text-xs ${theme.textMuted}`}>显示更多条目…</button>}
      {node?.cursor && <button type="button" onClick={() => load(directory, { more: true })} disabled={node.loading} className={`px-3 py-2 text-xs ${theme.textMuted}`}>加载下一页目录</button>}
      {node?.truncated && !node.cursor && <p className="px-3 py-2 text-xs text-amber-500">目录过大，仅显示已返回条目</p>}
    </div>;
  };

  return <section aria-label="SSH 远端文件" className={`flex h-full min-h-0 min-w-0 flex-col rounded-lg border ${theme.card}`} onDragOver={event => { if (connected) event.preventDefault(); }} onDrop={event => {
    event.preventDefault(); const files = [...(event.dataTransfer?.files || [])];
    if (connected && files.length) void run(() => window.electronAPI.sshUploadDropped({ sessionId: session.id, destination: destination || rootPath }, files));
  }}>
    <div className="flex items-center gap-1 border-b border-slate-400/20 px-2 py-2"><h3 className="min-w-0 flex-1 truncate text-xs font-semibold">SFTP 文件</h3><button type="button" aria-label="刷新 SSH 文件" title="刷新" disabled={!connected} onClick={() => load(rootPath, { asRoot: true, force: true })} className={button}><RefreshCw size={13} /></button><button type="button" aria-label="返回 SSH 主目录" title="主目录" disabled={!connected} onClick={() => load('', { asRoot: true, force: true })} className={button}><Home size={13} /></button><button type="button" aria-label="SSH 上级目录" title="上级目录" disabled={!connected || rootPath === '/'} onClick={() => load(remoteParent(rootPath), { asRoot: true, force: true })} className={button}><ArrowUp size={13} /></button></div>
    <form className="flex gap-1 p-2" onSubmit={event => { event.preventDefault(); void load(pathInput, { asRoot: true, force: true }); }}><input aria-label="SSH 远端路径" value={pathInput} onChange={event => setPathInput(event.target.value)} disabled={!connected} placeholder="远端目录" className={`min-w-0 flex-1 rounded border px-2 py-1.5 text-xs ${theme.input}`} /><button type="submit" disabled={!connected} className={`rounded px-2 text-xs ${theme.button.secondary}`}>打开</button></form>
    <div className="flex flex-wrap gap-1 px-2 pb-2"><button type="button" aria-label="上传 SSH 文件" title="上传文件到当前目录" disabled={!connected || busy || !rootPath} onClick={() => fileAction('uploadFiles')} className={button}><Upload size={13} /></button><button type="button" aria-label="上传 SSH 文件夹" title="上传文件夹到当前目录" disabled={!connected || busy || !rootPath} onClick={() => fileAction('uploadDirectory')} className={button}><Folder size={13} /></button><button type="button" aria-label="下载 SSH 选中项" title="下载选中项" disabled={!connected || !selected || busy} onClick={() => fileAction('download')} className={button}><ArrowDownToLine size={13} /></button><button type="button" aria-label="新建 SSH 文件" title="新建空文件并编辑" disabled={!connected || !rootPath} onClick={() => fileAction('createfile')} className={button}><FilePlus2 size={13} /></button><button type="button" aria-label="新建 SSH 目录" title="新建目录" disabled={!connected || !rootPath} onClick={() => fileAction('mkdir')} className={button}><FolderPlus size={13} /></button><button type="button" aria-label="重命名 SSH 选中项" title="重命名" disabled={!connected || !selected} onClick={() => fileAction('rename')} className={button}><Pencil size={13} /></button><button type="button" aria-label="移动 SSH 选中项" title="移动到远端绝对路径" disabled={!connected || !selected} onClick={() => fileAction('move')} className={button}><MoveRight size={13} /></button><button type="button" aria-label="删除 SSH 选中项" title="删除选中项（需要确认）" disabled={!connected || !selected || busy} onClick={() => fileAction('delete')} className={button}><Trash2 size={13} /></button></div>
    <div className="flex flex-wrap items-center gap-2 px-2 pb-2"><label className="sr-only" htmlFor={sortId}>SSH 文件排序</label><SelectMenu id={sortId} compact isDark={isDarkTheme(theme)} value={sort} onChange={setSort} options={[{ value: 'name', label: '按名称' }, { value: 'size', label: '按大小' }, { value: 'mtime', label: '按修改时间' }]} className="min-w-0 flex-1" /><label className={`flex items-center gap-1 text-[10px] ${theme.textMuted}`}><input type="checkbox" checked={showHidden} onChange={event => setShowHidden(event.target.checked)} />显示隐藏项</label></div>
    {error && <p role="alert" className="break-words px-2 pb-2 text-xs text-red-500">{error}</p>}
    {!connected && <p className={`px-3 py-2 text-xs ${theme.textMuted}`}>连接后可浏览文件；断开不会丢失已打开的编辑内容。</p>}
    <div role="tree" aria-label="SSH 文件树" onContextMenu={event => openMenu(event, null)} className="min-h-0 flex-1 overflow-auto px-1 pb-2">{rootPath ? branch(rootPath) : <p className={`p-3 text-xs ${theme.textMuted}`}>{connected ? '正在读取主目录…' : '尚未连接'}</p>}</div>
    {selected && <div aria-label="SSH 选中项属性" className={`space-y-0.5 border-t border-slate-400/15 px-2 py-1.5 text-[10px] ${theme.textMuted}`}><p className="truncate" title={selected.path}>{selected.path}</p><p>{selected.type === 'directory' ? '目录' : selected.type === 'symlink' ? '符号链接' : '文件'} · {formatSshBytes(selected.size)} · 权限 {typeof selected.mode === 'number' ? (selected.mode & 0o7777).toString(8).padStart(4, '0') : selected.mode || '—'}</p><p>修改：{selected.mtime ? new Date(typeof selected.mtime === 'number' && selected.mtime < 1e12 ? selected.mtime * 1000 : selected.mtime).toLocaleString() : '—'}</p></div>}
    <p className={`border-t border-slate-400/15 px-2 py-1.5 text-[10px] ${theme.textMuted}`}>可拖入本地文件；符号链接不自动跟随。</p>
    {active && operation && <NameDialog operation={operation} theme={theme} onSubmit={nameSubmit} onClose={() => setOperation(null)} />}
    {active && menu && <SshFileContextMenu key={`${menu.x}-${menu.y}-${menu.item?.path || ''}`} x={menu.x} y={menu.y} items={menuItems} theme={theme} onClose={() => setMenu(null)} onAction={action => { if (menu.sessionId === session.id) fileAction(action, menu.item, menu.rootPath); }} />}
  </section>;
}
