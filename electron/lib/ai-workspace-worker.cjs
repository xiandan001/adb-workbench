const { parentPort } = require('node:worker_threads');
const { withLocale, tr } = require('./localization.cjs');
const { computeWorkspaceJob } = require('./ai-workspace-compute.cjs');
const { createAsyncReportStore, atomicWriteAsync, cancelled } = require('./ai-workspace-store-async.cjs');

let queue = Promise.resolve();
parentPort.on('message', request => {
  queue = queue.then(() => withLocale(request.locale, async () => {
    const flag = request.cancelBuffer ? new Int32Array(request.cancelBuffer) : null;
    try {
      cancelled(flag);
      let result;
      if (request.command.startsWith('basket:')) {
        const method = request.command.slice('basket:'.length), args = request.args;
        const store = require('./ai-evidence-basket-storage.cjs').createEvidenceBasketStore({ filename: args.filename });
        if (method === 'list') result = await store.list({ flag });
        else if (method === 'append') result = await store.append(args.item, { flag });
        else if (method === 'remove') result = await store.remove(args.id, { flag });
        else if (method === 'clear') result = await store.clear({ flag });
        else if (method === 'resolve') result = await store.resolve(args.revision, { flag });
        else throw Object.assign(new Error(tr('AI 后台操作无效。')), { code: 'AI_WORKER_OPERATION', safe: true });
      } else if (request.command.startsWith('history:') || request.command.startsWith('casebook:')) {
        const [kind, method] = request.command.split(':');
        const args = request.args;
        const store = createAsyncReportStore({ directory: args.directory, casebook: kind === 'casebook' });
        if (method === 'list') result = await store.list(args.query || {});
        else if (method === 'load') result = await store.load(args.id);
        else if (method === 'save') result = await store.save(args.report, args.name, args.review, flag);
        else if (method === 'update') result = await store.update(args.id, args.revision, args.review, flag);
        else if (method === 'delete') result = await store.delete(args.id, flag);
        else if (method === 'similar') result = await store.similar(args.report, args.limit);
        else throw Object.assign(new Error(tr('AI 后台操作无效。')), { code: 'AI_WORKER_OPERATION', safe: true });
      } else if (request.command === 'export') {
        await atomicWriteAsync(request.args.filename, request.args.text, { flag }); result = {};
      } else result = await computeWorkspaceJob(request.command, request.args, { flag });
      cancelled(flag);
      parentPort.postMessage({ id: request.id, result });
    } catch (error) {
      parentPort.postMessage({ id: request.id, error: { code: error.code || 'AI_WORKER_FAILED', message: error.safe ? error.message : tr('AI 本机后台操作未完成，请重试。') } });
    }
  })).catch(() => {});
});
