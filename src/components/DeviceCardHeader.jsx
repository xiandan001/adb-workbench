import { tr, useLocale } from '../shared/i18n';
import { Smartphone, Unplug, Play, Pencil, Star, Loader2 } from 'lucide-react';
import { displayDeviceId, platformLabel } from '../shared/devicePlatform';
import { deviceStatusLabel } from '../shared/deviceWorkflow';

export default function DeviceCardHeader({ device, deviceName, theme, isOnline, isActive, isPinned, scrcpyLoading,
  isEditing, editName, onBeginRename, onEditNameChange, onEditNameKeyDown, onNameSubmit, onSelectDevice, onTogglePin, onDisconnect, onStart }) {
  useLocale();
  const name = deviceName || device.model || tr('未知设备');
  const identifier = displayDeviceId(device);
  const color = theme.primary === 'cyan' ? 'blue' : theme.primary;
  const tone = { blue: 'bg-blue-100 text-blue-600', pink: 'bg-pink-100 text-pink-600', green: 'bg-green-100 text-green-600',
    orange: 'bg-orange-100 text-orange-600' }[color] || 'bg-emerald-100 text-emerald-600';
  const dot = { blue: 'bg-blue-500', pink: 'bg-pink-500', green: 'bg-green-500', orange: 'bg-orange-500' }[color] || 'bg-emerald-500';
  const statusTone = ['blue', 'pink', 'green', 'orange'].includes(color) ? tone : 'bg-slate-100 text-slate-600';
  return <div className={`device-card-header border-b ${theme.header}`}>
    <div className="device-card-identity">
      <div className={`device-card-avatar ${isOnline ? tone : 'bg-slate-100 text-slate-400'}`} data-online={isOnline}><Smartphone size={24} /></div>
      <div className="device-card-identity-content">
        <div className="device-card-name-row">
          {isEditing ? <input type="text" value={editName} onChange={event => onEditNameChange(event.target.value)}
            onKeyDown={onEditNameKeyDown} onBlur={onNameSubmit} autoFocus placeholder={tr('输入设备名称')}
            aria-label={tr('输入设备名称')} className={`device-card-name-input rounded border px-2 py-1 text-sm outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 ${theme.input} ${theme.text}`} />
            : <h3 className={`device-card-name text-lg font-bold ${theme.text.replace('text-slate-700', 'text-slate-800').replace('text-pink-700', 'text-pink-800')}`} title={name}>{name}</h3>}
          {!isEditing && <div className="device-card-name-actions">
            <button type="button" onClick={onBeginRename} title={tr('编辑名称')} aria-label={tr('编辑名称')}
              className="device-card-icon-button text-slate-400 hover:text-emerald-500"><Pencil size={14} /></button>
            <button type="button" data-device-pin onClick={onTogglePin} aria-pressed={Boolean(isPinned)}
              title={isPinned ? tr('取消置顶') : tr('设为常用，优先显示')} aria-label={isPinned ? tr('取消置顶') : tr('设为常用')}
              className={`device-card-icon-button ${isPinned ? 'text-amber-500 hover:text-amber-600' : 'text-slate-400 hover:text-amber-500'}`}>
              <Star size={15} fill={isPinned ? 'currentColor' : 'none'} />
            </button>
          </div>}
        </div>
        <div className={`device-card-chips text-xs ${theme.textMuted}`}>
          <span className={`device-card-state-dot ${isOnline ? dot : 'bg-slate-300'}`} aria-hidden="true" />
          <code className="device-card-id font-mono text-sm" title={identifier}>{identifier}</code>
          <span className="device-card-platform">{platformLabel(device)}</span>
          <span className={`device-card-state rounded-full px-2 py-0.5 ${statusTone}`} data-online={isOnline}>{deviceStatusLabel(device.status)}</span>
        </div>
      </div>
    </div>
    <div className="device-card-header-actions">
      <button type="button" onClick={onSelectDevice} aria-pressed={isActive}
        className={`device-card-selection rounded border px-2 py-1 text-xs ${isActive ? 'text-emerald-500 border-emerald-500/40' : theme.button.secondary}`}>
        {isActive ? tr('当前设备') : tr('选用')}
      </button>
      <button type="button" onClick={onDisconnect} title={tr('断开设备')} aria-label={tr('断开设备')}
        className="device-card-disconnect rounded-lg p-2 text-slate-400 hover:bg-red-500/10 hover:text-red-500"><Unplug size={20} /></button>
      <button type="button" onClick={onStart} disabled={!isOnline || scrcpyLoading} aria-busy={scrcpyLoading}
        className={`device-card-primary rounded-lg px-5 py-2.5 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${theme.button.primary}`}>
        {scrcpyLoading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}<span>{scrcpyLoading ? tr('启动中...') : tr('开始投屏')}</span>
      </button>
    </div>
  </div>;
}
