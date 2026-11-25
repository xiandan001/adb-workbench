import { tr } from '../shared/i18n.js';

export default function SettingsSoftwareDirectory({ sections, active, select, theme, normalClass, selectedClass }) {
  const label = tr('设置项目');
  return (
    <>
      <nav aria-label={label} className={`preferences-software-directory rounded-2xl border p-2 ${theme.card}`}>
        <p className={`px-3 pt-2 pb-1.5 text-xs font-medium ${theme.textMuted}`}>{label}</p>
        {sections.map(item => {
          const { id, label: title, icon: Icon } = item;
          return (
          <button key={id} type="button" aria-controls={id} aria-current={active === id ? 'true' : undefined}
            onClick={() => select(id)}
            className={`my-0.5 flex min-h-10 w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm leading-5 outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${
              active === id ? `font-semibold ${selectedClass}` : normalClass
            }`}>
            <Icon size={16} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{title}</span>
          </button>
          );
        })}
      </nav>
      <label className={`preferences-software-select flex flex-wrap items-center gap-2 rounded-xl border px-3 py-2 ${theme.card}`}>
        <span className={`text-sm ${theme.textMuted}`}>{label}</span>
        <select value={active} onChange={event => select(event.target.value)}
          className={`min-w-36 flex-1 rounded-lg border px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 ${theme.input}`}>
          {sections.map(({ id, label: title }) => <option key={id} value={id}>{title}</option>)}
        </select>
      </label>
    </>
  );
}
