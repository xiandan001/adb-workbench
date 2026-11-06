const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

function findEffect(filename, match) {
  const source = fs.readFileSync(path.join(__dirname, '../src/components', filename), 'utf8');
  let effect;
  traverse(parser.parse(source, { sourceType: 'module', plugins: ['jsx'] }), { CallExpression({ node }) {
    if (node.callee.name !== 'useEffect' || !node.arguments[0]) return;
    const body = source.slice(node.arguments[0].start, node.arguments[0].end);
    if (body.includes(match)) effect = body;
  } });
  assert.ok(effect, filename);
  return context => vm.runInNewContext(`(${effect})()`, context);
}

const artifactEffect = findEffect('ArtifactCenter.jsx', 'onArtifactRequestHandled?.(request)');
const guardEffect = findEffect('QualityCenter.jsx', 'onGuardRequestHandled?.(incomingGuardId)');

test('artifact navigation acknowledges the exact object only after list readiness and preserves the opened preview', async () => {
  const { resolveArtifactPreviewRequest } = await import('../src/shared/artifactWorkspace.js');
  const request = { id: 'task:one', requestId: 'one-request' }, item = { id: request.id };
  const previews = [], receipts = [];
  const context = { resolveArtifactPreviewRequest, incomingArtifactRequest: request, items: [item], handledPreviewRequest: { current: '' },
    loading: false, listReady: false, deleting: false, exporting: '', tr: value => value,
    setPreviewItem: value => previews.push(value), setError() {}, onArtifactRequestHandled: value => receipts.push(value) };
  artifactEffect(context); assert.equal(receipts.length, 0);
  context.listReady = true; context.exporting = 'busy'; artifactEffect(context); assert.equal(receipts.length, 0);
  context.exporting = ''; artifactEffect(context);
  assert.equal(receipts[0], request); assert.equal(previews[0], item);
  context.incomingArtifactRequest = null; artifactEffect(context);
  context.handledPreviewRequest = { current: '' }; artifactEffect(context); // Remount with parent's consumed request.
  assert.equal(previews.length, 1); assert.equal(receipts.length, 1);
});

test('a missing artifact is consumed once, and a late old receipt cannot identify itself as a new request', async () => {
  const { resolveArtifactPreviewRequest } = await import('../src/shared/artifactWorkspace.js');
  const old = { id: 'missing', requestId: 'old' }, newer = { id: 'new', requestId: 'new' };
  let parentRequest = old;
  const receipts = [], errors = [];
  const context = { resolveArtifactPreviewRequest, incomingArtifactRequest: old, items: [], handledPreviewRequest: { current: '' },
    loading: false, listReady: true, deleting: false, exporting: '', tr: value => value,
    setPreviewItem() { throw new Error('Unknown artifacts cannot open'); },
    setError: value => { errors.push(value); parentRequest = newer; },
    onArtifactRequestHandled: value => { receipts.push(value); if (parentRequest === value) parentRequest = null; } };
  artifactEffect(context); artifactEffect(context);
  assert.equal(receipts.length, 1); assert.equal(receipts[0], old); assert.equal(parentRequest, newer);
  assert.match(errors[0], /不存在/);
});

test('guard receipt waits for local request acceptance, acknowledges once and never clears the displayed record', async () => {
  const { guardNavigationRequest } = await import('../src/shared/qualityNavigation.js');
  const request = { id: 'guard-old', requestId: 'uuid-request' };
  const navigation = guardNavigationRequest(request), receipts = [];
  const context = { incomingGuardId: request, guardRequest: navigation, handledGuard: '', requestedGuardId: '',
    guardReceiptRef: { current: '' }, onGuardRequestHandled: value => receipts.push(value) };
  guardEffect(context); assert.equal(receipts.length, 0);
  context.handledGuard = navigation.key; context.requestedGuardId = navigation.id;
  guardEffect(context); guardEffect(context); assert.equal(receipts.length, 1); assert.equal(receipts[0], request);
  context.incomingGuardId = null; guardEffect(context);
  assert.equal(context.requestedGuardId, 'guard-old');
  const newer = { id: 'guard-new', requestId: 'new-request' };
  context.incomingGuardId = newer; context.guardRequest = guardNavigationRequest(newer);
  guardEffect(context); assert.equal(receipts.length, 1); // Old accepted state cannot acknowledge the new request.
  context.handledGuard = context.guardRequest.key; context.requestedGuardId = newer.id;
  guardEffect(context); assert.equal(receipts[1], newer);
});
