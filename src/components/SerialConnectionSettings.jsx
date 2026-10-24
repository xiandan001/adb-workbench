import { tr, useLocale } from '../shared/i18n';
import { useId, useState } from 'react';
import { ChevronDown, Loader2, Plug, RefreshCw, Unplug } from 'lucide-react';
import SelectMenu from './SelectMenu';

const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const STATUS_TEXT = () => ({ disconnected: tr("未连接"), connecting: tr("连接中…"), connected: tr("已连接"), disconnecting: tr("断开中…"), error: tr("连接错误") });

export default function SerialConnectionSettings({ theme, isDark, ports, selectedPath, onSelectPath, config, onConfig, status, activePath, pending, connectingRequest, cancelling, refreshing, onRefresh, onConnect, onDisconnect, advanced, onAdvanced }) {
  useLocale();
  const id = useId();
  const [customBaud, setCustomBaud] = useState(!BAUD_RATES.includes(config.baudRate));
  const [customValue, setCustomValue] = useState(String(config.baudRate));
  const locked = ['connecting', 'connected', 'disconnecting'].includes(status) || pending;
  const connected = status === 'connected';
  const field = `w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50 ${theme.input}`;
  const button = `inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${theme.button.secondary}`;
  const options = ports.map(port => ({ value: port.path, label: `${port.path}${port.friendlyName || port.manufacturer ? ` · ${port.friendlyName || port.manufacturer}` : ''}` }));
  if (selectedPath && !options.some(option => option.value === selectedPath)) options.unshift({ value: selectedPath, label: tr("{0} · 当前未发现", { 0: selectedPath }), disabled: true });
  const customValid = /^\d+$/.test(customValue) && Number(customValue) >= 1 && Number(customValue) <= 4000000;
  const setFraming = (key, value) => onConfig({ ...config, [key]: value });
  const setting = (key, label, values) => <div className="min-w-0 space-y-1 text-xs"><label htmlFor={`${id}-${key}`}>{label}</label><SelectMenu id={`${id}-${key}`} isDark={isDark} disabled={locked} value={config[key]} onChange={value => setFraming(key, value)} options={values} /></div>;

  return <div className="space-y-3">
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-0 flex-1 basis-64 space-y-1 text-xs"><label htmlFor={`${id}-port`}>{tr("串口")}</label><SelectMenu id={`${id}-port`} isDark={isDark} value={selectedPath} onChange={onSelectPath} disabled={locked} options={options} placeholder={tr("请选择串口")} emptyText={tr("未发现串口，请连接串口线并检查驱动")} /></div>
      <button type="button" aria-label={tr("刷新串口列表")} disabled={refreshing} onClick={onRefresh} className={button}><RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} /></button>
      <div className="w-32 space-y-1 text-xs"><label htmlFor={`${id}-baud`}>{tr("波特率")}</label><SelectMenu id={`${id}-baud`} isDark={isDark} disabled={locked} value={customBaud ? 'custom' : config.baudRate} options={[...BAUD_RATES.map(rate => ({ value: rate, label: String(rate) })), { value: 'custom', label: tr("自定义") }]} onChange={value => { setCustomBaud(value === 'custom'); if (value !== 'custom') setFraming('baudRate', value); else setCustomValue(String(config.baudRate)); }} /></div>
      {customBaud && <label className="w-32 space-y-1 text-xs">{tr("自定义波特率")}<input aria-label={tr("自定义波特率")} type="number" min="1" max="4000000" step="1" disabled={locked} value={customValue} onChange={event => { const value = event.target.value; setCustomValue(value); if (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 4000000) setFraming('baudRate', Number(value)); }} className={field} /></label>}
      <button type="button" onClick={connected ? onDisconnect : onConnect} disabled={Boolean(pending) || ['connecting', 'disconnecting'].includes(status) || (!connected && (!ports.some(port => port.path === selectedPath) || (customBaud && !customValid)))} className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-4 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${connected ? theme.button.secondary : theme.button.primary}`}>
        {pending || ['connecting', 'disconnecting'].includes(status) ? <Loader2 size={15} className="animate-spin" /> : connected ? <Unplug size={15} /> : <Plug size={15} />}{connected ? tr("断开串口") : status === 'connecting' || connectingRequest ? tr("连接中…") : status === 'disconnecting' ? tr("断开中…") : tr("连接串口")}
      </button>
      {(status === 'connecting' || connectingRequest) && <button type="button" disabled={cancelling} onClick={onDisconnect} className={button}><Unplug size={14} />{tr("取消连接")}</button>}
      {status === 'error' && <button type="button" disabled={Boolean(pending)} onClick={onDisconnect} className={button}><Unplug size={14} />{tr("重试释放端口")}</button>}
    </div>
    <div className={`flex flex-wrap items-center justify-between gap-2 text-xs ${theme.textMuted}`}>
      <span role="status" className={connected ? 'text-emerald-500' : ''}>{STATUS_TEXT()[status] || tr("未连接")}{connected && activePath ? ` · ${activePath}` : ''}{connected ? tr(" · 修改参数前请先断开") : tr(" · 仅点击连接后打开端口")}</span>
      <button type="button" aria-expanded={advanced} aria-controls={`${id}-advanced`} onClick={() => onAdvanced(!advanced)} className="inline-flex items-center gap-1 rounded py-1"><ChevronDown size={13} className={advanced ? '' : '-rotate-90'} />{tr("高级连接参数")}</button>
    </div>
    {customBaud && !customValid && <p role="alert" className="text-xs text-amber-500">{tr("请输入 1–4000000 的整数波特率，实际支持范围取决于驱动。")}</p>}
    {advanced && <div id={`${id}-advanced`} className="space-y-3 rounded-lg border border-slate-400/20 p-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {setting('dataBits', tr("数据位"), [5, 6, 7, 8].map(value => ({ value, label: String(value) })))}
        {setting('stopBits', tr("停止位"), [1, 1.5, 2].map(value => ({ value, label: String(value) })))}
        {setting('parity', tr("校验位"), [{ value: 'none', label: tr("无校验") }, { value: 'even', label: tr("偶校验") }, { value: 'odd', label: tr("奇校验") }, { value: 'mark', label: tr("标记校验") }, { value: 'space', label: tr("空格校验") }])}
        {setting('flowControl', tr("流控"), [{ value: 'none', label: tr("无流控") }, { value: 'rtscts', label: tr("硬件 RTS/CTS") }, { value: 'xonxoff', label: tr("软件 XON/XOFF") }])}
      </div>
      <p className={`text-xs leading-5 ${theme.textMuted}`}>{tr("默认 9600 / 8 / 1 / 无校验 / 无流控，并非自动识别的设备参数。打开端口时驱动可能改变 DTR / RTS 控制线；软件不会主动切换控制线探测或复位设备。")}</p>
    </div>}
  </div>;
}
