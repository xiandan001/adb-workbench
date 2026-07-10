const ADB_DEVICE_STATES = /^(device|offline|unauthorized|recovery|sideload|bootloader|no permissions)(?:\s+(.*))?$/i;

function parseAdbDeviceRows(text) {
  const lines = String(text || '').split(/\r?\n/);
  const headerIndex = lines.findIndex(line => line.trim() === 'List of devices attached');
  if (headerIndex < 0) return [];

  return lines.slice(headerIndex + 1)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [id, ...statusParts] = line.split(/\s+/);
      const match = statusParts.join(' ').match(ADB_DEVICE_STATES);
      if (!id || !match) return null;
      return { id, status: match[1].toLowerCase(), detail: match[2] || '' };
    })
    .filter(Boolean);
}

module.exports = { parseAdbDeviceRows };
