import test from 'node:test';
import assert from 'node:assert/strict';
import { emptySshView, sshWorkspaceReducer, normalizeSshLayout, readSshLayout, saveSshLayout, SSH_LAYOUT_KEY, dirtySshPaths, remoteParent, remoteChild, reconcileSshSelection, createSshDirectoryRequests, clearSshDirectoryLoading } from '../src/shared/sshWorkspace.js';

const document = (sessionId, path = '/etc/test.txt') => ({ sessionId, documentId: `${sessionId}:${path}`, path, kind: 'text', text: 'original', revision: 'r1', size: 8, readOnly: false });
const open = (state, sessionId, path) => sshWorkspaceReducer(state, { type: 'open-document', sessionId, document: document(sessionId, path) });

test('SSH sessions isolate same remote paths, draft edits and terminal selection', () => {
  let state = open(emptySshView(), 'A');
  state = open(state, 'B');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'edited A' });
  state = sshWorkspaceReducer(state, { type: 'select-terminal', sessionId: 'B', terminalId: 'B-pty2' });
  assert.equal(state.sessions.A.documents[0].draft, 'edited A');
  assert.equal(state.sessions.B.documents[0].draft, 'original');
  assert.equal(state.sessions.B.activeTerminalId, 'B-pty2');
  assert.equal(state.sessions.A.activeTerminalId, '');
  assert.deepEqual(dirtySshPaths(state.sessions.A), ['/etc/test.txt']);
  assert.deepEqual(dirtySshPaths(state.sessions.B), []);
});

test('SSH opening an already dirty path selects it without replacing the local draft', () => {
  let state = open(emptySshView(), 'A');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'local changes' });
  state = sshWorkspaceReducer(state, { type: 'open-document', sessionId: 'A', document: { ...document('A'), text: 'remote new', revision: 'r2' } });
  assert.equal(state.sessions.A.documents.length, 1);
  assert.equal(state.sessions.A.documents[0].draft, 'local changes');
  assert.equal(state.sessions.A.documents[0].revision, 'r1');
});

test('SSH delayed save acknowledgement does not mark newer edits clean or another session saved', () => {
  let state = open(open(emptySshView(), 'A'), 'B');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'submitted' });
  state = sshWorkspaceReducer(state, { type: 'save-started', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'submitted' });
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'typed while saving' });
  state = sshWorkspaceReducer(state, { type: 'save-succeeded', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'submitted', revision: 'r2' });
  assert.equal(state.sessions.A.documents[0].dirty, true);
  assert.equal(state.sessions.A.documents[0].draft, 'typed while saving');
  assert.equal(state.sessions.A.documents[0].savedText, 'submitted');
  assert.equal(state.sessions.A.documents[0].revision, 'r2');
  assert.equal(state.sessions.B.documents[0].revision, 'r1');
});

test('SSH errors retain drafts; closing dirty documents needs explicit discard', () => {
  let state = open(emptySshView(), 'A');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'unsaved' });
  state = sshWorkspaceReducer(state, { type: 'save-failed', sessionId: 'A', documentId: 'A:/etc/test.txt', error: 'Remote changed', code: 'SSH_FILE_CONFLICT' });
  assert.equal(state.sessions.A.documents[0].draft, 'unsaved');
  assert.equal(state.sessions.A.documents[0].error, 'Remote changed');
  assert.equal(sshWorkspaceReducer(state, { type: 'close-document', sessionId: 'A', documentId: 'A:/etc/test.txt' }), state);
  state = sshWorkspaceReducer(state, { type: 'close-document', sessionId: 'A', documentId: 'A:/etc/test.txt', discard: true });
  assert.equal(state.sessions.A.documents.length, 0);
});

test('SSH refuses mismatched session documents and does not edit binary/read-only content', () => {
  const initial = emptySshView();
  assert.equal(sshWorkspaceReducer(initial, { type: 'open-document', sessionId: 'A', document: document('B') }), initial);
  let state = sshWorkspaceReducer(initial, { type: 'open-document', sessionId: 'A', document: { ...document('A'), readOnly: true } });
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'blocked' });
  assert.equal(state.sessions.A.documents[0].draft, 'original');
});

test('SSH layout is bounded and storage contains layout only, not credentials or documents', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const initial = readSshLayout(storage);
  assert.equal(initial.version, 1);
  assert.equal(normalizeSshLayout({ ...initial, files: 0.9, editor: 0.1 }).files, 0.45);
  saveSshLayout({ ...initial, files: 0.3, editor: 0.6, transfersOpen: true }, storage);
  assert.equal(readSshLayout(storage).editor, 0.6);
  assert.deepEqual([...values.keys()], [SSH_LAYOUT_KEY]);
  values.set(SSH_LAYOUT_KEY, '{bad');
  assert.throws(() => saveSshLayout(initial, storage), /布局/);
  assert.equal(values.get(SSH_LAYOUT_KEY), '{bad');
});

test('SSH workspace appearance defaults current for legacy layout and persists without changing app theme', () => {
  const old = JSON.stringify({ version: 1, files: 0.3, editor: 0.6, transfersOpen: false });
  const values = new Map([[SSH_LAYOUT_KEY, old], ['currentTheme', 'default']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const restored = readSshLayout(storage);
  assert.equal(restored.appearance, 'current');
  assert.equal(values.get(SSH_LAYOUT_KEY), old, 'reading old layout must not rewrite it');
  saveSshLayout({ ...restored, appearance: 'classic' }, storage);
  assert.equal(readSshLayout(storage).appearance, 'classic');
  assert.equal(values.get('currentTheme'), 'default');
  assert.throws(() => normalizeSshLayout({ ...restored, appearance: 'unknown' }), /布局/);
});

test('SSH remote path helpers use POSIX separators without touching local paths', () => {
  assert.equal(remoteParent('/etc/config'), '/etc');
  assert.equal(remoteParent('/'), '/');
  assert.equal(remoteChild('/', '配置 文件.txt'), '/配置 文件.txt');
  assert.equal(remoteChild('/home/u/', 'file'), '/home/u/file');
  assert.throws(() => remoteChild('/home/u', '../x'));
  assert.throws(() => remoteChild('/home/u', ''));
});

test('SSH background directory refresh preserves the current selection unless it disappeared', () => {
  const selected = { name: 'uploaded.txt', path: '/home/u/uploaded.txt', type: 'file', size: 10 };
  const entries = [{ name: 'uploaded.txt', type: 'file', size: 20 }];
  assert.deepEqual(reconcileSshSelection(selected, '/home/u', '/home/u', entries), { ...selected, size: 20 });
  assert.equal(reconcileSshSelection(selected, '/home/u', '/other', entries), null);
  assert.equal(reconcileSshSelection(selected, '/home/u', '/home/u', []), null);
});

test('SSH rename and directory move update only matching paths in the owning session', () => {
  let state = open(emptySshView(), 'A', '/work/folder/a.txt');
  state = open(state, 'A', '/work/folder/nested/b.txt');
  state = open(state, 'A', '/work/folder-other/c.txt');
  state = open(state, 'B', '/work/folder/a.txt');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/work/folder/a.txt', text: 'dirty draft' });
  state = sshWorkspaceReducer(state, { type: 'move-path', sessionId: 'A', source: '/work/folder', path: '/new/place' });
  assert.deepEqual(state.sessions.A.documents.map(item => item.path), ['/new/place/a.txt', '/new/place/nested/b.txt', '/work/folder-other/c.txt']);
  const moved = state.sessions.A.documents[0];
  assert.equal(moved.documentId, 'A:/work/folder/a.txt');
  assert.equal(moved.draft, 'dirty draft');
  assert.equal(moved.revision, 'r1');
  assert.equal(moved.dirty, true);
  assert.equal(state.sessions.B.documents[0].path, '/work/folder/a.txt');
  state = sshWorkspaceReducer(state, { type: 'move-path', sessionId: 'A', source: '/new/place/a.txt', path: '/new/place/renamed.txt' });
  assert.equal(state.sessions.A.documents[0].path, '/new/place/renamed.txt');
});

test('SSH deletion keeps local content and marks only the deleted path and descendants missing', () => {
  let state = open(open(open(emptySshView(), 'A', '/x/a.txt'), 'A', '/x-other/b.txt'), 'B', '/x/a.txt');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/x/a.txt', text: 'recover this' });
  state = sshWorkspaceReducer(state, { type: 'delete-path', sessionId: 'A', path: '/x' });
  assert.equal(state.sessions.A.documents[0].remoteMissing, true);
  assert.equal(state.sessions.A.documents[0].draft, 'recover this');
  assert.equal(state.sessions.A.documents[0].dirty, true);
  assert.equal(state.sessions.A.documents[1].remoteMissing, undefined);
  assert.equal(state.sessions.B.documents[0].remoteMissing, undefined);
});

test('transfer folder navigation selects its host without replacing dirty documents or terminal state', () => {
  let state = open(open(emptySshView(), 'A'), 'B');
  state = sshWorkspaceReducer(state, { type: 'edit-document', sessionId: 'A', documentId: 'A:/etc/test.txt', text: 'retain draft' });
  state = sshWorkspaceReducer(state, { type: 'select-terminal', sessionId: 'A', terminalId: 'A-pty2' });
  state = sshWorkspaceReducer(state, { type: 'select-session', sessionId: 'B' });
  const documents = state.sessions.A.documents; const otherHost = state.sessions.B;
  state = sshWorkspaceReducer(state, { type: 'reveal-directory', sessionId: 'A', path: '/uploads' });
  assert.equal(state.selectedSessionId, 'A'); assert.equal(state.sessions.A.directory, '/uploads');
  assert.equal(state.sessions.A.directoryRevision, 1); assert.equal(state.sessions.A.activeTerminalId, 'A-pty2');
  assert.equal(state.sessions.A.documents, documents); assert.equal(state.sessions.A.documents[0].dirty, true);
  assert.equal(state.sessions.B, otherHost);
  state = sshWorkspaceReducer(state, { type: 'reveal-directory', sessionId: 'A', path: '/uploads' });
  assert.equal(state.sessions.A.directoryRevision, 2, 'same directory reveal requests a fresh listing');
  const before = state;
  assert.equal(sshWorkspaceReducer(state, { type: 'directory', sessionId: 'A', path: '/old', revision: 1 }), before);
  state = sshWorkspaceReducer(state, { type: 'directory', sessionId: 'A', path: '/resolved', revision: 2 });
  assert.equal(state.sessions.A.directory, '/resolved'); assert.equal(state.sessions.A.documents, documents);
  assert.equal(sshWorkspaceReducer(state, { type: 'reveal-directory', sessionId: 'A', path: 'relative' }), state);
});

test('SSH directory request gate rejects old root and same-path late results but allows a fresh repeat', () => {
  const requests = createSshDirectoryRequests();
  const oldRoot = requests.begin('/old', true);
  const expansion = requests.begin('/old/child', false);
  assert.equal(requests.begin('/old/child', false), null);
  const current = requests.begin('/uploads', true);
  assert.equal(requests.isCurrent(oldRoot), false); assert.equal(requests.isCurrent(expansion), false);
  assert.equal(requests.isCurrent(current), true);
  const refreshedChild = requests.begin('/old/child', false);
  assert.ok(refreshedChild, 'abandoned child must not remain blocked by an old pending request');
  requests.finish(expansion); assert.equal(requests.isCurrent(refreshedChild), true);
  const repeat = requests.begin('/uploads', true);
  requests.finish(current);
  assert.equal(requests.isCurrent(current), false); assert.equal(requests.isCurrent(repeat), true);
  requests.invalidate(); assert.equal(requests.isCurrent(repeat), false);
  const next = requests.begin('/uploads', true); assert.equal(requests.isCurrent(next), true);
});

test('root navigation clears abandoned spinners and one-use cursors while retaining visible entries', () => {
  const entries = [{ name: 'cached.txt' }];
  const idle = { loaded: true, loading: false, entries: [] };
  const cleared = clearSshDirectoryLoading({ '/child': { loading: true }, '/cached': { loaded: true, loading: true, entries, cursor: 'consumed-page-token', truncated: true }, '/idle': idle });
  assert.deepEqual(cleared['/child'], { loading: false, loaded: false, cursor: undefined, truncated: false });
  assert.equal(cleared['/cached'].loading, false); assert.equal(cleared['/cached'].loaded, false);
  assert.equal(cleared['/cached'].cursor, undefined, 'a cancelled next-page request may already have consumed its token');
  assert.equal(cleared['/cached'].truncated, false);
  assert.equal(cleared['/cached'].entries, entries); assert.equal(cleared['/idle'], idle);
  const withNewRequest = { ...cleared, '/child': { ...cleared['/child'], loading: true } };
  assert.equal(withNewRequest['/child'].loading, true);
  assert.equal(clearSshDirectoryLoading(cleared), cleared);
});
