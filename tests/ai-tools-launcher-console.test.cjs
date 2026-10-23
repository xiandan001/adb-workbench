const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

// Explicit opt-in: this test opens only its own harmless console, never a real CLI.
test('Windows external launcher opens an interactive console and actually executes an isolated command', {
  skip: process.platform !== 'win32' || process.env.AWB_TEST_VISIBLE_LAUNCH !== '1', timeout: 30000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-launch-console-'));
  const cwd = path.join(root, "fixture project's space"); fs.mkdirSync(cwd);
  const proof = path.join(root, 'proof.json'); const owned = new Set();
  const { createAiToolsLauncher } = require('../electron/lib/ai-tools-launcher.cjs');
  const { launchTerminal } = createAiToolsLauncher({ keepOpen: false, windowTitle: '卓控台 · 无害启动验证（自动退出）',
    spawnProcess: (...args) => { const child = childProcess.spawn(...args); child.once('spawn', () => owned.add(child.pid)); return child; },
  });
  t.after(async () => {
    // The fixture uses CMD /C, so it closes its own host after the harmless command.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && [...owned].some(pid => { try { process.kill(pid, 0); return true; } catch { return false; } })) await new Promise(resolve => setTimeout(resolve, 25));
    const cleanup = `$ErrorActionPreference='SilentlyContinue'; Stop-Process -Id @(${[...owned].join(',')}) -Force`;
    try { childProcess.execFileSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(cleanup, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* All fixture processes may already be gone. */ }
    await new Promise(resolve => setTimeout(resolve, 250));
    const absolute = path.resolve(root);
    assert.ok(absolute.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(absolute).startsWith('awb-launch-console-'));
    fs.rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const fixture = path.join(root, 'fixture.cjs');
  fs.writeFileSync(fixture, `const fs=require('node:fs');fs.writeFileSync(process.env.AWB_LAUNCH_PROBE_PATH,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),inputTTY:process.stdin.isTTY===true,outputTTY:process.stdout.isTTY===true,parentPid:process.ppid,fixtureEnv:process.env.AWB_LAUNCH_FIXTURE}));\n`);
  const shim = path.join(root, 'fixture.cmd');
  fs.writeFileSync(shim, `@echo off\n"${process.execPath}" "%~dp0fixture.cjs" %*\n`);
  const args = ['argument with spaces', "literal'apostrophe"];
  const result = await launchTerminal({ executable: shim, args, cwd,
    env: { AWB_LAUNCH_PROBE_PATH: proof, AWB_LAUNCH_FIXTURE: 'inherited-fixture-only' } });
  if (result?.terminalPid) owned.add(result.terminalPid);
  if (result?.launcherPid) owned.add(result.launcherPid);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(proof) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(proof), 'the isolated command must actually run');
  const actual = JSON.parse(fs.readFileSync(proof, 'utf8'));
  owned.add(actual.parentPid);
  console.log(JSON.stringify({ launcherProof: { inputTTY: actual.inputTTY, outputTTY: actual.outputTTY,
    cwdMatches: actual.cwd === cwd, argsMatch: JSON.stringify(actual.args) === JSON.stringify(args),
    inheritedFixtureEnv: actual.fixtureEnv === 'inherited-fixture-only', terminalReady: result?.terminalReady === true,
    terminalPid: result?.terminalPid, fixtureParentPid: actual.parentPid } }));
  assert.equal(actual.inputTTY, true); assert.equal(actual.outputTTY, true);
  assert.equal(actual.cwd, cwd); assert.deepEqual(actual.args, args);
  assert.equal(actual.fixtureEnv, 'inherited-fixture-only');
  assert.equal(result?.terminalReady, true);
});
