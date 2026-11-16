import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import ApplicationPicker from './ApplicationPicker';
import { validAiDiagnosticPackage } from '../shared/aiSelectionDraft';

export default function AiWorkspaceDiagnostics({ current, presets, onChange, disabled, online, theme, device }) {
  useLocale();
  const [error, setError] = useState('');
  const choosePreset = symptom => {
    const preset = presets.find(item => item.id === symptom);
    onChange({ diagnostic: { ...current.diagnostic, symptom }, ...(preset ? { checks: preset.checks } : {}) });
  };
  return <section className={`space-y-3 rounded-lg border p-3 ${theme.input}`}>
    <h4 className="flex items-center gap-2 text-xs font-medium"><Smartphone size={14} />{tr('应用专项排查')}</h4>
    <SelectMenu ariaLabel={tr('问题类型')} value={current.diagnostic.symptom} onChange={choosePreset} disabled={disabled} isDark={isDarkTheme(theme)} options={[{ value: '', label: tr('手动选择检查') }, ...presets.map(item => ({ value: item.id, label: item.label }))]} className="w-full" />
    <div className="space-y-1.5"><p className="text-xs">{current.deviceId.startsWith('hdc:') ? tr('目标应用 Bundle 名称') : tr('目标应用包名')}</p>
      <ApplicationPicker device={device || { id: current.deviceId, status: online ? 'device' : 'offline' }} label={tr('目标应用包名')} value={current.diagnostic.packageName} disabled={disabled} theme={theme} onChange={packageName => {
        if (!validAiDiagnosticPackage(packageName)) { setError(tr('请填写有效的应用包名并选择受支持的问题类型。')); return; }
        setError(''); onChange({ diagnostic: { ...current.diagnostic, packageName } });
      }} />
    </div>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('选择类型只调整检查项目；点击采集才执行固定读取，不启动、停止应用或修改权限。')}</p>
    {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
  </section>;
}
