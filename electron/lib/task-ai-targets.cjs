const { randomUUID } = require('node:crypto');
const { tr } = require('./localization.cjs');

const TTL = 10 * 60 * 1000;
const TARGET_TYPES = new Set(['tap', 'longPress', 'waitText', 'assertText']);
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const clone = value => JSON.parse(JSON.stringify(value));
const invalid = () => Object.assign(new Error(tr('控件引用已失效或不属于当前设备，请重新读取并选择控件。')), { code: 'TASK_TARGET_INVALID', safe: true });

function targetSelector(node) {
  if (node?.password === true) return null;
  const selector = {};
  for (const key of ['text', 'resourceId', 'contentDesc', 'className', 'packageName']) {
    const value = node?.[key];
    if (typeof value === 'string' && value.trim() && value.length <= 500 && !/[\x00-\x1f\x7f]/.test(value)) selector[key] = value.trim();
  }
  // Class-only and XPath-only matches are too broad for AI-generated actions.
  return selector.resourceId || selector.contentDesc || selector.text ? selector : null;
}

function createTaskTargetRegistry({ now = Date.now } = {}) {
  const snapshots = new Map(), selected = new Map();
  const ownerKey = owner => typeof owner === 'object' ? owner?.id : owner;
  function prune() {
    for (const map of [snapshots, selected]) for (const [key, value] of map) if (value.expiresAt <= now()) map.delete(key);
  }
  function publicTarget(item) {
    return { token: item.token, label: item.label, deviceId: item.deviceId, capturedAt: item.capturedAt,
      expiresAt: new Date(item.expiresAt).toISOString() };
  }
  return {
    remember(snapshot, deviceId, owner) {
      prune(); const key = ownerKey(owner);
      if (!Number.isSafeInteger(key) || !deviceId || !Array.isArray(snapshot?.nodes)) throw invalid();
      for (const [id, item] of snapshots) if (item.owner === key && item.deviceId === deviceId) snapshots.delete(id);
      while (snapshots.size >= 12) snapshots.delete(snapshots.keys().next().value);
      const id = randomUUID(), capturedAt = new Date(now()).toISOString();
      const nodes = snapshot.nodes.slice(0, 300).map(node => ({ ...clone(node), targetNodeId: randomUUID() }));
      const candidates = nodes.map(node => ({ node, selector: targetSelector(node) }));
      const allowed = new Map();
      for (const { node, selector } of candidates) {
        if (!selector) continue;
        const matches = candidates.filter(item => Object.entries(selector).every(([field, value]) => String(item.node[field] || '').trim() === value));
        if (matches.length === 1) allowed.set(node.targetNodeId, { selector, label: String(node.label || selector.text || selector.resourceId || selector.contentDesc).slice(0, 200) });
      }
      snapshots.set(id, { owner: key, deviceId, capturedAt, expiresAt: now() + TTL, allowed });
      return { ...snapshot, snapshotId: id, nodes: nodes.map(node => ({ ...node, aiSelectable: allowed.has(node.targetNodeId) })) };
    },
    select({ snapshotId, nodeId }, owner) {
      prune(); const snapshot = snapshots.get(snapshotId), node = snapshot?.allowed.get(nodeId), key = ownerKey(owner);
      if (!snapshot || snapshot.owner !== key || !node) throw invalid();
      const duplicate = [...selected.values()].find(item => item.owner === key && item.snapshotId === snapshotId && item.nodeId === nodeId);
      if (duplicate) return publicTarget(duplicate);
      if ([...selected.values()].filter(item => item.owner === key).length >= 30) throw Object.assign(new Error(tr('已选控件过多，请移除旧选择或等待过期后重试。')), { code: 'TASK_TARGET_LIMIT', safe: true });
      const item = { token: randomUUID(), owner: key, snapshotId, nodeId, ...clone(node), deviceId: snapshot.deviceId,
        capturedAt: snapshot.capturedAt, expiresAt: snapshot.expiresAt };
      selected.set(item.token, item); return publicTarget(item);
    },
    resolve(tokens, owner) {
      prune(); const key = ownerKey(owner);
      if (!Array.isArray(tokens) || !tokens.length || tokens.length > 10 || new Set(tokens).size !== tokens.length) throw invalid();
      const targets = tokens.map((token, index) => {
        const item = UUID.test(token || '') ? selected.get(token) : null;
        if (!item || item.owner !== key) throw invalid();
        return { ...publicTarget(item), id: `T${index + 1}`, selector: clone(item.selector) };
      });
      if (new Set(targets.map(item => item.deviceId)).size !== 1) throw invalid();
      return { deviceId: targets[0].deviceId, targets };
    },
    clearOwner(owner) { const key = ownerKey(owner); for (const map of [snapshots, selected]) for (const [id, item] of map) if (item.owner === key) map.delete(id); },
    clear() { snapshots.clear(); selected.clear(); },
  };
}

function materializeAiSteps(steps, targets = []) {
  if (!Array.isArray(steps) || steps.length > 20 || !Array.isArray(targets) || targets.length > 10) throw invalid();
  const byId = new Map(targets.map(target => [target.id, target]));
  if (byId.size !== targets.length || targets.some(target => !/^T[1-9]\d*$/.test(target.id || '') || !targetSelector(target.selector))) throw invalid();
  return steps.map(step => {
    if (!Object.hasOwn(step, 'targetId')) return clone(step);
    const target = byId.get(step.targetId);
    const fields = ['type', 'label', 'targetId', ...(step.type === 'longPress' ? ['durationMs'] : []), ...(['waitText', 'assertText'].includes(step.type) ? ['timeoutMs'] : [])];
    if (!TARGET_TYPES.has(step.type) || !target || Object.keys(step).some(key => !fields.includes(key))
      || typeof step.label !== 'string' || step.label.length > 80) throw invalid();
    const { targetId: _targetId, ...value } = step;
    // Existing task editors store selector fields at the step's top level.
    return { ...clone(value), ...targetSelector(target.selector), requireUnique: true };
  });
}

module.exports = { createTaskTargetRegistry, materializeAiSteps, targetSelector, TARGET_TYPES, TTL };
