import { ClipboardCheck, ClipboardList, FolderOpen, Gauge, ShieldCheck, SlidersHorizontal, Sparkles } from 'lucide-react';
import { isDarkTheme } from '../shared/theme.js';
import { nextWorkbenchCenterPage } from '../shared/workbenchCenters.js';

const icons = {
  quality: ShieldCheck, tasks: ClipboardList, artifacts: FolderOpen,
  troubleshoot: ClipboardCheck, performance: Gauge, 'ai-workspace': Sparkles, 'ai-tools': SlidersHorizontal,
};
const tabId = page => `workbench-center-tab-${page}`;

export default function WorkbenchCenterTabs({ center, activeTab, onChange, theme }) {
  if (!center) return null;
  const selectedColor = isDarkTheme(theme) ? 'text-emerald-300' : 'text-emerald-800';

  function navigate(event) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const leaf = event.target.closest('[role="tab"]')?.dataset.centerPage;
    const next = nextWorkbenchCenterPage(center, leaf, event.key);
    if (!next) return;
    event.preventDefault();
    onChange(next);
    event.currentTarget.ownerDocument.getElementById(tabId(next))?.focus({ preventScroll: true });
  }

  return <div role="tablist" aria-label={center.title} aria-orientation="horizontal" onKeyDown={navigate}
    className="flex w-full min-w-0 basis-full flex-wrap gap-1.5">
    {center.pages.map(({ id, label }) => {
      const selected = id === activeTab;
      const Icon = icons[id];
      return <button key={id} id={tabId(id)} type="button" role="tab" data-center-page={id}
        aria-selected={selected} aria-controls="workbench-center-panel" tabIndex={selected ? 0 : -1}
        onClick={() => onChange(id)}
        className={`inline-flex min-h-9 min-w-0 max-w-full items-center gap-2 rounded-lg border px-3 py-1.5 text-left text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-500 ${
          selected ? `border-emerald-500/35 bg-emerald-500/10 font-semibold ${selectedColor}` : theme.button.secondary
        }`}>
        {Icon && <Icon size={15} className="shrink-0" aria-hidden="true" />}
        <span className="min-w-0 break-words">{label}</span>
      </button>;
    })}
  </div>;
}
