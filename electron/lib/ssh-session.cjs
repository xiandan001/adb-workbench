const { tr } = require('./localization.cjs');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { createSshTerminal, terminalSize, closeChannel, sshError } = require('./ssh-session-terminal.cjs');
const { buildBashIntegrationScript } = require('./ssh-shell-integration.cjs');
const { installBashIntegration } = require('./ssh-shell-bootstrap.cjs');
const { probeBash, bashStartupScript, bashStartupCommand } = require('./ssh-shell-startup.cjs');

const MAX_ACTIVE_SESSIONS = 16;
const MAX_RETAINED_SESSIONS = 64;
const MAX_TERMINALS = 16;

function createSshSessionService({ createClient, resolveProfile, verifyHostKey, onChange = () => {}, onShellCommand = () => {}, shouldRememberCommands = () => false,
  connectTimeoutMs = 20000, hostVerifyTimeoutMs = 90000, channelTimeoutMs = 15000, closeTimeoutMs = 3000, writeTimeoutMs = 10000, shellIntegrationTimeoutMs = 15000, shellCleanupTimeoutMs = 2000, shellProbeTimeoutMs = 3000 }) {
  if (![createClient, resolveProfile, verifyHostKey].every(value => typeof value === 'function')) throw new Error(tr("SSH 服务配置不完整"));
  const sessions = new Map();
  let revision = 0;
  let disposed = false;

  function notify() { revision++; try { onChange(); } catch {} }
  function find(id) {
    const session = sessions.get(id);
    if (!session) throw sshError('SSH_SESSION_NOT_FOUND', tr("SSH 会话不存在或已移除"));
    return session;
  }
  function assertCurrent(session) {
    if (disposed || sessions.get(session.id) !== session || session.closed || session.status === 'disconnecting' || session.controller.signal.aborted) throw sshError('SSH_SESSION_CLOSED', tr("SSH 会话已断开，旧操作不会重播"));
  }
  function assertConnected(session) {
    assertCurrent(session);
    if (session.status !== 'connected') throw sshError('SSH_SESSION_NOT_READY', tr("SSH 会话尚未连接"));
  }
  function snapshot() {
    return { revision, sessions: [...sessions.values()].map(session => ({ id: session.id, name: session.name, profileId: session.profileId,
      host: session.host, port: session.port, username: session.username, status: session.status, error: session.error,
      fingerprint: session.fingerprint, keyType: session.keyType,
      terminals: [...session.terminals.values()].map(terminal => terminal.view.snapshot()) })) };
  }

  function stopSessionOperations(session) {
    if (!session.controller.signal.aborted) session.controller.abort(sshError('SSH_SESSION_CLOSED', tr("SSH 会话已断开，操作已取消")));
    clearTimeout(session.timer);
    clearTimeout(session.closeTimer);
    for (const operation of [...session.operations]) operation.cancel();
    for (const terminal of session.terminals.values()) terminal.view.close();
    closeChannel(session.sftp);
    session.sftp = null;
  }

  function finishClosed(session, failure) {
    if (session.closed) return;
    session.closed = true;
    stopSessionOperations(session);
    session.status = failure ? 'error' : 'disconnected';
    session.error = failure?.message || session.cleanupWarning || '';
    session.connection.reject(failure || sshError('SSH_CONNECT_CANCELLED', tr("SSH 连接已取消或断开")));
    session.closing?.resolve();
    notify();
  }

  function failConnection(session, failure) {
    if (session.closed) return;
    finishClosed(session, failure);
    try { session.client?.destroy(); } catch {}
  }

  function armConnectionTimeout(session, delay, hostPrompt = false) {
    clearTimeout(session.timer);
    session.timer = setTimeout(() => failConnection(session, sshError(hostPrompt ? 'SSH_HOST_KEY_TIMEOUT' : 'SSH_CONNECT_TIMEOUT',
      hostPrompt ? tr("SSH 主机指纹确认超时，连接已取消") : tr("SSH 连接超时，请检查主机和网络"))), delay);
  }

  function hostVerifier(session, key, callback) {
    const rekeying = session.authenticated;
    let answered = false;
    const answer = accepted => {
      if (answered) return; answered = true;
      try { callback(accepted && !session.closed && !session.controller.signal.aborted); } catch {}
    };
    try {
      assertCurrent(session);
      if (!Buffer.isBuffer(key) || key.length < 4 || key.length > 1024 * 1024) throw sshError('SSH_HOST_KEY_INVALID', tr("SSH 主机密钥格式无效"));
      const keyLength = key.readUInt32BE(0);
      const keyType = keyLength <= key.length - 4 && keyLength <= 200 ? key.subarray(4, keyLength + 4).toString('ascii') : 'unknown';
      session.keyType = /^[a-zA-Z0-9@._+-]+$/.test(keyType) ? keyType : 'unknown';
      session.fingerprint = 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
      if (!rekeying) session.status = 'verifying-host';
      notify();
      armConnectionTimeout(session, hostVerifyTimeoutMs, true);
      Promise.resolve().then(() => verifyHostKey({ sessionId: session.id, host: session.host, port: session.port,
        username: session.username, keyType: session.keyType, fingerprint: session.fingerprint, signal: session.controller.signal })).then(accepted => {
        if (session.closed || session.controller.signal.aborted) { answer(false); return; }
        if (accepted !== true) {
          session.trustError = sshError('SSH_HOST_KEY_REJECTED', tr("未信任此 SSH 主机指纹，连接已取消"));
          answer(false); failConnection(session, session.trustError); return;
        }
        session.hostVerified = true;
        if (rekeying) clearTimeout(session.timer);
        else { session.status = 'connecting'; armConnectionTimeout(session, connectTimeoutMs); }
        notify(); answer(true);
      }).catch(failure => {
        // This injected main-process verifier owns the trusted, non-secret fingerprint message.
        session.trustError = sshError(failure?.code || 'SSH_HOST_KEY_REJECTED', String(failure?.message || tr("SSH 主机指纹验证失败")).slice(0, 500));
        answer(false); if (!session.closed) failConnection(session, session.trustError);
      });
    } catch (failure) { session.trustError = failure; answer(false); failConnection(session, failure); }
  }

  async function initialize(session, args, size) {
    try {
      const profile = await resolveProfile(args);
      assertCurrent(session);
      if (!profile || typeof profile.host !== 'string' || !profile.host.trim() || typeof profile.username !== 'string' || !profile.username.trim()
        || !Number.isInteger(profile.port) || profile.port < 1 || profile.port > 65535) throw new Error('Invalid profile');
      Object.assign(session, { host: profile.host, port: profile.port, username: profile.username,
        name: typeof profile.name === 'string' ? profile.name.slice(0, 200) : profile.host,
        profileId: typeof profile.profileId === 'string' ? profile.profileId : undefined });
      const client = createClient(); session.client = client;
      client.on('error', failure => {
        if (session.closed) return;
        const safe = session.trustError || (failure?.level === 'client-authentication'
          ? sshError('SSH_AUTH_FAILED', tr("SSH 认证失败，请检查用户名、密码或私钥"))
          : sshError('SSH_CONNECTION_FAILED', tr("SSH 连接中断，请检查网络与服务器状态")));
        failConnection(session, safe);
      });
      client.on('close', () => finishClosed(session));
      client.on('end', () => {
        if (!session.closed && session.status !== 'disconnecting') { finishClosed(session); try { client.destroy(); } catch {} }
      });
      client.on('ready', () => {
        if (session.closed || session.controller.signal.aborted) { try { client.destroy(); } catch {} return; }
        if (!session.hostVerified) { failConnection(session, sshError('SSH_HOST_KEY_REJECTED', tr("SSH 主机指纹尚未验证，已拒绝认证会话"))); return; }
        if (session.authenticated) return;
        session.authenticated = true;
        clearTimeout(session.timer); session.status = 'connected'; session.error = ''; notify();
        openTerminal({ sessionId: session.id, ...size }).catch(() => {}).then(() => {
          if (!session.closed && session.status === 'connected') session.connection.resolve({ sessionId: session.id });
        });
      });
      const options = { host: profile.host, port: profile.port, username: profile.username,
        readyTimeout: connectTimeoutMs * 2 + hostVerifyTimeoutMs, keepaliveInterval: 15000, keepaliveCountMax: 3,
        tryKeyboard: false, hostVerifier: (key, callback) => hostVerifier(session, key, callback) };
      for (const key of ['password', 'privateKey', 'passphrase']) if (profile[key] !== undefined) options[key] = profile[key];
      notify(); client.connect(options); client.setNoDelay?.(true);
    } catch {
      if (!session.closed) failConnection(session, sshError('SSH_PROFILE_FAILED', tr("SSH 连接配置不可用，请检查保存的连接信息与凭据")));
    }
  }

  function connect(args = {}) {
    try {
      if (disposed) throw sshError('SSH_DISPOSED', tr("SSH 服务正在退出"));
      const size = terminalSize(args);
      if ([...sessions.values()].filter(session => !session.closed).length >= MAX_ACTIVE_SESSIONS) throw sshError('SSH_SESSION_LIMIT', tr("最多同时连接 16 个 SSH 会话"));
      if (sessions.size >= MAX_RETAINED_SESSIONS) throw sshError('SSH_HISTORY_LIMIT', tr("最多保留 64 个 SSH 会话，请先关闭不需要的旧会话"));
      const session = { id: randomUUID(), name: 'SSH', profileId: undefined, host: '', port: 22, username: '', status: 'connecting', error: '',
        fingerprint: '', keyType: '', controller: new AbortController(), connection: deferred(), client: null,
        terminals: new Map(), nextTerminal: 1, operations: new Set(), sftp: null, sftpPromise: null, closed: false,
        hostVerified: false, authenticated: false };
      sessions.set(session.id, session); notify(); armConnectionTimeout(session, connectTimeoutMs);
      void initialize(session, args, size);
      return session.connection.promise;
    } catch (failure) { return Promise.reject(failure); }
  }

  function channelRequest(session, invoke, code, message, { timeoutCode = code, timeoutMessage = message } = {}) {
    const action = deferred();
    let settled = false;
    const operation = { cancel: () => finish(sshError('SSH_SESSION_CLOSED', tr("SSH 会话已断开，通道操作已取消"))) };
    const timer = setTimeout(() => finish(sshError(timeoutCode, timeoutMessage)), channelTimeoutMs);
    function finish(failure, channel) {
      if (settled) { closeChannel(channel); return; }
      settled = true; clearTimeout(timer); session.operations.delete(operation);
      if (failure) action.reject(failure); else action.resolve(channel);
    }
    session.operations.add(operation);
    try { invoke((failure, channel) => {
      if (settled || session.closed || session.controller.signal.aborted) { closeChannel(channel); finish(sshError('SSH_SESSION_CLOSED', tr("SSH 会话已断开"))); return; }
      if (failure || !channel || typeof channel.on !== 'function') { closeChannel(channel); finish(sshError(code, message)); } else finish(null, channel);
    }); } catch { finish(sshError(code, message)); }
    return { promise: action.promise, cancel: operation.cancel };
  }

  function assertTerminal(session, terminal, id) {
    assertConnected(session);
    if (session.terminals.get(id) !== terminal || terminal.closingTask) throw sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端已关闭"));
  }
  async function attachRequested(session, terminal, id) {
    const channel = await terminal.request.promise;
    try { assertTerminal(session, terminal, id); }
    catch (failure) { closeChannel(channel); throw failure; }
    terminal.view.attach(channel);
  }

  async function openTerminal({ sessionId, cols, rows } = {}) {
    const session = find(sessionId); assertConnected(session);
    const size = terminalSize({ cols, rows });
    if (session.terminals.size >= MAX_TERMINALS) throw sshError('SSH_TERMINAL_LIMIT', tr("每个 SSH 会话最多保留 16 个终端，请先关闭旧终端"));
    const id = randomUUID();
    const terminal = { view: createSshTerminal({ sessionId, terminalId: id, title: tr('终端 {0}', { 0: session.nextTerminal++ }), ...size,
      assertCurrent: () => assertConnected(session), onChange: notify, writeTimeoutMs,
      onShellCommand: command => onShellCommand({ sessionId, terminalId: id, host: session.host, port: session.port,
        username: session.username, profileId: session.profileId, fingerprint: session.fingerprint, command }) }), request: null };
    session.terminals.set(id, terminal); notify();
    let remember = false;
    try { remember = shouldRememberCommands({ host: session.host, port: session.port, username: session.username, profileId: session.profileId, fingerprint: session.fingerprint }) === true; } catch {}
    if (remember) {
      let launchAttempted = false; let launched = false; let rejected = false;
      try {
        await runShellIntegration(session, terminal, id, { automatic: true, launch: async (bash, ownedPath, signal) => {
          assertTerminal(session, terminal, id);
          if (signal.aborted) throw sshError('SSH_SHELL_INTEGRATION_CANCELLED', tr("命令识别准备已取消"));
          launchAttempted = true;
          terminal.request = channelRequest(session,
            callback => session.client.exec(bashStartupCommand(bash, ownedPath), { pty: { term: 'xterm-256color', ...size } }, callback),
            'SSH_AUTO_EXEC_REJECTED', tr("服务器不允许增强终端启动，将使用普通终端"),
            { timeoutCode: 'SSH_AUTO_EXEC_TIMEOUT', timeoutMessage: tr("增强终端启动结果未确认，请新建终端重试") });
          const cancel = () => terminal.request.cancel();
          signal.addEventListener('abort', cancel, { once: true });
          try {
            const channel = await terminal.request.promise;
            launched = true;
            try { assertTerminal(session, terminal, id); }
            catch (failure) { closeChannel(channel); throw failure; }
            terminal.view.attach(channel);
          } catch (failure) { rejected = failure.code === 'SSH_AUTO_EXEC_REJECTED'; throw failure; }
          finally { signal.removeEventListener('abort', cancel); }
        } });
        return { terminalId: id };
      } catch (failure) {
        assertTerminal(session, terminal, id);
        // Once an interactive exec was accepted, retain it even if the helper
        // did not become ready. Never secretly start a second shell/program.
        if (launched) return { terminalId: id };
        if (launchAttempted && !rejected) {
          terminal.view.failShellIntegration(tr("增强终端启动结果未确认，未创建第二个终端；请新建终端重试"));
          terminal.view.failOpen(); throw failure;
        }
      }
    }
    terminal.request = channelRequest(session, callback => session.client.shell({ term: 'xterm-256color', ...size }, callback), 'SSH_SHELL_FAILED', tr("无法打开 SSH 终端；仍可使用文件功能"));
    try {
      await attachRequested(session, terminal, id);
      return { terminalId: id };
    } catch (failure) { if (!session.closed && session.terminals.get(id) === terminal) terminal.view.failOpen(); throw failure; }
  }

  function getTerminal(args) {
    const session = find(args?.sessionId);
    const terminal = session.terminals.get(args?.terminalId);
    if (!terminal) throw sshError('SSH_TERMINAL_NOT_FOUND', tr("SSH 终端不存在或已关闭"));
    return { session, terminal };
  }
  function terminalRead(args) { return getTerminal(args).terminal.view.read(args); }
  async function terminalWrite(args) { const { session, terminal } = getTerminal(args); assertConnected(session); if (terminal.closingTask) throw sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端正在关闭")); return terminal.view.write(args); }
  async function terminalResize(args) { const { session, terminal } = getTerminal(args); assertConnected(session); if (terminal.closingTask) throw sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端正在关闭")); return terminal.view.resize(args); }
  async function enableShellIntegration(args) {
    const { session, terminal } = getTerminal(args); assertConnected(session);
    if (terminal.closingTask) throw sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端正在关闭"));
    return runShellIntegration(session, terminal, args.terminalId);
  }
  function runShellIntegration(session, terminal, terminalId, { automatic = false, launch } = {}) {
    const nonce = randomBytes(32).toString('hex');
    const waitReady = terminal.view.startShellIntegration(nonce, shellIntegrationTimeoutMs, { allowOpening: automatic });
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.controller.signal.addEventListener('abort', abort, { once: true });
    waitReady.catch(abort);
    const operation = { controller, promise: null }; terminal.integration = operation;
    operation.promise = (async () => {
      try {
        const assertHeld = () => {
          assertTerminal(session, terminal, terminalId);
          if (!['opening', 'ready'].includes(terminal.view.snapshot().status)) throw sshError('SSH_TERMINAL_CLOSED', tr("SSH 终端已关闭"));
        };
        const bash = automatic ? await probeBash(session.client, { signal: controller.signal, assertCurrent: assertHeld, timeoutMs: shellProbeTimeoutMs }) : null;
        await installBashIntegration({ getSftp: () => getSftp(session.id), signal: controller.signal,
          assertCurrent: assertHeld, script: automatic ? bashStartupScript(nonce) : buildBashIntegrationScript(nonce),
          ...(automatic ? { launch: ownedPath => launch(bash.path, ownedPath, controller.signal) } : { write: text => terminal.view.writeBootstrap(text) }), waitReady,
          timeoutMs: shellIntegrationTimeoutMs, cleanupTimeoutMs: shellCleanupTimeoutMs });
        return { shellIntegration: terminal.view.snapshot().shellIntegration };
      } catch (error) {
        const state = terminal.view.snapshot();
        if (error.code === 'SSH_SHELL_CLEANUP_FAILED') {
          session.cleanupWarning = error.message; session.error = error.message;
          terminal.view.failShellIntegration(error.message); notify();
        } else if (['opening', 'ready'].includes(state.status) && state.shellIntegration.status !== 'unsupported' && !controller.signal.aborted) {
          terminal.view.failShellIntegration(automatic ? tr("未自动启用命令识别：{0}", { 0: error.message }) : undefined);
        }
        throw error;
      } finally {
        session.controller.signal.removeEventListener('abort', abort);
        if (terminal.integration === operation) terminal.integration = null;
      }
    })();
    return operation.promise;
  }
  async function cancelIntegration(terminal) {
    const operation = terminal.integration;
    if (!operation) return null;
    operation.controller.abort(); terminal.view.disableShellIntegration();
    try { await operation.promise; return null; }
    catch (error) { return error.code === 'SSH_SHELL_CLEANUP_FAILED' ? error : null; }
  }
  function disableShellIntegration(args) {
    return { shellIntegration: getTerminal(args).terminal.view.disableShellIntegration() };
  }
  async function closeTerminal(args) {
    const { session, terminal } = getTerminal(args);
    if (terminal.closingTask) return terminal.closingTask;
    terminal.closingTask = (async () => {
      const failure = await cancelIntegration(terminal);
      terminal.request?.cancel(); terminal.view.close();
      if (failure) { terminal.view.failShellIntegration(failure.message); throw failure; }
      session.terminals.delete(args.terminalId); notify();
    })();
    try { return await terminal.closingTask; }
    finally { terminal.closingTask = null; }
  }

  function getSessionContext(sessionId) {
    const session = find(sessionId); assertConnected(session);
    return { client: session.client, signal: session.controller.signal, assertCurrent: () => assertConnected(session) };
  }
  function getSftp(sessionId) {
    try {
      const session = find(sessionId); assertConnected(session);
      if (session.sftpPromise) return session.sftpPromise;
      const request = channelRequest(session, callback => session.client.sftp(callback), 'SSH_SFTP_FAILED', tr("无法打开 SFTP 文件通道"));
      const promise = request.promise.then(channel => {
        try { assertConnected(session); } catch (failure) { closeChannel(channel); throw failure; }
        session.sftp = channel;
        const clear = () => { if (session.sftp === channel) { session.sftp = null; session.sftpPromise = null; } };
        channel.once('close', clear); channel.on('error', clear);
        return channel;
      }).catch(failure => { if (session.sftpPromise === promise) session.sftpPromise = null; throw failure; });
      session.sftpPromise = promise;
      return promise;
    } catch (failure) { return Promise.reject(failure); }
  }

  async function disconnect({ sessionId } = {}) {
    const session = find(sessionId);
    if (session.closed) return { sessionId };
    if (session.disconnectTask) return session.disconnectTask;
    session.closing = deferred(); session.status = 'disconnecting';
    notify();
    session.disconnectTask = (async () => {
      const failures = await Promise.all([...session.terminals.values()].map(cancelIntegration));
      stopSessionOperations(session); session.connection.reject(sshError('SSH_CONNECT_CANCELLED', tr("SSH 连接已取消或断开")));
      if (!session.client) finishClosed(session);
      else if (!session.closed) {
        session.closeTimer = setTimeout(() => { try { session.client.destroy(); } catch {} finishClosed(session); }, closeTimeoutMs);
        try { session.client.end(); } catch { try { session.client.destroy(); } catch {} finishClosed(session); }
      }
      await session.closing.promise;
      const failure = failures.find(Boolean);
      if (failure) throw failure;
      return { sessionId };
    })();
    return session.disconnectTask;
  }
  async function removeSession({ sessionId } = {}) {
    const session = find(sessionId);
    if (!session.closed) throw sshError('SSH_SESSION_ACTIVE', tr("请先断开 SSH 会话再移除"));
    sessions.delete(sessionId); notify();
  }
  function needsQuitConfirmation() { return [...sessions.values()].some(session => !session.closed); }
  async function dispose() {
    disposed = true;
    const results = await Promise.allSettled([...sessions.keys()].map(sessionId => disconnect({ sessionId })));
    const failed = results.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  return { snapshot, connect, disconnect, removeSession, openTerminal, closeTerminal, terminalRead, terminalWrite, terminalResize, enableShellIntegration, disableShellIntegration,
    getSessionContext, getSftp, needsQuitConfirmation, dispose };
}

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

module.exports = { createSshSessionService };
