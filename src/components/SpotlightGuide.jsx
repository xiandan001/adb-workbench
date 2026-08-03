import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { HelpCircle, X } from 'lucide-react';

const TARGET_PADDING = 8;
const TOOLTIP_GAP = 14;

function SpotlightGuide({ guide, theme, onSkip, skipLabel = '跳过教程' }) {
  const [targetRect, setTargetRect] = useState(null);
  const [revision, setRevision] = useState(0);
  const isDark = theme.primary === 'tech';

  useEffect(() => {
    if (!guide?.selector || typeof document === 'undefined') return undefined;
    let frameId = 0;
    let target = null;
    let resizeObserver = null;
    let hasScrolled = false;

    const update = () => {
      frameId = 0;
      const nextTarget = document.querySelector(guide.selector);
      if (nextTarget !== target) {
        resizeObserver?.disconnect();
        target = nextTarget;
        resizeObserver = target && typeof ResizeObserver !== 'undefined'
          ? new ResizeObserver(scheduleUpdate)
          : null;
        resizeObserver?.observe(target);
      }
      if (!target) {
        setTargetRect(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const outsideViewport = rect.bottom < 0
        || rect.top > window.innerHeight
        || rect.right < 0
        || rect.left > window.innerWidth;
      if (!hasScrolled && outsideViewport) {
        hasScrolled = true;
        target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        window.setTimeout(scheduleUpdate, 260);
      }
      const nextRect = {
        top: Math.max(0, rect.top - TARGET_PADDING),
        left: Math.max(0, rect.left - TARGET_PADDING),
        right: Math.min(window.innerWidth, rect.right + TARGET_PADDING),
        bottom: Math.min(window.innerHeight, rect.bottom + TARGET_PADDING),
        width: Math.max(0, rect.width + TARGET_PADDING * 2),
        height: Math.max(0, rect.height + TARGET_PADDING * 2)
      };
      setTargetRect(current => current
        && current.top === nextRect.top
        && current.left === nextRect.left
        && current.right === nextRect.right
        && current.bottom === nextRect.bottom
        && current.width === nextRect.width
        && current.height === nextRect.height
        ? current
        : nextRect);
    };

    function scheduleUpdate() {
      if (frameId) cancelAnimationFrame(frameId);
      frameId = requestAnimationFrame(update);
    }

    const mutationObserver = new MutationObserver(scheduleUpdate);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('scroll', scheduleUpdate, true);
    scheduleUpdate();

    return () => {
      if (frameId) cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('scroll', scheduleUpdate, true);
    };
  }, [guide?.selector, revision]);

  const tooltipStyle = useMemo(() => {
    if (!targetRect || typeof window === 'undefined') return null;
    const width = Math.min(340, window.innerWidth - 24);
    const fitsBelow = targetRect.bottom + TOOLTIP_GAP + 150 <= window.innerHeight;
    const top = fitsBelow
      ? targetRect.bottom + TOOLTIP_GAP
      : Math.max(12, targetRect.top - TOOLTIP_GAP - 150);
    const left = Math.max(12, Math.min(
      window.innerWidth - width - 12,
      targetRect.left + targetRect.width / 2 - width / 2
    ));
    return { top, left, width };
  }, [targetRect]);

  if (!guide || typeof document === 'undefined') return null;

  if (!targetRect) {
    return createPortal(
      <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4">
        <div className={`w-full max-w-sm rounded-2xl border p-5 shadow-2xl ${isDark ? 'border-[#3E4145] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800'}`}>
          <div className="flex items-center gap-2 font-semibold">
            <HelpCircle size={18} className="text-emerald-500" />
            正在定位操作位置
          </div>
          <p className={`mt-2 text-sm leading-6 ${isDark ? 'text-[#9AA0A6]' : 'text-slate-500'}`}>
            当前操作位置尚未显示，可以重新定位或退出教程。
          </p>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={onSkip} className={`rounded-lg border px-3 py-2 text-sm ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145]' : 'border-slate-200 hover:bg-slate-50'}`}>
              {skipLabel}
            </button>
            <button type="button" onClick={() => setRevision(value => value + 1)} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-700">
              重新定位
            </button>
          </div>
        </div>
      </div>,
      document.body
    );
  }

  const maskClass = 'fixed z-[120] bg-black/65 pointer-events-auto';
  return createPortal(
    <>
      <div aria-hidden="true" className={maskClass} style={{ top: 0, left: 0, right: 0, height: targetRect.top }} />
      <div aria-hidden="true" className={maskClass} style={{ top: targetRect.top, left: 0, width: targetRect.left, height: targetRect.height }} />
      <div aria-hidden="true" className={maskClass} style={{ top: targetRect.top, left: targetRect.right, right: 0, height: targetRect.height }} />
      <div aria-hidden="true" className={maskClass} style={{ top: targetRect.bottom, left: 0, right: 0, bottom: 0 }} />
      <div
        aria-hidden="true"
        className="pointer-events-none fixed z-[121] rounded-xl border-2 border-emerald-400 shadow-[0_0_0_4px_rgba(16,185,129,0.18),0_0_28px_rgba(16,185,129,0.45)]"
        style={{
          top: targetRect.top,
          left: targetRect.left,
          width: targetRect.width,
          height: targetRect.height
        }}
      />
      <aside
        className={`fixed z-[122] rounded-xl border p-4 shadow-2xl ${isDark ? 'border-[#3E4145] bg-[#202124] text-[#E8EAED]' : 'border-slate-200 bg-white text-slate-800'}`}
        style={tooltipStyle}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium text-emerald-500">第 {guide.step}/6 步</div>
            <div className="mt-1 font-semibold">{guide.title}</div>
          </div>
          <button type="button" aria-label={skipLabel} onClick={onSkip} className={`rounded-md border p-1.5 ${isDark ? 'border-[#5F6368] hover:bg-[#3E4145]' : 'border-slate-200 hover:bg-slate-50'}`}>
            <X size={14} />
          </button>
        </div>
        <p className={`mt-2 text-sm leading-6 ${isDark ? 'text-[#BDC1C6]' : 'text-slate-600'}`}>{guide.description}</p>
        <div className={`mt-3 text-xs ${isDark ? 'text-[#9AA0A6]' : 'text-slate-400'}`}>直接点击高亮区域继续</div>
      </aside>
    </>,
    document.body
  );
}

export default SpotlightGuide;
