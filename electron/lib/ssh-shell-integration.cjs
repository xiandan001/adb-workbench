const { tr } = require('./localization.cjs');
const fs = require('node:fs');
const path = require('node:path');

const MAX_OSC_BYTES = 16 * 1024;
const MAX_COMMAND_BYTES = 4096;
const PREFIX = '\x1b]7777;AWB;';
let script;

function buildBashIntegrationScript(nonce) {
  if (typeof nonce !== 'string' || !/^[a-f0-9]{64}$/.test(nonce)) throw new Error(tr("SSH 命令识别标识无效"));
  script ??= fs.readFileSync(path.join(__dirname, '../assets/ssh-bash-integration.sh'), 'utf8');
  return script.replaceAll('@AWB_NONCE@', nonce);
}

// Only this application's authenticated records are interpreted. Standard OSC
// sequences remain terminal output; private records (even invalid ones) never
// expose a nonce through the renderer's output ring.
function createSshShellIntegration({ onData, onMarker = () => {}, onCommand = () => {}, onChange = () => {} }) {
  let nonce = '';
  let enabled = false;
  let installed = false;
  let status = 'disabled';
  let phase = 'unknown';
  let promptId = 0;
  let error = '';
  let commandAllowed = false;
  let promptStarted = false;
  let serializedPrompts = false;
  let lastPromptSerial = 0;
  let pendingPromptSerial = null;
  let pending = [];
  let discard = false;
  let passthrough = false;
  let escaped = false;
  let plain = [];
  const snapshot = () => ({ status, phase, promptId, ...(error ? { error } : {}) });
  const changed = () => onChange(snapshot());
  const flush = () => { if (plain.length) { onData(Buffer.from(plain)); plain = []; } };
  const output = bytes => { for (const byte of bytes) { plain.push(byte); if (plain.length >= 4096) flush(); } };
  function marker(kind) { flush(); onMarker({ kind, promptId }); changed(); }
  function receive(bytes) {
    const value = bytes.toString('latin1');
    if (!value.startsWith(PREFIX)) { output(bytes); return; }
    if (!enabled || !nonce) return;
    const end = value.endsWith('\x07') ? -1 : -2;
    const fields = value.slice(PREFIX.length, end).split(';');
    if (fields[0] !== nonce || fields.length > 3) return;
    const type = fields[1];
    if (type === 'X' && status === 'enabling') {
      status = 'unsupported'; phase = 'unknown'; error = tr("命令识别需要 Bash 4.4+、已启用 Readline 和默认 Enter / Ctrl+J 提交绑定；自定义绑定或其他同类钩子保持不变"); changed(); return;
    }
    if (type === 'R' && status === 'enabling') { installed = true; status = 'ready'; phase = 'unknown'; changed(); return; }
    if (!installed || status !== 'ready') return;
    if (type === 'A') {
      if (phase === 'running') return;
      if (fields.length === 3) {
        const serial = Number(fields[2]);
        if (!/^[1-9][0-9]{0,15}$/.test(fields[2]) || !Number.isSafeInteger(serial) || serial <= lastPromptSerial
          || promptStarted && pendingPromptSerial !== null && serial <= pendingPromptSerial) return;
        serializedPrompts = true; pendingPromptSerial = serial;
      } else {
        // Old fixtures remain valid, but cannot bypass a numbered live prompt.
        if (serializedPrompts) return;
        pendingPromptSerial = null;
      }
      phase = 'unknown'; commandAllowed = false; promptStarted = true; marker('prompt-start');
    }
    else if (type === 'B' && promptStarted) {
      if (serializedPrompts ? fields.length !== 3 || fields[2] !== String(pendingPromptSerial) : fields.length !== 2) return;
      if (pendingPromptSerial !== null) lastPromptSerial = pendingPromptSerial;
      pendingPromptSerial = null; promptStarted = false; phase = 'prompt'; promptId++; marker('prompt');
    }
    else if (type === 'C' && phase === 'prompt') { phase = 'running'; commandAllowed = true; marker('running'); }
    else if (type === 'D') { phase = 'unknown'; commandAllowed = false; promptStarted = false; pendingPromptSerial = null; changed(); }
    else if (type === 'E' && commandAllowed && phase === 'running') {
      commandAllowed = false;
      const hex = fields[2];
      if (!hex || hex.length > MAX_COMMAND_BYTES * 2 || hex.length % 2 || !/^[a-f0-9]+$/.test(hex)) return;
      try {
        const command = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex, 'hex'));
        if (command.trim() && !command.startsWith(' ')
          && !Array.from(command).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) onCommand(command);
      } catch { /* Invalid UTF-8 is not a trustworthy command. */ }
    }
  }
  function feed(bytes) {
    if (!pending.length && !discard && !passthrough && bytes.indexOf(27) < 0) { onData(bytes); return; }
    for (const byte of bytes) {
      if (discard || passthrough) {
        if (passthrough) output([byte]);
        if (byte === 7 || (escaped && byte === 92)) { discard = false; passthrough = false; }
        escaped = byte === 27;
        continue;
      }
      if (!pending.length) {
        if (byte === 27) pending.push(byte); else output([byte]);
        continue;
      }
      if (pending.length === 1 && byte !== 93) {
        output(pending); pending = [];
        if (byte === 27) pending.push(byte); else output([byte]);
        continue;
      }
      pending.push(byte);
      if (pending.length < 2) continue;
      if (byte === 7 || (pending.length > 2 && pending.at(-2) === 27 && byte === 92)) {
        receive(Buffer.from(pending)); pending = [];
      } else if (pending.length >= MAX_OSC_BYTES) {
        const privateRecord = Buffer.from(pending.slice(0, PREFIX.length)).toString('latin1') === PREFIX;
        if (!privateRecord) output(pending);
        discard = privateRecord; passthrough = !privateRecord; escaped = byte === 27; pending = [];
        commandAllowed = false;
      }
    }
    flush();
  }
  function start(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(tr("SSH 命令识别标识无效"));
    nonce = token; enabled = true; installed = false; status = 'enabling'; phase = 'unknown';
    error = ''; commandAllowed = false; promptStarted = false; serializedPrompts = false; lastPromptSerial = 0; pendingPromptSerial = null; changed();
  }
  function fail(message = tr("命令识别未收到 Bash 确认，请确认在空提示符后重新打开终端再试")) {
    enabled = false; status = 'error'; phase = 'unknown'; commandAllowed = false; error = message; changed();
  }
  function disable() { enabled = false; status = 'disabled'; phase = 'unknown'; commandAllowed = false; error = ''; changed(); }
  function close() { disable(); pending = []; plain = []; nonce = ''; }
  return { start, feed, fail, disable, close, snapshot, pendingBytes: () => pending.length };
}

module.exports = { createSshShellIntegration, buildBashIntegrationScript };
