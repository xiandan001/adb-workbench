import { useEffect, useId, useRef } from 'react';

export default function DeviceShortcutConfirm({ request, isDark }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => {
      dialog.close();
      // React StrictMode replays effects without unmounting the dialog.
      queueMicrotask(() => { if (!dialog.isConnected) request.resolve(false); });
    };
  }, [request]);
  return <dialog ref={dialogRef} aria-labelledby={titleId} onCancel={event => { event.preventDefault(); request.resolve(false); }}
    className={`m-auto w-[min(560px,calc(100vw-32px))] max-h-[85vh] overflow-y-auto rounded-xl border p-5 shadow-2xl backdrop:bg-black/60 ${isDark ? 'bg-[#2D2F33] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-800'}`}>
    <h2 id={titleId} className="font-semibold">确认执行 ADB 命令</h2>
    <p className="mt-3 break-all text-sm">目标设备：<strong>{request.deviceId}</strong></p>
    <p className="mt-2 text-sm">命令可能改变设备或删除数据，请核对完整内容。按钮名称“{request.label}”不代表命令安全。</p>
    <pre className="my-4 whitespace-pre-wrap break-all rounded-lg bg-slate-400/10 p-3 text-xs">{request.command}</pre>
    <div className="flex justify-end gap-2"><button type="button" autoFocus onClick={() => request.resolve(false)} className="rounded-lg border border-slate-400/40 px-4 py-2 text-sm">取消</button>
      <button type="button" onClick={() => request.resolve(true)} className="rounded-lg bg-amber-600 px-4 py-2 text-sm text-white">确认执行</button></div>
  </dialog>;
}
