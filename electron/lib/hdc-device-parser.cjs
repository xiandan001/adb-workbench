const { hdcDeviceId } = require('./device-platform.cjs');

const STATES = /^(?:Connected|Ready|Offline|Unauthorized|Unknown)$/i;
function parseHdcDeviceRows(text) {
  const devices = [], seen = new Set();
  for (const line of String(text || '').split(/\r?\n/)) {
    const value = line.trim();
    if (!value || /^(?:\[?Empty\]?|No (?:devices|targets)(?: found)?\.?)$/i.test(value) || /^(?:\[|OpenHarmony|HDC |hdc |Connect |Usage:|Ver:|[-=]{3})/i.test(value)) continue;
    const columns = value.split(/\s+/);
    const stateIndex = columns.findIndex((column, index) => index > 0 && STATES.test(column));
    if (stateIndex < 0 && columns.length !== 1) continue;
    const targetKey = columns[0];
    let id;
    try { id = hdcDeviceId(targetKey); } catch { continue; }
    if (seen.has(id)) continue;
    const rawStatus = stateIndex < 0 ? 'Connected' : columns[stateIndex];
    const status = /^Connected$/i.test(rawStatus) ? 'device' : /^Unauthorized$/i.test(rawStatus) ? 'unauthorized' : 'offline';
    const connectionType = columns.find((column, index) => index > 0 && /^(?:USB|TCP|UART|WIFI)$/i.test(column))?.toLowerCase() || '';
    const name = stateIndex < 0 ? '' : columns.slice(stateIndex + 1).filter(column => column.toLowerCase() !== 'hdc').join(' ');
    devices.push({ id, targetKey, displayId: targetKey, transport: 'hdc', platform: 'harmony', status, rawStatus, connectionType, model: name || targetKey });
    seen.add(id);
  }
  return devices;
}
module.exports = { parseHdcDeviceRows };
