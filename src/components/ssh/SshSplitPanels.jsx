import { useEffect, useRef } from 'react';

export default function SshSplitPanels({ layout, onChange, onCommit, left, top, bottom }) {
  const root = useRef(null); const right = useRef(null); const drag = useRef(null);
  useEffect(() => () => { if (drag.current) document.body.style.userSelect = drag.current.selection; }, []);
  const start = (event, axis) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { axis, selection: document.body.style.userSelect, value: layout };
    document.body.style.userSelect = 'none';
  };
  const move = event => {
    if (!drag.current) return;
    const { axis } = drag.current; const rect = (axis === 'files' ? root : right).current.getBoundingClientRect();
    const ratio = axis === 'files' ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    const value = { ...layout, [axis]: Math.max(axis === 'files' ? 0.18 : 0.25, Math.min(axis === 'files' ? 0.45 : 0.75, ratio)) };
    drag.current.value = value; onChange(value);
  };
  const end = event => {
    if (!drag.current) return;
    const value = drag.current.value; document.body.style.userSelect = drag.current.selection; drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(value);
  };
  const key = (event, axis) => {
    const negative = axis === 'files' ? 'ArrowLeft' : 'ArrowUp'; const positive = axis === 'files' ? 'ArrowRight' : 'ArrowDown';
    if (![negative, positive].includes(event.key)) return;
    event.preventDefault(); const next = { ...layout, [axis]: Math.max(axis === 'files' ? 0.18 : 0.25, Math.min(axis === 'files' ? 0.45 : 0.75, layout[axis] + (event.key === positive ? 0.02 : -0.02))) };
    onChange(next); onCommit(next);
  };
  return <div ref={root} className="grid h-full min-h-0 min-w-0" style={{ gridTemplateColumns: `minmax(160px,${layout.files * 100}fr) 8px minmax(280px,${(1 - layout.files) * 100}fr)` }}>
    <div className="min-h-0 min-w-0 overflow-hidden">{left}</div>
    <div role="separator" aria-label="SSH 文件区宽度" aria-orientation="vertical" aria-valuenow={Math.round(layout.files * 100)} aria-valuemin={18} aria-valuemax={45} tabIndex={0} onPointerDown={event => start(event, 'files')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={event => key(event, 'files')} className="mx-0.5 cursor-col-resize rounded hover:bg-emerald-500/30 focus-visible:bg-emerald-500/30 focus-visible:outline-none" />
    <div ref={right} className="grid h-full min-h-0 min-w-0" style={{ gridTemplateRows: `minmax(160px,${layout.editor * 100}fr) 8px minmax(220px,${(1 - layout.editor) * 100}fr)` }}><div className="min-h-0 min-w-0 overflow-hidden">{top}</div><div role="separator" aria-label="SSH 编辑区高度" aria-orientation="horizontal" aria-valuenow={Math.round(layout.editor * 100)} aria-valuemin={25} aria-valuemax={75} tabIndex={0} onPointerDown={event => start(event, 'editor')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onKeyDown={event => key(event, 'editor')} className="my-0.5 cursor-row-resize rounded hover:bg-emerald-500/30 focus-visible:bg-emerald-500/30 focus-visible:outline-none" /><div className="min-h-0 min-w-0 overflow-hidden">{bottom}</div></div>
  </div>;
}
