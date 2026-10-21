import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Command, Keyboard, Plus, RotateCcw, Search, Trash2, X } from 'lucide-react';
import { isDarkTheme } from '../shared/theme';
import SelectMenu from './SelectMenu';
import {
  COMMAND_ACTIONS,
  DEFAULT_COMMAND_SHORTCUT,
  actionLabel,
  eventToCommandShortcut,
  formatCommandShortcut
} from '../data/globalCommands';

function GlobalCommandPalette({ open, commands, theme, onClose, onRun }) {
  const isDark = isDarkTheme(theme);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-800';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return commands.filter(command => {
      if (!keyword) return true;
      return [command.title, command.description, command.group].some(value => String(value || '').toLowerCase().includes(keyword));
    });
  }, [commands, query]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const runCommand = (command) => {
    onRun(command);
    setQuery('');
    setActiveIndex(0);
    onClose();
  };

  const onInputKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(index => Math.min(index + 1, Math.max(filtered.length - 1, 0)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(index => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (filtered[activeIndex]) runCommand(filtered[activeIndex]);
    }
  };

  return (
    <div className="fixed inset-0 z-[220] bg-black/55 backdrop-blur-sm flex items-start justify-center px-4 pt-[12vh]" onMouseDown={onClose}>
      <div
        className={`w-full max-w-2xl rounded-xl border shadow-2xl overflow-hidden ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-white border-slate-200'}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className={`px-4 py-3 border-b flex items-center gap-3 ${isDark ? 'border-[#3E4145]' : 'border-slate-200'}`}>
          <Command size={18} className="text-emerald-400" />
          <div className="relative flex-1">
            <Search size={16} className={`absolute left-0 top-1/2 -translate-y-1/2 ${muted}`} />
            <input
              autoFocus
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="搜索命令"
              className={`w-full pl-7 pr-3 py-2 bg-transparent outline-none text-sm ${text}`}
            />
          </div>
          <button onClick={onClose} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-[#3E4145] text-[#9AA0A6]' : 'hover:bg-slate-100 text-slate-500'}`}>
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[56vh] overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className={`py-10 text-center text-sm ${muted}`}>未找到命令</div>
          ) : filtered.map((command, index) => (
            <button
              key={command.id}
              type="button"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runCommand(command)}
              className={`w-full text-left rounded-lg px-3 py-3 flex items-center justify-between gap-3 transition-colors ${
                activeIndex === index
                  ? isDark ? 'bg-[#3E4145]' : 'bg-emerald-50'
                  : isDark ? 'hover:bg-[#2D2F33]' : 'hover:bg-slate-50'
              }`}
            >
              <span className="min-w-0">
                <span className={`block text-sm font-semibold truncate ${text}`}>{command.title}</span>
                <span className={`block text-xs mt-0.5 truncate ${muted}`}>{command.description || actionLabel(command.action)}</span>
              </span>
              <span className={`shrink-0 text-[11px] px-2 py-1 rounded-full ${isDark ? 'bg-[#202124] text-[#9AA0A6]' : 'bg-white text-slate-500 border border-slate-200'}`}>
                {command.group || '命令'}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function GlobalCommandSettings({ settings, theme, onChange }) {
  const isDark = isDarkTheme(theme);
  const [draft, setDraft] = useState({ title: '', description: '', action: COMMAND_ACTIONS[0].value });
  const [recordingShortcut, setRecordingShortcut] = useState(false);
  const text = isDark ? 'text-[#E8EAED]' : 'text-slate-700';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-[#9AA0A6]';
  const field = isDark ? 'bg-[#202124] border-[#5F6368] text-[#E8EAED]' : 'bg-white border-slate-200 text-slate-700';
  const customCommands = Array.isArray(settings.customCommands) ? settings.customCommands : [];
  const shortcutLabel = formatCommandShortcut(settings.shortcut);

  const update = useCallback((patch) => onChange({ ...settings, ...patch }), [onChange, settings]);
  const addCommand = () => {
    const title = draft.title.trim();
    if (!title) return;
    const next = {
      id: `custom-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      title,
      description: draft.description.trim(),
      action: draft.action,
      group: '自定义'
    };
    update({ customCommands: [...customCommands, next] });
    setDraft({ title: '', description: '', action: COMMAND_ACTIONS[0].value });
  };
  const removeCommand = (id) => {
    update({ customCommands: customCommands.filter(command => command.id !== id) });
  };

  useEffect(() => {
    if (!recordingShortcut) return undefined;
    const onKeyDown = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecordingShortcut(false);
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        update({ shortcut: null });
        setRecordingShortcut(false);
        return;
      }
      const shortcut = eventToCommandShortcut(event);
      if (!shortcut) return;
      update({ shortcut });
      setRecordingShortcut(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [recordingShortcut, update]);

  return (
    <div className={`mb-6 p-4 rounded-xl border ${isDark ? 'bg-[#202124] border-[#3E4145]' : 'bg-slate-50 border-slate-200'}`}>
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className={`font-semibold ${text}`}>全局命令面板</div>
          <div className={`text-xs mt-1 ${muted}`}>通过自定义快捷键打开，可添加常用命令</div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={settings.enabled !== false}
            onChange={(event) => update({ enabled: event.target.checked })}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-emerald-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
        </label>
      </div>

      <div className={`mt-4 rounded-lg border p-3 ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className={`text-sm font-medium flex items-center gap-2 ${text}`}>
              <Keyboard size={15} className="text-emerald-400" />
              打开快捷键
            </div>
            <div className={`mt-1 text-xs ${muted}`}>需要包含 Ctrl / Alt / Shift / Win 中至少一个组合键；录制时 Esc 取消，Backspace 清除。</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setRecordingShortcut(true)}
              className={`min-w-[132px] px-3 py-2 rounded-lg border text-sm font-medium ${recordingShortcut ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
            >
              {recordingShortcut ? '按下组合键...' : shortcutLabel}
            </button>
            <button
              type="button"
              onClick={() => update({ shortcut: { ...DEFAULT_COMMAND_SHORTCUT } })}
              className={`p-2 rounded-lg border ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
              title="恢复默认 Ctrl+K"
            >
              <RotateCcw size={15} />
            </button>
            <button
              type="button"
              onClick={() => update({ shortcut: null })}
              className={`px-3 py-2 rounded-lg border text-sm ${isDark ? 'border-[#5F6368] text-[#E8EAED] hover:bg-[#3E4145]' : 'border-slate-200 text-slate-700 hover:bg-slate-100'}`}
            >
              清除
            </button>
          </div>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_1fr_220px_auto] gap-2 mt-4">
        <input
          value={draft.title}
          onChange={(event) => setDraft(prev => ({ ...prev, title: event.target.value }))}
          placeholder="命令名称"
          className={`px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${field}`}
        />
        <input
          value={draft.description}
          onChange={(event) => setDraft(prev => ({ ...prev, description: event.target.value }))}
          placeholder="描述"
          className={`px-3 py-2 border rounded-lg text-sm outline-none focus:ring-2 focus:ring-emerald-500 ${field}`}
        />
        <div><label htmlFor="global-command-action" className="sr-only">命令操作</label><SelectMenu
          id="global-command-action"
          value={draft.action}
          onChange={action => setDraft(prev => ({ ...prev, action }))}
          isDark={isDark}
          options={COMMAND_ACTIONS}
        /></div>
        <button
          type="button"
          onClick={addCommand}
          className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium flex items-center justify-center gap-1.5"
        >
          <Plus size={15} />添加
        </button>
      </div>

      {customCommands.length > 0 && (
        <div className="mt-4 space-y-2">
          {customCommands.map(command => (
            <div key={command.id} className={`flex items-center justify-between gap-3 rounded-lg border px-3 py-2 ${isDark ? 'border-[#3E4145] bg-[#2D2F33]' : 'border-slate-200 bg-white'}`}>
              <div className="min-w-0">
                <div className={`text-sm font-medium truncate ${text}`}>{command.title}</div>
                <div className={`text-xs truncate ${muted}`}>{command.description || actionLabel(command.action)}</div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-emerald-400 flex items-center gap-1"><Check size={13} />已启用</span>
                <button onClick={() => removeCommand(command.id)} className={`p-1.5 rounded-lg ${isDark ? 'hover:bg-[#3E4145] text-[#9AA0A6]' : 'hover:bg-slate-100 text-slate-500'}`}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default GlobalCommandPalette;
