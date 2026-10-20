import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { isDarkTheme } from '../shared/theme';

export default function TaskCenterDraftDialog({ name, saving, theme, onCancel, onDiscard, onSave }) {
  const dialogRef = useRef(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => { dialog?.close(); previousFocus?.focus?.(); };
  }, []);
  return createPortal(
    <dialog ref={dialogRef} aria-labelledby="draft-replace-title" onCancel={(event) => { event.preventDefault(); if (!saving) onCancel(); }} className={`m-auto w-[min(440px,90vw)] rounded-xl border p-5 shadow-2xl backdrop:bg-black/50 ${isDarkTheme(theme) ? 'bg-[#202124] text-[#E8EAED] border-[#3E4145]' : 'bg-white text-slate-800 border-slate-200'}`}>
      <h3 id="draft-replace-title" className="font-semibold">保留当前修改？</h3>
      <p className="mt-3 text-sm leading-6">“{name || '未命名脚本'}”尚未保存为脚本。继续后将替换当前本地草稿。</p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" autoFocus disabled={saving} onClick={onCancel} className={`rounded-lg border px-3 py-2 text-sm ${theme.button.secondary}`}>取消</button>
        <button type="button" disabled={saving} onClick={onDiscard} className="rounded-lg border border-red-500/30 px-3 py-2 text-sm text-red-500">放弃修改并继续</button>
        <button type="button" disabled={saving} onClick={onSave} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm text-white disabled:opacity-50">{saving ? '保存中…' : '保存后继续'}</button>
      </div>
    </dialog>,
    document.body
  );
}
