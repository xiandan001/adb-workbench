const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createSshShellIntegration, buildBashIntegrationScript } = require('../electron/lib/ssh-shell-integration.cjs');

const bash = process.platform === 'win32' ? 'D:/AppStore/Git/bin/bash.exe' : '/bin/bash';
async function runBash(t, commands, setup = '', beforeIntegration = []) {
  const available = await fs.access(bash).then(() => true, () => false);
  if (!available) { t.skip('Isolated Bash executable is unavailable'); return null; }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adb-ssh-shell-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('adb-ssh-shell-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const nonce = 'd'.repeat(64); const asset = path.join(directory, 'integration.bash');
  await fs.writeFile(asset, buildBashIntegrationScript(nonce), { flag: 'wx' });
  const collected = []; const output = []; const states = [];
  const integration = createSshShellIntegration({ onData: data => output.push(Buffer.from(data)), onCommand: text => collected.push(text), onChange: state => states.push(state) });
  integration.start(nonce);
  const child = spawn(bash, ['--noprofile', '--norc', '-c', 'exec /usr/bin/bash --noprofile --norc -i 2>&1'],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, HISTFILE: path.join(directory, 'history'), INPUTRC: '/dev/null', BASH_ENV: '/dev/null', ENV: '/dev/null' } });
  child.stdout.on('data', data => integration.feed(data)); child.stderr.on('data', data => output.push(data));
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
  // Git Bash forks are slower during parallel Windows packaging/test runs.
  // Bound the whole multi-command fixture, not the application's startup timeout.
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; child.kill(); }, process.platform === 'win32' ? 30000 : 10000);
  t.after(() => { clearTimeout(timeout); child.kill(); });
  const quoted = asset.replaceAll('\\', '/').replaceAll("'", "'\\''");
  child.stdin.end(["HISTCONTROL=ignorespace:ignoredups; HISTIGNORE='echo ignored'; PS1='TEST> '; PS0='OLDPS0'; " + (setup || ':'), ...beforeIntegration, ` . '${quoted}'`, ...commands, 'exit', ''].join('\n'));
  const code = await done; clearTimeout(timeout);
  assert.equal(timedOut, false, 'Isolated Bash fixture exceeded its execution deadline');
  assert.equal(code, 0);
  return { collected, output: Buffer.concat(output).toString(), states };
}
test('real Bash records only new submitted shell commands, never ignored or silent read input', async t => {
  const result = await runBash(t, ['echo visible', ' echo leading-secret', 'echo ignored', 'echo duplicate', 'echo duplicate', 'read -s answer', 'sudo-password-secret', 'printf "中文\\n"']);
  if (!result) return;
  assert.deepEqual(result.collected, ['echo visible', 'echo duplicate', 'echo duplicate', 'read -s answer', 'printf "中文\\n"', 'exit']);
  assert.ok(!JSON.stringify(result.collected).includes('sudo-password-secret'));
  assert.match(result.output, /OLDPS0/);
  assert.ok(result.states.some(state => state.phase === 'prompt'));
});
test('real Bash preserves PROMPT_COMMAND array once per prompt and original exit status', async t => {
  const result = await runBash(t, ['false', 'echo checked'], "PROMPT_COMMAND=('builtin printf \"HOOK1:%s\\n\" \"$?\"' 'builtin printf \"HOOK2\\n\"')");
  if (!result) return;
  assert.match(result.output, /HOOK1:1/);
  assert.equal(result.output.split('\n').filter(line => line === 'HOOK2').length, 4);
  assert.deepEqual(result.collected, ['false', 'echo checked', 'exit']);
});
test('real Bash history disabled never reuses a previous accepted command', async t => {
  const result = await runBash(t, ['echo before', 'set +o history', 'echo not-recorded', 'read -s answer', 'private-answer', 'set -o history', 'echo after']);
  if (!result) return;
  assert.deepEqual(result.collected, ['echo before', 'set +o history', 'echo after', 'exit']);
});
test('real Bash preserves command leading whitespace even when HISTCONTROL would save it', async t => {
  const result = await runBash(t, [' printf "leading-secret\\n"', 'echo public'], "HISTCONTROL=''; HISTIGNORE=''");
  if (!result) return;
  assert.deepEqual(result.collected, ['echo public', 'exit']);
  assert.match(result.output, /leading-secret/);
});
test('real nested interactive shell input is not mistaken for outer integrated Bash commands', async t => {
  const result = await runBash(t, ['/usr/bin/bash --noprofile --norc -i', 'echo nested-private-input', 'exit', 'echo outer-again']);
  if (!result) return;
  assert.deepEqual(result.collected, ['/usr/bin/bash --noprofile --norc -i', 'echo outer-again', 'exit']);
  assert.match(result.output, /nested-private-input/);
});

test('Readline captures repeats already in history before enable with ignoreboth and erasedups', async t => {
  for (const control of ['ignoreboth', 'ignorespace:erasedups']) {
    const result = await runBash(t, ['echo repeat-before', 'echo repeat-before'], `HISTCONTROL=${control}; HISTIGNORE=''`, ['echo repeat-before']);
    if (!result) return;
    assert.deepEqual(result.collected, ['echo repeat-before', 'echo repeat-before', 'exit']);
  }
});
test('Readline capture works with zero HISTSIZE and preserves configured history settings', async t => {
  const command = 'printf "CONFIG:%s:%s:%s\\n" "$HISTSIZE" "$HISTCONTROL" "$HISTIGNORE"';
  const result = await runBash(t, ['echo zero-size', 'echo zero-size', command], "HISTSIZE=0; HISTCONTROL=ignoreboth; HISTIGNORE='echo ignored'");
  if (!result) return;
  assert.deepEqual(result.collected, ['echo zero-size', 'echo zero-size', command, 'exit']);
  assert.match(result.output, /CONFIG:0:ignoreboth:echo ignored/);
});
test('Readline keeps HISTIGNORE patterns and leading-space privacy without stale history fallback', async t => {
  const result = await runBash(t, ['echo public', 'echo private-one', 'printf "private-two\\n"', ' echo leading-private', 'echo public'], "HISTSIZE=0; HISTIGNORE='echo private*:printf*'");
  if (!result) return;
  assert.deepEqual(result.collected, ['echo public', 'echo public', 'exit']);
});
test('Readline never captures read-e answers, PS2 continuation fragments or history expansion text', async t => {
  const result = await runBash(t, ['read -e answer', 'readline-private-answer', "printf '%s\\n' '", "continuation-private'", 'echo after', '!!', 'echo final']);
  if (!result) return;
  assert.deepEqual(result.collected, ['read -e answer', 'echo after', 'echo final', 'exit']);
  assert.ok(!JSON.stringify(result.collected).includes('private'));
});
test('Readline preserves default emacs CR and CtrlJ and default vi insert/command submission', async t => {
  for (const mode of ['emacs', 'vi']) {
    const result = await runBash(t, ['echo cr\r', 'echo lf', ...(mode === 'vi' ? ['echo vi-command\x1b'] : [])], `set -o ${mode}`);
    if (!result) return;
    assert.deepEqual(result.collected, ['echo cr', 'echo lf', ...(mode === 'vi' ? ['echo vi-command'] : []), 'exit']);
  }
});
test('custom Enter binding fails closed without overwriting it or reporting ready', async t => {
  const command = 'bind -m emacs-standard -p';
  const result = await runBash(t, [command], `bind -m emacs-standard '"\\C-m":backward-char'`);
  if (!result) return;
  assert.deepEqual(result.collected, []);
  assert.ok(result.states.some(state => state.status === 'unsupported'));
  assert.ok(!result.states.some(state => state.status === 'ready'));
  assert.match(result.output, /"\\C-m": backward-char/);
});

test('Readline honors explicit HISTIGNORE previous-line and extended glob privacy rules', async t => {
  const result = await runBash(t, ['echo same', 'echo new', 'echo new', 'echo secret', 'echo public'], "HISTIGNORE='&:echo @(secret|private)'; shopt -s extglob", ['echo same']);
  if (!result) return;
  assert.deepEqual(result.collected, ['echo new', 'echo public', 'exit']);
});
test('Readline preserves previous exit status and records a compound line exactly once', async t => {
  const command = 'printf "FIRST:%s\\n" "$?"; printf "SECOND\\n"';
  const result = await runBash(t, ['false', command, 'echo after']);
  if (!result) return;
  assert.deepEqual(result.collected, ['false', command, 'echo after', 'exit']);
  assert.match(result.output, /FIRST:1/);
});
test('Readline does not overwrite a reserved-key macro or record ambiguous history pattern inputs', async t => {
  const conflict = await runBash(t, ['echo still-native'], `bind -m emacs-standard '"\\e[999;1~":"existing-macro"'`);
  if (!conflict) return;
  assert.ok(conflict.states.some(state => state.status === 'unsupported'));
  assert.deepEqual(conflict.collected, []);
  assert.match(conflict.output, /still-native/);
  const ambiguous = await runBash(t, ['echo safely-ignored'], "HISTIGNORE='echo \\&' ");
  assert.deepEqual(ambiguous.collected, []);
});
test('Readline refuses a user binding on an ancestor of its private sequence', async t => {
  const result = await runBash(t, ['echo remains-native', 'bind -m emacs-standard -s'], `bind -m emacs-standard '"\\e[999":"existing-prefix"'`);
  if (!result) return;
  assert.ok(result.states.some(state => state.status === 'unsupported'));
  assert.ok(!result.states.some(state => state.status === 'ready'));
  assert.deepEqual(result.collected, []);
  assert.match(result.output, /"\\e\[999": "existing-prefix"/);
});
test('Readline submit redisplay does not advance the prompt counter before command completion', async t => {
  const result = await runBash(t, ['echo first', 'echo second', 'echo third']);
  if (!result) return;
  assert.deepEqual(result.collected, ['echo first', 'echo second', 'echo third', 'exit']);
  assert.deepEqual(result.states.filter(state => state.phase === 'prompt').map(state => state.promptId), [1, 2, 3, 4]);
});
