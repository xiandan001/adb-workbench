import { RefreshCw } from 'lucide-react';
import themes from '../data/themes';

function ControlButton({ icon, label, onClick, disabled, loading, theme, isRecording, title }) {
  const t = theme || themes.default;
  const primaryColor = t.primary;

  const getSecondaryClass = () => {
    if (primaryColor === 'cyan' || primaryColor === 'blue') return 'text-blue-600';
    if (primaryColor === 'pink') return 'text-pink-600';
    if (primaryColor === 'green') return 'text-green-600';
    if (primaryColor === 'orange') return 'text-orange-600';
    return 'text-emerald-600';
  };

  // 录屏按钮红色样式
  const isRecordButton = isRecording !== undefined;
  const buttonClass = isRecordButton && isRecording
    ? 'flex items-center space-x-2 border bg-red-500 hover:bg-red-600 text-white disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded-md text-sm font-medium transition-colors'
    : `flex items-center space-x-2 border ${t.button.secondary} hover:${getSecondaryClass()} disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 rounded-md text-sm font-medium transition-colors`;

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={buttonClass}
    >
      {loading ? (
        <>
          <RefreshCw size={16} className="animate-spin" />
          <span>{label}</span>
        </>
      ) : (
        <>
          {icon}
          <span>{label}</span>
        </>
      )}
    </button>
  );
}

export default ControlButton;
