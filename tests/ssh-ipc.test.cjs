const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSshController } = require('../electron/lib/ssh-controller.cjs');

function fixture(t, { openDirectoryResult = '' } = {}) {
  const handlers = new Map(); const calls = []; const mainFrame = {};
  const sender = Object.assign(new EventEmitter(), { mainFrame, isDestroyed: () => false, setIgnoreMenuShortcuts: value => calls.push(['menu-ignore', value]) });
  const owner = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: sender });
  const state = [{ id: 'a', name: '主机 A', host: 'host-a', username: 'u', port: 22, status: 'connected', terminals: [{ id: 'ta', title: '终端 1', status: 'ready' }] },
    { id: 'b', name: '主机 B', host: 'host-b', username: 'u', port: 22, status: 'connected', terminals: [] }];
  const transfers = []; let response = 0;
  const profiles = { list: () => [{ id: 'profile', name: 'test', hasSavedCredential: true }],
    resolve: args => ({ host: 'host-a', username: 'u', password: args.credential?.password || 'stored' }), save: () => ({ id: 'profile' }), remove: id => calls.push(['remove', id]) };
  const sessions = { snapshot: () => ({ sessions: state }), needsQuitConfirmation: () => state.some(item => item.status === 'connected'),
    connect: async args => { calls.push(['connect', args.config]); return { sessionId: 'a' }; },
    disconnect: async args => { calls.push(['disconnect', args.sessionId]); state.find(s => s.id === args.sessionId).status = 'disconnected'; },
    removeSession: async args => { calls.push(['remove-session', args.sessionId]); state.splice(state.findIndex(s => s.id === args.sessionId), 1); },
    closeTerminal: async args => { calls.push(['close-terminal', args.terminalId]); },
    terminalWrite: async args => { calls.push(['write', args]); return { bytes: args.content.length }; },
    dispose: async () => {} };
  const files = { listTransfers: () => transfers,
    list: async args => ({ sessionId: args.sessionId, path: '/', entries: [] }),
    planDelete: async args => { calls.push(['plan', args]); return { planId: 'one-use' }; },
    confirmDelete: async args => { calls.push(['delete', args]); return {}; },
    startTransfer: async args => { calls.push(['transfer', args]); return { transferId: 't' }; },
    retryTransfer: async args => { calls.push(['retry', args]); return { transferId: 't' }; },
    disposeSession: async id => calls.push(['dispose-files', id]), dispose: async () => {},
    saveDocument: async args => { calls.push(['save', args]); return { revision: 'v2' }; } };
  const dialogs = { ask: async options => { calls.push(['ask', options]); return { response }; }, open: async () => ({ canceled: true }) };
  const historyCalls = []; const historyEntries = new Map(); const pauses = new Map();
  const keyOf = identity => JSON.stringify(identity);
  const history = {
    list: identity => ({ entries: historyEntries.get(keyOf(identity)) || [], paused: pauses.get(keyOf(identity)) || false, persistent: true }),
    record: (identity, command) => { historyCalls.push(['record', identity, command]); if (pauses.get(keyOf(identity))) return { recorded: false }; historyEntries.set(keyOf(identity), [{ id: 'entry-1', command, lastUsed: 1, count: 1 }]); return { recorded: true }; },
    remove: (identity, id) => { historyCalls.push(['remove', identity, id]); historyEntries.set(keyOf(identity), []); },
    clear: identity => { historyCalls.push(['clear', identity]); historyEntries.set(keyOf(identity), []); },
    setPaused: (identity, paused) => { historyCalls.push(['pause', identity, paused]); pauses.set(keyOf(identity), paused); }
  };
  const published = [];
  const controller = createSshController({ sessions, files, profiles, history, getOwner: () => owner, dialogs,
    openLocalDirectory: async target => { calls.push(['open-directory', target]); return openDirectoryResult; },
    onPublish: data => published.push(data) });
  controller.register({ handle: (channel, action) => handlers.set(channel, action) });
  t.after(() => controller.dispose());
  const run = (name, args, event = { sender, senderFrame: mainFrame }) => handlers.get(`ssh:${name}`)(event, args);
  return { run, handlers, sender, mainFrame, owner, profiles, sessions, files, history, historyCalls, calls, state, transfers, dialogs, published, controller, answer: value => { response = value; } };
}
test('every SSH IPC rejects foreign windows and subframes before invoking any operation', async t => {
  const h = fixture(t);
  for (const [channel, handler] of h.handlers) {
    assert.equal((await handler({ sender: {} }, {})).success, false, channel);
    assert.equal((await handler({ sender: h.sender, senderFrame: {} }, {})).success, false, channel);
  }
  assert.deepEqual(h.calls, []);
});

test('transfer record clearing forwards IDs only and publishes the refreshed snapshot', async t => {
  const h = fixture(t);
  h.files.clearTransfer = args => { h.calls.push(['clear-one', args]); return { removedIds: [args.transferId] }; };
  h.files.clearTransfers = (...args) => { h.calls.push(['clear-all', args]); return { removedIds: ['old'] }; };
  await h.run('subscribe', { active: true });
  assert.deepEqual((await h.run('clear-transfer', { transferId: 'done', path: 'untrusted', deleteFiles: true })).removedIds, ['done']);
  assert.deepEqual(h.calls.find(([name]) => name === 'clear-one'), ['clear-one', { transferId: 'done' }]);
  assert.deepEqual((await h.run('clear-transfers', { deleteFiles: true })).removedIds, ['old']);
  assert.deepEqual(h.calls.find(([name]) => name === 'clear-all'), ['clear-all', []]);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.published.length, 1);
  assert.ok(!h.calls.some(([name]) => ['delete', 'dispose-files', 'disconnect', 'retry'].includes(name)));
});

test('completed local transfer location ignores supplied paths and remains usable after host removal', async t => {
  const h = fixture(t); h.state.splice(0);
  h.files.getTransferLocation = args => { h.calls.push(['location', args]); return { kind: 'local', sessionId: 'a', path: 'C:\\fixture\\Downloads' }; };
  const result = await h.run('open-transfer-location', { transferId: 'download', path: 'C:\\untrusted.exe', sessionId: 'b' });
  assert.equal(result.success, true); assert.equal(result.kind, 'local');
  assert.deepEqual(h.calls, [['location', { transferId: 'download' }], ['open-directory', 'C:\\fixture\\Downloads']]);
});

test('missing folders and failed native folder opening report errors without a shell fallback', async t => {
  const h = fixture(t, { openDirectoryResult: 'native launch failed' });
  h.files.getTransferLocation = () => ({ kind: 'local', sessionId: 'a', path: 'C:\\fixture' });
  assert.match((await h.run('open-transfer-location', { transferId: 'download' })).error, /无法打开/);
  h.files.getTransferLocation = () => { throw new Error('所在文件夹已移动或删除'); };
  assert.match((await h.run('open-transfer-location', { transferId: 'download' })).error, /已移动或删除/);
  assert.equal(h.calls.filter(([name]) => name === 'open-directory').length, 1);
});

test('remote transfer navigation validates its owning connection and folder without local launch', async t => {
  const h = fixture(t);
  h.files.getTransferLocation = () => ({ kind: 'remote', sessionId: 'b', path: '/data/packages' });
  h.files.list = async args => { h.calls.push(['list', args]); return { ...args, entries: [] }; };
  const result = await h.run('open-transfer-location', { transferId: 'upload', sessionId: 'a', path: '/untrusted' });
  assert.deepEqual(result, { success: true, kind: 'remote', sessionId: 'b', path: '/data/packages' });
  assert.deepEqual(h.calls, [['list', { sessionId: 'b', path: '/data/packages' }]]);
  h.state[1].status = 'disconnected';
  assert.equal((await h.run('open-transfer-location', { transferId: 'upload' })).success, false);
  h.state[1].status = 'connected'; h.files.list = async () => { h.state[1].status = 'disconnected'; return { path: '/data/packages' }; };
  assert.equal((await h.run('open-transfer-location', { transferId: 'upload' })).success, false);
});
test('snapshot and notifications contain no saved secrets; renderer cannot supply resolved config', async t => {
  const h = fixture(t);
  const result = await h.run('connect', { profileId: 'profile', config: { host: 'evil', password: 'injected' } });
  assert.equal(result.sessionId, 'a'); assert.equal(result.password, undefined);
  assert.equal(h.calls[0][1].host, 'host-a');
  assert.ok(!JSON.stringify(await h.run('snapshot')).includes('stored'));
  await h.run('subscribe', { active: true }); h.controller.publish();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(h.published.length, 1); assert.equal(h.published[0].revision > 0, true);
});
test('native delete cancellation never mutates; approval passes one-use main plan and captured session', async t => {
  const h = fixture(t);
  assert.equal((await h.run('delete', { sessionId: 'a', path: '/home/u/file', confirmed: true })).cancelled, true);
  assert.ok(!h.calls.some(([operation]) => operation === 'delete'));
  h.answer(1);
  assert.equal((await h.run('delete', { sessionId: 'b', path: '/home/u/file', planId: 'renderer-token' })).success, true);
  assert.deepEqual(h.calls.find(([operation]) => operation === 'delete')[1], { sessionId: 'b', planId: 'one-use' });
});
test('dirty drafts protect close and quit; disconnect of A leaves B unchanged', async t => {
  const h = fixture(t);
  await h.run('set-drafts', { sessionId: 'a', paths: ['/edited.conf'] });
  assert.equal((await h.run('close-session', { sessionId: 'a' })).cancelled, true);
  assert.equal(h.state.length, 2);
  assert.equal(await h.controller.confirmQuit(h.dialogs.ask), false);
  h.answer(1);
  await h.run('disconnect', { sessionId: 'a' });
  assert.equal(h.state[0].status, 'disconnected'); assert.equal(h.state[1].status, 'connected');
  assert.equal(h.state.length, 2);
  await h.run('close-session', { sessionId: 'a' });
  assert.equal(h.state.length, 1); assert.equal(h.state[0].id, 'b');
});
test('migration rejects active SSH and reserves new connections once idle', async t => {
  const h = fixture(t);
  assert.throws(() => h.controller.reserveForMigration(), /SSH/);
  h.state.forEach(session => { session.status = 'disconnected'; });
  const release = h.controller.reserveForMigration();
  assert.equal((await h.run('connect', { profileId: 'profile' })).success, false);
  assert.equal((await h.run('snapshot')).success, true);
  release(); assert.equal((await h.run('connect', { profileId: 'profile' })).success, true);
});
test('picker cancel does not transfer; uploads cannot enable renderer overwrite', async t => {
  const h = fixture(t);
  assert.equal((await h.run('upload', { sessionId: 'a', destination: '/home/u' })).cancelled, true);
  assert.equal(h.calls.length, 0);
  h.dialogs.open = async () => ({ canceled: false, filePaths: ['C:\\test\\fixture.txt'] });
  await h.run('upload', { sessionId: 'b', destination: '/tmp', overwrite: true });
  const args = h.calls.find(([op]) => op === 'transfer')[1];
  assert.equal(args.sessionId, 'b'); assert.equal(args.overwrite, false);
});
test('a conflict retry needs fresh native confirmation and cannot use renderer approval', async t => {
  const h = fixture(t);
  h.transfers.push({ id: 't', sessionId: 'b', source: 'a', target: 'b', status: 'conflict' });
  assert.equal((await h.run('retry-transfer', { transferId: 't', overwrite: true })).cancelled, true);
  assert.ok(!h.calls.some(([op]) => op === 'retry'));
  h.answer(1); await h.run('retry-transfer', { transferId: 't' });
  assert.deepEqual(h.calls.find(([op]) => op === 'retry')[1], { transferId: 't', overwrite: true });
});
test('closing a live terminal requires confirmation and does not touch sibling session', async t => {
  const h = fixture(t);
  assert.equal((await h.run('close-terminal', { sessionId: 'a', terminalId: 'ta' })).cancelled, true);
  h.answer(1); await h.run('close-terminal', { sessionId: 'a', terminalId: 'ta' });
  assert.equal(h.calls.filter(([op]) => op === 'close-terminal').length, 1);
  assert.equal(h.state[1].status, 'connected');
});
test('disconnect is blocked during remote mutation until its result is known', async t => {
  const h = fixture(t); let finish;
  h.files.saveDocument = () => new Promise(resolve => { finish = resolve; });
  const saving = h.run('save-document', { sessionId: 'a', documentId: 'doc', text: 'content' });
  assert.equal((await h.run('disconnect', { sessionId: 'a' })).success, false);
  finish({ revision: 'v2' }); await saving;
  assert.equal((await h.run('disconnect', { sessionId: 'a' })).success, true);
});

test('close confirmation holds a gate against racing file writes', async t => {
  const h = fixture(t); let answer;
  await h.run('set-drafts', { sessionId: 'a', paths: ['/draft'] });
  h.dialogs.ask = () => new Promise(resolve => { answer = resolve; });
  const closing = h.run('close-session', { sessionId: 'a' });
  assert.equal((await h.run('save-document', { sessionId: 'a', documentId: 'doc' })).success, false);
  h.dialogs.open = async () => ({ canceled: false, filePaths: ['C:\\fixture.txt'] });
  h.transfers.push({ id: 't', sessionId: 'a', status: 'failed' });
  for (const operation of ['upload', 'upload-dropped', 'download', 'retry-transfer', 'open-terminal']) {
    assert.equal((await h.run(operation, { sessionId: 'a', transferId: 't', destination: '/home/u', sources: ['/home/u/file'], paths: ['C:\\fixture.txt'] })).success, false, operation);
  }
  assert.ok(!h.calls.some(([operation]) => ['transfer', 'retry'].includes(operation)));
  answer({ response: 0 }); await closing;
  assert.equal((await h.run('save-document', { sessionId: 'a', documentId: 'doc' })).success, true);
});

test('an open file picker cannot start a transfer after close confirmation begins', async t => {
  const h = fixture(t); let select; let answer;
  h.dialogs.open = () => new Promise(resolve => { select = resolve; });
  const upload = h.run('upload', { sessionId: 'a', destination: '/tmp' });
  await h.run('set-drafts', { sessionId: 'a', paths: ['/draft'] });
  h.dialogs.ask = () => new Promise(resolve => { answer = resolve; });
  const closing = h.run('close-session', { sessionId: 'a' });
  select({ canceled: false, filePaths: ['C:\\fixture.txt'] });
  assert.equal((await upload).success, false);
  assert.ok(!h.calls.some(([operation]) => operation === 'transfer'));
  answer({ response: 0 }); await closing;
});

test('a pending connection participates in migration/quit guards before session publication', async t => {
  const h = fixture(t); let finish;
  h.state.forEach(session => { session.status = 'disconnected'; });
  h.sessions.connect = () => new Promise(resolve => { finish = resolve; });
  const connecting = h.run('connect', { profileId: 'profile' });
  assert.throws(() => h.controller.reserveForMigration(), /SSH/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.needsQuitConfirmation(), true);
  finish({ sessionId: 'new' }); await connecting;
  const release = h.controller.reserveForMigration(); release();
});

test('terminal traffic does not invalidate file-tree revisions', t => {
  const h = fixture(t);
  h.controller.publish(); h.controller.publish();
  assert.deepEqual(h.controller.snapshot().fileRevisions, {});
  h.controller.publish({ type: 'files-changed', sessionId: 'a', path: '/home' });
  h.controller.publish({ type: 'transfer', sessionId: 'a' });
  assert.deepEqual(h.controller.snapshot().fileRevisions, { a: 1 });
});

test('session cleanup still runs if transfer cleanup reports failure', async t => {
  const h = fixture(t); let sessionClosed = false;
  h.files.dispose = async () => { throw new Error('fixture cleanup failure'); };
  h.sessions.dispose = async () => { sessionClosed = true; };
  await assert.rejects(h.controller.dispose(), /cleanup failure/);
  assert.equal(sessionClosed, true);
  h.files.dispose = async () => {};
});

test('history is main-only, host-scoped and never part of terminal snapshots', async t => {
  const h = fixture(t);
  assert.equal(h.handlers.has('ssh:history-record'), false);
  await h.controller.recordShellCommand({ sessionId: 'a', terminalId: 'ta', host: 'injected-host', username: 'intruder', command: 'git status' });
  assert.deepEqual(h.historyCalls[0][1], { host: 'host-a', port: 22, username: 'u' });
  assert.equal((await h.run('history-list', { sessionId: 'a', host: 'host-b' })).entries[0].command, 'git status');
  assert.equal((await h.run('history-list', { sessionId: 'b' })).entries.length, 0);
  const snapshot = await h.run('snapshot');
  assert.ok(!JSON.stringify(snapshot).includes('git status'));
  assert.deepEqual(snapshot.historyRevisions, { a: 1 });
  await h.controller.recordShellCommand({ sessionId: 'b', terminalId: 'ta', command: 'wrong owner' });
  assert.equal(h.historyCalls.length, 1);
});

test('history clear requires native approval; pause and remove remain identity-scoped', async t => {
  const h = fixture(t);
  await h.controller.recordShellCommand({ sessionId: 'a', terminalId: 'ta', command: 'git status' });
  assert.equal((await h.run('history-clear', { sessionId: 'a', confirmed: true })).cancelled, true);
  assert.equal((await h.run('history-list', { sessionId: 'a' })).entries.length, 1);
  assert.equal((await h.run('history-pause', { sessionId: 'a', paused: true })).paused, true);
  assert.equal((await h.run('history-list', { sessionId: 'b' })).paused, false);
  assert.equal((await h.run('history-pause', { sessionId: 'a', paused: 'false' })).success, false);
  h.answer(1); assert.equal((await h.run('history-clear', { sessionId: 'a' })).entries.length, 0);
});

test('Bash initialization requires an explicit native action and revalidates the selected terminal', async t => {
  const h = fixture(t); const enabled = [];
  h.sessions.enableShellIntegration = async args => { enabled.push(args); return {}; };
  assert.equal((await h.run('enable-shell-integration', { sessionId: 'a', terminalId: 'ta', confirmed: true })).cancelled, true);
  assert.equal(enabled.length, 0);
  h.answer(1);
  assert.equal((await h.run('enable-shell-integration', { sessionId: 'a', terminalId: 'ta', command: 'not allowed' })).success, true);
  assert.deepEqual(enabled, [{ sessionId: 'a', terminalId: 'ta' }]);
  let finish;
  h.dialogs.ask = () => new Promise(resolve => { finish = resolve; });
  const pending = h.run('enable-shell-integration', { sessionId: 'a', terminalId: 'ta' });
  h.state[0].status = 'disconnected'; finish({ response: 1 });
  assert.equal((await pending).success, false); assert.equal(enabled.length, 1);
});

test('history storage failure does not interrupt terminal operations or expose command text', async t => {
  const h = fixture(t); h.history.record = () => { throw new Error('must-not-leak-command-content'); };
  await h.controller.recordShellCommand({ sessionId: 'a', terminalId: 'ta', command: 'private command' });
  const state = await h.run('history-list', { sessionId: 'a' });
  assert.match(state.warning, /保存未完成/); assert.ok(!state.warning.includes('must-not-leak'));
  assert.equal((await h.run('terminal-write', { sessionId: 'a', terminalId: 'ta', content: 'a' })).success, true);
});

test('already submitted commands can finish history capture while close confirmation is pending', async t => {
  const h = fixture(t); let finish;
  await h.run('set-drafts', { sessionId: 'a', paths: ['/draft'] });
  h.dialogs.ask = () => new Promise(resolve => { finish = resolve; });
  const closing = h.run('close-session', { sessionId: 'a' });
  await h.controller.recordShellCommand({ sessionId: 'a', terminalId: 'ta', command: 'git status' });
  assert.equal((await h.run('history-list', { sessionId: 'a' })).entries[0].command, 'git status');
  finish({ response: 0 }); await closing;
});

test('terminal-focus IPC restores native shortcuts on hide and ignores old terminal blur', async t => {
  const h = fixture(t); h.state[0].terminals.push({ id: 'tb', status: 'ready' });
  await h.run('terminal-focus', { sessionId: 'a', terminalId: 'ta', focused: true });
  await h.run('terminal-focus', { sessionId: 'a', terminalId: 'tb', focused: true });
  await h.run('terminal-focus', { sessionId: 'a', terminalId: 'ta', focused: false });
  assert.equal(h.calls.at(-1)[1], true);
  await h.run('subscribe', { active: false }); assert.equal(h.calls.at(-1)[1], false);
});
