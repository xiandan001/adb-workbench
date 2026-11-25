import { Package, Settings, ShieldCheck } from 'lucide-react';
import { tr } from '../shared/i18n.js';
import { nextSettingsCategory, settingsCategories } from '../shared/settingsNavigation.js';

const icons = { software: Settings, legal: ShieldCheck, version: Package };

export default function SettingsCategoryTabs({ active, onChange, theme, isDark }) {
  const descriptions = {
    software: tr('快捷命令、投屏与外观'),
    legal: tr('数据使用与开源许可'),
    version: tr('版本信息与软件更新'),
  };
  const selectedColor = isDark ? 'text-emerald-300' : 'text-emerald-800';
  return (
    <div role="tablist" aria-label={tr('设置分类')}
      className={`preferences-category-grid rounded-2xl border p-1.5 ${theme.card}`}>
      {settingsCategories().map(({ id, label }) => {
        const Icon = icons[id];
        const selected = active === id;
        return (
          <button key={id} id={`settings-tab-${id}`} type="button" role="tab" aria-label={label} aria-selected={selected}
            aria-controls={`settings-panel-${id}`} tabIndex={selected ? 0 : -1}
            onClick={() => onChange(id)}
            onKeyDown={event => {
              const next = nextSettingsCategory(id, event.key);
              if (!next) return;
              event.preventDefault();
              onChange(next);
              event.currentTarget.ownerDocument.getElementById(`settings-tab-${next}`)?.focus({ preventScroll: true });
            }}
            className={`flex min-w-0 flex-col items-center gap-1.5 rounded-xl border px-2 py-2.5 text-center transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500 sm:flex-row sm:gap-3 sm:px-3 sm:text-left ${
              selected ? `border-emerald-500/25 bg-emerald-500/10 ${selectedColor}`
                : `border-transparent hover:bg-slate-400/10 ${theme.text}`
            }`}>
            <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${selected ? 'bg-emerald-500/15' : theme.textMuted}`}>
              <Icon size={18} aria-hidden="true" />
            </span>
            <span className="min-w-0">
              <span className="block break-words text-sm font-semibold leading-5">{label}</span>
              <span className={`preferences-category-detail mt-0.5 break-words text-xs leading-4 ${theme.textMuted}`}>{descriptions[id]}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
