const { types } = require('node:util');
const path = require('node:path');
const { isIP } = require('node:net');
const { redactWorkspaceText } = require('./ai-workspace-redaction.cjs');

const TEXT_BYTES = 4096, STACK_BYTES = 8192, ROW_BYTES = 32768;
const nativeStack = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;
const defaultPrepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace')?.value;
const defaultErrorToString = Object.getOwnPropertyDescriptor(Error.prototype, 'toString')?.value;
function prefix(value, maximum) {
  let end = Math.min(value.length, maximum);
  if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--;
  return value.slice(0, end);
}
function own(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function location(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, 32768).replace(/(?:file:\/\/\/)?(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|opt|var)\/)[^\n()]*?(?=:\d+(?::\d+)?(?:\)?\s|$))/g, match => {
    const normalized = match.replace(/\\/g, '/');
    const known = /\/(electron|src|dist|tests|node_modules)\//g;
    let found, last; while ((found = known.exec(normalized))) last = found.index;
    return last === undefined ? `<local>/${path.posix.basename(normalized)}` : normalized.slice(last + 1);
  });
}
function bounded(value, maximum = TEXT_BYTES) {
  if (typeof value !== 'string') return { text: '', truncatedBytes: 0, excludedValues: 1 };
  const input = prefix(value, 32768);
  let text = location(input).replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  let excludedValues = 0;
  if (/"(?:messages|prompt|userContent|systemPrompt|body|input|command|env)"\s*:|\b(?:requestBody|responseBody|userContent|systemPrompt)\s*[:=]|\b(?:AI|LLM).*?(?:payload|prompt|content)\s*[:=]/i.test(text)) {
    text = '[sensitive payload omitted]'; excludedValues = 1;
  }
  text = redactWorkspaceText(text).replace(/\b(?:https?|wss?|ftp):\/\/[^\s"'<>)]*/gi, '[url omitted]')
    .replace(/\b[0-9a-f]{16,}\b/gi, '[identifier omitted]').replace(/Command failed:[\s\S]*/gi, 'Command failed: [arguments omitted]')
    .replace(/(?:\/sdcard|\/data|\/storage|\/mnt)\/[^\s"'<>]+/g, '[device path omitted]')
    .replace(/[a-f\d:]{3,45}/gi, value => isIP(value) === 6 ? '[address omitted]' : value);
  const bytes = Buffer.from(text, 'utf8'); let end = Math.min(maximum, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  // Exact input-byte counting of an arbitrarily large string would itself block
  // Main. Report a lower bound and the omitted character count separately.
  return { text: bytes.subarray(0, end).toString('utf8'), truncatedBytes: Math.max(0, bytes.length - end),
    omittedCharacters: Math.max(0, value.length - input.length), excludedValues };
}
function errorStack(value) {
  if (!value || types.isProxy(value) || !types.isNativeError(value)) return '';
  const descriptor = Object.getOwnPropertyDescriptor(value, 'stack');
  if (typeof descriptor?.value === 'string') return descriptor.value;
  const prepare = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  if (descriptor?.get !== nativeStack || !nativeStack || prepare?.value !== defaultPrepare) return '';
  let formatterSeen = false;
  for (let object = value; object; object = Object.getPrototypeOf(object)) {
    if (types.isProxy(object)) return '';
    for (const key of ['name', 'message']) {
      const field = Object.getOwnPropertyDescriptor(object, key);
      if (field && (!Object.hasOwn(field, 'value') || typeof field.value !== 'string')) return '';
    }
    const formatter = Object.getOwnPropertyDescriptor(object, 'toString');
    if (formatter && !formatterSeen) {
      if (!Object.hasOwn(formatter, 'value') || formatter.value !== defaultErrorToString) return '';
      formatterSeen = true;
    }
  }
  return Reflect.apply(nativeStack, value, []);
}
function describe(value, errorData = false) {
  if (typeof value === 'string') return { message: value };
  if (value === null || ['number', 'boolean', 'undefined'].includes(typeof value)) return { message: String(value) };
  if (!value || typeof value !== 'object' || types.isProxy(value)) return { message: '[value omitted]', excludedValues: 1 };
  if (types.isNativeError(value)) {
    const stack = errorStack(value);
    return { message: typeof own(value, 'message') === 'string' ? own(value, 'message') : 'Error', stack, excludedValues: stack ? 0 : 1 };
  }
  if (errorData && typeof own(value, 'message') === 'string' && typeof own(value, 'stack') === 'string') return { message: own(value, 'message'), stack: own(value, 'stack') };
  const fields = ['name', 'code', 'status', 'statusCode', 'reason', 'durationMs'].flatMap(key => {
    const item = own(value, key);
    return ['string', 'number', 'boolean'].includes(typeof item) ? [`${key}=${typeof item === 'string' ? item.slice(0, 512) : item}`] : [];
  });
  return { message: fields.length ? `{${fields.join(', ')}}` : '[object omitted]', excludedValues: 1 };
}
function normalizeCodeArguments(args, { errorData = false } = {}) {
  if (!Array.isArray(args) || types.isProxy(args)) return { message: '[arguments omitted]', excludedValues: 1, truncatedBytes: 0, omittedCharacters: 0 };
  const parts = []; let stack = '', excludedValues = 0, omittedCharacters = 0;
  for (let index = 0; index < Math.min(args.length, 8); index++) {
    const descriptor = Object.getOwnPropertyDescriptor(args, String(index));
    if (descriptor && !Object.hasOwn(descriptor, 'value')) { excludedValues++; continue; }
    const value = descriptor?.value;
    const described = describe(value, errorData);
    const selected = prefix(described.message, 32768);
    omittedCharacters += Math.max(0, described.message.length - selected.length);
    parts.push(selected); stack ||= described.stack || ''; excludedValues += described.excludedValues || 0;
  }
  const frames = stack.slice(0, 32768).split('\n').filter(line => /^\s*at\s/.test(line));
  const omittedFrames = frames.slice(40).reduce((sum, line) => sum + line.length + 1, 0);
  const message = bounded(parts.join(' ')), trace = bounded(frames.slice(0, 40).join('\n'), STACK_BYTES);
  return { message: message.text, ...(trace.text ? { stack: trace.text } : {}),
    truncatedBytes: message.truncatedBytes + trace.truncatedBytes,
    omittedCharacters: omittedCharacters + message.omittedCharacters + trace.omittedCharacters + omittedFrames + Math.max(0, stack.length - 32768),
    excludedValues: excludedValues + message.excludedValues + Math.max(0, args.length - 8) };
}

module.exports = { TEXT_BYTES, STACK_BYTES, ROW_BYTES, own, location, bounded, normalizeCodeArguments };
