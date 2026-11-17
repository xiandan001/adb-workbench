const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createApplicationLogSession } = require('../electron/lib/application-log-session.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-log-loss-'));
  const session = createApplicationLogSession({ directory, metadata: { version: '4.7.19' } });
  t.after(async () => { await session.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, session };
}
test('accepted rich code rows beyond the former 2048-character parser bound survive restart with their original capture version', async t => {
  const { directory, session } = await fixture(t); await session.start();
  session.record({ source: 'code', event: 'console', origin: 'main', level: 'error', message: 'x'.repeat(3500) + 'RICH_ROW_END_MARKER', stack: '    at electron/lib/source.cjs:42:7\n'.repeat(70) });
  await session.stop();
  const restored = createApplicationLogSession({ directory, metadata: { version: '4.7.31' } }); t.after(() => restored.dispose());
  assert.equal((await restored.status()).captureVersion, '4.7.19');
  const text = await restored.text(); assert.ok(text.includes('RICH_ROW_END_MARKER'));
  assert.ok(text.trim().split('\n').some(line => line.length > 2048));
  assert.match(text, /electron\/lib\/source\.cjs:42:7/);
});
test('line, queue, rate and intentionally excluded output counters survive export without claiming a complete recording', async t => {
  const { session } = await fixture(t); await session.start();
  session.record({ source: 'code', event: 'console', message: 'x'.repeat(256 * 1024) });
  session.noteLoss('sensitive-output', 2);
  for (let index = 0; index < 150; index++) session.record({ source: 'code', event: 'console', message: 'x'.repeat(4096), stack: 'x'.repeat(8192) });
  await session.status();
  for (let index = 0; index < 150; index++) session.record({ source: 'app', event: 'ready' });
  const status = await session.stop(), footer = JSON.parse((await session.text()).trim().split('\n').at(-1));
  assert.ok(status.losses.textTruncated > 0); assert.ok(status.losses.queueLimited > 0); assert.ok(status.losses.rateLimited > 0);
  assert.equal(status.losses.sensitiveOutput, 2); assert.ok(status.dropped > 0);
  assert.deepEqual(footer.losses, status.losses);
});
test('discarded malformed or oversized historical rows are disclosed and their original source bytes are never overwritten', async t => {
  const { directory, session } = await fixture(t); await session.status();
  const time = new Date().toISOString(), original = [JSON.stringify({ time, source: 'session', event: 'start', version: '4.7.19' }),
    'MALFORMED_PRIVATE'.repeat(10000), JSON.stringify({ time, source: 'app', event: 'ready' }), JSON.stringify({ time, source: 'session', event: 'stop', reason: 'manual' })].join('\n') + '\n';
  const file = path.join(directory, 'capture.log'); await fs.writeFile(file, original);
  const restored = createApplicationLogSession({ directory }); t.after(() => restored.dispose());
  assert.ok((await restored.status()).losses.recovery > 0);
  const text = await restored.text(); assert.ok(JSON.parse(text.trim().split('\n').at(-1)).losses.recovery > 0);
  assert.doesNotMatch(text, /MALFORMED_PRIVATE/); assert.equal(await fs.readFile(file, 'utf8'), original);
});
