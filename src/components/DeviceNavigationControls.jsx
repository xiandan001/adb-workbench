import { useRef, useState } from 'react';
import { Home, PanelRightOpen, Settings, Presentation, Loader2 } from 'lucide-react';

const actions = [
  { id: 'home', label: '回到桌面', icon: <Home size={19} />, command: 'input keyevent KEYCODE_HOME' },
  {
    id: 'sidebar', label: '打开侧边栏', icon: <PanelRightOpen size={19} />,
    packageName: 'com.xbh.navisetting',
    command: 'am broadcast --user current -a com.xbh.action.show_control_panel -p com.xbh.navisetting'
  },
  {
    id: 'settings', label: '打开系统设置', icon: <Settings size={19} />,
    packageName: 'com.xbh.jyjsetting',
    command: 'am start --user current -W -n com.xbh.jyjsetting/.mainsetting.view.MainActivity'
  },
  {
    id: 'whiteboard', label: '打开白板', icon: <Presentation size={19} />,
    packageName: 'com.xbh.whiteboard',
    command: 'am start --user current -W -n com.xbh.whiteboard/.LaunchActivity'
  }
];

function DeviceNavigationControls({ deviceId, isOnline, showToast }) {
  const [pending, setPending] = useState('');
  const busyRef = useRef(false);

  const runAction = async (action) => {
    if (!isOnline || busyRef.current) return;
    const api = window.electronAPI;
    if (!api?.adbShell) {
      showToast('设备控制需要在桌面应用中使用');
      return;
    }
    busyRef.current = true;
    setPending(action.id);
    try {
      if (action.packageName) {
        const probe = await api.adbShell(deviceId, `pm path ${action.packageName}`);
        if (!probe.success) throw new Error(probe.error || '无法读取设备应用信息');
        if (!/^package:/m.test(probe.output || '')) {
          throw new Error('设备未安装对应的系统应用');
        }
      }
      // am 可能将错误写入输出且仍返回 0，合并 stderr 后检查实际结果。
      const result = await api.adbShell(deviceId, `${action.command} 2>&1`);
      const output = result.output || '';
      if (!result.success || /(?:^|\n)\s*(?:Error(?:\s+type\s+\d+)?\s*:|Exception|java\.[\w.]+Exception)/i.test(output)) {
        throw new Error(result.error || output || '设备未能执行指令');
      }
      showToast(`已发送${action.label}指令`);
    } catch (error) {
      showToast(`${action.label}失败：${error.message}`);
    } finally {
      busyRef.current = false;
      setPending('');
    }
  };

  return (
    <div className="device-navigation-grid" role="group" aria-label="设备快捷操作">
      {actions.map(action => (
        <button
          key={action.id}
          type="button"
          className="device-navigation-button"
          onClick={() => runAction(action)}
          disabled={!isOnline || Boolean(pending)}
          aria-busy={pending === action.id}
          aria-label={action.label}
        >
          <span className="device-navigation-icon" aria-hidden="true">
            {pending === action.id ? <Loader2 size={19} className="animate-spin" /> : action.icon}
          </span>
          <span>{pending === action.id ? '执行中…' : action.label}</span>
        </button>
      ))}
    </div>
  );
}

export default DeviceNavigationControls;
