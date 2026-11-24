const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { tmpdir } = require('node:os');
const test = require('node:test');
const { promisify } = require('node:util');
const { installCodeHooks } = require('../electron/lib/application-log-hooks.cjs');
const { createToolObserver } = require('../electron/lib/application-log-tools.cjs');

const program = 'process.stdout.write(String.fromCharCode(97).repeat(40000));process.stderr.write(String.fromCharCode(98).repeat(50000));';
const stdout = 'a'.repeat(40000);
const stderr = 'b'.repeat(50000);
const quote = value => process.platform === 'win32' ? '"' + value + '"' : "'" + value.replaceAll("'", "'\"'\"'") + "'";
const shellCommand = code => quote(process.execPath) + ' -e ' + quote(code);

function fixture(t) {
  // Use the native implementations while keeping other tests' global child-process exports intact.
  const wrapped = { exec: childProcess.exec, execFile: childProcess.execFile };
  const observed = [];
  const records = [];
  const record = row => records.push(row);
  const isEnabled = () => true;
  const observer = createToolObserver({ record, isEnabled });
  const remove = installCodeHooks({
    consoleObject: {}, childProcess: wrapped, record, isEnabled,
    observeToolProcess(child, policy) {
      observed.push(child);
      return observer.observe(child, policy);
    },
  });
  t.after(() => { remove(); observer.cleanup(); });
  return { wrapped, observed, records };
}

function assertOutput(output) {
  assert.equal(typeof output, 'object', 'a native result has both output streams');
  assert.ok(output.stdout === stdout, 'stdout is complete');
  assert.ok(output.stderr === stderr, 'stderr is complete');
}

function assertObservedChildren(children, observed) {
  assert.equal(observed.length, children.length, 'one observation per child');
  children.forEach((child, index) => {
    assert.ok(child instanceof childProcess.ChildProcess, 'native promise exposes its child immediately');
    assert.ok(child === observed[index], 'observed the exact returned child');
  });
}

test('application logging preserves native promisified execFile and exec results and their child handles', async t => {
  const { wrapped, observed, records } = fixture(t);
  const nativeArgs = [process.execPath, ['-e', program]];
  const file = promisify(wrapped.execFile)(...nativeArgs);
  const shell = promisify(wrapped.exec)(shellCommand(program));
  const children = [file.child, shell.child];
  const results = await Promise.all([file, shell]);
  assertObservedChildren(children, observed);
  results.forEach(assertOutput);
  assert.equal(records.filter(row => row.event === 'spawn').length, 2);
  assert.equal(records.filter(row => row.event === 'exit' && row.exitCode === 0).length, 2);
});

test('promisified errors retain output and exit codes, including a real spawn failure', async t => {
  const { wrapped, observed } = fixture(t);
  const failedProgram = program + 'process.exitCode=7;';
  const file = promisify(wrapped.execFile)(process.execPath, ['-e', failedProgram]);
  const shell = promisify(wrapped.exec)(shellCommand(failedProgram));
  const missing = promisify(wrapped.execFile)(path.join(tmpdir(), 'missing-veylo-node-' + randomUUID()));
  const children = [file.child, shell.child, missing.child];
  await Promise.all([
    ...[file, shell].map(pending => assert.rejects(pending, error => {
      assert.equal(error.code, 7);
      assertOutput(error);
      return true;
    })),
    assert.rejects(missing, error => {
      assert.equal(error.code, 'ENOENT');
      // Promise result storage lives on the error when the native callback fails.
      assert.equal(error.stdout, '');
      assert.equal(error.stderr, '');
      return true;
    }),
  ]);
  assertObservedChildren(children, observed);
});

test('callback overload still returns and observes the same native child without losing output', async t => {
  const { wrapped, observed } = fixture(t);
  let child;
  const output = await new Promise((resolve, reject) => {
    child = wrapped.execFile(process.execPath, ['-e', program], (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
  assertOutput(output);
  assertObservedChildren([child], observed);
});
