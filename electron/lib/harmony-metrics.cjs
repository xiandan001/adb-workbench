const { tr } = require('./localization.cjs');
const { runHdc } = require('./hdc-runtime.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');

const ticks = new Map();
const MARKERS = { cpu: '__AWB_HOS_CPU__', memory: '__AWB_HOS_MEMORY__', disk: '__AWB_HOS_DISK__', processes: '__AWB_HOS_PROCESSES__', battery: '__AWB_HOS_BATTERY__', thermal: '__AWB_HOS_THERMAL__' };
function metricSections(text) {
  const values = Object.fromEntries(Object.keys(MARKERS).map(key => [key, '']));
  let current = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const key = Object.keys(MARKERS).find(key => line === MARKERS[key]);
    if (key) current = key;
    else if (current) values[current] += line + '\n';
  }
  return values;
}
function parseHarmonyCpu(text, previous) {
  const line = String(text || '').split(/\r?\n/).find(line => /^cpu\s/.test(line));
  if (!line) return { value: { usage: null }, ticks: null };
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some(value => !Number.isFinite(value) || value < 0)) return { value: { usage: null }, ticks: null };
  const sample = { idle: values[3] + (values[4] || 0), total: values.slice(0, 8).reduce((sum, value) => sum + value, 0) };
  const delta = previous ? sample.total - previous.total : 0;
  const idleDelta = previous ? sample.idle - previous.idle : 0;
  const usage = delta > 0 && idleDelta >= 0 && idleDelta <= delta ? Number(((1 - idleDelta / delta) * 100).toFixed(1)) : null;
  return { value: { usage }, ticks: sample };
}
function parseHarmonyMemory(text) {
  const values = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = /^(MemTotal|MemAvailable|MemFree):\s+(\d+)\s+kB\s*$/i.exec(line);
    if (match) values[match[1].toLowerCase()] = Number(match[2]);
  }
  const total = values.memtotal;
  const available = values.memavailable ?? values.memfree;
  if (!(total > 0) || !Number.isFinite(available) || available < 0 || available > total) {
    return { totalKb: null, usedKb: null, availableKb: null, usage: null, source: '/proc/meminfo' };
  }
  return { totalKb: total, availableKb: available, usedKb: total - available,
    usage: Number(((total - available) / total * 100).toFixed(1)), source: '/proc/meminfo',
    availableBasis: values.memavailable !== undefined ? 'MemAvailable' : 'MemFree' };
}
function parseHarmonyDisk(text) {
  return String(text || '').split(/\r?\n/).flatMap(line => {
    const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
    if (!match || Number(match[5]) > 100) return [];
    return [{ filesystem: match[1], sizeKb: Number(match[2]), usedKb: Number(match[3]), availableKb: Number(match[4]), usage: Number(match[5]), mount: match[6] }];
  }).slice(0, 64);
}
function parseHarmonyProcesses(text) {
  const lines = String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const index = lines.findIndex(line => /\bPID\b/.test(line));
  if (index < 0) return [];
  const header = lines[index].split(/\s+/), pidIndex = header.indexOf('PID');
  const nameIndex = header.findIndex(value => /^(?:NAME|CMD|COMMAND|ARGS|CMDLINE)$/.test(value));
  if (pidIndex < 0 || nameIndex < 0) return [];
  return lines.slice(index + 1).flatMap(line => {
    const cells = line.split(/\s+/), pid = cells[pidIndex];
    return /^\d+$/.test(pid || '') ? [{ pid, name: cells.slice(nameIndex).join(' '), cpu: null, memory: null }] : [];
  }).slice(0, 100);
}
function nativeMetricCommand(includeProcesses) {
  return [
    `printf '${MARKERS.cpu}\\n'; cat /proc/stat 2>/dev/null`,
    `printf '${MARKERS.memory}\\n'; cat /proc/meminfo 2>/dev/null`,
    `printf '${MARKERS.disk}\\n'; df -k 2>/dev/null`,
    `printf '${MARKERS.battery}\\n'; for supply in /sys/class/power_supply/*; do [ "$(cat "$supply/type" 2>/dev/null)" = Battery ] || continue; for property in capacity temp status present; do printf '%s=' "$property"; cat "$supply/$property" 2>/dev/null; printf '\\n'; done; break; done`,
    `printf '${MARKERS.thermal}\\n'; count=0; for zone in /sys/class/thermal/thermal_zone*; do [ -r "$zone/temp" ] || continue; printf '%s|' "$zone"; cat "$zone/type" 2>/dev/null | tr '\\n' ' '; printf '|'; cat "$zone/temp" 2>/dev/null; printf '\\n'; count=$((count+1)); [ "$count" -lt 12 ] || break; done`,
    ...(includeProcesses ? [`printf '${MARKERS.processes}\\n'; ps -A -o PID,NAME 2>/dev/null || ps -ef 2>/dev/null`] : []),
    'true'
  ].join('; ');
}
function parseHarmonyBattery(text) {
  const values = Object.fromEntries(String(text || '').split(/\r?\n/).flatMap(line => {
    const match = /^(capacity|temp|status|present)=(.*)$/.exec(line); return match ? [[match[1], match[2].trim()]] : [];
  }));
  const numeric = (key, min, max) => /^-?\d+$/.test(values[key] || '') && Number(values[key]) >= min && Number(values[key]) <= max ? Number(values[key]) : null;
  const temperature = numeric('temp', -1000, 2000), level = numeric('capacity', 0, 100), present = numeric('present', 0, 1);
  return { present: present === null ? level === null ? null : true : Boolean(present), level, temperature: temperature === null ? null : temperature / 10,
    status: values.status || null, plugged: null, health: null, source: '/sys/class/power_supply', temperatureUnit: 'tenths-Celsius' };
}
function parseHarmonyThermal(text) {
  const sensors = String(text || '').split(/\r?\n/).flatMap(line => {
    const match = /^(\/sys\/class\/thermal\/thermal_zone\d+)\|([^|]*)\|(-?\d+)$/.exec(line.trim());
    if (!match || Number(match[3]) < -100000 || Number(match[3]) > 250000) return [];
    return [{ name: match[2].trim() || match[1].split('/').pop(), value: Number(match[3]) / 1000, status: null, source: match[1], unit: 'Celsius' }];
  }).slice(0, 12);
  return { sensors, hottest: sensors.length ? Math.max(...sensors.map(item => item.value)) : null };
}
async function collectHarmonySnapshot(deviceId, options = {}) {
  const ref = resolveDeviceRef(deviceId, options);
  const execute = options.runHdc || runHdc;
  const response = await execute(deviceId, ['shell', nativeMetricCommand(options.includeProcesses === true)], {
    ...options, deviceRef: ref, timeoutMs: Math.max(2500, options.timeoutMs || 0), maxBuffer: 1024 * 1024,
  });
  const sections = metricSections(response.ok ? response.stdout : '');
  const key = `${ref.id}:${ref.generation}`;
  const cpu = parseHarmonyCpu(sections.cpu, ticks.get(key));
  if (cpu.ticks) ticks.set(key, cpu.ticks); else ticks.delete(key);
  if (ticks.size > 128) ticks.delete(ticks.keys().next().value);
  const memory = parseHarmonyMemory(sections.memory), disk = parseHarmonyDisk(sections.disk);
  const battery = parseHarmonyBattery(sections.battery), thermal = parseHarmonyThermal(sections.thermal);
  const unavailable = [];
  if (cpu.value.usage === null) unavailable.push({ metric: 'cpu', reason: cpu.ticks ? tr('CPU 需要相邻两次有效采样。') : tr('设备未提供可读的 CPU 计数。') });
  if (memory.usage === null) unavailable.push({ metric: 'memory', reason: tr('设备未提供可读的内存统计。') });
  if (!disk.length) unavailable.push({ metric: 'disk', reason: tr('设备未提供可读的存储统计。') });
  const mediaReason = tr('此鸿蒙设备尚未提供已验证的帧率采样能力。');
  unavailable.push({ metric: 'fps', reason: mediaReason });
  if (battery.present === null) unavailable.push({ metric: 'battery', reason: tr('未取得可验证的鸿蒙电池数据。') });
  if (thermal.hottest === null && battery.temperature === null) unavailable.push({ metric: 'thermal', reason: tr('未取得单位明确的鸿蒙温度数据。') });
  return { timestamp: Date.now(), deviceId, platform: 'harmony', transport: 'hdc', generation: ref.generation,
    cpu: cpu.value, memory, disk, battery, thermal,
    fps: { foreground: { fps: null, packageName: '', activityName: '', source: 'harmony', error: mediaReason },
      surfaceFlinger: { fps: null, layer: '', refreshRate: null, source: 'harmony', error: mediaReason } },
    processes: options.includeProcesses ? parseHarmonyProcesses(sections.processes) : [], warnings: [], unavailable,
    source: { cpu: '/proc/stat', memory: '/proc/meminfo', disk: 'df -k', processes: 'ps', platform: 'harmony' },
    sampleError: response.ok ? !cpu.ticks && memory.usage === null && !disk.length ? tr('本次未取得可验证的性能样本。') : '' : response.error || tr('鸿蒙性能采样失败。') };
}
module.exports = { collectHarmonySnapshot, metricSections, parseHarmonyCpu, parseHarmonyMemory, parseHarmonyDisk, parseHarmonyProcesses, parseHarmonyBattery, parseHarmonyThermal, nativeMetricCommand };
