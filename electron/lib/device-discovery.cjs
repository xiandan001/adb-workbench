const { runAdb } = require('./adb-runtime.cjs');
const { runHdc, runHdcHost } = require('./hdc-runtime.cjs');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');
const { parseHdcDeviceRows } = require('./hdc-device-parser.cjs');
const { tr } = require('./localization.cjs');
const { registerDiscoveredDevices, markDeviceDiscoveryUnconfirmed, resolveDeviceRef, knownDevices } = require('./device-registry.cjs');

const transports = ['adb', 'hdc'];
const nativeMetadata = new Map();
const probeScript = [
  "printf '__AWB_MODEL__'; param get const.product.model 2>/dev/null; printf '\\n'",
  "printf '__AWB_VERSION__'; param get const.product.software.version 2>/dev/null; printf '\\n'",
  "printf '__AWB_API__'; param get const.ohos.apiversion 2>/dev/null; printf '\\n'",
  ...['uitest', 'snapshot_display', 'screenrecord', 'hilog', 'hidumper', 'bm', 'aa', 'mediatool'].map(name => `if command -v ${name} >/dev/null 2>&1; then printf '__AWB_TOOL__${name}\\n'; fi`),
  "if [ -r /proc/stat ] || [ -r /proc/meminfo ]; then printf '__AWB_METRICS__\\n'; fi",
  'true'
].join('; ');

async function enrichHarmonyDevice(device, options) {
  if (device.status !== 'device') return device;
  const ref = resolveDeviceRef(device.id);
  const cached = nativeMetadata.get(device.id);
  if (cached?.generation === ref.generation && Date.now() - cached.at < 60000) return { ...device, ...cached.value };
  const result = await (options.readHdc || runHdc)(device.id, ['shell', probeScript], { timeoutMs: 7000 });
  const text = result.ok ? String(result.stdout) : '';
  const property = name => text.match(new RegExp(`__AWB_${name}__([^\\r\\n]*)`))?.[1]?.trim() || '';
  const tools = new Set([...text.matchAll(/__AWB_TOOL__([a-z_]+)/g)].map(match => match[1]));
  const apiVersion = Number(property('API')) || null;
  const available = name => result.ok ? tools.has(name) : null;
  const capabilities = { probed: result.ok, shell: result.ok ? true : null, files: true, apps: available('bm'),
    logs: available('hilog'), screenshot: available('uitest'), ui: available('uitest'),
    textInput: tools.has('uitest') && apiVersion >= 18, recording: null, mirror: null,
    mediaCandidate: tools.has('uitest') && apiVersion >= 12,
    performance: text.includes('__AWB_METRICS__'), tools: [...tools] };
  const value = { model: property('MODEL') || device.model, systemVersion: property('VERSION'), apiVersion, capabilities };
  if (resolveDeviceRef(device.id, { allowOffline: true }).generation === ref.generation) {
    nativeMetadata.set(device.id, { at: Date.now(), generation: ref.generation, value });
  }
  return { ...device, ...value };
}
function parseChannelRows(transport, result) {
  if (!result?.ok) throw new Error(result?.error || String(result?.stderr || '') || tr('无法读取设备列表，请运行环境自检。'));
  const stdout = String(result.stdout || '');
  if (transport === 'adb') {
    if (!stdout.split(/\r?\n/).some(line => line.trim() === 'List of devices attached')) {
      throw new Error(tr('无法读取设备列表，请运行环境自检。'));
    }
    return parseAdbDeviceRows(stdout).map(({ id, status, detail }) => ({
      id, status, model: detail.match(/model:([^\s]+)/)?.[1] || '', transport: 'adb', platform: 'android'
    }));
  }
  const rows = parseHdcDeviceRows(stdout);
  if (stdout.trim() && !rows.length && !stdout.split(/\r?\n/).some(line => /^(?:\[?Empty\]?|No (?:devices|targets)(?: found)?\.?)$/i.test(line.trim()))) {
    throw new Error(tr('无法读取设备列表，请运行环境自检。'));
  }
  return rows;
}
async function readDeviceChannels(options, publish) {
  const known = knownDevices().filter(device => device.status !== 'disconnected');
  const devices = Object.fromEntries(transports.map(transport => [transport, known.filter(device => device.transport === transport)]));
  const channels = { adb: 'pending', hdc: 'pending' };
  const errors = {};
  let unconnectedTargets = [];
  const snapshot = () => ({
    devices: transports.flatMap(transport => devices[transport]), channels: { ...channels }, errors: { ...errors },
    available: Object.values(channels).includes('ready'), unconnectedTargets
  });
  async function discoverChannel(transport, read) {
    try {
      const parsed = parseChannelRows(transport, await read());
      if (transport === 'hdc') unconnectedTargets = parsed.filter(device => !['device', 'unauthorized'].includes(device.status));
      const rows = transport === 'hdc' ? parsed.filter(device => ['device', 'unauthorized'].includes(device.status)) : parsed;
      devices[transport] = registerDiscoveredDevices(transport, rows);
      channels[transport] = 'ready';
    } catch (failure) {
      errors[transport] = failure.message;
      devices[transport] = markDeviceDiscoveryUnconfirmed(transport);
      channels[transport] = 'unconfirmed';
    }
    publish?.(snapshot());
    if (transport === 'hdc' && channels.hdc === 'ready') {
      const enriched = await Promise.all(devices.hdc.map(device => enrichHarmonyDevice(device, options).catch(() => device)));
      devices.hdc = registerDiscoveredDevices('hdc', enriched);
      publish?.(snapshot());
    }
  }
  await Promise.all([
    discoverChannel('adb', () => (options.readAdb || runAdb)(['devices', '-l'], { timeoutMs: 10000, queueGlobal: true })),
    discoverChannel('hdc', () => (options.readHdcHost || runHdcHost)(['list', 'targets', '-v'], { timeoutMs: 8000 }))
  ]);
  return snapshot();
}
let currentDiscovery = null;
async function discoverDevices(options = {}, onProgress) {
  if (Object.keys(options).length) return readDeviceChannels(options, onProgress);
  if (!currentDiscovery) {
    const flight = { listeners: new Set(), latest: null };
    currentDiscovery = flight;
    flight.promise = readDeviceChannels(options, snapshot => {
      flight.latest = snapshot;
      for (const listener of flight.listeners) listener(snapshot);
    }).finally(() => { currentDiscovery = null; });
  }
  const flight = currentDiscovery;
  if (onProgress) {
    flight.listeners.add(onProgress);
    if (flight.latest) onProgress(flight.latest);
  }
  try { return await flight.promise; }
  finally { if (onProgress) flight.listeners.delete(onProgress); }
}
async function listDevices(options) { return (await discoverDevices(options)).devices; }
module.exports = { discoverDevices, listDevices, enrichHarmonyDevice };
