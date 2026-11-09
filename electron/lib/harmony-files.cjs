const { tr } = require('./localization.cjs');
const { shellQuote } = require('./device-platform.cjs');
const { runHdc } = require('./hdc-runtime.cjs');

function remoteDirectory(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(tr('设备目录无效。'));
  return require('node:path').posix.normalize(value);
}
function parseDirectory(text, directory) {
  const fields = String(text || '').split('\0'), items = [];
  if (directory !== '/') items.push({ name: '..', path: require('node:path').posix.dirname(directory), isDirectory: true, isLink: false, size: null });
  for (let index = 0; index + 2 < fields.length && items.length < 10000; index += 3) {
    const [kind, name, size] = fields.slice(index, index + 3);
    if (!['d', 'f', 'l'].includes(kind) || !name || name.includes('/') || name === '.' || name === '..') continue;
    items.push({ name, path: require('node:path').posix.join(directory, name), isDirectory: kind === 'd', isLink: kind === 'l', size: /^\d+$/.test(size) && kind !== 'd' ? size : null });
  }
  return items.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}
async function listHarmonyDirectory(deviceId, value, options = {}) {
  const directory = remoteDirectory(value);
  const command = `cd ${shellQuote(directory)} || exit $?; for entry in .[!.]* ..?* *; do [ -e "$entry" ] || [ -L "$entry" ] || continue; kind=f; if [ -d "$entry" ]; then kind=d; elif [ -L "$entry" ]; then kind=l; fi; size=$(stat -c %s "./$entry" 2>/dev/null); printf '%s\\0%s\\0%s\\0' "$kind" "$entry" "$size"; done`;
  const response = await (options.runHdc || runHdc)(deviceId, ['shell', command], { ...options, maxBuffer: 4 * 1024 * 1024 });
  if (!response.ok) return { success: false, error: response.error || tr('无法读取设备目录。') };
  return { success: true, currentPath: directory, items: parseDirectory(response.stdout, directory) };
}
module.exports = { remoteDirectory, parseDirectory, listHarmonyDirectory };
