import { tr, useLocale, getLocale } from '../shared/i18n';
import { useState } from 'react';
import { PERFORMANCE_METRICS, makePerformancePath, nearestPerformanceSample, performanceAxisMax, performanceLogPositions, performanceNoticeLabel, performanceTimelinePositions } from '../shared/performanceChart';

const GROUPS = () => ([
  { id: 'percent', label: tr("占用率 %"), unit: '%' },
  { id: 'temperature', label: tr("温度 °C"), unit: '°C' },
  { id: 'fps', label: tr("帧率 FPS"), unit: 'FPS' }
]);

export default function PerformanceTrendChart({ points, isDark, selectedTimestamp, onSelectIncident, logTimes = [] }) {
  useLocale();
  const [group, setGroup] = useState('percent');
  const [hidden, setHidden] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const metrics = PERFORMANCE_METRICS.filter(metric => metric.group === group);
  const visible = metrics.filter(metric => !hidden.includes(metric.key));
  const unit = GROUPS().find(item => item.id === group).unit;
  const width = 720;
  const height = 260;
  const pad = 42;
  const max = performanceAxisMax(group, points, metrics);
  const fixedIndex = points.findIndex(point => point.timestamp === selectedTimestamp);
  const selectedIndex = activeIndex >= 0 ? Math.min(activeIndex, points.length - 1) : fixedIndex;
  const selected = points[selectedIndex];
  const ticks = Array.from({ length: 5 }, (_, index) => max * index / 4);
  const times = points.length >= 2 ? [points[0].timestamp, (points[0].timestamp + points.at(-1).timestamp) / 2, points.at(-1).timestamp] : [];
  const positions = performanceTimelinePositions(points);
  const timestamps = points.map(point => point.timestamp);
  const loggedPositions = performanceLogPositions(points, logTimes);
  const xAt = index => pad + positions[index] * (width - pad * 2);
  const recent = points.filter(point => point.notices?.length).slice(-4).reverse();
  const field = isDark ? 'border-[#5F6368] bg-[#202124] text-[#E8EAED]' : 'border-slate-300 bg-white text-slate-700';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const formatTime = timestamp => timestamp ? new Date(timestamp).toLocaleTimeString(getLocale(), { hour12: false }) : '--:--:--';
  const pointerIndex = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.width ? (event.clientX - rect.left) / rect.width * width : pad;
    return nearestPerformanceSample((x - pad) / (width - pad * 2), positions);
  };
  const selectPoint = index => {
    if (points[index]) onSelectIncident?.(points[index]);
  };
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div role="group" aria-label={tr("趋势图单位分组")} className="flex flex-wrap gap-1">
          {GROUPS().map(item => <button key={item.id} type="button" aria-pressed={group === item.id} onClick={() => setGroup(item.id)} className={`rounded-lg border px-2.5 py-1.5 text-xs ${group === item.id ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600' : field}`}>{item.label}</button>)}
        </div>
        <span className={`text-xs ${muted}`}>{tr("显示最近 {0} 个样本（最多 80 个）", { 0: points.length })}</span>
      </div>
      <div className="flex flex-wrap gap-3 mb-2" role="group" aria-label={tr("显示的性能指标")}>
        {metrics.map(metric => <label key={metric.key} className={`inline-flex items-center gap-1.5 text-xs ${muted}`}>
          <input type="checkbox" checked={!hidden.includes(metric.key)} onChange={() => setHidden(previous => previous.includes(metric.key) ? previous.filter(key => key !== metric.key) : [...previous, metric.key])} />
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: metric.color }} />{metric.label}
        </label>)}
      </div>
      <div className={`h-[270px] overflow-hidden rounded-lg border ${field}`}>
        {points.length < 2 ? <div className={`flex h-full items-center justify-center text-sm ${muted}`}>{tr("至少需要 2 个样本显示趋势")}</div> : visible.length === 0 ? <div className={`flex h-full items-center justify-center text-sm ${muted}`}>{tr("勾选至少一个指标以显示曲线")}</div> : (
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`h-full w-full ${onSelectIncident ? 'cursor-crosshair' : ''}`} role="img" aria-label={tr("{0} 性能趋势图", { 0: unit })}
            onPointerMove={event => setActiveIndex(pointerIndex(event))} onPointerLeave={() => setActiveIndex(-1)}
            onClick={event => selectPoint(pointerIndex(event))}>
            <text x={8} y={20} fontSize="12" fill={isDark ? '#cbd5e1' : '#475569'}>{unit}</text>
            {ticks.map(value => {
              const y = pad + (max - value) / max * (height - pad * 2);
              return <g key={value}><line x1={pad} x2={width - pad} y1={y} y2={y} stroke={isDark ? '#334155' : '#e2e8f0'} strokeDasharray="4 6" /><text x={pad - 8} y={y + 4} textAnchor="end" fontSize="11" fill={isDark ? '#94a3b8' : '#64748b'}>{Number(value.toFixed(1))}</text></g>;
            })}
            {times.map((time, index) => <text key={time} x={pad + index / 2 * (width - pad * 2)} y={height - 12} textAnchor={['start', 'middle', 'end'][index]} fontSize="11" fill={isDark ? '#94a3b8' : '#64748b'}>{formatTime(time)}</text>)}
            {visible.map(metric => <path key={metric.key} d={makePerformancePath(points.map(point => point[metric.key]), width, height, pad, max, positions, timestamps)} fill="none" stroke={metric.color} strokeWidth="2.4" />)}
            {points.map((point, index) => point.notices?.length > 0 ? <circle key={point.timestamp} cx={xAt(index)} cy={pad - 10} r={4} fill={isDark ? '#fbbf24' : '#b45309'} /> : null)}
            {loggedPositions.map(position => {
              const x = pad + position * (width - pad * 2);
              return <line key={position} x1={x} x2={x} y1={height - pad + 5} y2={height - pad + 13} stroke={isDark ? '#7dd3fc' : '#0369a1'} strokeWidth="2" />;
            })}
            {fixedIndex >= 0 && <line x1={xAt(fixedIndex)} x2={xAt(fixedIndex)} y1={pad - 10} y2={height - pad} stroke={isDark ? '#6ee7b7' : '#047857'} strokeDasharray="3 3" />}
            {selected && selectedIndex !== fixedIndex && <line x1={xAt(selectedIndex)} x2={xAt(selectedIndex)} y1={pad - 10} y2={height - pad} stroke={isDark ? '#e2e8f0' : '#475569'} strokeDasharray="3 3" />}
          </svg>
        )}
      </div>
      <div className={`mt-2 min-h-8 text-xs ${muted}`} aria-live="polite">
        {selected ? <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>{formatTime(selected.timestamp)}</span>
          {visible.map(metric => <span key={metric.key}>{metric.label}：{Number.isFinite(selected[metric.key]) ? `${selected[metric.key].toFixed(1)} ${metric.unit}` : tr("无数据")}</span>)}
        </div> : tr("点击曲线查看同一设备附近的日志。")}
      </div>
      {points.length > 1 && <input type="range" min="0" max={points.length - 1} value={selectedIndex < 0 ? points.length - 1 : selectedIndex} onChange={event => setActiveIndex(Number(event.target.value))} aria-label={tr("用键盘选择趋势样本")} className="w-full accent-emerald-500" />}
      {!!points.length && <button type="button" onClick={() => selectPoint(selectedIndex < 0 ? points.length - 1 : selectedIndex)}
        className={`mt-2 rounded-lg border px-3 py-2 text-xs ${field}`}>{tr('查看该时刻日志')}</button>}
      {!!loggedPositions.length && <span className={`ms-3 inline-flex items-center gap-1.5 text-xs ${muted}`}>
        <span aria-hidden="true" className={`h-2 w-0.5 ${isDark ? 'bg-sky-300' : 'bg-sky-700'}`} />{tr('日志时间标记')}</span>}
      {!!recent.length && <div className="mt-4 space-y-2 border-t border-current/10 pt-3">
        <h4 className="text-xs font-semibold">{tr('近期异常与告警')}</h4>
        <div className="flex flex-wrap gap-2">{recent.map(point => <button key={point.timestamp} type="button"
          aria-pressed={selectedTimestamp === point.timestamp} onClick={() => onSelectIncident?.(point)}
          className={`rounded-lg border px-2.5 py-1.5 text-left text-xs ${selectedTimestamp === point.timestamp ? 'border-emerald-500/50 bg-emerald-500/10' : field}`}>
          <span className={`me-2 ${muted}`}>{formatTime(point.timestamp)}</span>
          {point.notices.map(performanceNoticeLabel).join(' · ')}
        </button>)}</div>
      </div>}
    </div>
  );
}
