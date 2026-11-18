const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { tcpServer, udpSocket } = require('./ip-control-transports.cjs');

const MAX_SEND = 64 * 1024, MAX_ROWS = 10000, MAX_RETAINED = 4 * 1024 * 1024;
const PAGE_ROWS = 100, PAGE_BYTES = 64 * 1024, CHUNK_BYTES = 4096;
const failed = code => ({ ok: false, code });

function networkCode(error) {
  switch (error?.code) {
    case 'EADDRINUSE': return 'PORT_IN_USE';
    case 'EADDRNOTAVAIL': case 'EACCES': return 'INVALID_BIND';
    case 'ECONNREFUSED': return 'REFUSED';
    case 'ETIMEDOUT': return 'TIMEOUT';
    case 'ENETUNREACH': case 'EHOSTUNREACH': case 'EHOSTDOWN': case 'ENETDOWN': return 'UNREACHABLE';
    case 'ECONNRESET': case 'EPIPE': return 'RESET';
    default: return 'SOCKET_ERROR';
  }
}

function parseHex(hex) {
  if (typeof hex !== 'string') return failed('INVALID_HEX');
  if (hex.length > 1024 * 1024) return failed('SEND_TOO_LARGE');
  const groups = hex.trim().split(/[ \t\r\n]+/);
  if (groups.some(group => !group.length || group.length % 2 || /[^0-9a-f]/i.test(group))) return failed('INVALID_HEX');
  const compact = groups.join('');
  if (compact.length > MAX_SEND * 2) return failed('SEND_TOO_LARGE');
  return { ok: true, bytes: Buffer.from(compact, 'hex') };
}

// TCP data event boundaries are not device message boundaries. Keep ordered byte chunks
// and format only the bounded IPC page, never the whole retained stream.
function createRecordBuffer() {
  let rows = [], head = 0, bytes = 0, lastId = 0, dropped = 0;
  function append(direction, data, datagram = false, peer = null) {
    const at = Date.now();
    const step = datagram ? Math.max(1, data.length) : CHUNK_BYTES;
    for (let i = 0; i < (datagram ? Math.max(1, data.length) : data.length); i += step) {
      const part = Buffer.from(data.subarray(i, i + step));
      rows.push({ id: ++lastId, at, direction, data: part, peer }); bytes += part.length;
      while (rows.length - head > MAX_ROWS || bytes > MAX_RETAINED) {
        bytes -= rows[head].data.length; rows[head++] = null; dropped++;
      }
      if (head > 1024 && head * 2 >= rows.length) { rows = rows.slice(head); head = 0; }
    }
  }
  function page(after) {
    const firstId = rows[head]?.id || 0;
    // A stale cursor from a former session is safe to restore as a tail snapshot.
    const tail = after === undefined || after > lastId;
    let start, end, size = 0;
    if (tail) {
      end = rows.length; start = end;
      while (start > head && end - start < PAGE_ROWS && size + rows[start - 1].data.length <= PAGE_BYTES) size += rows[--start].data.length;
    } else {
      start = Math.min(rows.length, head + Math.max(0, after + 1 - firstId)); end = start;
      while (end < rows.length && end - start < PAGE_ROWS && size + rows[end].data.length <= PAGE_BYTES) size += rows[end++].data.length;
    }
    const entries = rows.slice(start, end).map(({ id, at, direction, data, peer }) => ({ id, at, direction, hex: data.toString('hex').toUpperCase(), ...(peer || {}) }));
    const omitted = tail ? (entries[0]?.id || 1) - 1 : Math.max(0, firstId - after - 1);
    return { entries, firstId, lastId, dropped, omitted, nextAfter: entries.at(-1)?.id ?? lastId, hasMore: end < rows.length };
  }
  return { append, page };
}

function createIpControlService({ createSocket = () => new net.Socket(), connectTimeoutMs = 5000, writeTimeoutMs = 5000, onSuccessfulEndpoint } = {}) {
  let owner, disposed = false, records = createRecordBuffer();
  const noPeer = { peerId: '', peerHost: '', peerPort: 0 };
  let state = { status: 'idle', code: '', host: '', port: 0, sessionId: '', mode: 'tcp-client', localPort: 0, ...noPeer };
  function finishRequest(session, key, result) {
    const request = session[key]; if (!request) return;
    session[key] = null; clearTimeout(request.timer); request.resolve(result);
  }
  function close(session, status, code = '') {
    if (owner !== session) return;
    owner = null; Object.assign(state, { status, code, ...noPeer });
    finishRequest(session, 'opening', failed(code || 'CANCELLED'));
    finishRequest(session, 'writing', failed(code || 'CANCELLED'));
    session.socket.destroy();
  }
  function connect(args) {
    if (disposed) return Promise.resolve(failed('DISPOSED'));
    if (owner) return Promise.resolve(failed('CONNECT_BUSY'));
    const host = typeof args?.host === 'string' ? args.host.trim() : '', port = args?.port;
    const mode = args?.mode === undefined ? 'tcp-client' : args.mode, localPort = args?.localPort ?? 0;
    if (!['tcp-client', 'tcp-server', 'udp'].includes(mode)) return Promise.resolve(failed('INVALID_MODE'));
    if (!host || host.length > 128 || !net.isIP(host)) return Promise.resolve(failed('INVALID_IP'));
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return Promise.resolve(failed('INVALID_PORT'));
    if (mode === 'udp' && (!Number.isSafeInteger(localPort) || localPort < 0 || localPort > 65535)) return Promise.resolve(failed('INVALID_BIND'));
    if (mode === 'udp' && (['0.0.0.0', '255.255.255.255', '::'].includes(host) || (net.isIPv4(host) && Number(host.split('.')[0]) >= 224) || /^ff/i.test(host))) return Promise.resolve(failed('INVALID_IP'));
    const sessionId = randomUUID(); records = createRecordBuffer();
    state = { status: 'connecting', code: '', host, port, sessionId, mode, localPort: 0, ...noPeer };
    let socket;
    try { socket = mode === 'tcp-client' ? createSocket() : mode === 'tcp-server' ? tcpServer() : udpSocket(net.isIP(host)); } catch (error) {
      state.status = 'error'; state.code = networkCode(error); return Promise.resolve(failed(state.code));
    }
    const session = { socket }; owner = session;
    // Record user-configured endpoints only, never transient peers, payloads,
    // failed attempts, or a UDP socket that merely opened locally.
    function remember() {
      if (!onSuccessfulEndpoint || session.remembered || owner !== session) return;
      session.remembered = true;
      try { Promise.resolve(onSuccessfulEndpoint({mode,host,port,...(mode === 'udp' ? {localPort} : {})})).catch(() => {}); }
      catch { /* Persistence must not break a successful socket operation. */ }
    }
    socket.once('connect', () => {
      if (owner !== session) return;
      state.status = 'connected'; state.localPort = socket.localPort || 0; remember(); finishRequest(session, 'opening', { ok: true, sessionId });
    });
    const openStatus = mode === 'tcp-server' ? 'listening' : 'ready';
    if (mode !== 'tcp-client') socket.once(openStatus, boundPort => {
      if (owner !== session) return;
      Object.assign(state, { status: openStatus, localPort: boundPort }); finishRequest(session, 'opening', { ok: true, sessionId });
    });
    socket.on('peer', peer => { if (owner === session) { session.peer = peer; Object.assign(state, peer, { status: 'connected' }); remember(); } });
    socket.on('leave', id => {
      if (owner !== session || state.peerId !== id) return;
      session.peer = null; Object.assign(state, noPeer, { status: 'listening' }); finishRequest(session, 'writing', failed('REMOTE_CLOSED'));
    });
    socket.on('data', data => { if (owner === session && state.status === 'connected') records.append('RX', data, false, session.peer); });
    socket.on('datagram', data => { if (owner === session && state.status === 'ready') { records.append('RX', data, true); remember(); } });
    socket.on('error', error => close(session, 'error', networkCode(error)));
    socket.once('end', () => close(session, 'error', 'REMOTE_CLOSED'));
    socket.once('close', () => close(session, 'error', 'REMOTE_CLOSED'));
    return new Promise(resolve => {
      session.opening = { resolve, timer: setTimeout(() => close(session, 'error', 'TIMEOUT'), connectTimeoutMs) };
      try { socket.connect(mode === 'udp' ? { host, port, localPort } : { host, port }); } catch (error) { close(session, 'error', networkCode(error)); }
    });
  }
  function send(args) {
    if (disposed) return Promise.resolve(failed('DISPOSED'));
    if (owner && state.status === 'listening') return Promise.resolve(failed('NO_PEER'));
    if (!['connected', 'ready'].includes(state.status) || !owner) return Promise.resolve(failed('NOT_CONNECTED'));
    if (args?.sessionId !== state.sessionId) return Promise.resolve(failed('STALE_SESSION'));
    if (state.mode === 'tcp-server' && args.peerId !== state.peerId) return Promise.resolve(failed('STALE_PEER'));
    const session = owner;
    if (session.writing) return Promise.resolve(failed('SEND_BUSY'));
    const data = parseHex(args.hex); if (!data.ok) return Promise.resolve(data);
    if (state.mode === 'udp' && data.bytes.length > 65507) return Promise.resolve(failed('UDP_TOO_LARGE'));
    return new Promise(resolve => {
      function writeError(code) {
        if (owner !== session || session.writing !== request) return;
        if (state.mode === 'tcp-server') { finishRequest(session, 'writing', failed(code)); session.socket.dropPeer(); }
        else close(session, 'error', code);
      }
      const request = { resolve, timer: setTimeout(() => writeError('TIMEOUT'), writeTimeoutMs) };
      session.writing = request;
      try {
        session.socket.write(data.bytes, error => {
          if (owner !== session || session.writing !== request) return;
          if (error) { writeError(networkCode(error)); return; }
          records.append('TX', data.bytes, state.mode === 'udp', session.peer); finishRequest(session, 'writing', { ok: true });
        });
      } catch (error) { writeError(networkCode(error)); }
    });
  }
  function disconnect(args) {
    if (disposed) return failed('DISPOSED');
    if (!owner) return failed('NOT_CONNECTED');
    if (args?.sessionId !== state.sessionId) return failed('STALE_SESSION');
    close(owner, 'idle'); return { ok: true };
  }
  function read(args = {}) {
    if (disposed) return failed('DISPOSED');
    const after = args?.after;
    if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) return failed('INVALID_CURSOR');
    const currentCursor = args?.sessionId === undefined || args.sessionId === state.sessionId;
    return { ok: true, ...state, sending: Boolean(owner?.writing), ...records.page(currentCursor ? after : undefined) };
  }
  function dispose() {
    disposed = true;
    if (owner) close(owner, 'idle');
    records = createRecordBuffer();
  }
  return { connect, disconnect, send, read, dispose };
}

module.exports = { createIpControlService };
