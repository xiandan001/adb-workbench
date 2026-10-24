const { tr } = require('./localization.cjs');
const path = require('node:path');
const { buildBashIntegrationScript } = require('./ssh-shell-integration.cjs');
const { closeChannel, sshError } = require('./ssh-session-terminal.cjs');

const BASH_PROBE = 'case "${SHELL-}" in */bash) ;; *) exit 77;; esac; BASH_ENV= ENV= "$SHELL" --noprofile --norc -c \'if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then builtin printf "AWB_BASH_V1\\n%s\\n%s.%s\\n" "$BASH" "${BASH_VERSINFO[0]}" "${BASH_VERSINFO[1]}"; else exit 77; fi\'';
const unavailable = () => sshError('SSH_BASH_UNAVAILABLE', tr("默认 Shell 不是受支持的 Bash 4.4+，或服务器不允许安全检测；仍可使用普通终端"));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
function safeBashPath(value) {
  return typeof value === 'string' && value.length <= 3072 && path.posix.isAbsolute(value) && path.posix.basename(value) === 'bash'
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

function probeBash(client, { signal, assertCurrent, timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    let stream; let settled = false; let exitCode; let bytes = 0; const chunks = [];
    const abort = () => finish(unavailable());
    const timer = setTimeout(abort, timeoutMs);
    const data = chunk => {
      const value = Buffer.from(chunk); bytes += value.length;
      if (bytes > 4096) { finish(unavailable()); return; }
      chunks.push(value);
    };
    const stderr = chunk => { bytes += chunk.length; if (bytes > 4096) finish(unavailable()); };
    const exited = code => { exitCode = code; };
    const closed = () => {
      try {
        assertCurrent();
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const result = /^AWB_BASH_V1\r?\n([^\r\n]+)\r?\n([0-9]+)\.([0-9]+)\r?\n?$/.exec(text);
        if (exitCode !== 0 || !result || !safeBashPath(result[1])) throw unavailable();
        const major = Number(result[2]); const minor = Number(result[3]);
        if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor) || major < 4 || major === 4 && minor < 4) throw unavailable();
        finish(null, { path: result[1], major, minor });
      } catch { finish(unavailable()); }
    };
    function finish(error, value) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (stream) {
        stream.removeListener('data', data); stream.removeListener('exit', exited); stream.removeListener('close', closed);
        stream.stderr?.removeListener('data', stderr);
        closeChannel(stream);
      }
      if (error) reject(error); else resolve(value);
    }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      assertCurrent(); if (signal?.aborted) { abort(); return; }
      client.exec(BASH_PROBE, { pty: false }, (error, channel) => {
        if (settled) { closeChannel(channel); return; }
        if (error || !channel) { closeChannel(channel); finish(unavailable()); return; }
        stream = channel;
        stream.on('data', data); stream.on('error', abort); stream.on('exit', exited); stream.on('close', closed);
        stream.stderr?.on('data', stderr); stream.stderr?.on('error', abort);
      });
    } catch { finish(unavailable()); }
  });
}

function bashStartupScript(nonce) {
  // Like common IDE terminals, this is interactive non-login Bash: preserve the
  // user's bashrc, without rewriting it or guessing a login-profile order.
  return 'if [ -r "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi\n' + buildBashIntegrationScript(nonce);
}
function bashStartupCommand(bash, ownedPath) {
  if (!safeBashPath(bash) || typeof ownedPath !== 'string' || !path.posix.isAbsolute(ownedPath)
    || Array.from(ownedPath).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw unavailable();
  return `exec ${quote(bash)} --rcfile ${quote(ownedPath)} -i`;
}

module.exports = { probeBash, bashStartupScript, bashStartupCommand };
