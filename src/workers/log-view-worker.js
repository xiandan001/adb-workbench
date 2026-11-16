import { createLogViewIndex } from '../shared/logWorkbenchModel.js';

let index = createLogViewIndex(), generation = -1, revision = 0;
globalThis.onmessage = ({ data }) => {
  if (data.type === 'sync') {
    if (data.generation !== generation) { index = createLogViewIndex(); generation = data.generation; }
    index.sync(data); revision = data.revision; return;
  }
  if (data.type !== 'query' || data.generation !== generation) return;
  try {
    const result = index.query({ filter: data.filter, timeRange: data.timeRange, rules: data.rules });
    globalThis.postMessage({ type: 'result', generation, revision, requestId: data.requestId, result });
  } catch (error) {
    globalThis.postMessage({ type: 'error', generation, revision, requestId: data.requestId, code: error.code });
  }
};
