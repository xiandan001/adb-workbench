import { useEffect, useRef, useState } from 'react';
import { Camera, Copy, FolderOpen, Image, Loader2, X } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';

export default function ScreenshotResult({ screenshot, theme, onClose }) {
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const timer = window.setTimeout(() => closeRef.current(), 10000);
    return () => window.clearTimeout(timer);
  }, [screenshot]);
  const isDark = isDarkTheme(theme);
  const runAction = async (action) => {
    if (busy) return;
    setBusy(action);
    setMessage('');
    try {
      const result = await window.electronAPI.screenshotAction({ path: screenshot.path, action });
      if (!result.success) throw new Error(result.error);
      setFailed(false);
      setMessage({ copy: '图片已复制，可直接粘贴', open: '已打开图片', folder: '已在文件夹中定位截图' }[action]);
    } catch (error) {
      setFailed(true);
      setMessage(error.message || '截图操作失败');
    } finally {
      setBusy('');
    }
  };
  return (
    <section aria-label="截图已保存" className={`fixed bottom-5 right-5 z-40 w-96 max-w-[calc(100vw-2.5rem)] rounded-xl border p-3 shadow-xl ${isDark ? 'bg-[#2D2F33] border-[#5F6368]' : 'bg-white border-slate-200'}`}>
      <div className={`flex items-center gap-2 text-sm font-semibold ${theme.text}`}>
        <Camera size={16} className="text-emerald-500" />
        <span className="flex-1">截图已保存</span>
        <span className={`text-[11px] font-normal ${theme.textMuted}`}>10 秒后自动关闭</span>
        <button type="button" aria-label="关闭截图预览" onClick={onClose} className={`rounded p-1 ${theme.button.secondary}`}><X size={16} /></button>
      </div>
      {screenshot.preview && <button type="button" onClick={() => runAction('open')} disabled={!!busy} className="mt-2 block w-full rounded-lg bg-black/5" title="打开完整截图"><img src={screenshot.preview} alt={`${screenshot.deviceName} 的截图预览`} className="mx-auto h-32 max-w-full object-contain" /></button>}
      <p className={`mt-2 truncate text-xs ${theme.textMuted}`} title={screenshot.path}>{screenshot.path}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {[['copy', <Copy size={14} />, '复制图片'], ['open', <Image size={14} />, '打开'], ['folder', <FolderOpen size={14} />, '文件夹']].map(([action, icon, label]) => (
          <button key={action} type="button" onClick={() => runAction(action)} disabled={!!busy} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs disabled:opacity-50 ${theme.button.secondary}`}>
            {busy === action ? <Loader2 size={14} className="animate-spin" /> : icon}{label}
          </button>
        ))}
      </div>
      {message && <p role={failed ? 'alert' : 'status'} className={`mt-2 break-words text-xs ${failed ? 'text-red-500' : 'text-emerald-500'}`}>{message}</p>}
    </section>
  );
}
