const requirements = require('./membership-entitlements.json');

function canUseMembershipFeature(status, feature) {
  const requirement = Object.hasOwn(requirements, feature) ? requirements[feature] : null;
  if (requirement === 'available') return true;
  return status?.activated === true &&
    (requirement === 'activated' || requirement === 'vip' && status.scope === 'vip');
}

module.exports = { canUseMembershipFeature };
