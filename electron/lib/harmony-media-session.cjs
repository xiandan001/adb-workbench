const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { tr } = require('./localization.cjs');
const { runHdc, getHdcCommand } = require('./hdc-runtime.cjs');
const { resolveDeviceRef } = require('./device-registry.cjs');
const { shellQuote } = require('./device-platform.cjs');
const { captureScreenshot } = require('./harmony-media.cjs');
const { sessionPaths, createAgentConfig, parseReady, parseUiTestVersion, createFrameParser } = require('./harmony-media-protocol.cjs');

const LIVE = new Set(['starting', 'awaiting-consent', 'streaming', 'stopping']);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const failure = (code, message) => Object.assign(new Error(message), { code, safe: true });
function runFile(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 },
    (error, stdout) => error ? reject(error) : resolve(String(stdout))));
}
async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(error => error ? reject(error) : resolve(port)); });
  });
}
async function verifyLoopbackForward(port) {
  if (process.platform !== 'win32') throw failure('HOST_PLATFORM', tr('此媒体转发验证目前仅支持 Windows 桌面版。'));
  let addresses;
  try {
    const text = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '(Get-NetTCPConnection -LocalPort ' + port + ' -State Listen -ErrorAction Stop).LocalAddress | ConvertTo-Json -Compress']);
    const value = JSON.parse(text); addresses = Array.isArray(value) ? value : [value];
  } catch {
    const text = await runFile('netstat.exe', ['-ano', '-p', 'tcp']);
    addresses = text.split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .filter(fields => fields[0] === 'TCP' && fields[1]?.endsWith(':' + port) && fields[3] === 'LISTENING')
      .map(fields => fields[1].slice(0, -String(port).length - 1).replace(/^\[|\]$/g, ''));
  }
  if (!addresses.length || addresses.some(address => !isLoopbackAddress(address))) {
    throw failure('NON_LOOPBACK_FORWARD', tr('HDC 转发未被确认仅监听本机回环地址，未发送认证信息或开始采集。'));
  }
}
function isLoopbackAddress(value) {
  return typeof value === 'string' && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(value.toLowerCase());
}
function readAgent(hdcPath, abi) {
  const directory = path.join(path.dirname(hdcPath), 'agent');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  const item = manifest.abis?.[abi];
  if (manifest.version !== 1 || manifest.protocol !== 1 || manifest.minimumApi !== 12 || !item
    || item.file !== abi + '/awb-media-agent.so' || !/^[a-f\d]{64}$/.test(item.sha256 || '')) throw failure('AGENT_UNAVAILABLE', tr('本机缺少匹配设备 ABI 的媒体组件，请修复安装。'));
  const filename = path.join(directory, item.file);
  const bytes = fs.readFileSync(filename);
  const expected = { 'arm64-v8a': [2, 183], x86_64: [2, 62], 'armeabi-v7a': [1, 40] }[abi];
  if (!expected || bytes.length !== item.bytes || bytes.length > 32 * 1024 * 1024
    || !bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || bytes[4] !== expected[0]
    || bytes.readUInt16LE(18) !== expected[1] || createHash('sha256').update(bytes).digest('hex') !== item.sha256) {
    throw failure('AGENT_INTEGRITY', tr('媒体组件校验失败，未部署到设备。'));
  }
  return filename;
}
function parseAbi(text) {
  const value = String(text || '').trim().toLowerCase();
  if (/\b(arm64-v8a|aarch64|arm64)\b/.test(value)) return 'arm64-v8a';
  if (/\b(x86_64|amd64)\b/.test(value)) return 'x86_64';
  if (/\b(armeabi-v7a|armv7l|armv7)\b/.test(value)) return 'armeabi-v7a';
  throw failure('ABI_UNSUPPORTED', tr('无法确认此设备的受支持原生 ABI，未部署媒体组件。'));
}
function ownedStopCommand(entry) {
  if (!Number.isSafeInteger(entry.ready?.pid) || entry.ready.pid <= 1) return '';
  const expected = 'uitest start-daemon singleness --extension-name ' + entry.paths.extension + ' --config ' + entry.paths.config + ' ';
  return 'cmd=$(tr \'\\000\' \' \' < /proc/' + entry.ready.pid + '/cmdline 2>/dev/null); case "$cmd" in '
    + shellQuote(expected) + '|' + shellQuote('/system/bin/' + expected) + ') kill -TERM ' + entry.ready.pid
    + ' ;; "") printf gone ;; *) printf owner_mismatch; exit 3 ;; esac';
}

function createHarmonyMediaSessions({
  invoke = runHdc, resolve = resolveDeviceRef, commandPath = getHdcCommand, screenshot = captureScreenshot,
  agentFile = readAgent, reservePort = availablePort, verifyForward = verifyLoopbackForward,
  connect = options => net.createConnection(options), onFrame = () => {}, onState = () => {},
  sleep = delay, now = Date.now, firstFrameTimeoutMs = 60000
} = {}) {
  const entries = new Map();
  const publicState = entry => ({ id: entry.id, deviceId: entry.deviceId, status: entry.status, error: entry.error || '',
    width: entry.config?.width || 0, height: entry.config?.height || 0, sourceWidth: entry.sourceSize?.width || 0,
    sourceHeight: entry.sourceSize?.height || 0, fps: entry.config?.fps || 20, frames: entry.frames || 0, startedAt: entry.startedAt });
  const publish = entry => { try { onState(publicState(entry)); } catch { /* Window lifetime cannot break cleanup. */ } };
  const execute = async (entry, args, options = {}) => {
    entry.binding.assertCurrent?.();
    return invoke(entry.deviceId, args, { ...entry.binding, signal: entry.abort.signal, ...options });
  };
  const checked = async (entry, args, options) => {
    const result = await execute(entry, args, options);
    if (!result.ok) throw failure(result.cancelled ? 'CANCELLED' : 'HDC_MEDIA', result.cancelled ? tr('用户取消') : tr('设备媒体准备命令未成功完成。'));
    return result;
  };
  async function readReadiness(entry, deadlineMs = 15000) {
    const deadline = now() + deadlineMs;
    while (now() < deadline && !entry.abort.signal.aborted) {
      const result = await execute(entry, ['shell', 'cat', entry.paths.ready], { timeoutMs: 2000, maxBuffer: 8192 });
      if (result.ok) {
        const ready = parseReady(String(result.stdout), entry.id);
        if (parseUiTestVersion(ready.uitestVersion) !== entry.version) throw failure('UITEST_CHANGED', tr('设备 UITest 版本在启动期间发生变化，未继续采集。'));
        return ready;
      }
      await sleep(150);
    }
    throw failure('AGENT_HANDSHAKE', tr('媒体组件未完成独立握手；设备可能不支持此扩展或无法加载所需运行库。'));
  }
  function receive(entry) {
    return new Promise((resolveFirst, rejectFirst) => {
      let settled = false;
      const failFirst = error => { if (!settled) { settled = true; clearTimeout(entry.firstTimer); rejectFirst(error); } };
      entry.firstTimer = setTimeout(() => failFirst(failure('CAPTURE_TIMEOUT', tr('等待授权或首个视频帧超时，未将投屏标记为成功。'))), firstFrameTimeoutMs);
      const parser = createFrameParser(packet => {
        if (entry.closing) return;
        if (packet.kind === 'video') {
          if (!packet.data.length) return;
          onFrame(entry.id, packet);
          if (!(packet.flags & 2)) {
            entry.frames++;
            if (!settled) { settled = true; clearTimeout(entry.firstTimer); entry.status = 'streaming'; publish(entry); resolveFirst(publicState(entry)); }
          }
        } else if (packet.kind === 'error' || packet.state.includes('error') || packet.state === 'stream-backpressure'
          || packet.state === 'capture-state' && [1, 2, 3, 4].includes(packet.code) || packet.code === -1) {
          const error = failure('CAPTURE_DENIED', packet.state === 'capture-state' ? tr('设备或用户中止了屏幕录制授权。') : tr('原生视频采集未能继续，请检查设备系统能力与授权。'));
          failFirst(error); entry.error = error.message; entry.status = 'failed'; publish(entry); void stop(entry.id);
        } else if (packet.state === 'awaiting-consent') { entry.status = 'awaiting-consent'; publish(entry); }
        else if (['stopped', 'ended'].includes(packet.state)) { failFirst(failure('CAPTURE_ENDED', tr('设备已停止视频采集。'))); void stop(entry.id); }
      });
      entry.socket = connect({ host: '127.0.0.1', port: entry.localPort });
      entry.socket.setNoDelay?.(true);
      entry.socket.once('connect', () => {
        if (entry.closing) { entry.socket.destroy(); return; }
        entry.socket.write('AUTH ' + entry.config.token + '\n');
        entry.heartbeat = setInterval(() => { if (!entry.socket.destroyed) entry.socket.write('PING\n'); }, 5000);
        entry.heartbeat.unref?.();
      });
      entry.socket.on('data', data => { try { parser.push(data); } catch { const error = failure('MEDIA_PROTOCOL', tr('媒体连接返回了无效数据，采集已停止。')); failFirst(error); entry.error = error.message; void stop(entry.id); } });
      entry.socket.on('error', () => { failFirst(failure('MEDIA_SOCKET', tr('媒体回环连接失败。'))); if (!entry.closing) { entry.error = tr('媒体回环连接失败。'); void stop(entry.id); } });
      entry.socket.once('close', () => {
        clearInterval(entry.heartbeat);
        failFirst(failure('MEDIA_CLOSED', tr('媒体连接在首帧到达前已关闭。')));
        if (!entry.closing) { entry.error ||= tr('媒体连接已断开。'); void stop(entry.id); }
      });
      entry.abort.signal.addEventListener('abort', () => failFirst(failure('CANCELLED', tr('用户取消'))), { once: true });
    });
  }
  async function start(deviceId, options = {}) {
    const current = [...entries.values()].find(entry => entry.deviceId === deviceId && LIVE.has(entry.status));
    if (current?.status === 'stopping') return { success: false, error: tr('上次投屏仍在清理，请稍候再试。') };
    if (current) return current.readyResult || { success: current.status === 'streaming', session: publicState(current) };
    let ref;
    try { ref = resolve(deviceId); if (ref.transport !== 'hdc') throw new Error(); }
    catch { return { success: false, error: tr('请选择已连接且获授权的鸿蒙设备。') }; }
    const id = randomUUID(), entry = { id, deviceId, ref, paths: sessionPaths(id), abort: new AbortController(), frames: 0, status: 'starting', startedAt: now() };
    entry.readyResult = new Promise(resolveResult => { entry.resolveResult = resolveResult; });
    entries.set(id, entry); publish(entry);
    try {
      entry.binding = { deviceRef: ref, command: commandPath(), assertCurrent: () => {
        const current = resolve(deviceId);
        if (current.generation !== ref.generation || current.targetKey !== ref.targetKey) throw failure('DEVICE_CHANGED', tr('设备连接已变化，已停止本次媒体操作。'));
      } };
      const version = await checked(entry, ['shell', 'uitest', '--version'], { timeoutMs: 10000 });
      try { entry.version = parseUiTestVersion(version.stdout); }
      catch (error) { throw failure('UITEST_UNSUPPORTED', error.message); }
      let abi = await execute(entry, ['shell', 'param', 'get', 'const.product.cpu.abilist'], { timeoutMs: 10000 });
      if (!abi.ok || !String(abi.stdout).trim()) abi = await checked(entry, ['shell', 'uname', '-m'], { timeoutMs: 10000 });
      entry.abi = parseAbi(abi.stdout);
      const agent = agentFile(entry.binding.command, entry.abi);
      entry.localDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'awb-harmony-media-'));
      const initialImage = path.join(entry.localDirectory, 'initial.png');
      const capture = await screenshot(deviceId, initialImage, { ...entry.binding, signal: entry.abort.signal });
      if (!capture.ok) throw failure('CAPTURE_SIZE', capture.error || tr('无法确认设备画面尺寸。'));
      entry.sourceSize = { width: capture.width, height: capture.height };
      entry.config = createAgentConfig(id, entry.sourceSize, options);
      const localConfig = path.join(entry.localDirectory, 'config');
      await fs.promises.writeFile(localConfig, entry.config.content, { mode: 0o600, flag: 'wx' });
      await checked(entry, ['shell', 'mkdir', '-m', '700', entry.paths.directory]);
      entry.deployed = true;
      await checked(entry, ['file', 'send', agent, entry.paths.agent], { timeoutMs: 60000 });
      await checked(entry, ['file', 'send', localConfig, entry.paths.config]);
      await checked(entry, ['shell', 'chmod', '600', entry.paths.config]);
      await checked(entry, ['shell', 'chmod', '700', entry.paths.agent]);
      await checked(entry, ['shell', 'uitest', 'start-daemon', 'singleness', '--extension-name', entry.paths.extension, '--config', entry.paths.config], { timeoutMs: 15000 });
      entry.ready = await readReadiness(entry);
      entry.localPort = await reservePort();
      await checked(entry, ['fport', 'tcp:' + entry.localPort, 'tcp:' + entry.ready.port]);
      entry.forwarded = true;
      await verifyForward(entry.localPort);
      const session = await receive(entry);
      const result = { success: true, session }; entry.resolveResult(result); return result;
    } catch (error) {
      entry.error = error.safe ? error.message : tr('原生媒体组件未能安全启动；设备与现有服务未被替换。');
      await stop(id);
      const result = { success: false, error: entry.error, code: error.code, session: publicState(entry) };
      entry.resolveResult(result); return result;
    }
  }
  async function stop(id) {
    const entry = entries.get(id);
    if (!entry) return { success: true };
    if (entry.stopPromise) return entry.stopPromise;
    entry.closing = true; entry.abort.abort(); clearTimeout(entry.firstTimer); clearInterval(entry.heartbeat);
    entry.status = 'stopping'; publish(entry);
    entry.stopPromise = (async () => {
      const warnings = [];
      if (entry.socket && !entry.socket.destroyed) {
        entry.socket.write('STOP\n');
        await Promise.race([new Promise(resolveClosed => entry.socket.once('close', resolveClosed)), sleep(1500)]);
        entry.socket.destroy();
      }
      let current = false;
      try { current = resolve(entry.deviceId, { allowOffline: true }).generation === entry.ref.generation; } catch { /* No fallback target. */ }
      const cleanupOptions = { signal: undefined, timeoutMs: 5000, queue: false };
      if (entry.deployed && current) {
        if (entry.ready) {
          const result = await execute(entry, ['shell', ownedStopCommand(entry)], cleanupOptions).catch(() => null);
          if (!result?.ok) warnings.push(tr('未能确认本次媒体进程已退出；未终止其他进程。'));
        }
        if (entry.forwarded) {
          const result = await execute(entry, ['fport', 'rm', 'tcp:' + entry.localPort, 'tcp:' + entry.ready.port], cleanupOptions).catch(() => null);
          if (!result?.ok) warnings.push(tr('本次媒体端口转发未能清理。'));
        }
        await execute(entry, ['shell', 'rm', '-f', entry.paths.agent, entry.paths.config, entry.paths.ready], cleanupOptions).catch(() => {});
        await execute(entry, ['shell', 'rmdir', entry.paths.directory], cleanupOptions).catch(() => {});
      } else if (entry.deployed) warnings.push(tr('设备连接已变化，未向其他目标发送清理命令。'));
      if (entry.localDirectory) {
        for (const name of ['config', 'initial.png']) await fs.promises.unlink(path.join(entry.localDirectory, name)).catch(() => {});
        await fs.promises.rmdir(entry.localDirectory).catch(() => {});
      }
      if (entry.config) { entry.config.token = ''; entry.config.content = ''; }
      entry.socket?.removeAllListeners(); entry.socket = null;
      entry.status = entry.error ? 'failed' : 'stopped';
      entry.cleanupWarnings = warnings; publish(entry);
      const finished = [...entries.values()].filter(item => !LIVE.has(item.status)).sort((a, b) => b.startedAt - a.startedAt);
      for (const previous of finished.slice(20)) entries.delete(previous.id);
      return { success: warnings.length === 0, session: publicState(entry), warnings };
    })();
    return entry.stopPromise;
  }
  return { start, stop, list: () => [...entries.values()].map(publicState),
    get: id => entries.has(id) ? publicState(entries.get(id)) : null,
    hasActiveStreams: () => [...entries.values()].some(entry => LIVE.has(entry.status)),
    async shutdownAll() { const results = await Promise.all([...entries.keys()].map(stop)); return { success: results.every(result => result.success), failed: results.filter(result => !result.success) }; } };
}

module.exports = { createHarmonyMediaSessions, parseAbi, readAgent, ownedStopCommand, verifyLoopbackForward, isLoopbackAddress };
