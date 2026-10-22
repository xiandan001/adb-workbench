const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { Server, utils } = require('ssh2');

// This fixture never executes shell commands. Every filesystem operation stays in its private sandbox.
async function startTestServer(options = {}) {
  const ownedRoot = !options.root;
  const root = await fs.realpath(options.root || await fs.mkdtemp(path.join(os.tmpdir(), 'adb-ssh-test-')));
  const username = options.username || 'test-user'; const password = options.password || 'test-password';
  const hostKey = options.hostKey || generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const authorizedKeys = (options.authorizedKeys || []).map(value => { const key = utils.parseKey(value); if (key instanceof Error) throw key; return Array.isArray(key) ? key[0] : key; });
  const clients = new Set(); const connections = []; const shells = []; const requests = []; const cleanup = new Set(); const channels = new Set();
  const codes = utils.sftp.STATUS_CODE; const openFlags = utils.sftp.OPEN_MODE; let closed = false;
  const within = p => { const relative = path.relative(root, p); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
  function resolveRemote(remote) {
    if (typeof remote !== 'string' || remote.includes('\0') || remote.includes('\\') || remote.split('/').includes('..')) throw Object.assign(new Error('Invalid fixture path'), { code: 'EACCES' });
    if (remote === '.' || remote === '') remote = '/home/test';
    if (!remote.startsWith('/')) throw Object.assign(new Error('Absolute paths required'), { code: 'EACCES' });
    const result = path.resolve(root, `.${remote}`);
    if (!within(result)) throw Object.assign(new Error('Outside fixture root'), { code: 'EACCES' });
    return result;
  }
  async function safe(remote, allowMissingLeaf = false) {
    const local = resolveRemote(remote); const segments = path.relative(root, local).split(path.sep).filter(Boolean); let current = root;
    for (let i = 0; i < segments.length; i++) {
      current = path.join(current, segments[i]);
      let stat;
      try { stat = await fs.lstat(current); } catch (error) { if (allowMissingLeaf && error.code === 'ENOENT' && i === segments.length - 1) return local; throw error; }
      if (stat.isSymbolicLink()) throw Object.assign(new Error('Fixture does not follow symlinks'), { code: 'EACCES' });
    }
    return local;
  }
  function attrs(stat) {
    return { size: stat.size, uid: 1000, gid: 1000, mode: stat.isDirectory() ? (0o040000 | (stat.mode & 0o777)) : (0o100000 | (stat.mode & 0o777)), atime: Math.floor(stat.atimeMs / 1000), mtime: Math.floor(stat.mtimeMs / 1000) };
  }
  async function writeFile(relative, data) {
    const remote = relative.startsWith('/') ? relative : `/home/test/${relative}`; const local = resolveRemote(remote);
    // Test setup only: callers control relative paths and contents, never a renderer or remote peer.
    await fs.mkdir(path.dirname(local), { recursive: true }); await fs.writeFile(local, data); return remote;
  }
  await fs.mkdir(path.join(root, 'home', 'test'), { recursive: true });

  function serveSftp(sftp) {
    channels.add(sftp); const handles = new Map(); let nextHandle = 0;
    if (options.atomicRename !== false) {
      // ssh2's test server sends a fixed VERSION packet without extension declarations. Decorate only
      // this test channel's wire packet so the real client negotiates posix-rename through the protocol.
      const protocol = sftp._protocol;
      sftp._protocol = new Proxy(protocol, { get(target, key) {
        if (key === 'channelData') return (id, data) => {
          if (id === sftp.outgoing.id && data.length === 9 && data[4] === 2) {
            const name = Buffer.from('posix-rename@openssh.com'); const value = Buffer.from('1');
            const extension = Buffer.alloc(8 + name.length + value.length); extension.writeUInt32BE(name.length, 0); name.copy(extension, 4); extension.writeUInt32BE(value.length, 4 + name.length); value.copy(extension, 8 + name.length);
            const packet = Buffer.concat([data, extension]); packet.writeUInt32BE(packet.length - 4, 0); data = packet;
          }
          return target.channelData(id, data);
        };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    const statusError = (id, error) => {
      const code = error.code === 'ENOENT' ? codes.NO_SUCH_FILE : error.code === 'EACCES' || error.code === 'EPERM' ? codes.PERMISSION_DENIED : codes.FAILURE;
      try { sftp.status(id, code, error.message); } catch { /* Channel may have been cancelled. */ }
    };
    function register(name, handler) {
      sftp.on(name, (id, ...args) => {
        requests.push({ name, args: args.map(arg => Buffer.isBuffer(arg) ? Buffer.from(arg) : arg) });
        const task = Promise.resolve().then(async () => {
          if (options.requestDelayMs) await new Promise(resolve => setTimeout(resolve, options.requestDelayMs));
          await options.beforeRequest?.({ name, args, sftp, id }); await handler(id, ...args);
        }).catch(error => statusError(id, error));
        cleanup.add(task); void task.finally(() => cleanup.delete(task));
      });
    }
    function addHandle(value) { const handle = Buffer.alloc(4); handle.writeUInt32BE(++nextHandle); handles.set(handle.toString('hex'), value); return handle; }
    function getHandle(handle) { const found = handles.get(handle.toString('hex')); if (!found) throw new Error('Invalid handle'); return found; }
    register('REALPATH', async (id, p) => {
      const local = await safe(p); const remote = '/' + path.relative(root, local).split(path.sep).join('/');
      sftp.name(id, [{ filename: remote, longname: remote, attrs: attrs(await fs.lstat(local)) }]);
    });
    for (const event of ['STAT', 'LSTAT']) register(event, async (id, p) => sftp.attrs(id, attrs(await fs.lstat(await safe(p)))));
    register('OPENDIR', async (id, p) => {
      const local = await safe(p); const stat = await fs.lstat(local); if (!stat.isDirectory()) throw new Error('Not directory');
      const names = await fs.readdir(local); sftp.handle(id, addHandle({ kind: 'directory', local, names, index: 0 }));
    });
    register('READDIR', async (id, handle) => {
      const value = getHandle(handle); if (value.kind !== 'directory') throw new Error('Not directory handle');
      const names = value.names.slice(value.index, value.index + (options.directoryPageSize || 100)); value.index += names.length;
      if (!names.length) return sftp.status(id, codes.EOF);
      const entries = [];
      for (const name of names) entries.push({ filename: name, longname: name, attrs: attrs(await fs.lstat(path.join(value.local, name))) });
      sftp.name(id, entries);
    });
    register('OPEN', async (id, p, flags, mode) => {
      const creating = Boolean(flags & openFlags.CREAT); const local = await safe(p, creating);
      let fsFlags;
      if (creating && (flags & openFlags.EXCL)) fsFlags = 'wx';
      else if (flags & openFlags.TRUNC) fsFlags = 'w';
      else if (flags & openFlags.APPEND) fsFlags = 'a';
      else fsFlags = flags & openFlags.WRITE ? 'r+' : 'r';
      const file = await fs.open(local, fsFlags, mode.mode || 0o600); sftp.handle(id, addHandle({ kind: 'file', file, local }));
    });
    register('READ', async (id, handle, offset, length) => {
      const value = getHandle(handle); if (value.kind !== 'file') throw new Error('Not file handle');
      const bytes = Buffer.alloc(Math.min(length, options.readChunkSize || 32768)); const { bytesRead } = await value.file.read(bytes, 0, bytes.length, offset);
      if (!bytesRead) return sftp.status(id, codes.EOF); sftp.data(id, bytes.subarray(0, bytesRead));
    });
    register('WRITE', async (id, handle, offset, bytes) => {
      const value = getHandle(handle); if (value.kind !== 'file') throw new Error('Not file handle');
      let written = 0;
      while (written < bytes.length) { const result = await value.file.write(bytes, written, bytes.length - written, offset + written); if (!result.bytesWritten) throw new Error('Short write'); written += result.bytesWritten; }
      sftp.status(id, codes.OK);
    });
    register('FSTAT', async (id, handle) => sftp.attrs(id, attrs(await getHandle(handle).file.stat())));
    register('FSETSTAT', async (id, handle, attributes) => { const file = getHandle(handle).file; if (attributes.mode !== undefined) await file.chmod(attributes.mode & 0o777); sftp.status(id, codes.OK); });
    register('CLOSE', async (id, handle) => {
      const key = handle.toString('hex'); const value = getHandle(handle); handles.delete(key);
      if (value.file) await value.file.close(); sftp.status(id, codes.OK);
    });
    register('REMOVE', async (id, p) => { await fs.unlink(await safe(p)); sftp.status(id, codes.OK); });
    register('MKDIR', async (id, p, mode) => { await fs.mkdir(await safe(p, true), { mode: mode.mode || 0o755 }); sftp.status(id, codes.OK); });
    register('RMDIR', async (id, p) => { const local = await safe(p); if (local === root) throw new Error('Root protected'); await fs.rmdir(local); sftp.status(id, codes.OK); });
    async function rename(from, to, replace) {
      const source = await safe(from); const destination = await safe(to, true);
      if (source === root || destination === root) throw new Error('Root protected');
      if (!replace) {
        try { await fs.lstat(destination); throw Object.assign(new Error('Destination exists'), { code: 'EEXIST' }); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await fs.rename(source, destination);
    }
    register('RENAME', async (id, a, b) => { await rename(a, b, false); sftp.status(id, codes.OK); });
    register('EXTENDED', async (id, name, data) => {
      if (name !== 'posix-rename@openssh.com' || options.atomicRename === false) return sftp.status(id, codes.OP_UNSUPPORTED);
      let offset = 0;
      const string = () => { if (offset + 4 > data.length) throw new Error('Invalid extension'); const size = data.readUInt32BE(offset); offset += 4; if (offset + size > data.length) throw new Error('Invalid extension'); const value = data.toString('utf8', offset, offset + size); offset += size; return value; };
      const from = string(); const to = string(); if (offset !== data.length) throw new Error('Invalid extension');
      await rename(from, to, true); sftp.status(id, codes.OK);
    });
    const release = async () => { channels.delete(sftp); const owned = [...handles.values()]; handles.clear(); await Promise.allSettled(owned.filter(x => x.file).map(x => x.file.close())); };
    sftp.on('error', () => {}); sftp.once('close', () => { const task = release(); cleanup.add(task); void task.finally(() => cleanup.delete(task)); });
  }

  const server = new Server({ hostKeys: [hostKey] }, client => {
    clients.add(client); const clientId = randomUUID(); const connection = { clientId, client, closed: false }; connections.push(connection);
    client.on('error', () => {}); client.once('close', () => { clients.delete(client); connection.closed = true; });
    client.on('authentication', context => {
      if (context.username !== username) return context.reject(['password', 'publickey']);
      if (context.method === 'password' && context.password === password && options.passwordAuth !== false) return context.accept();
      if (context.method === 'publickey') {
        const key = authorizedKeys.find(value => value.getPublicSSH().equals(context.key.data));
        if (key && (!context.signature || key.verify(context.blob, context.signature, context.hashAlgo) === true)) return context.accept();
      }
      context.reject(options.passwordAuth === false ? ['publickey'] : ['password', 'publickey']);
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); let pty = { cols: 80, rows: 24 }; let record;
      session.on('pty', (acceptPty, _reject, info) => { pty = { ...info }; acceptPty?.(); });
      session.on('window-change', (acceptResize, _reject, info) => { pty = { ...pty, ...info }; if (record) record.pty = { ...pty }; acceptResize?.(); });
      session.on('shell', acceptShell => {
        const stream = acceptShell(); const shellId = randomUUID(); record = { shellId, clientId, stream, pty: { ...pty }, received: [], closed: false }; shells.push(record);
        stream.on('error', () => {}); stream.once('close', () => { record.closed = true; });
        stream.on('data', data => {
          const bytes = Buffer.from(data); record.received.push(bytes);
          if (options.onShellData) options.onShellData({ stream, data: bytes, shellId, clientId, record }); else stream.write(bytes);
        });
        if (options.banner !== false) stream.write(options.banner || 'SSH test fixture ready\r\n$ ');
        options.onShell?.(record);
      });
      session.on('sftp', acceptSftp => serveSftp(acceptSftp()));
      session.on('exec', (acceptExec, rejectExec, info) => {
        if (!options.onExec) { rejectExec(); return; }
        Promise.resolve().then(() => options.onExec({ accept: acceptExec, reject: rejectExec, info, pty: { ...pty }, clientId })).catch(() => { try { rejectExec(); } catch {} });
      });
    }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
  server.on('error', () => {});
  async function close() {
    if (closed) return; closed = true;
    for (const channel of channels) { try { channel.end(); } catch { /* Closing test channel. */ } }
    for (const client of clients) { client.end(); client._sock?.destroy(); }
    await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([...cleanup]);
    // Give close handlers a turn before removing this fixture's own temporary directory.
    await new Promise(resolve => setImmediate(resolve)); await Promise.allSettled([...cleanup]);
    if (ownedRoot) {
      const resolved = await fs.realpath(root);
      if (resolved !== root || !path.basename(root).startsWith('adb-ssh-test-') || path.dirname(root) !== path.resolve(os.tmpdir())) throw new Error('Refusing unsafe fixture cleanup');
      await fs.rm(root, { recursive: true, force: true });
    }
  }
  function disconnectClient(clientId) {
    for (const connection of connections) if (clientId === undefined || connection.clientId === clientId) { connection.client.end(); connection.client._sock?.destroy(); }
  }
  function closeSftp() { for (const channel of channels) channel.end(); }
  return { host: '127.0.0.1', port: server.address().port, root, username, password, hostKey, clients, connections, shells, requests, close, writeFile, disconnectClient, closeSftp };
}

module.exports = { startTestServer };
