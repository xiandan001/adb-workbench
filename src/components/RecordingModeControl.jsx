import { tr, useLocale } from '../shared/i18n.js';
import { recordingModeSelection } from '../shared/recordingWorkspace.js';
import { isDarkTheme } from '../shared/theme.js';
import SelectMenu from './SelectMenu.jsx';

export default function RecordingModeControl({ recording, preferredWithLogs, onChange, compact, theme }) {
  useLocale();
  const mode = recordingModeSelection(recording, preferredWithLogs);
  return <div className={`device-record-options mt-2 text-xs ${theme.textMuted}`} data-recording-mode={mode.withLogs ? 'logs' : 'screen'}>
    {compact ? <><span className="shrink-0">{tr('录屏模式')}</span><SelectMenu compact ariaLabel={tr('录屏模式')} value={mode.withLogs ? 'logs' : 'screen'}
      onChange={value => { if (!mode.locked) onChange(value === 'logs'); }} disabled={mode.locked} isDark={isDarkTheme(theme)}
      className="min-w-0 flex-1 sm:max-w-44" options={[{ value: 'screen', label: tr('仅录屏') }, { value: 'logs', label: tr('录屏＋日志') }]} /></>
      : <label className="device-record-options-label inline-flex items-center gap-2" title={tr('默认关闭。随录屏开始和停止抓取日志，最多保存 100 MB，不会请求 AI 分析。')}>
        <input type="checkbox" checked={mode.withLogs} disabled={mode.locked} onChange={event => { if (!mode.locked) onChange(event.target.checked); }} className="accent-emerald-500" />{tr('录屏同时抓取日志')}
      </label>}
    <span className="device-record-options-note text-[11px] opacity-75">{tr('不调用 AI · 上限 100 MB')}</span>
  </div>;
}
