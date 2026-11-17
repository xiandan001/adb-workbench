import { Component, useEffect } from 'react';
import { tr, useLocale } from '../shared/i18n.js';

export function LogWindowReady() {
  useEffect(() => {
    let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(() => window.electronAPI?.startupPresentationReady?.()); });
    return () => cancelAnimationFrame(frame);
  }, []);
  return null;
}
function LogWindowFailure() {
  useLocale();
  return <main className="flex min-h-screen items-center justify-center bg-[#181818] p-6 text-slate-100">
    <section role="alert" className="w-full max-w-lg rounded-2xl border border-white/15 bg-[#212121] p-6 shadow-2xl">
      <p className="text-xs font-semibold tracking-[.2em] text-emerald-400">VEYLO</p><h1 className="mt-4 text-xl font-semibold">{tr('日志助手未能显示')}</h1>
      <p className="mt-3 text-sm leading-6 text-slate-300">{tr('日志窗口未能正常显示，可以重新加载。不会自动开始采集或调用 AI。')}</p>
      <button type="button" onClick={() => window.location.reload()} className="mt-6 rounded-lg bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500">{tr('重试加载')}</button>
    </section>
  </main>;
}
export default class LogWindowStartupBoundary extends Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() {
    console.error('[LogWindow] renderer-error');
    window.electronAPI?.startupPresentationFailed?.();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <LogWindowFailure />;
  }
}
