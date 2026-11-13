const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const script = path.resolve(__dirname, '../../electron/assets/update-processes.ps1');
const nativeSource = path.resolve(__dirname, '../native-update-process.cpp');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const parentWaitMarker = 'VEYLO_FIXTURE_PARENT_WAIT';

function assertWithin(root, target) {
  const relative = path.relative(root, target);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative),
    `fixture target must stay below its owned root: ${target}`);
  return target;
}

function trackProcess(child, executable) {
  const record = { child, executable, pid: child.pid, closed: false, stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { record.stdout += chunk; });
  child.stderr.on('data', chunk => { record.stderr += chunk; });
  record.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => { record.closed = true; resolve({ code, signal }); });
  });
  return record;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function compileNative(directory) {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
    'Microsoft Visual Studio/Installer/vswhere.exe');
  const visualStudio = cp.execFileSync(vswhere, ['-latest', '-products', '*', '-requires',
    'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'],
  { windowsHide: true, encoding: 'utf8' }).trim();
  assert.ok(visualStudio, 'MSVC x64 build tools are required for isolated process fixtures');
  const executable = assertWithin(directory, path.join(directory, 'wait-only-native.exe'));
  const object = assertWithin(directory, path.join(directory, 'wait-only-native.obj'));
  const vcvars = path.join(visualStudio, 'VC/Auxiliary/Build/vcvarsall.bat');
  const command = `call "${vcvars}" x64 >nul && cl.exe /nologo /utf-8 /std:c++17 /O2 /MT /EHsc /DUNICODE /D_UNICODE /Fo"${object}" "${nativeSource}" /link /OUT:"${executable}"`;
  // Do not timeout only the cmd driver and strand a still-writing compiler descendant.
  cp.execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`],
    { cwd: directory, windowsHide: true, windowsVerbatimArguments: true, encoding: 'utf8',
      env: { ...process.env, VSCMD_SKIP_SENDTELEMETRY: '1' } });
  return executable;
}

function createFixtureSuite() {
  const temporaryParent = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, 'veylo-update-process-test-'));
  assertWithin(temporaryParent, root);
  const records = [];
  let native;
  try {
    native = compileNative(root);
  } catch (error) {
    const resolved = fs.realpathSync.native(root);
    assert.equal(resolved.toLowerCase(), root.toLowerCase(), 'refuse cleanup after a root identity change');
    try {
      fs.rmSync(assertWithin(temporaryParent, resolved), { recursive: true, maxRetries: 10, retryDelay: 100 });
    } catch (cleanupError) {
      error.message += `; retained owned fixture ${resolved}: ${cleanupError.message}`;
    }
    throw error;
  }
  function owned(target) {
    assertWithin(root, path.resolve(target));
    if (fs.existsSync(target)) assertWithin(root, fs.realpathSync.native(target));
    return target;
  }
  function copy(relative) {
    const target = owned(path.join(root, relative));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    owned(path.dirname(target));
    fs.copyFileSync(native, target);
    return owned(target);
  }
  async function start(executable, options = {}) {
    const canonical = fs.realpathSync.native(executable);
    owned(canonical);
    const gate = options.gate && owned(path.join(root, options.gate));
    const args = gate ? ['--gate', gate] : ['--wait-ms', String(options.waitMs ?? 60000)];
    const record = trackProcess(cp.spawn(executable, args,
      { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), canonical);
    record.kind = 'fixture';
    records.push(record);
    await bounded((async () => {
      while (!record.stdout.includes('\n') && !record.closed) await delay(10);
      assert.equal(Number(record.stdout.trim()), record.pid, `native fixture did not report its own PID: ${record.stderr}`);
      assert.ok(!record.closed, 'native fixture must be ready and waiting');
    })(), 5000, 'native process fixture did not become ready');
    return { pid: record.pid, done: record.done,
      isAlive: () => !record.closed && record.child.exitCode === null && record.child.signalCode === null,
      release: () => { assert.ok(gate, 'only gated processes can be released'); fs.writeFileSync(owned(gate), 'release\n'); } };
  }
  function invoke(mode, payload, environment = {}, { observeParentWait = false } = {}) {
    assert.ok(fs.existsSync(script), `shared process script is missing: ${script}`);
    if (mode === 'StopTools') for (const target of payload.targets) owned(fs.realpathSync.native(target));
    if (mode === 'PrepareInstall') {
      owned(fs.realpathSync.native(environment.VEYLO_INSTALLER_ROOT));
      owned(fs.realpathSync.native(environment.VEYLO_INSTALLER_APP_EXE));
      if (environment.VEYLO_UPDATE_EXE) owned(fs.realpathSync.native(environment.VEYLO_UPDATE_EXE));
      if (environment.VEYLO_UPDATE_PID) assert.ok(records.some(record => record.kind === 'fixture' && String(record.pid) === environment.VEYLO_UPDATE_PID),
        'a parent identity may reference only a PID created by this suite');
    }
    const env = { ...process.env };
    for (const key of ['VEYLO_INSTALLER_ROOT', 'VEYLO_INSTALLER_APP_EXE', 'VEYLO_UPDATE_PID', 'VEYLO_UPDATE_EXE']) delete env[key];
    Object.assign(env, environment);
    const powershell = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
    if (observeParentWait) {
      assert.equal(mode, 'PrepareInstall');
      Object.assign(env, { VEYLO_FIXTURE_SCRIPT: script, VEYLO_FIXTURE_MODE: mode, VEYLO_FIXTURE_PAYLOAD: encoded });
      // Observe the real function call after Add-Type startup, without changing the script or its inputs.
      args.push('-Command', `Set-PSBreakpoint -Command Wait-ForUpdateParent -Action { [Console]::Error.WriteLine('${parentWaitMarker}') } | Out-Null; & $env:VEYLO_FIXTURE_SCRIPT -Mode $env:VEYLO_FIXTURE_MODE -PayloadBase64 $env:VEYLO_FIXTURE_PAYLOAD`);
    } else {
      args.push('-File', script, '-Mode', mode, '-PayloadBase64', encoded);
    }
    const record = trackProcess(cp.spawn(powershell, args,
      { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }), powershell);
    record.kind = 'powershell';
    records.push(record);
    const pending = bounded(record.done, 25000, `shared process script did not finish: ${mode}`).then(result => {
      const output = record.stdout.trim();
      assert.ok(output, `shared process script did not return JSON: ${record.stderr}`);
      return { ...result, result: JSON.parse(output), stderr: record.stderr };
    });
    if (observeParentWait) pending.parentWait = bounded((async () => {
      while (!record.stderr.includes(parentWaitMarker)) {
        assert.ok(!record.closed, `script exited before entering the parent wait: ${record.stderr}`);
        await delay(10);
      }
    })(), 20000, 'script did not enter the verified parent wait');
    return pending;
  }
  function shortPath(executable) {
    owned(fs.realpathSync.native(executable));
    return cp.execFileSync(native, ['--short-path', executable], { windowsHide: true, encoding: 'utf8', timeout: 5000 }).trim();
  }
  async function dispose() {
    for (const record of records) {
      assert.ok(record.pid > 0, 'cleanup may address only a recorded child process');
      assert.equal(record.pid, record.child.pid, 'cleanup must use the original child-process handle');
      if (record.kind === 'fixture') owned(record.executable);
      else assert.equal(record.kind, 'powershell', 'cleanup must not acquire an unrelated process');
      if (!record.closed) record.child.kill();
    }
    await bounded(Promise.allSettled(records.map(record => record.done)), 5000, 'owned fixture children did not exit');
    assert.equal(fs.realpathSync.native(root).toLowerCase(), root.toLowerCase(), 'refuse cleanup after a root identity change');
    fs.rmSync(assertWithin(temporaryParent, root), { recursive: true, maxRetries: 10, retryDelay: 100 });
  }
  return { root, copy, start, invoke, shortPath, dispose };
}

module.exports = { createFixtureSuite, bounded, delay };
