import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import ApplicationPicker from './ApplicationPicker';
import { clearWorkspaceApplicationSelection } from './AiWorkspaceFlow';
import { validAiDiagnosticPackage } from '../shared/aiSelectionDraft';

export default function AiWorkspaceDiagnostics({ current, presets, onChange, disabled, online, theme, device, applicationLabel, applicationReason }) {
  useLocale();
  const [error, setError] = useState('');
  const packageRequired = Boolean(applicationReason);
  const requirementLabel = packageRequired ? tr('必填') : tr('可选');
  const packageMissing = packageRequired && !current.diagnostic.packageName.trim();
  const choosePreset = symptom => {
    const preset = presets.find(item => item.id === symptom);
    onChange({ diagnostic: { ...current.diagnostic, symptom }, ...(preset ? { checks: preset.checks } : {}) });
  };
  return <section className={`space-y-3 rounded-lg border p-3 ${theme.input}`}>
    <h4 className="flex items-center gap-2 text-xs font-medium"><Smartphone size={14} />{tr('应用专项排查')}</h4>
    <SelectMenu ariaLabel={tr('问题类型')} value={current.diagnostic.symptom} onChange={choosePreset} disabled={disabled} isDark={isDarkTheme(theme)} options={[{ value: '', label: tr('手动选择检查') }, ...presets.map(item => ({ value: item.id, label: item.label }))]} className="w-full" />
    <div id="ai-workspace-required-package" tabIndex={-1} className="space-y-1.5">
      <p className="flex flex-wrap items-center gap-2 text-xs">{applicationLabel}<span className={`rounded px-1.5 py-0.5 text-[11px] ${packageRequired ? 'bg-amber-500/10 text-amber-700 dark:text-amber-400' : theme.textMuted}`}>{requirementLabel}</span></p>
      <ApplicationPicker device={device || { id: current.deviceId, status: online ? 'device' : 'offline' }} label={`${applicationLabel} · ${requirementLabel}`} placeholder={packageRequired ? tr('请选择目标应用') : tr('选择应用')} value={current.diagnostic.packageName} disabled={disabled} theme={theme} emptyOption={{
        label: tr('不指定应用（仅做设备检查）'),
        selected: !packageRequired && !current.diagnostic.packageName,
        onSelect: () => { setError(''); onChange(clearWorkspaceApplicationSelection(current)); },
      }} onChange={packageName => {
        if (!validAiDiagnosticPackage(packageName)) { setError(tr('请填写有效的应用包名并选择受支持的问题类型。')); return; }
        setError(''); onChange({ diagnostic: { ...current.diagnostic, packageName } });
      }} />
      {packageRequired && <p className={`text-xs leading-5 ${packageMissing ? 'text-amber-700 dark:text-amber-400' : theme.textMuted}`}>{applicationReason}</p>}
    </div>
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('选择类型只调整检查项目；点击采集才执行固定读取，不启动、停止应用或修改权限。')}</p>
    {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
  </section>;
}
