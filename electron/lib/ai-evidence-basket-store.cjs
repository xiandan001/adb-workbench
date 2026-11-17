const path = require('node:path');
const { validateBasket, BASKET_LIMITS, createEvidenceBasketStore: createStorage } = require('./ai-evidence-basket-storage.cjs');

function createEvidenceBasketStore({ filename, io, processor } = {}) {
  // Injected I/O stays available for atomic-failure fixtures. Production parses,
  // validates and serializes the complete basket only in the bounded worker.
  if (io) return createStorage({ filename, io });
  const target = path.resolve(filename);
  const process = processor || require('./ai-workspace-processor.cjs').runWorkspaceJob;
  const call = (method, args, options) => process('basket:' + method, { filename: target, ...args }, options);
  return {
    list: options => call('list', {}, options),
    append: (item, options) => call('append', { item }, options),
    remove: (id, options) => call('remove', { id }, options),
    clear: options => call('clear', {}, options),
    resolve: (revision, options) => call('resolve', { revision }, options),
  };
}

module.exports = { createEvidenceBasketStore, validateBasket, BASKET_LIMITS };
