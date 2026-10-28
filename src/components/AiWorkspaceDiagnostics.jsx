import { useState } from 'react';
import { Smartphone } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';

export default function AiWorkspaceDiagnostics({ current, presets, onChange, disabled, online, theme }) {
  useLocale();
  const [packages, setPackages] = useState({ deviceId: '', items: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const readApps = async () => {
    if (loading || disabled || !online) return;
    const deviceId = current.deviceId; setLoading(true); setError('');
    try {
      const response = await window.electronAPI.packageList({ deviceId });
      if (!response?.ok) throw new Error(response?.error || tr('无法读取应用列表，请检查设备连接。'));
      setPackages({ deviceId, items: (response.packages || []).slice(0, 2000) });
    } catch (failure) { setError(failure.message); }
    finally { setLoading(false); }
  };
  const choosePreset = symptom => {
    const preset = presets.find(item => item.id === symptom);
    onChange({ diagnostic: { ...current.diagnostic, symptom }, ...(preset ? { checks: preset.checks } : {}) });
  };
  const matches = packages.deviceId === current.deviceId ? packages.items.filter(item => item.packageName.includes(current.diagnostic.packageName)).slice(0, 80) : [];
  return <section className={`space-y-3 rounded-lg border p-3 ${theme.input}`}>
    <h4 className="flex items-center gap-2 text-xs font-medium"><Smartphone size={14} />{tr('应用专项排查')}</h4>
    <SelectMenu ariaLabel={tr('问题类型')} value={current.diagnostic.symptom} onChange={choosePreset} disabled={disabled} isDark={isDarkTheme(theme)} options={[{ value: '', label: tr('手动选择检查') }, ...presets.map(item => ({ value: item.id, label: item.label }))]} className="w-full" />
    <label className="block space-y-1.5"><span className="text-xs">{tr('目标应用包名')}</span><input maxLength={200} value={current.diagnostic.packageName} disabled={disabled} onChange={event => onChange({ diagnostic: { ...current.diagnostic, packageName: event.target.value } })} placeholder={tr('例如：com.example.app')} className={`w-full rounded-lg border px-3 py-2 text-xs ${theme.input}`} /></label>
    <button type="button" onClick={readApps} disabled={disabled || loading || !online} className={`rounded-lg px-3 py-2 text-xs disabled:opacity-40 ${theme.button.secondary}`}>{loading ? tr('正在读取应用…') : tr('读取所选设备应用')}</button>
    {matches.length > 0 && <SelectMenu ariaLabel={tr('从已读取应用中选择')} value={current.diagnostic.packageName} onChange={packageName => onChange({ diagnostic: { ...current.diagnostic, packageName } })} disabled={disabled} isDark={isDarkTheme(theme)} options={matches.map(item => ({ value: item.packageName, label: item.packageName }))} className="w-full" />}
    <p className={`text-[11px] leading-5 ${theme.textMuted}`}>{tr('选择类型只调整检查项目；点击采集才执行固定读取，不启动、停止应用或修改权限。')}</p>
    {error && <p role="alert" className="break-words text-xs text-red-500">{tr(error)}</p>}
  </section>;
}
