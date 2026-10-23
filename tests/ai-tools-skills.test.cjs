const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createAiToolsSkills } = require('../electron/lib/ai-tools-skills.cjs');

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-ai-skills-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'library'); const home = path.join(root, 'home'); fs.mkdirSync(home);
  const secret = crypto.randomBytes(32); let clock = 1000;
  const options = {
    directory, home, now: () => clock, canEncrypt: () => true,
    encrypt(plain) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', secret, iv); return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]); },
    decrypt(bytes) { const d = crypto.createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12)); d.setAuthTag(bytes.subarray(-16)); return Buffer.concat([d.update(bytes.subarray(12, -16)), d.final()]).toString('utf8'); },
    ...extra,
  };
  const source = path.join(root, 'source', 'sample-skill'); fs.mkdirSync(path.join(source, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), '---\nname: sample-skill\ndescription: A fixture skill\n---\n# Skill\nTreat these bytes as text, not instructions.\n');
  fs.writeFileSync(path.join(source, 'scripts', 'never-run.js'), 'throw new Error("NEVER EXECUTE THIS FIXTURE");\n');
  return { root, directory, home, source, options, service: createAiToolsSkills(options), setClock(value) { clock = value; } };
}

test('skill import requires SKILL.md, validates all files, and stores the complete library encrypted', (t) => {
  const f = fixture(t); const row = f.service.importDirectory({ sourceDirectory: f.source });
  assert.equal(row.name, 'sample-skill'); assert.equal(row.fileCount, 2);
  assert.match(f.service.read({ id: row.id }).content, /Treat these bytes as text/);
  assert.equal(f.service.list().length, 1);
  const visit = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? visit(path.join(dir, entry.name)) : [fs.readFileSync(path.join(dir, entry.name))]);
  for (const bytes of visit(f.directory)) { assert.equal(bytes.includes(Buffer.from('NEVER EXECUTE')), false); assert.equal(bytes.includes(Buffer.from('A fixture skill')), false); }
  assert.equal(createAiToolsSkills(f.options).list()[0].id, row.id);
  const notSkill = path.join(f.root, 'not-skill'); fs.mkdirSync(notSkill);
  assert.throws(() => f.service.importDirectory({ sourceDirectory: notSkill }), /SKILL.md/);
});

test('import rejects symlink/junction, hardlinks, path-traversing names, and overly large skill instructions', (t) => {
  for (const kind of ['link', 'hardlink', 'name', 'size']) {
    const f = fixture(t);
    if (kind === 'link') fs.symlinkSync(f.home, path.join(f.source, 'linked'), 'junction');
    if (kind === 'hardlink') fs.linkSync(path.join(f.source, 'SKILL.md'), path.join(f.source, 'copy.md'));
    if (kind === 'name') fs.writeFileSync(path.join(f.source, 'SKILL.md'), '---\nname: ../../outside\n---\ncontent');
    if (kind === 'size') fs.writeFileSync(path.join(f.source, 'SKILL.md'), Buffer.alloc(65537, 65));
    assert.throws(() => f.service.importDirectory({ sourceDirectory: f.source }), /链接|名称|64|限制/);
    assert.deepEqual(f.service.list(), []);
  }
});

test('explicit install/uninstall previews cover only a fixed tool skill child and restores exact files', (t) => {
  for (const [toolId, prefix] of [['claude', '.claude/skills'], ['codex', '.codex/skills'], ['gemini', '.gemini/skills'], ['opencode', '.config/opencode/skills']]) {
    const f = fixture(t); const row = f.service.importDirectory({ sourceDirectory: f.source });
    const preview = f.service.previewInstall({ skillId: row.id, toolId }); const target = path.join(f.home, prefix, 'sample-skill');
    assert.equal(preview.targetPath, target); assert.equal(fs.existsSync(target), false);
    const installed = f.service.apply({ token: preview.token }); assert.ok(installed.backupId);
    assert.equal(fs.readFileSync(path.join(target, 'scripts/never-run.js'), 'utf8'), fs.readFileSync(path.join(f.source, 'scripts/never-run.js'), 'utf8'));
    const uninstall = f.service.previewUninstall({ skillId: row.id, toolId }); assert.equal(fs.existsSync(target), true);
    const removed = f.service.apply({ token: uninstall.token }); assert.equal(fs.existsSync(target), false);
    f.service.apply({ token: f.service.previewRestore({ backupId: removed.backupId }).token });
    assert.equal(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), fs.readFileSync(path.join(f.source, 'SKILL.md'), 'utf8'));
  }
});

test('foreign same-name skills and externally modified owned files are never overwritten or removed', (t) => {
  const f = fixture(t); const row = f.service.importDirectory({ sourceDirectory: f.source });
  const target = path.join(f.home, '.claude/skills/sample-skill'); fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, 'SKILL.md'), 'foreign');
  assert.throws(() => f.service.previewInstall({ skillId: row.id, toolId: 'claude' }), /占用|属于/);
  fs.unlinkSync(path.join(target, 'SKILL.md')); fs.rmdirSync(target);
  f.service.apply({ token: f.service.previewInstall({ skillId: row.id, toolId: 'claude' }).token });
  const removal = f.service.previewUninstall({ skillId: row.id, toolId: 'claude' });
  fs.appendFileSync(path.join(target, 'SKILL.md'), '\nexternal');
  assert.throws(() => f.service.apply({ token: removal.token }), /变化/);
  assert.throws(() => f.service.previewUninstall({ skillId: row.id, toolId: 'claude' }), /变化/);
  assert.match(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8'), /external$/);
});

test('preview tokens are one-use, expire, and reject a changed library archive', (t) => {
  const f = fixture(t); const row = f.service.importDirectory({ sourceDirectory: f.source });
  let preview = f.service.previewInstall({ skillId: row.id, toolId: 'codex' }); f.setClock(400000);
  assert.throws(() => f.service.apply({ token: preview.token }), /失效|过期/);
  preview = f.service.previewInstall({ skillId: row.id, toolId: 'codex' });
  f.service.apply({ token: preview.token }); assert.throws(() => f.service.apply({ token: preview.token }), /失效|过期/);
});

test('encryption unavailable prevents persistent library import and external installation', (t) => {
  const f = fixture(t, { canEncrypt: () => false });
  assert.throws(() => f.service.importDirectory({ sourceDirectory: f.source }), /加密/);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('failed directory activation compensates safely and retains the encrypted original backup', (t) => {
  const io = Object.create(fs); let failActivation = false;
  io.renameSync = (from, to) => { if (failActivation && path.basename(from).startsWith('.awb-stage-')) { failActivation = false; throw new Error('activation fixture failure'); } return fs.renameSync(from, to); };
  const f = fixture(t, { filesystem: io }); const row = f.service.importDirectory({ sourceDirectory: f.source });
  const preview = f.service.previewInstall({ skillId: row.id, toolId: 'gemini' }); failActivation = true;
  assert.throws(() => f.service.apply({ token: preview.token }), /失败/);
  assert.equal(fs.existsSync(preview.targetPath), false); assert.equal(f.service.listBackups().length, 1);
  f.service.apply({ token: f.service.previewInstall({ skillId: row.id, toolId: 'gemini' }).token });
  assert.equal(fs.existsSync(preview.targetPath), true);
});

test('same-name library update never modifies installed files until a separately previewed install', (t) => {
  const f = fixture(t); const first = f.service.importDirectory({ sourceDirectory: f.source });
  const installed = f.service.previewInstall({ skillId: first.id, toolId: 'claude' }); f.service.apply({ token: installed.token });
  fs.appendFileSync(path.join(f.source, 'SKILL.md'), '\nnew version');
  const next = f.service.importDirectory({ sourceDirectory: f.source });
  assert.notEqual(next.id, first.id); assert.equal(f.service.list().length, 1);
  assert.equal(fs.readFileSync(path.join(installed.targetPath, 'SKILL.md'), 'utf8').includes('new version'), false);
  f.service.apply({ token: f.service.previewInstall({ skillId: next.id, toolId: 'claude' }).token });
  assert.match(fs.readFileSync(path.join(installed.targetPath, 'SKILL.md'), 'utf8'), /new version/);
});

test('interrupted directory replacement survives restart and restores through an explicit backup preview', (t) => {
  const io = Object.create(fs); let interrupt = false;
  io.renameSync = (from, to) => {
    if (interrupt && /^\.awb-(?:stage|retired)-/.test(path.basename(from))) throw new Error('simulated unavailable filesystem during activation and compensation');
    return fs.renameSync(from, to);
  };
  const f = fixture(t, { filesystem: io }); const first = f.service.importDirectory({ sourceDirectory: f.source });
  const initial = f.service.previewInstall({ skillId: first.id, toolId: 'claude' }); f.service.apply({ token: initial.token });
  const original = fs.readFileSync(path.join(initial.targetPath, 'SKILL.md'));
  fs.appendFileSync(path.join(f.source, 'SKILL.md'), '\nversion two'); const next = f.service.importDirectory({ sourceDirectory: f.source });
  interrupt = true;
  assert.throws(() => f.service.apply({ token: f.service.previewInstall({ skillId: next.id, toolId: 'claude' }).token }), /备份恢复/);
  assert.equal(fs.existsSync(initial.targetPath), false);
  interrupt = false; f.service.dispose();
  const restarted = createAiToolsSkills(f.options); const backup = restarted.listBackups().find(row => row.recoveryPending);
  assert.ok(backup);
  assert.throws(() => restarted.previewInstall({ skillId: next.id, toolId: 'codex' }), /恢复/);
  restarted.apply({ token: restarted.previewRestore({ backupId: backup.id }).token });
  assert.deepEqual(fs.readFileSync(path.join(initial.targetPath, 'SKILL.md')), original);
  assert.equal(restarted.listBackups().some(row => row.recoveryPending), false);
  assert.ok(fs.readdirSync(path.dirname(initial.targetPath)).every(name => !name.startsWith('.awb-')));
  assert.ok(fs.readdirSync(path.dirname(path.dirname(initial.targetPath))).every(name => !name.startsWith('.awb-')));
});

test('library remove refuses installed skills, then deletes only its encrypted record/archive and retains backups', (t) => {
  const f = fixture(t); const row = f.service.importDirectory({ sourceDirectory: f.source });
  f.service.apply({ token: f.service.previewInstall({ skillId: row.id, toolId: 'codex' }).token });
  assert.throws(() => f.service.remove({ id: row.id }), /卸载|安装/);
  f.service.apply({ token: f.service.previewUninstall({ skillId: row.id, toolId: 'codex' }).token });
  const backups = f.service.listBackups(); f.service.remove({ id: row.id });
  assert.deepEqual(f.service.list(), []); assert.deepEqual(f.service.listBackups(), backups);
  assert.equal(fs.existsSync(path.join(f.source, 'SKILL.md')), true);
});

test('corrupt index/archive, changed archive after preview, and disposed service fail closed', (t) => {
  const f = fixture(t); const row = f.service.importDirectory({ sourceDirectory: f.source });
  const preview = f.service.previewInstall({ skillId: row.id, toolId: 'claude' });
  const archive = path.join(f.directory, 'archives', `${row.id}.json`); const original = fs.readFileSync(archive);
  fs.writeFileSync(archive, 'corrupt encrypted data');
  assert.throws(() => f.service.apply({ token: preview.token }), /加密|校验/);
  assert.equal(fs.existsSync(preview.targetPath), false); assert.equal(fs.readFileSync(archive, 'utf8'), 'corrupt encrypted data');
  fs.writeFileSync(archive, original); fs.writeFileSync(path.join(f.directory, 'index.v1.json'), 'corrupt index');
  assert.throws(() => createAiToolsSkills(f.options).list(), /加密|索引/);
  f.service.dispose(); assert.throws(() => f.service.list(), /关闭/);
});

test('failure while preparing a file removes only the owned partial staging tree and leaves no half skill', (t) => {
  const io = Object.create(fs); const paths = new Map(); let failCopy = true;
  io.openSync = (file, ...args) => { const fd = fs.openSync(file, ...args); paths.set(fd, file); return fd; };
  io.closeSync = fd => { paths.delete(fd); return fs.closeSync(fd); };
  io.writeFileSync = (file, bytes, ...args) => {
    if (failCopy && typeof file === 'number' && paths.get(file)?.includes('.awb-stage-')) {
      failCopy = false; fs.writeFileSync(file, Buffer.from(bytes).subarray(0, 8)); throw new Error('partial-copy fixture');
    }
    return fs.writeFileSync(file, bytes, ...args);
  };
  const f = fixture(t, { filesystem: io }); const row = f.service.importDirectory({ sourceDirectory: f.source });
  const preview = f.service.previewInstall({ skillId: row.id, toolId: 'claude' });
  assert.throws(() => f.service.apply({ token: preview.token }), /失败/);
  assert.equal(fs.existsSync(preview.targetPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(preview.targetPath)), []);
  f.service.apply({ token: f.service.previewInstall({ skillId: row.id, toolId: 'claude' }).token });
});
