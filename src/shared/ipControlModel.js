import { tr } from './i18n.js';

const ENDPOINT_KEY = 'adb-workbench.ip-control.endpoint.v1';
export const DEFAULT_ENDPOINT = Object.freeze({ host: '172.20.74.227', port: '8192' });
export const IP_CONTROL_MODES = Object.freeze(['tcp-client', 'tcp-server', 'udp']);
const endpointKey = mode => mode === 'tcp-client' ? ENDPOINT_KEY : ENDPOINT_KEY + '.' + mode;
const defaults = mode => mode === 'tcp-server' ? { host: '127.0.0.1', port: '8192' }
  : mode === 'udp' ? { ...DEFAULT_ENDPOINT, localPort: '0' } : { ...DEFAULT_ENDPOINT };
export const MAX_DISPLAY_ENTRIES = 100;

export function validateEndpoint(host, port) {
  const ip = String(host ?? '').trim(), p = String(port ?? '').trim();
  const ipv4 = /^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(ip) && ip.split('.').every(value => Number(value) <= 255);
  let ipv6 = false;
  if (ip.includes(':') && /^[0-9a-f:.]+$/i.test(ip)) {
    try { ipv6 = new URL('http://[' + ip + ']').hostname.startsWith('['); } catch { /* Invalid IP literal. */ }
  }
  if (!ipv4 && !ipv6) return 'INVALID_IP';
  return /^\d{1,5}$/.test(p) && Number(p) >= 1 && Number(p) <= 65535 ? '' : 'INVALID_PORT';
}

export function validateModeEndpoint(mode, endpoint) {
  if (!IP_CONTROL_MODES.includes(mode)) return 'INVALID_MODE';
  const error = validateEndpoint(endpoint.host, endpoint.port);
  if (error || mode !== 'udp') return error;
  const port = String(endpoint.localPort ?? '').trim();
  return !port || /^\d{1,5}$/.test(port) && Number(port) <= 65535 ? '' : 'INVALID_LOCAL_PORT';
}

export function readEndpoint(storage = globalThis.localStorage, mode = 'tcp-client') {
  try {
    const value = JSON.parse(storage.getItem(endpointKey(mode)));
    if (value?.version === 1 && typeof value.host === 'string' && Number.isInteger(value.port) &&
      (mode !== 'udp' || Number.isInteger(value.localPort)) && !validateModeEndpoint(mode, value)) {
      return { host: value.host, port: String(value.port), ...(mode === 'udp' ? { localPort: String(value.localPort) } : {}) };
    }
  } catch { /* A failed preference read must not open a connection. */ }
  return defaults(mode);
}

export function saveEndpoint({ host, port, localPort }, storage = globalThis.localStorage, mode = 'tcp-client') {
  if (validateModeEndpoint(mode, { host, port, localPort })) return false;
  try { storage.setItem(endpointKey(mode), JSON.stringify({ version: 1, host: host.trim(), port: Number(port), ...(mode === 'udp' ? { localPort: Number(localPort || 0) } : {}) })); return true; }
  catch { return false; }
}

export function inspectHex(text, mode = 'tcp-client') {
  if (typeof text !== 'string') return { code: 'INVALID_HEX', bytes: 0 };
  if (text.length > 1024 * 1024) return { code: 'SEND_TOO_LARGE', bytes: 0 };
  if (!text.trim()) return { code: 'INVALID_HEX', bytes: 0 };
  const groups = text.trim().split(/[ \t\r\n]+/);
  if (!groups.every(value => value.length % 2 === 0 && /^[\da-f]+$/i.test(value))) return { code: 'INVALID_HEX', bytes: 0 };
  const bytes = groups.reduce((sum, value) => sum + value.length / 2, 0);
  return { code: mode === 'udp' && bytes > 65507 ? 'UDP_TOO_LARGE' : bytes > 65536 ? 'SEND_TOO_LARGE' : '', bytes };
}

export function ipControlError(code) {
  switch (code) {
    case '': case 'CANCELLED': return '';
    case 'INVALID_IP': return tr('请填写有效的 IPv4 或 IPv6 地址，不含协议或端口。');
    case 'INVALID_PORT': return tr('端口必须是 1 到 65535 之间的整数。');
    case 'REFUSED': return tr('连接被拒绝。请确认设备已开启 IP Control，并核对端口。');
    case 'TIMEOUT': return tr('连接超时。请检查设备是否在线、网络是否互通，然后重试。');
    case 'UNREACHABLE': return tr('网络不可达。请检查本机网络和设备 IP 地址。');
    case 'REMOTE_CLOSED': return tr('对端已断开连接，可以重新连接。');
    case 'RESET': return tr('连接已重置，请重新连接。');
    case 'STALE_SESSION': return tr('连接已变化，请核对目标后重试。');
    case 'NOT_CONNECTED': return tr('请先连接设备再发送。');
    case 'SEND_BUSY': return tr('正在发送，请稍后再试。');
    case 'INVALID_HEX': return tr('请输入成对的十六进制字节，例如 FE 08 00 CF。');
    case 'SEND_TOO_LARGE': return tr('单次最多发送 64 KiB，请缩短内容。');
    case 'INVALID_MODE': return tr('网络模式无效，请重新选择。');
    case 'INVALID_LOCAL_PORT': return tr('本地端口须为 0 到 65535 的整数。');
    case 'INVALID_BIND': return tr('无法绑定此地址，请填写本机的 IP 地址。');
    case 'PORT_IN_USE': return tr('端口已被占用，请更换本地端口后重试。');
    case 'NO_PEER': return tr('尚无客户端接入，暂时不能发送。');
    case 'STALE_PEER': return tr('客户端已变化，请核对后重试发送。');
    case 'UDP_TOO_LARGE': return tr('UDP 单个数据报最多 65507 字节，请缩短内容。');
    case 'NOT_AUTHORIZED': case 'DISPOSED': case 'UNAVAILABLE': return tr('无法使用网络工具，请重启卓控台后重试。');
    case 'CONNECT_BUSY': return tr('连接或发送正在进行，请稍候。');
    default: return tr('网络操作未完成。请检查地址、端口和设备状态。');
  }
}

export function mergeIpRead(previous, read, replace) {
  const retain = !replace && previous?.sessionId === read.sessionId;
  const prior = retain ? previous.entries : [];
  const incoming = read.entries.filter(item => item.id > (prior.at(-1)?.id || 0));
  const entries = !incoming.length ? prior : [...prior, ...incoming].slice(-MAX_DISPLAY_ENTRIES);
  const omitted = Boolean(read.dropped || read.omitted || (retain && previous.omitted) || incoming.length + prior.length > MAX_DISPLAY_ENTRIES);
  if (previous && entries === previous.entries && previous.omitted === omitted &&
    ['mode', 'sessionId', 'host', 'port', 'localPort', 'peerId', 'peerHost', 'peerPort', 'status', 'code', 'sending', 'nextAfter'].every(key => previous[key] === read[key])) return previous;
  return { ...read, entries, omitted };
}
