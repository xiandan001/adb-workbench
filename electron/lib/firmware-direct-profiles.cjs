// Keep hardware/firmware admission in the main process, independent of renderer choices.
const mtkG520 = {
    platform: 'mtk', board: 'IFPD-G520', product: 'IFPD-G520', boardPlatform: 'mt8189',
    chip: 'MT8189', project: 'aiot8391p2_64_bsp', adbVids: ['046d', '0e8d'],
    firmwareSha256: '91c552437cc325ddb7cd5825debc40f86b660f88dcbf9c05eaf47016ca9e2109',
    toolVersion: '6.2444.00.000', usb: { vid: '0e8d', pid: '2000', stage: 'preloader' }, reboot: true,
    boot: {
      product: 'LANGO/IFPD-G520/IFPD-G520:17/CP2A.260605.016/20261124:userdebug/release-keys',
      system: 'alps/sys_mssi_aiot_64_cn_armv82_wifi/mssi_aiot_64_cn_armv82_wifi:17/CP2A.260605.016/20261124:userdebug/release-keys',
      vendor: 'LANGO/IFPD-G520/IFPD-G520:14/UP1A.231005.007/20261124:userdebug/release-keys',
      avb: '35559a9ae8c78fb10d7ade9a32c5afe880a389e61f2a2ac18d0c741430b4c2fa',
    },
};

const acceptedFlashProfiles = Object.freeze([
  ...['download-only', 'firmware-upgrade', 'format-all-download'].map(mode => ({ ...mtkG520, mode })),
  {
    platform: 'rk', mode: 'upgrade', board: 'IFPD3576_Pro', product: 'IFPD3576_Pro', boardPlatform: 'rk3576',
    chip: '0x33353736', adbVids: ['2207'],
    contentSha256: 'ea882602f7e4b415727b8793e770edd373d5b76c9e193fc297db64f87b0d5723',
    toolVersion: '2.46', usb: { vid: '2207', pid: '350e', stages: ['loader', 'maskrom'] }, reboot: true,
    boot: {
      product: 'LANGO/IFPD3576_Pro/IFPD3576_Pro:17/BP2A.250605.031.A3/20261124:userdebug/release-keys',
      system: 'rockchip/ssi_17_arm64/ssi_17_arm64:17/CP2A.260605.016/20261124:userdebug/release-keys',
      vendor: 'LANGO/IFPD3576_Pro/IFPD3576_Pro:14/UQ1A.240205.004.B1/20261124:userdebug/release-keys',
      avb: '12865f27b994db517d746b1faef214cd5ece97babf3a60b03bb84a3c3867106e',
    },
  },
]);

module.exports = { acceptedFlashProfiles };
