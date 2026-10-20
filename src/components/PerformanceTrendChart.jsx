import { useState } from 'react';
import { PERFORMANCE_METRICS, makePerformancePath, performanceAxisMax, performanceSampleIndex } from '../shared/performanceChart';

const GROUPS = [
  { id: 'percent', label: '占用率 %', unit: '%' },
  { id: 'temperature', label: '温度 °C', unit: '°C' },
  { id: 'fps', label: '帧率 FPS', unit: 'FPS' }
];

export default function PerformanceTrendChart({ points, isDark }) {
  const [group, setGroup] = useState('percent');
  const [hidden, setHidden] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const metrics = PERFORMANCE_METRICS.filter(metric => metric.group === group);
  const visible = metrics.filter(metric => !hidden.includes(metric.key));
  const unit = GROUPS.find(item => item.id === group).unit;
  const width = 720;
  const height = 260;
  const pad = 42;
  const max = performanceAxisMax(group, points, metrics);
  const selectedIndex = Math.min(activeIndex, points.length - 1);
  const selected = points[selectedIndex];
  const ticks = Array.from({ length: 5 }, (_, index) => max * index / 4);
  const times = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(index => index >= 0 && index < points.length);
  const field = isDark ? 'border-[#5F6368] bg-[#202124] text-[#E8EAED]' : 'border-slate-300 bg-white text-slate-700';
  const muted = isDark ? 'text-[#9AA0A6]' : 'text-slate-500';
  const formatTime = timestamp => timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div role="group" aria-label="趋势图单位分组" className="flex flex-wrap gap-1">
          {GROUPS.map(item => <button key={item.id} type="button" aria-pressed={group === item.id} onClick={() => setGroup(item.id)} className={`rounded-lg border px-2.5 py-1.5 text-xs ${group === item.id ? 'border-emerald-500 bg-emerald-500/10 text-emerald-600' : field}`}>{item.label}</button>)}
        </div>
        <span className={`text-xs ${muted}`}>显示最近 {points.length} 个样本（最多 80 个）</span>
      </div>
      <div className="flex flex-wrap gap-3 mb-2" role="group" aria-label="显示的性能指标">
        {metrics.map(metric => <label key={metric.key} className={`inline-flex items-center gap-1.5 text-xs ${muted}`}>
          <input type="checkbox" checked={!hidden.includes(metric.key)} onChange={() => setHidden(previous => previous.includes(metric.key) ? previous.filter(key => key !== metric.key) : [...previous, metric.key])} />
          <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: metric.color }} />{metric.label}
        </label>)}
      </div>
      <div className={`h-[270px] overflow-hidden rounded-lg border ${field}`}>
        {points.length < 2 ? <div className={`flex h-full items-center justify-center text-sm ${muted}`}>至少需要 2 个样本显示趋势</div> : visible.length === 0 ? <div className={`flex h-full items-center justify-center text-sm ${muted}`}>勾选至少一个指标以显示曲线</div> : (
          <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="w-full h-full" role="img" aria-label={`${unit} 性能趋势图`} onPointerMove={event => {
            const rect = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width * width;
            setActiveIndex(performanceSampleIndex((x - pad) / (width - pad * 2), points.length));
          }} onPointerLeave={() => setActiveIndex(-1)}>
            <text x={8} y={20} fontSize="12" fill={isDark ? '#cbd5e1' : '#475569'}>{unit}</text>
            {ticks.map(value => {
              const y = pad + (max - value) / max * (height - pad * 2);
              return <g key={value}><line x1={pad} x2={width - pad} y1={y} y2={y} stroke={isDark ? '#334155' : '#e2e8f0'} strokeDasharray="4 6" /><text x={pad - 8} y={y + 4} textAnchor="end" fontSize="11" fill={isDark ? '#94a3b8' : '#64748b'}>{Number(value.toFixed(1))}</text></g>;
            })}
            {times.map(index => <text key={index} x={pad + index / Math.max(points.length - 1, 1) * (width - pad * 2)} y={height - 12} textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'} fontSize="11" fill={isDark ? '#94a3b8' : '#64748b'}>{formatTime(points[index]?.timestamp)}</text>)}
            {visible.map(metric => <path key={metric.key} d={makePerformancePath(points.map(point => point[metric.key]), width, height, pad, max)} fill="none" stroke={metric.color} strokeWidth="2.4" />)}
            {selected && <line x1={pad + selectedIndex / Math.max(points.length - 1, 1) * (width - pad * 2)} x2={pad + selectedIndex / Math.max(points.length - 1, 1) * (width - pad * 2)} y1={pad} y2={height - pad} stroke={isDark ? '#e2e8f0' : '#475569'} strokeDasharray="3 3" />}
          </svg>
        )}
      </div>
      <div className={`mt-2 min-h-8 text-xs ${muted}`} aria-live="polite">
        {selected ? <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>{formatTime(selected.timestamp)}</span>
          {visible.map(metric => <span key={metric.key}>{metric.label}：{Number.isFinite(selected[metric.key]) ? `${selected[metric.key].toFixed(1)} ${metric.unit}` : '无数据'}</span>)}
        </div> : '悬停查看时间和准确数值；缺失样本不连线。'}
      </div>
      {points.length > 1 && <input type="range" min="0" max={points.length - 1} value={selectedIndex < 0 ? points.length - 1 : selectedIndex} onChange={event => setActiveIndex(Number(event.target.value))} aria-label="用键盘选择趋势样本" className="w-full accent-emerald-500" />}
    </div>
  );
}
