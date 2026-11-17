const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { own } = require('./application-log-text.cjs');
const { types } = require('node:util');

function installWorkerObservation({ workerThreads, appRoot, observeToolProcess }) {
  const Original = workerThreads.Worker;
  if (typeof Original !== 'function') return () => {};
  const roots = [path.resolve(appRoot), path.resolve(appRoot.replace(/app\.asar$/i, 'app.asar.unpacked'))];
  const trusted = (filename, options) => {
    if (options && types.isProxy(options)) return false;
    for (const key of ['eval', 'stdout', 'stderr']) {
      const descriptor = options && Object.getOwnPropertyDescriptor(options, key);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) return false;
    }
    if (own(options, 'eval') === true) return false;
    try {
      const file = path.resolve(filename instanceof URL ? fileURLToPath(filename) : filename);
      return roots.some(root => { const relative = path.relative(path.join(root, 'electron', 'lib'), file);
        return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && /\.c?js$/i.test(relative); });
    } catch { return false; }
  };
  const observed = new Proxy(Original, { construct(target, args, newTarget) {
    const worker = Reflect.construct(target, args, newTarget === observed ? target : newTarget);
    try {
      const allowed = trusted(args[0], args[1]), streams = allowed ? { stdout: worker.stdout, stderr: worker.stderr } : {};
      observeToolProcess(worker, { tool: 'worker', operation: 'process', streams,
        stdout: allowed && own(args[1], 'stdout') !== true ? 'text' : 'sensitive',
        stderr: allowed && own(args[1], 'stderr') !== true ? 'text' : 'sensitive' });
    } catch { /* Preserve the exact original Worker and its options. */ }
    return worker;
  } });
  workerThreads.Worker = observed;
  return () => { if (workerThreads.Worker === observed) workerThreads.Worker = Original; };
}
module.exports = { installWorkerObservation };
