const { types } = require('node:util');
const { queuedBytes } = require('./ai-context-limits.json');

// Reserve UTF-16/string-clone headroom, not a second serialized copy on main.
// Exact serialized content limits are checked by the worker before use.
function workspaceReservation(value) {
  const pending = [value], seen = new Set(); let bytes = 0, nodes = 0;
  while (pending.length) {
    const item = pending.pop();
    if (++nodes > 200000) return queuedBytes + 1;
    if (typeof item === 'string') bytes += 2 * Buffer.byteLength(item, 'utf8') + 16;
    else if (item && typeof item === 'object') {
      if (types.isProxy(item)) return queuedBytes + 1;
      if (seen.has(item)) continue;
      seen.add(item);
      if (ArrayBuffer.isView(item)) bytes += item.byteLength + 64;
      else if (item instanceof ArrayBuffer) bytes += item.byteLength + 64;
      else {
        if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return queuedBytes + 1;
        const descriptors = Object.getOwnPropertyDescriptors(item);
        bytes += 64;
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (!Object.hasOwn(descriptor, 'value')) return queuedBytes + 1;
          bytes += 2 * Buffer.byteLength(key) + 16;
          pending.push(descriptor.value);
        }
      }
    } else bytes += 8;
    if (bytes > queuedBytes) return bytes;
  }
  return bytes;
}

module.exports = { workspaceReservation };
