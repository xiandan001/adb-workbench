const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiToolsProjects } = require('../electron/lib/ai-tools-projects.cjs');

function fixture(t, launchTerminal) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-launch-project-'));
  const projectDirectory = path.join(root, 'project'); fs.mkdirSync(projectDirectory);
  const service = createAiToolsProjects({ directory: path.join(root, 'data'), home: root,
    canEncrypt: () => true, encrypt: text => Buffer.from(text).map(value => value ^ 63), decrypt: bytes => bytes.map(value => value ^ 63).toString(),
    findExecutable: async () => 'C:\\fixture\\codex.cmd', launchTerminal,
  });
  const project = service.save({ name: 'Fixture', toolId: 'codex', pinned: false, directoryToken: service.offerDirectory(projectDirectory).token });
  t.after(() => { service.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { service, project };
}

test('project launch returns verified console metadata without claiming model or login availability', async t => {
  const h = fixture(t, async ({ signal }) => { assert.ok(signal instanceof AbortSignal); return { terminalReady: true, terminalPid: 123, launcherPid: 124 }; });
  const preview = await h.service.previewLaunch({ projectId: h.project.id });
  assert.deepEqual(await h.service.launch({ token: preview.token }), { launched: true, projectId: h.project.id, terminalReady: true, terminalPid: 123, launcherPid: 124 });
});

test('migration and disposal abort an in-flight terminal handshake rather than allowing a late CLI start', async t => {
  for (const action of ['cancelPending', 'dispose']) {
    let started; const began = new Promise(resolve => { started = resolve; }); let permission = false;
    const h = fixture(t, ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'AI_TOOLS_CANCELLED' })), { once: true });
      started(() => { if (!signal.aborted) { permission = true; resolve({ terminalReady: true, terminalPid: 123 }); } });
    }));
    const preview = await h.service.previewLaunch({ projectId: h.project.id });
    const launching = h.service.launch({ token: preview.token }); const lateReady = await began;
    const rejected = assert.rejects(launching, { code: 'AI_TOOLS_CANCELLED' });
    h.service[action](); lateReady(); await rejected; assert.equal(permission, false);
    if (action === 'cancelPending') assert.ok((await h.service.previewLaunch({ projectId: h.project.id })).token);
  }
});
