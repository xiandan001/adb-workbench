import { AlertCircle } from 'lucide-react';
import { tr, useLocale } from '../shared/i18n.js';
import { isDarkTheme } from '../shared/theme.js';
import { deviceConnectionHint, deviceStatusLabel } from '../shared/deviceWorkflow.js';
import { displayDeviceId, platformLabel } from '../shared/devicePlatform.js';
import SelectMenu from './SelectMenu.jsx';
import ApplicationPicker from './ApplicationPicker.jsx';

export default function WorkbenchContextBar({ devices, activeDevice, deviceNames, onDeviceChange, packageName, onApplicationChange, theme, onEnvironment }) {
  useLocale();
  const dark = isDarkTheme(theme);
  return <section aria-label={tr('当前工作目标')} className={`workbench-context-bar border ${dark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-white'} ${theme.text}`}>
    <div className="workbench-context-field"><label htmlFor="active-device" className={`text-xs font-medium ${theme.textMuted}`}>{tr('当前设备')}</label>
      <SelectMenu id="active-device" value={activeDevice?.id || ''} onChange={onDeviceChange} isDark={dark}
        placeholder={tr('尚未发现设备')} emptyText={tr('尚未发现设备')} className="workbench-active-device"
        options={[...(!activeDevice ? [{ value: '', label: devices.length ? tr('请选择设备') : tr('尚未发现设备') }] : []),
          ...devices.map(device => ({ value: device.id, label: [deviceNames[device.id] || device.model, displayDeviceId(device), platformLabel(device), deviceStatusLabel(device.status)].filter(Boolean).join(' · ') }))]} />
    </div>
    <div className="workbench-context-field"><span className={`text-xs font-medium ${theme.textMuted}`}>{tr('当前应用')}</span>
      <ApplicationPicker key={`${activeDevice?.id || ''}:${activeDevice?.generation || 0}`} device={activeDevice} value={packageName || ''}
        onChange={onApplicationChange} theme={theme} disabled={!activeDevice || activeDevice.status !== 'device'} label={tr('当前应用')} />
    </div>
    <p className={`workbench-context-note text-[11px] ${theme.textMuted}`}>{tr('新操作默认使用此目标；进行中的操作保持原目标。')}</p>
    {activeDevice && activeDevice.status !== 'device' && <div role="status" className="workbench-context-note flex flex-wrap items-center gap-2 text-xs text-amber-500">
      <AlertCircle size={14} /><span className="min-w-0 flex-1 break-words">{deviceStatusLabel(activeDevice.status)} · {deviceConnectionHint(activeDevice.status)}</span>
      <button type="button" onClick={onEnvironment} className="underline underline-offset-2">{tr('环境自检')}</button>
    </div>}
  </section>;
}
