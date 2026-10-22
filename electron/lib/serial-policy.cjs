const encodeUtf8 = value => Buffer.from(value, 'utf8');
const encodedOutput = value => Buffer.from(value);

const DEFAULT_CONFIG = Object.freeze({ baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none' });
const CONFIG_KEYS = ['baudRate', 'dataBits', 'stopBits', 'parity', 'flowControl'];
const PREF_KEYS_V1 = ['version', 'config', 'receiveMode', 'sendMode', 'lineEnding', 'favorites'];
const PREF_KEYS_V2 = [...PREF_KEYS_V1, 'terminalConfig'];
const FAVORITE_KEYS = ['id', 'name', 'mode', 'content', 'lineEnding'];
const LINE_ENDINGS = Object.freeze({ none: '', lf: '\n', cr: '\r', crlf: '\r\n' });
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SEND_BYTES = 64 * 1024;

function exactObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error(`${label}格式无效或包含不支持的字段`);
  }
  return value;
}

function enumValue(value, choices, label) {
  if (!choices.includes(value)) throw new Error(`${label}无效`);
  return value;
}

function normalizeConfig(value = DEFAULT_CONFIG) {
  exactObject(value, CONFIG_KEYS, '串口参数');
  if (!Number.isSafeInteger(value.baudRate) || value.baudRate < 1 || value.baudRate > 4000000) {
    throw new Error('波特率应为 1 至 4000000 的整数，实际支持范围以驱动为准');
  }
  return { baudRate: value.baudRate,
    dataBits: enumValue(value.dataBits, [5, 6, 7, 8], '数据位'),
    stopBits: enumValue(value.stopBits, [1, 1.5, 2], '停止位'),
    parity: enumValue(value.parity, ['none', 'even', 'odd', 'mark', 'space'], '校验位'),
    flowControl: enumValue(value.flowControl, ['none', 'rtscts', 'xonxoff'], '流控') };
}

function messageFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('发送内容格式无效');
  const mode = enumValue(value.mode, ['text', 'hex', 'ascii'], '发送模式');
  const lineEnding = enumValue(value.lineEnding, Object.keys(LINE_ENDINGS), '换行设置');
  if (typeof value.content !== 'string' || !value.content.length) throw new Error('发送内容不能为空');
  return { mode, content: value.content, lineEnding };
}

function hexBytes(content) {
  if (content.length > 1024 * 1024) throw new Error('HEX 输入过长，请减少空白；单次最多发送 64 KiB');
  const tokens = content.trim().split(/\s+/u);
  if (tokens.some(token => !/^[0-9a-f]+$/iu.test(token) || token.length % 2 !== 0)) {
    throw new Error('HEX 内容必须是成对的十六进制字符，字节之间可用空白分隔');
  }
  const compact = tokens.join('');
  if (compact.length / 2 > MAX_SEND_BYTES) throw new Error('单次发送不能超过 64 KiB');
  const bytes = new Uint8Array(compact.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function encodeMessage(value) {
  const { mode, content, lineEnding } = messageFields(value);
  if (mode === 'hex') return encodedOutput(hexBytes(content));
  if (content.length > MAX_SEND_BYTES) throw new Error('单次发送不能超过 64 KiB');
  if (mode === 'ascii') {
    for (let index = 0; index < content.length; index++) {
      if (content.charCodeAt(index) > 127) throw new Error('ASCII 仅支持 0–127 的字符，第 ' + (index + 1) + ' 个字符不符合；中文或其他 Unicode 请使用 UTF-8');
    }
  }
  const bytes = encodeUtf8(content + LINE_ENDINGS[lineEnding]);
  if (bytes.length > MAX_SEND_BYTES) throw new Error('单次发送不能超过 64 KiB');
  return encodedOutput(bytes);
}

function normalizeFavorite(value) {
  exactObject(value, FAVORITE_KEYS, '常用命令');
  if (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 200
    || UNSAFE_KEYS.has(value.id) || [...value.id].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error('常用命令 ID 无效');
  }
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('常用命令名称应为 1 至 80 个字符');
  if (typeof value.content !== 'string' || value.content.length > 8192) throw new Error('常用命令内容不能超过 8192 个字符');
  const message = messageFields(value);
  encodeMessage(message);
  return { id: value.id, name: value.name.trim(), ...message };
}

function normalizePreferences(value) {
  if (value?.version !== 1 && value?.version !== 2) throw new Error('串口偏好版本不受支持');
  exactObject(value, value.version === 1 ? PREF_KEYS_V1 : PREF_KEYS_V2, '串口偏好');
  if (value.config === undefined || (value.version === 2 && value.terminalConfig === undefined)) throw new Error('串口偏好缺少连接参数');
  const config = normalizeConfig(value.config);
  const terminalConfig = normalizeConfig(value.version === 1 ? value.config : value.terminalConfig);
  if (!Array.isArray(value.favorites) || value.favorites.length > 30) throw new Error('常用命令最多保存 30 条');
  const favorites = value.favorites.map(normalizeFavorite);
  if (new Set(favorites.map(item => item.id)).size !== favorites.length) throw new Error('常用命令 ID 重复');
  return { version: 2, config, terminalConfig,
    receiveMode: enumValue(value.receiveMode, ['text', 'hex', 'ascii'], '接收模式'),
    sendMode: enumValue(value.sendMode, ['text', 'hex', 'ascii'], '发送模式'),
    lineEnding: enumValue(value.lineEnding, Object.keys(LINE_ENDINGS), '换行设置'), favorites };
}

module.exports = { DEFAULT_CONFIG, normalizeConfig, encodeMessage, normalizePreferences };
