import test from 'node:test';
import assert from 'node:assert/strict';
import { splitTerminalInput, mapTerminalKey, prepareTerminalPaste, normalizeTerminalNewlines, localEchoTerminalInput } from '../src/shared/serialTerminalInput.js';
import { createSerialTerminalWriter, createSerialTerminalReader } from '../src/shared/serialTerminalTransport.js';

const bytes = value => new TextEncoder().encode(value).length;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('terminal UTF-8 batches remain <=512 bytes and preserve Unicode/control input exactly', () => {
  const input = '中'.repeat(200) + '🙂' + '\t\r\x1b[A\x03\x04\x1a';
  const chunks = splitTerminalInput(input);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every(chunk => bytes(chunk) <= 512));
  assert.equal(bytes(chunks[0]), 510);
  assert.deepEqual(splitTerminalInput(''), []);
  assert.throws(() => splitTerminalInput('x'.repeat(65537)), /64 KiB/);
});

test('terminal key mapping affects only ordinary Enter and Backspace', () => {
  assert.equal(mapTerminalKey('\r', { key: 'Enter' }, { enter: 'cr' }), '\r');
  assert.equal(mapTerminalKey('\r', { key: 'Enter' }, { enter: 'lf' }), '\n');
  assert.equal(mapTerminalKey('\r', { key: 'Enter' }, { enter: 'crlf' }), '\r\n');
  assert.equal(mapTerminalKey('\x7f', { key: 'Backspace' }, { backspace: 'bs' }), '\x08');
  assert.equal(mapTerminalKey('\x08', { key: 'Backspace' }, { backspace: 'del' }), '\x7f');
  for (const value of ['\t', '\x1b[A', '\x1bOD', '\x03', '\x04', '\x1a']) assert.equal(mapTerminalKey(value, { key: 'c', ctrlKey: true }, {}), value);
  assert.equal(mapTerminalKey('\r', { key: 'm', ctrlKey: true }, { enter: 'lf' }), '\r');
  assert.equal(mapTerminalKey('\x1bOM', { key: 'Enter' }, { enter: 'lf' }), '\x1bOM');
  assert.equal(mapTerminalKey('\x1b\x7f', { key: 'Backspace' }, { backspace: 'bs' }), '\x1b\x7f');
});

test('terminal paste confirms newlines/control characters and obeys both original/final byte limits', () => {
  assert.deepEqual(prepareTerminalPaste('pwd', 'cr'), { content: 'pwd', bytes: 3, requiresConfirmation: false });
  assert.deepEqual(prepareTerminalPaste('one\ntwo', 'crlf'), { content: 'one\r\ntwo', bytes: 8, requiresConfirmation: true });
  assert.equal(prepareTerminalPaste('one\ttwo', 'cr').requiresConfirmation, false);
  assert.equal(prepareTerminalPaste('\x1b[6n', 'cr').requiresConfirmation, true);
  assert.equal(prepareTerminalPaste('\u009b2J', 'cr').requiresConfirmation, true);
  assert.equal(localEchoTerminalInput('\u009b2J\u009d52;payload'), '\\x9B2J\\x9D52;payload');
  assert.throws(() => prepareTerminalPaste('x'.repeat(65537), 'cr'), /64 KiB/);
  assert.throws(() => prepareTerminalPaste('\n'.repeat(40000), 'crlf'), /64 KiB/);
  assert.equal(normalizeTerminalNewlines('a\r\nb\nc\r', 'lf'), 'a\nb\nc\n');
  assert.equal(localEchoTerminalInput('a\r\n\x03\x1b[6n\x7f'), 'a\r\n^C\r\n^[[6n\b \b');
});

test('writer permits only one IPC at a time and Ctrl+C drops queued text without replay', async () => {
  const first = deferred();
  const writes = [];
  const writer = createSerialTerminalWriter({ sessionId: 's1', delayMs: 1000, write: async message => { writes.push(message); if (writes.length === 1) return first.promise; return { success: true, bytes: bytes(message.content) }; } });
  writer.enqueue('x'.repeat(1024));
  const running = writer.flush();
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(bytes(writes[0].content), 512);
  assert.equal(writer.state().queuedBytes, 1024);
  writer.enqueue('never-sent');
  writer.interrupt();
  first.resolve({ success: true, bytes: 512 });
  await running;
  assert.deepEqual(writes.map(item => item.content), ['x'.repeat(512), '\x03']);
  assert.equal(writer.state().queuedBytes, 0);
  writer.dispose();
});

test('writer overflow/failure pauses, clears old input and requires explicit resume', async () => {
  const errors = [];
  const writes = [];
  const writer = createSerialTerminalWriter({ sessionId: 's1', delayMs: 1000, onError: message => errors.push(message), write: async message => { writes.push(message.content); return { success: false, error: 'write failed' }; } });
  assert.equal(writer.enqueue('x'.repeat(65537)), false);
  assert.equal(writer.state().paused, true);
  assert.equal(writer.enqueue('discard'), false);
  assert.equal(writer.resume(), true);
  writer.enqueue('new');
  await writer.flush();
  assert.deepEqual(writes, ['new']);
  assert.equal(writer.state().paused, true);
  assert.equal(writer.state().queuedBytes, 0);
  assert.equal(errors.length, 2);
  writer.dispose();
});

test('writer disposal discards queued text and ignores an old write completion', async () => {
  const pending = deferred();
  const sent = [];
  let calls = 0;
  const writer = createSerialTerminalWriter({ sessionId: 'old', delayMs: 1000, write: () => { calls++; return pending.promise; }, onSent: content => sent.push(content) });
  writer.enqueue('x'.repeat(1024));
  const running = writer.flush();
  await tick();
  writer.dispose();
  pending.resolve({ success: true, bytes: 512 });
  await running;
  assert.equal(calls, 1);
  assert.deepEqual(sent, []);
  assert.equal(writer.enqueue('stale'), false);
});

test('accepted terminal paste finishes on its original session after switching views', async () => {
  const first = deferred();
  const writes = [];
  let activeView = 'terminal';
  const writer = createSerialTerminalWriter({ sessionId: 'terminal-COM17', delayMs: 1000,
    canWrite: () => true,
    write: async message => { writes.push(message); if (writes.length === 1) return first.promise; return { success: true, bytes: bytes(message.content) }; } });
  const acceptUserInput = content => activeView === 'terminal' && writer.enqueue(content);
  const paste = 'a'.repeat(1500) + '\r';
  assert.equal(acceptUserInput(paste), true);
  const running = writer.flush();
  await tick();
  activeView = 'rs232';
  assert.equal(acceptUserInput('hidden-new-input'), false);
  first.resolve({ success: true, bytes: 512 });
  await running;
  assert.equal(writes.map(item => item.content).join(''), paste);
  assert.ok(writes.every(item => item.sessionId === 'terminal-COM17'));
  assert.equal(writer.state().queuedBytes, 0);
  writer.dispose();
});

test('writer schedules text enqueued between drain completion and promise cleanup', async () => {
  const writes = [];
  const writer = createSerialTerminalWriter({ sessionId: 's1', delayMs: 0,
    write: async message => { writes.push(message.content); return { success: true, bytes: bytes(message.content) }; },
    onSent: content => { if (content === 'first') queueMicrotask(() => writer.enqueue('next')); } });
  writer.enqueue('first');
  await writer.flush();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(writes, ['first', 'next']);
  writer.dispose();
});

test('writer does not join isolated surrogates from different input events into new bytes', async () => {
  const writes = [];
  const writer = createSerialTerminalWriter({ sessionId: 's1', delayMs: 1000,
    write: async message => { writes.push(message.content); return { success: true, bytes: bytes(message.content) }; } });
  writer.enqueue('\ud83d');
  writer.enqueue('\ude42');
  await writer.flush();
  assert.deepEqual(writes, ['\ufffd\ufffd']);
  assert.equal(writer.state().paused, false);
  writer.dispose();
});

test('reader waits for terminal display acknowledgement and reports a truncated raw cursor', async () => {
  const rendered = deferred();
  const requests = [];
  const displayed = [];
  const truncated = [];
  const replay = [];
  const scheduled = [];
  const reader = createSerialTerminalReader({ sessionId: 's1', schedule: callback => { scheduled.push(callback); return callback; }, cancel: () => {},
    read: async request => { requests.push(request); return requests.length === 1
      ? { success: true, sessionId: 's1', startOffset: 2, endOffset: 5, nextOffset: 5, hex: '414243', truncated: true }
      : { success: true, sessionId: 's1', startOffset: 2, endOffset: 6, nextOffset: 6, hex: '44', truncated: false }; },
    write: async (data, replaying) => { displayed.push({ bytes: [...data], replaying }); if (displayed.length === 1) await rendered.promise; },
    onTruncated: value => truncated.push(value), onReplayChange: value => replay.push(value) });
  reader.start();
  await tick();
  assert.equal(requests.length, 1);
  assert.equal(scheduled.length, 0, 'cannot poll before xterm write callback');
  assert.deepEqual(displayed[0], { bytes: [65, 66, 67], replaying: true });
  rendered.resolve();
  await tick();
  assert.equal(reader.state().offset, 5);
  assert.equal(truncated.length, 1);
  assert.deepEqual(replay, [true, false]);
  scheduled.shift()();
  await tick();
  assert.equal(requests[1].offset, 5);
  assert.deepEqual(displayed[1], { bytes: [68], replaying: false });
  reader.dispose();
});

test('reader pause/dispose prevents stale output and session changes fail closed', async () => {
  const response = deferred();
  const errors = [];
  const displayed = [];
  const reader = createSerialTerminalReader({ sessionId: 's1', read: () => response.promise, write: data => displayed.push(data), onError: message => errors.push(message) });
  reader.start();
  reader.pause();
  response.resolve({ success: true, sessionId: 's1', startOffset: 0, endOffset: 1, nextOffset: 1, hex: '41' });
  await tick();
  assert.deepEqual(displayed, []);
  assert.equal(reader.state().offset, 0);
  reader.dispose();
  const wrong = createSerialTerminalReader({ sessionId: 's1', read: async () => ({ success: true, sessionId: 'other', startOffset: 0, endOffset: 0, nextOffset: 0, hex: '' }), write: data => displayed.push(data), onError: message => errors.push(message) });
  wrong.start();
  await tick();
  assert.equal(errors.length, 1);
  assert.deepEqual(displayed, []);
  wrong.dispose();
});

test('reader treats resumed backlog as readonly replay and returns to live only after catch-up', async () => {
  const scheduled = [];
  const writes = [];
  let calls = 0;
  const reader = createSerialTerminalReader({ sessionId: 's1', schedule: callback => { scheduled.push(callback); return callback; }, cancel: () => {},
    read: async () => ++calls === 1 ? { success: true, sessionId: 's1', startOffset: 0, endOffset: 0, nextOffset: 0, hex: '' }
      : calls === 2 ? { success: true, sessionId: 's1', startOffset: 0, endOffset: 4, nextOffset: 4, hex: '1b5b366e' }
        : { success: true, sessionId: 's1', startOffset: 0, endOffset: 5, nextOffset: 5, hex: '41' },
    write: async (_bytes, replaying) => writes.push(replaying) });
  reader.start(); await tick();
  reader.pause(); reader.start(); await tick();
  assert.deepEqual(writes, [true]);
  assert.equal(reader.state().replaying, false);
  scheduled.at(-1)(); await tick();
  assert.deepEqual(writes, [true, false]);
  reader.dispose();
});

test('reader ignores an old pending read after pause/resume before allowing live responses', async () => {
  const pending = deferred();
  const scheduled = [];
  const writes = [];
  let calls = 0;
  const reader = createSerialTerminalReader({ sessionId: 's1', schedule: callback => { scheduled.push(callback); return callback; }, cancel: () => {},
    read: async () => ++calls === 1 ? pending.promise : { success: true, sessionId: 's1', startOffset: 0, endOffset: 4, nextOffset: 4, hex: '1b5b366e' },
    write: async (_bytes, replaying) => writes.push(replaying) });
  reader.start(); reader.pause(); reader.start();
  pending.resolve({ success: true, sessionId: 's1', startOffset: 0, endOffset: 0, nextOffset: 0, hex: '' });
  await tick();
  assert.equal(reader.state().replaying, true);
  assert.deepEqual(writes, []);
  scheduled.at(-1)(); await tick();
  assert.deepEqual(writes, [true]);
  reader.dispose();
});

test('reader acknowledges an old displayed batch without ending a newer replay boundary', async () => {
  const rendered = deferred();
  const scheduled = [];
  const writes = [];
  const offsets = [];
  const reader = createSerialTerminalReader({ sessionId: 's1', schedule: callback => { scheduled.push(callback); return callback; }, cancel: () => {},
    read: async args => { offsets.push(args.offset); return offsets.length === 1
      ? { success: true, sessionId: 's1', startOffset: 0, endOffset: 1, nextOffset: 1, hex: '41' }
      : { success: true, sessionId: 's1', startOffset: 0, endOffset: 5, nextOffset: 5, hex: '1b5b366e' }; },
    write: async (_bytes, replaying) => { writes.push(replaying); if (writes.length === 1) await rendered.promise; } });
  reader.start(); await tick();
  reader.pause(); reader.start();
  rendered.resolve(); await tick();
  assert.equal(reader.state().offset, 1);
  assert.equal(reader.state().replaying, true);
  scheduled.at(-1)(); await tick();
  assert.deepEqual(offsets, [0, 1]);
  assert.deepEqual(writes, [true, true]);
  assert.equal(reader.state().replaying, false);
  reader.dispose();
});
