import { useEffect, useId, useRef, useState } from 'react';
import { Bot, ChevronRight, FileText, Loader2, MessageSquare, Shield, X } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';

const documents = [
  { id: 'scrcpy', name: 'scrcpy', license: 'Apache License 2.0', read: () => import('../../scrcpy-win64/LICENSE.txt?raw') },
  { id: 'hdc-license', name: 'HDC', license: 'Apache License 2.0', read: () => import('../../hdc/LICENSE-HDC?raw') },
  { id: 'hdc-notice', name: 'HDC', read: () => import('../../hdc/NOTICE?raw') },
  { id: 'libusb', name: 'libusb', license: 'LGPL 2.1', read: () => import('../../hdc/LICENSE-libusb?raw') },
  { id: 'agent', name: 'HDC Agent', read: () => import('../../hdc/agent/NOTICE.txt?raw') },
  { id: 'agent-runtime', name: 'HDC Agent · OpenHarmony Runtime', read: () => import('../../hdc/agent/NOTICE-OpenHarmony-Runtime.txt?raw') },
  { id: 'agent-llvm', name: 'HDC Agent · LLVM', read: () => import('../../hdc/agent/NOTICE-LLVM.txt?raw') },
  { id: 'cc-switch', name: 'CC Switch', license: 'MIT', read: () => import('../../electron/assets/ai-tools-NOTICE.txt?raw') },
];

function LicenseReader({ doc, theme, onClose }) {
  const dialog = useRef(null);
  const titleId = useId();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState({ status: 'loading' });
  const subtitle = doc.license || tr('第三方声明');
  useEffect(() => {
    const element = dialog.current;
    element.showModal();
    return () => element.close();
  }, []);
  useEffect(() => {
    let current = true;
    doc.read().then(({ default: text }) => {
      if (current) setState({ status: 'ready', text });
    }, () => {
      if (current) setState({ status: 'error' });
    });
    return () => { current = false; };
  }, [doc, attempt]);
  function dismiss() {
    dialog.current.close();
    onClose();
  }
  return <dialog ref={dialog} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); dismiss(); }}
    className={`m-auto max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border p-0 shadow-2xl backdrop:bg-black/55 open:flex open:flex-col ${theme.card} ${theme.text}`}>
    <header className="flex shrink-0 items-center gap-3 border-b border-slate-400/20 px-5 py-4">
      <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-500">
        <FileText size={17} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 id={titleId} className="break-words text-base font-semibold">{doc.name}</h3>
        <p className={`text-xs ${theme.textMuted}`}>{subtitle}</p>
      </div>
      <button type="button" data-license-close aria-label={tr('关闭')} onClick={dismiss}
        className={`grid size-9 shrink-0 place-items-center rounded-lg focus-visible:outline-2 focus-visible:outline-emerald-500 ${theme.button.secondary}`}>
        <X size={17} aria-hidden="true" />
      </button>
    </header>
    <div className="flex min-h-0 flex-col p-4 sm:p-5">
      {state.status === 'loading' && <p role="status" className={`flex min-h-28 items-center justify-center gap-2 text-sm ${theme.textMuted}`}>
        <Loader2 size={14} aria-hidden="true" className="animate-spin" />{tr('正在加载许可文本…')}
      </p>}
      {state.status === 'error' && <div className="flex flex-wrap items-center gap-2 text-xs">
        <p role="alert" className="text-red-500">{tr('未能加载许可文本。')}</p>
        <button type="button" className={`rounded-md px-2 py-1 ${theme.button.secondary}`}
          onClick={() => { setState({ status: 'loading' }); setAttempt(value => value + 1); }}>{tr('重试读取')}</button>
      </div>}
      {state.status === 'ready' && <pre tabIndex={0} aria-label={`${doc.name} · ${subtitle}`}
        className={`min-h-0 max-h-[min(65dvh,36rem)] select-text overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg border p-4 text-xs leading-6 focus-visible:outline-2 focus-visible:outline-emerald-500 ${theme.input}`}>{state.text}</pre>}
    </div>
  </dialog>;
}

function LicenseGroup({ title, entries, theme, onRead }) {
  return <div className="min-w-0 overflow-hidden rounded-xl border border-slate-400/20">
    <h3 className={`bg-slate-400/5 px-3 py-2 text-xs font-semibold ${theme.textMuted}`}>{title}</h3>
    <ul className="divide-y divide-slate-400/15 border-t border-slate-400/15">
      {entries.map(doc => <li key={doc.id}>
        <button type="button" data-license-id={doc.id} aria-haspopup="dialog" onClick={event => onRead(doc, event.currentTarget)}
          className="group flex min-h-14 w-full min-w-0 items-center gap-2.5 px-3 py-2 text-left transition-colors hover:bg-emerald-500/7 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-emerald-500">
          <FileText size={15} aria-hidden="true" className={`shrink-0 ${theme.textMuted}`} />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-medium">{doc.name}</span>
            {doc.license && <span className={`block text-xs ${theme.textMuted}`}>{doc.license}</span>}
          </span>
          <ChevronRight size={15} aria-hidden="true" className={`shrink-0 ${theme.textMuted} group-hover:text-emerald-500`} />
        </button>
      </li>)}
    </ul>
  </div>;
}

export default function SettingsLegal({ theme }) {
  useLocale();
  const opener = useRef(null);
  const [selected, setSelected] = useState(null);
  function open(doc, trigger) {
    opener.current = trigger;
    setSelected(doc);
  }
  function close() {
    setSelected(null);
    opener.current?.focus({ preventScroll: true });
  }
  const heading = `flex items-center gap-2 text-base font-semibold ${theme.text}`;
  const detail = `text-sm leading-relaxed ${theme.textMuted}`;
  const card = `min-w-0 rounded-2xl border p-4 sm:p-5 ${theme.card}`;
  const data = [
    { icon: FileText, label: tr('应用日志'), text: tr('记录卓控台的运行状态和错误，仅保存到本机，不会自动上传。') },
    { icon: Bot, label: tr('内置 AI'), text: tr('内置 AI 的请求内容会在发送前展示，确认后才会发送。') },
    { icon: MessageSquare, label: tr('反馈问题'), text: tr('提交前可以查看报告预览；确认提交后，报告将发布到公开 GitHub 仓库。') },
  ];
  return <div className="space-y-4">
    <section className={card}>
      <h2 className={heading}><Shield size={17} aria-hidden="true" className="shrink-0 text-emerald-500" />{tr('数据使用说明')}</h2>
      <dl className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(min(100%,13rem),1fr))] gap-x-5 gap-y-3.5">
        {data.map(({ icon, label, text }) => {
          const Icon = icon;
          return <div key={label} className="min-w-0 border-s-2 border-emerald-500/20 ps-3">
            <dt className={`flex min-w-0 items-center gap-2 text-sm font-medium ${theme.text}`}>
              <Icon size={15} aria-hidden="true" className="shrink-0 text-emerald-500" />{label}
            </dt>
            <dd className={`mt-1 ${detail}`}>{text}</dd>
          </div>;
        })}
      </dl>
    </section>
    <section className={card}>
      <h2 className={heading}><FileText size={17} aria-hidden="true" className="shrink-0 text-emerald-500" />{tr('开源许可与第三方声明')}</h2>
      <p className={`mt-1.5 ${detail}`}>{tr('选择条目可离线查看随附的许可和声明原文。')}</p>
      <div className="mt-4 grid items-start gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,17rem),1fr))]">
        <LicenseGroup title={tr('开源许可')} entries={documents.filter(doc => doc.license)} theme={theme} onRead={open} />
        <LicenseGroup title={tr('第三方声明')} entries={documents.filter(doc => !doc.license)} theme={theme} onRead={open} />
      </div>
      <p className={`mt-3 text-xs leading-5 ${theme.textMuted}`}>{tr('安装目录另附 Electron 与 Chromium 的许可文件。')}</p>
    </section>
    {selected && <LicenseReader doc={selected} theme={theme} onClose={close} />}
  </div>;
}
