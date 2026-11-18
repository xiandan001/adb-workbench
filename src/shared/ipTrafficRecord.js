import { tr } from './i18n.js';

export const ipDirection = direction => direction === 'RX' ? tr('接收 RX') : tr('发送 TX');
export const ipTransport = mode => mode === 'udp' ? tr('UDP 数据报') : tr('TCP 字节块');
export const ipMode = mode => mode === 'udp' ? tr('UDP') : mode === 'tcp-server' ? tr('TCP Server') : tr('TCP Client');
export const ipAddress = (host, port) => host ? (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`) : '';
export const rowEndpoint = (row, view) => row.peerHost ? ipAddress(row.peerHost, row.peerPort) : ipAddress(view?.host, view?.port);

// Keep only metadata and this immutable row's bytes, not the live receive buffer.
export function captureIpRecord(row, view) {
  return { row: { ...row }, mode: view?.mode, sessionId: view?.sessionId,
    endpoint: rowEndpoint(row, view), listener: view?.mode === 'tcp-server' ? ipAddress(view.host, view.port) : '', localPort: view?.localPort };
}
