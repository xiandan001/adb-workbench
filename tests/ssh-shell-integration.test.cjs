const test = require('node:test');
const assert = require('node:assert/strict');
const { createSshShellIntegration, buildBashIntegrationScript } = require('../electron/lib/ssh-shell-integration.cjs');

const nonce = 'a'.repeat(64);
const mark = (kind, value = '', token = nonce) => Buffer.from(`\x1b]7777;AWB;${token};${kind}${value ? ';' + value : ''}\x07`);
function fixture() {
  const data = []; const markers = []; const commands = [];
  const integration = createSshShellIntegration({ onData: bytes => data.push(Buffer.from(bytes)),
    onMarker: value => markers.push(value), onCommand: command => commands.push(command) });
  integration.start(nonce);
  return { integration, data, markers, commands };
}
test('nonce-verified Bash markers are consumed across all byte boundaries and raw output is unchanged', () => {
  const h = fixture();
  const wire = Buffer.concat([Buffer.from('hello'), mark('R'), mark('A'), Buffer.from('user$ '), mark('B'), Buffer.from('echo ok'), mark('C'), mark('E', Buffer.from('echo ok').toString('hex')), Buffer.from('\r\nok\r\n'), mark('D'), mark('A'), Buffer.from('user$ '), mark('B')]);
  for (const byte of wire) h.integration.feed(Buffer.from([byte]));
  assert.equal(Buffer.concat(h.data).toString(), 'hellouser$ echo ok\r\nok\r\nuser$ ');
  assert.deepEqual(h.commands, ['echo ok']);
  assert.deepEqual(h.markers.map(x => x.kind), ['prompt-start', 'prompt', 'running', 'prompt-start', 'prompt']);
  assert.equal(h.integration.snapshot().phase, 'prompt');
  assert.equal(h.integration.snapshot().promptId, 2);
  assert.ok(!JSON.stringify(h.integration.snapshot()).includes(nonce));
});
test('raw TX is not an input to command capture; forged, replayed and out-of-order markers never learn', () => {
  const h = fixture();
  h.integration.feed(Buffer.concat([mark('R'), mark('A'), mark('B'), Buffer.from('Password: hidden\r\n'), mark('E', '736563726574'), mark('C'), mark('E', '66616b65', 'b'.repeat(64))]));
  assert.deepEqual(h.commands, []);
  h.integration.feed(mark('E', Buffer.from('sudo true').toString('hex')));
  h.integration.feed(mark('E', Buffer.from('a-password').toString('hex')));
  assert.deepEqual(h.commands, ['sudo true']);
});
test('disabled integration continues stripping private nonce markers without recording commands', () => {
  const h = fixture(); h.integration.feed(Buffer.concat([mark('R'), mark('A'), mark('B')]));
  h.integration.disable();
  h.integration.feed(Buffer.concat([mark('C'), mark('E', '736563726574'), Buffer.from('visible'), mark('A'), mark('B')]));
  assert.equal(Buffer.concat(h.data).toString(), 'visible');
  assert.deepEqual(h.commands, []);
  assert.equal(h.integration.snapshot().status, 'disabled');
});
test('oversized private OSC and malformed command payloads are bounded and fail closed', () => {
  const h = fixture(); h.integration.feed(Buffer.concat([mark('R'), mark('A'), mark('B'), mark('C')]));
  h.integration.feed(Buffer.from(`\x1b]7777;AWB;${nonce};E;${'a'.repeat(100000)}\x07ok`));
  h.integration.feed(mark('E', 'ff'));
  assert.equal(Buffer.concat(h.data).toString(), 'ok');
  assert.deepEqual(h.commands, []);
  assert.ok(h.integration.pendingBytes() <= 16 * 1024);
});
test('unsupported Bash reports a fixed non-secret error and script keeps existing shell hooks', () => {
  const h = fixture(); h.integration.feed(mark('X'));
  assert.equal(h.integration.snapshot().status, 'unsupported');
  assert.equal(h.integration.snapshot().phase, 'unknown');
  const script = buildBashIntegrationScript(nonce);
  assert.ok(script.includes(nonce));
  assert.match(script, /BASH_VERSINFO/);
  assert.match(script, /READLINE_LINE/);
  assert.match(script, /HISTIGNORE/);
  assert.doesNotMatch(script, /__awb_shell_base/);
  assert.match(script, /PROMPT_COMMAND/);
  assert.doesNotMatch(script, /\.bashrc|\.bash_history|stty|trap .*DEBUG/);
});
test('high-bit nonce lookalikes and standard OSC cannot authenticate a private marker', () => {
  const h = fixture();
  const high = mark('R'); high[PREFIX_LENGTH()] |= 0x80;
  h.integration.feed(high);
  assert.equal(h.integration.snapshot().status, 'enabling');
  const standard = Buffer.from('\x1b]633;B\x07title\x1b]0;terminal\x1b\\');
  h.integration.feed(standard);
  assert.equal(Buffer.concat(h.data).toString(), standard.toString());
  assert.deepEqual(h.markers, []);
});
function PREFIX_LENGTH() { return Buffer.byteLength('\x1b]7777;AWB;'); }

test('Readline redisplay with the same prompt serial does not create a new prompt or command gate', () => {
  const h = fixture();
  h.integration.feed(Buffer.concat([mark('R'), mark('A', '1'), Buffer.from('user$ '), mark('B', '1')]));
  h.integration.feed(Buffer.concat([mark('A', '1'), Buffer.from('user$ typed'), mark('B', '1')]));
  assert.equal(h.integration.snapshot().promptId, 1);
  assert.deepEqual(h.markers.map(item => item.kind), ['prompt-start', 'prompt']);
  h.integration.feed(Buffer.concat([mark('C'), mark('E', Buffer.from('read -s answer').toString('hex'))]));
  h.integration.feed(Buffer.concat([mark('A', '1'), mark('B', '1'), mark('C'), mark('E', Buffer.from('password-answer').toString('hex'))]));
  assert.equal(h.integration.snapshot().phase, 'running');
  assert.equal(h.integration.snapshot().promptId, 1);
  assert.deepEqual(h.commands, ['read -s answer']);
  h.integration.feed(Buffer.concat([mark('D'), mark('A', '2'), Buffer.from('user$ '), mark('B', '2')]));
  assert.equal(h.integration.snapshot().promptId, 2);
  assert.equal(h.integration.snapshot().phase, 'prompt');
});

test('serialized prompt boundaries reject mismatched, older, malformed and unnumbered redisplay markers', () => {
  const h = fixture();
  h.integration.feed(Buffer.concat([mark('R'), mark('A', '2'), mark('B', '3')]));
  assert.equal(h.integration.snapshot().promptId, 0);
  h.integration.feed(mark('B', '2'));
  for (const value of ['1', '2', '0', '-1', '1.5', '9007199254740992']) h.integration.feed(Buffer.concat([mark('A', value), mark('B', value)]));
  h.integration.feed(Buffer.concat([mark('A'), mark('B')]));
  assert.equal(h.integration.snapshot().promptId, 1);
  h.integration.feed(Buffer.concat([mark('C'), mark('A', '3'), mark('B', '3')]));
  assert.equal(h.integration.snapshot().phase, 'running');
  assert.equal(h.integration.snapshot().promptId, 1);
});
