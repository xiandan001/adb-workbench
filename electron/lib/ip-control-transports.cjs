const net = require('node:net');
const dgram = require('node:dgram');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

// The service's session owns the listener and its one current peer. Refuse
// additional clients without disturbing or silently replacing the selected peer.
function tcpServer() {
  const events = new EventEmitter();
  let peer, peerId, closed = false;
  const listener = net.createServer(socket => {
    if (closed || peer) { socket.on('error', () => {}); socket.destroy(); return; }
    peer = socket; peerId = randomUUID();
    const id = peerId;
    const leave = () => {
      if (socket !== peer) return;
      peer = null; peerId = ''; socket.destroy(); events.emit('leave', id);
    };
    socket.on('data', data => { if (socket === peer) events.emit('data', data, id); });
    socket.on('error', leave); socket.once('end', leave); socket.once('close', leave);
    events.emit('peer', { peerId: id, peerHost: socket.remoteAddress, peerPort: socket.remotePort });
  });
  listener.on('error', err => { if (!closed) events.emit('error', err); });
  events.connect = ({ host, port }) => listener.listen({ host, port, exclusive: true }, () => {
    if (closed) { listener.close(); return; }
    events.emit('listening', listener.address().port);
  });
  events.write = (bytes, callback) => peer.write(bytes, callback);
  events.dropPeer = () => {
    const socket = peer, id = peerId; peer = null; peerId = '';
    socket?.destroy(); if (socket) events.emit('leave', id);
  };
  events.destroy = () => { closed = true; peer?.destroy(); peer = null; if (listener.listening) listener.close(); };
  return events;
}

function udpSocket(family) {
  const events = new EventEmitter(), socket = dgram.createSocket(family === 6 ? 'udp6' : 'udp4');
  let closed = false;
  socket.on('error', err => { if (!closed) events.emit('error', err); });
  socket.on('message', data => { if (!closed) events.emit('datagram', data); });
  socket.once('close', () => { if (!closed) events.emit('close'); });
  events.connect = ({ host, port, localPort }) => socket.bind({ port: localPort, exclusive: true }, () => {
    if (closed) return;
    try { socket.connect(port, host, () => { if (!closed) events.emit('ready', socket.address().port); }); }
    catch (err) { events.emit('error', err); }
  });
  events.write = (data, callback) => socket.send(data, callback);
  events.destroy = () => { closed = true; try { socket.close(); } catch (error) { if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error; } };
  return events;
}

module.exports = { tcpServer, udpSocket };
