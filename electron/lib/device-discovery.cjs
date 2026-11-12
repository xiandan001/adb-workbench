const { runAdb } = require('./adb-runtime.cjs');
const { runHdc, runHdcHost } = require('./hdc-runtime.cjs');
const { parseAdbDeviceRows } = require('./adb-device-parser.cjs');
const { parseHdcDeviceRows } = require('./hdc-device-parser.cjs');
const { registerDiscoveredDevices, resolveDeviceRef } = require('./device-registry.cjs');

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
async function readDeviceChannels(options) {
  const channels = await Promise.allSettled([
    (options.readAdb || runAdb)(['devices', '-l'], { timeoutMs: 10000, queueGlobal: true }),
    (options.readHdcHost || runHdcHost)(['list', 'targets', '-v'], { timeoutMs: 8000 })
  ]);
  const errors = {}, devices = [], unconnectedTargets = [];
  let available = false;
  for (const [index, transport] of ['adb', 'hdc'].entries()) {
    const response = channels[index];
    if (response.status === 'fulfilled' && response.value.ok) {
      available = true;
      const parsed = transport === 'adb' ? parseAdbDeviceRows(response.value.stdout).map(({ id, status, detail }) => ({
        id, status, model: detail.match(/model:([^\s]+)/)?.[1] || '', transport: 'adb', platform: 'android' })) : parseHdcDeviceRows(response.value.stdout);
      const rows = parsed.filter(device => {
        if (transport === 'hdc' && !['device', 'unauthorized'].includes(device.status)) { unconnectedTargets.push(device); return false; }
        return true;
      });
      devices.push(...registerDiscoveredDevices(transport, rows));
    } else {
      errors[transport] = response.status === 'rejected' ? response.reason?.message : response.value.error || String(response.value.stderr || '');
      registerDiscoveredDevices(transport, []);
    }
  }
  const enriched = await Promise.all(devices.map(device => device.transport === 'hdc' ? enrichHarmonyDevice(device, options).catch(() => device) : device));
  for (const transport of ['adb', 'hdc']) registerDiscoveredDevices(transport, enriched.filter(device => device.transport === transport));
  return { devices: enriched, errors, available, unconnectedTargets };
}
let currentDiscovery = null;
function discoverDevices(options = {}) {
  if (Object.keys(options).length) return readDeviceChannels(options);
  if (!currentDiscovery) currentDiscovery = readDeviceChannels(options).finally(() => { currentDiscovery = null; });
  return currentDiscovery;
}
async function listDevices(options) { return (await discoverDevices(options)).devices; }
module.exports = { discoverDevices, listDevices, enrichHarmonyDevice };
