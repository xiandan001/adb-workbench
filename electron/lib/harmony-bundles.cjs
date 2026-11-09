const { tr } = require('./localization.cjs');

function bundleName(value) {
  if (typeof value !== 'string' || value.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(value)) {
    throw Object.assign(new Error(tr('鸿蒙应用 Bundle 名称无效。')), { code: 'INVALID_BUNDLE', safe: true });
  }
  return value;
}

function readBmJson(value) {
  const text = String(value || '').replace(/^\uFEFF/, '');
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw formatError();
  // bm prefixes native JSON with a heading. Ignore no more than 16 non-JSON headings.
  const starts = [...text.matchAll(/^[ \t]*(?:\[|{)/gm)].slice(0, 16);
  for (const match of starts) {
    const start = match.index + match[0].length - 1;
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '[' || char === '{') depth++;
      else if (char === ']' || char === '}') {
        if (--depth !== 0) continue;
        try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
      }
    }
  }
  throw formatError();
}

function formatError() {
  return Object.assign(new Error(tr('无法识别设备返回的 bm JSON，请确认系统版本与工具能力。')), { code: 'HARMONY_BUNDLE_FORMAT', safe: true });
}

const bool = (...values) => values.find(value => typeof value === 'boolean') ?? null;
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && ![...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);

function bundleSummary(value) {
  const info = typeof value === 'string' ? { name: value } : value;
  if (!info || typeof info !== 'object' || Array.isArray(info)) throw formatError();
  const application = info.applicationInfo || {};
  const name = bundleName(info.bundleName || info.name || application.bundleName);
  return { packageName: name, bundleName: name, platform: 'harmony',
    apkName: typeof application.label === 'string' && !/^\$/.test(application.label) ? application.label : name,
    path: '', uid: text(info.uid ?? application.uid), versionName: text(info.versionName ?? application.versionName),
    versionCode: text(info.versionCode ?? application.versionCode),
    system: bool(info.isSystemApp, application.isSystemApp), enabled: bool(info.enabled, application.enabled) };
}

function parseBundleList(output) {
  const value = readBmJson(output);
  const items = Array.isArray(value) ? value : value?.bundleNames || value?.bundles || value?.bundleInfos;
  if (!Array.isArray(items) || items.length > 10000) throw formatError();
  const names = new Set();
  return items.map(bundleSummary).filter(item => {
    if (names.has(item.packageName)) return false;
    names.add(item.packageName); return true;
  }).sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function abilityList(info) {
  const rows = [];
  const add = (ability, module = {}) => {
    if (!ability || !validName(ability.name)) return;
    const moduleName = ability.moduleName || module.moduleName || module.name || '';
    if (moduleName && !validName(moduleName)) return;
    const exported = bool(ability.exported, ability.visible);
    const type = ability.type;
    const page = [1, '1', 'page', 'PAGE', 'UIAbility'].includes(type);
    const main = module.mainElementName === ability.name || module.mainAbility === ability.name;
    const skills = Array.isArray(ability.skills) ? ability.skills : [];
    const launcher = skills.some(skill => Array.isArray(skill.actions) && skill.actions.some(action => ['ohos.want.action.home', 'action.system.home'].includes(action))
      && Array.isArray(skill.entities) && skill.entities.includes('entity.system.home'));
    const isUi = page || (type == null && (main || launcher));
    rows.push({ name: ability.name, moduleName, exported, type: text(type), isLauncher: main || launcher, launchable: exported !== false && isUi });
  };
  for (const ability of info.abilityInfos || []) add(ability);
  for (const module of info.hapModuleInfos || []) {
    if (!module || typeof module !== 'object' || module.abilityInfos !== undefined && !Array.isArray(module.abilityInfos)) throw formatError();
    for (const ability of module.abilityInfos || []) add(ability, module);
  }
  const unique = new Map();
  for (const ability of rows) {
    const key = ability.moduleName + ':' + ability.name;
    const previous = unique.get(key);
    const exported = previous?.exported === false || ability.exported === false ? false : ability.exported ?? previous?.exported ?? null;
    unique.set(key, previous ? { ...ability, exported, isLauncher: previous.isLauncher || ability.isLauncher,
      launchable: exported !== false && (previous.launchable || ability.launchable) } : ability);
  }
  return [...unique.values()];
}

function parseBundleDetail(output, expectedName) {
  bundleName(expectedName);
  const parsed = readBmJson(output);
  const info = parsed?.bundleInfo || parsed;
  const summary = bundleSummary(info);
  if (summary.packageName !== expectedName || info.applicationInfo?.bundleName && info.applicationInfo.bundleName !== expectedName) {
    throw Object.assign(new Error(tr('设备返回的应用信息与所选 Bundle 不一致，未执行操作。')), { code: 'BUNDLE_TARGET_MISMATCH', safe: true });
  }
  if (info.abilityInfos !== undefined && !Array.isArray(info.abilityInfos) || info.hapModuleInfos !== undefined && !Array.isArray(info.hapModuleInfos)) throw formatError();
  const abilities = abilityList(info);
  const launchable = abilities.filter(ability => ability.launchable);
  const preferred = launchable.filter(ability => ability.isLauncher);
  const launchCandidates = (preferred.length ? preferred : launchable).map(ability => ({ abilityName: ability.name, moduleName: ability.moduleName }));
  const requested = Array.isArray(info.reqPermissions) ? info.reqPermissions : Array.isArray(info.applicationInfo?.permissions) ? info.applicationInfo.permissions : [];
  const permissions = [...new Set(requested.filter(value => typeof value === 'string'))].map(name => ({ name, granted: null, source: 'requested' }));
  return { ...summary, abilities, launchCandidates, permissions, firstInstallTime: text(info.installTime),
    lastUpdateTime: text(info.updateTime), installer: '', raw: String(output) };
}

function selectLaunchAbility(detail, requested = {}) {
  let candidates = detail.launchCandidates;
  if (requested.abilityName) {
    candidates = detail.abilities.filter(item => item.launchable && item.name === requested.abilityName
      && (requested.moduleName === undefined || item.moduleName === requested.moduleName))
      .map(item => ({ abilityName: item.name, moduleName: item.moduleName }));
  }
  if (candidates.length !== 1) throw Object.assign(new Error(candidates.length
    ? tr('检测到多个可启动 Ability，请先选择入口。') : tr('未找到可确认的页面 Ability，不能猜测应用启动入口。')),
  { code: candidates.length ? 'ABILITY_SELECTION_REQUIRED' : 'ABILITY_UNAVAILABLE', safe: true });
  return candidates[0];
}

module.exports = { bundleName, readBmJson, parseBundleList, parseBundleDetail, selectLaunchAbility };
