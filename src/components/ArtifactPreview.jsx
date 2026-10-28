import { tr, useLocale } from '../shared/i18n';
import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import SelectMenu from './SelectMenu';
import { formatBytes } from '../shared/artifactWorkspace';
import AiContextButton from './AiContextButton';

export default function ArtifactPreview({ item, isDark, onClose }) {
  useLocale();
  const dialog = useRef(null);
  const [files, setFiles] = useState([]);
  const [name, setName] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const chooseFile = value => {
    if (value === name) return;
    setLoading(true);
    setPreview(null);
    setError('');
    setName(value);
  };
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    window.electronAPI.artifactPreview({ id: item.id }).then(result => {
      if (!active) return;
      if (!result?.ok) { setError(result?.error || tr("读取失败")); setLoading(false); return; }
      setFiles(result.files);
      const preferred = item.reportPath || item.summaryPath;
      const first = result.files.find(file => preferred?.replaceAll('\\', '/').endsWith('/' + file.name.replaceAll('\\', '/'))) || result.files[0];
      setName(first?.name || '');
      if (!first) setLoading(false);
    }).catch(error => { if (active) { setError(error.message); setLoading(false); } });
    return () => { active = false; };
  }, [item]);
  useEffect(() => {
    if (!name) return;
    let active = true;
    window.electronAPI.artifactPreview({ id: item.id, name }).then(result => {
      if (!active) return;
      if (result?.ok) setPreview(result);
      else setError(result?.error || tr("预览失败"));
      setLoading(false);
    }).catch(error => { if (active) { setError(error.message); setLoading(false); } });
    return () => { active = false; };
  }, [item.id, name]);
  return (
    <dialog ref={dialog} aria-labelledby="artifact-preview-title" onCancel={onClose} onClose={onClose} className={`m-auto w-[min(1000px,94vw)] max-h-[90vh] rounded-xl border p-0 backdrop:bg-black/50 ${isDark ? 'bg-[#202124] text-[#E8EAED] border-[#5F6368]' : 'bg-white text-slate-800 border-slate-200'}`}>
      <div className="flex items-center justify-between gap-3 p-4 border-b border-slate-500/25">
        <h3 id="artifact-preview-title" className="font-semibold truncate">{tr("预览 · {0}", { 0: item.title })}</h3>
        <button type="button" aria-label={tr("关闭预览")} onClick={onClose} className="p-1 rounded hover:bg-slate-500/15"><X size={20} /></button>
      </div>
      <div className="p-4 space-y-3">
        {files.length > 0 && <SelectMenu id="artifact-preview-file" value={name} onChange={chooseFile} isDark={isDark} options={files.map(file => ({ value: file.name, label: `${file.name} · ${formatBytes(file.bytes)}` }))} />}
        {error && <p role="alert" className="text-sm text-red-500">{tr(error)}</p>}
        {loading && <div className="py-12 flex gap-2 justify-center text-sm"><Loader2 className="animate-spin" size={18} />{tr("正在读取预览…")}</div>}
        {!loading && !error && !files.length && <p className="text-sm opacity-70 py-8 text-center">{tr("没有可预览的报告、数据或图片，请使用“打开目录”查看。")}</p>}
        {preview?.truncated && <p className="text-xs text-amber-500">{tr("文件较大，仅预览前 512 KB；原文件未修改。")}</p>}
        {preview?.kind === 'text' && <AiContextButton disabled={loading || Boolean(error)} context={{ reference: { kind: 'artifact', artifactId: item.id, name } }} onCreated={onClose} />}
        {preview?.kind === 'image' ? <img alt={preview.name} src={preview.content} className="max-w-full max-h-[62vh] mx-auto object-contain" /> : preview && <pre className="text-xs leading-6 whitespace-pre-wrap break-words overflow-auto max-h-[62vh] p-3 rounded bg-slate-500/10">{preview.content}</pre>}
      </div>
    </dialog>
  );
}
