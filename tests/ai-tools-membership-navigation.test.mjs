import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const app = read('../src/App.jsx');
const log = read('../src/components/LogAnalyzer.jsx');

function loadCallbacks(source, names, globals) {
  const declarations = new Map();
  traverse(parse(source, { sourceType: 'module', plugins: ['jsx'] }), {
    VariableDeclarator({ node }) {
      if (names.includes(node.id.name)) declarations.set(node.id.name, source.slice(node.start, node.end));
    }
  });
  return runInNewContext(`const ${names.map(name => declarations.get(name)).join(', ')}; ({ ${names.join(', ')} });`, globals);
}

function appContext({ activeTab, activeDeviceId, devices }) {
  const membershipOriginRef = { current: null };
  const devicesRef = { current: devices };
  const effects = [];
  const context = { activeTab, activeDeviceId, devicesRef, membershipOriginRef, tr: value => value,
    rememberMembershipOrigin: origin => { membershipOriginRef.current = origin; },
    setActiveDeviceId: id => effects.push(['select', id]),
    refreshVipStatus: () => effects.push('read-license'),
    acceptVerifiedStatus: status => status?.activated === true,
    showToast: text => effects.push(text)
  };
  const callbacks = loadCallbacks(app, ['openMembership', 'returnFromMembership', 'activateMembership'], context);
  return { ...callbacks, devicesRef, membershipOriginRef, effects };
}

test('a contextual cancellation retains the origin device even when it disappears', () => {
  const selected = { id: 'A', status: 'device' };
  const other = { id: 'B', status: 'device' };
  const context = appContext({ activeTab: 'devices', activeDeviceId: 'B', devices: [selected, other] });
  context.openMembership({ deviceId: 'A', feature: 'inspection' });
  assert.equal(context.membershipOriginRef.current.open, true);
  assert.equal(context.membershipOriginRef.current.deviceId, 'A');
  assert.equal(context.membershipOriginRef.current.activeDeviceId, 'B');
  context.devicesRef.current = [other];
  context.returnFromMembership();
  assert.equal(context.membershipOriginRef.current.open, false);
  assert.equal(context.membershipOriginRef.current.deviceId, 'A');
  assert.equal(context.membershipOriginRef.current.devices[0], selected);
  assert.deepEqual(context.effects, ['read-license', '所选设备已断开，不会自动改用其他设备。已有证据仍属于原设备。']);
});

test('only a verified activation returns to the origin, without running a device or AI operation', () => {
  const context = appContext({ activeTab: 'ai-workspace', activeDeviceId: 'A', devices: [{ id: 'A', status: 'device' }] });
  context.openMembership({ deviceId: 'A' });
  context.activateMembership({ activated: false });
  assert.equal(context.membershipOriginRef.current.open, true);
  context.activateMembership({ activated: true });
  assert.equal(context.membershipOriginRef.current.open, false);
  assert.deepEqual(context.effects, ['read-license']);
  assert.match(app, /if \(origin\) return origin\.activeDeviceId;\s+const target = worksetTargetRef\.current/);
});

test('direct membership page has no return action and feature dialogs use the live origins', () => {
  assert.match(app, /<MemberCenter\s+theme=\{theme\}\s+vipStatus=\{vipStatus\}\s+onActivated=\{activateMembership\}\s+onRetry=\{refreshVipStatus\}\s+showToast=\{showToast\}\s+\/>/);
  assert.match(app, /membershipOrigin\?\.open && <MembershipDialog[\s\S]{0,320}onReturn=\{returnFromMembership\}/);
  assert.match(app, /<AiWorkspace[\s\S]{0,1200}onOpenMembership=\{openMembership\}/);
  assert.match(app, /<AiToolsWorkspace[^\n]*onOpenMembership=\{\(\) => openMembership/);
  const inspection = read('../src/components/InspectionPanel.jsx');
  assert.match(inspection, /onClick=\{\(\) => onOpenMemberCenter\?\.\(tr\('设备巡检'\)\)\}/);
  assert.match(inspection, /onClick=\{startInspection\} disabled=\{!isOnline\}/);
});

test('log membership return preserves the original window and marks an expired source', () => {
  const membershipOriginRef = { current: null };
  const effects = [];
  const globals = { source: 'realtime', captureDeviceId: 'A', deviceId: 'B', documentId: 'log-1', devices: [],
    membershipOriginRef, tr: value => value, setMembershipOrigin: value => effects.push(value ? 'show' : 'close-dialog'),
    setNote: value => effects.push(value), refreshVipStatus: () => effects.push('read-license')
  };
  const callbacks = loadCallbacks(log, ['showVipBlock', 'returnFromMembership'], globals);
  callbacks.showVipBlock('semantic-search');
  assert.equal(membershipOriginRef.current.deviceId, 'A');
  assert.equal(membershipOriginRef.current.documentId, 'log-1');
  globals.documentId = 'log-2';
  callbacks.returnFromMembership();
  assert.deepEqual(effects, ['show', 'read-license', 'close-dialog', '日志来源已变化，操作已取消，请重新核对。']);
  assert.doesNotMatch(log, /logAnalyzerClose\?*\./);
});
