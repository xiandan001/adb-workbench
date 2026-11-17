const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { createApplicationLogSession } = require('../electron/lib/application-log-session.cjs');

for (const workerFatal of [false, true]) test(`a real uncaught ${workerFatal ? 'app-owned Worker' : 'Node'} exception keeps its default nonzero exit and its active-session code stack is recoverable`, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'veylo-fatal-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'fatal-child.cjs'), appLogFile = path.resolve(__dirname, '../electron/lib/application-log.cjs');
  const worker = path.join(directory, 'electron/lib/fatal-worker.cjs');
  if (workerFatal) { await fs.mkdir(path.dirname(worker), { recursive: true }); await fs.writeFile(worker, "throw new Error('WORKER_FATAL_MARKER password=FATAL_FIXTURE_SECRET');"); }
  const marker = workerFatal ? 'WORKER_FATAL_MARKER' : 'FATAL_CAPTURE_MARKER';
  const trigger = workerFatal ? `new (require('node:worker_threads').Worker)(${JSON.stringify(worker)});` : "setImmediate(()=>{throw new Error('FATAL_CAPTURE_MARKER password=FATAL_FIXTURE_SECRET');});";
  await fs.writeFile(script, `const {EventEmitter}=require('node:events');const Module=require('node:module');
const directory=${JSON.stringify(directory)}, appLogFile=${JSON.stringify(appLogFile)};
const contents=Object.assign(new EventEmitter(),{mainFrame:{},isDestroyed:()=>false,getURL:()=>''});
const owner={webContents:contents,isDestroyed:()=>false};
const app=Object.assign(new EventEmitter(),{getAppPath:()=>directory,getPath:()=>directory,getVersion:()=>'4.7.31',getGPUFeatureStatus:()=>({})});
const original=Module._load;Module._load=function(name,...rest){if(name==='electron')return {app,dialog:{},webContents:{getAllWebContents:()=>[]}};if(name==='electron-updater')return {autoUpdater:new EventEmitter()};if(name==='./app-context.cjs')return {getMainWindow:()=>owner};return Reflect.apply(original,this,[name,...rest]);};
const api=require(appLogFile),handlers=new Map();api.installEarlyHooks({consoleObject:{},childProcess:{},appRoot:directory});api.register({handle:(name,fn)=>handlers.set(name,fn)});
(async()=>{const started=await handlers.get('app-log:start')({sender:contents,senderFrame:contents.mainFrame});if(!started.state?.recording)throw new Error('fixture did not start');Module._load=original;${trigger}})();
`);
  const result = await new Promise(resolve => execFile(process.execPath, [script], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.ok(result.error && result.error.code !== 0, 'The hook must not swallow default termination');
  assert.ok(result.stderr.includes(marker), `Child failed before the intended exception: ${result.error?.code} ${result.stderr.slice(0, 1500)}`);
  const session = createApplicationLogSession({ directory: path.join(directory, 'application-logs') }); t.after(() => session.dispose());
  const text = await session.text();
  assert.ok(text.includes(marker));
  assert.match(text, workerFatal ? /fatal-worker\.cjs:\d+:\d+/ : /fatal-child\.cjs:\d+:\d+/);
  assert.doesNotMatch(text, /FATAL_FIXTURE_SECRET/);
  assert.match(text, /"reason":"interrupted"/);
});
