// Hardware compatibility only. Firmware contents are reviewed per selection in the main process.
const mtkG520 = {
    platform: 'mtk', board: 'IFPD-G520', product: 'IFPD-G520', boardPlatform: 'mt8189',
    chip: 'MT8189', project: 'aiot8391p2_64_bsp', adbVids: ['046d', '0e8d'],
    sessionReview: true,
    toolVersion: '6.2444.00.000', usb: { vid: '0e8d', pid: '2000', stage: 'preloader' }, reboot: true,
};

const acceptedFlashProfiles = Object.freeze([
  ...['download-only', 'firmware-upgrade', 'format-all-download'].map(mode => ({ ...mtkG520, mode })),
  {
    platform: 'rk', mode: 'upgrade', board: 'IFPD3576_Pro', product: 'IFPD3576_Pro', boardPlatform: 'rk3576',
    chip: '0x33353736', adbVids: ['2207'],
    sessionReview: true,
    toolVersion: '2.46', usb: { vid: '2207', pid: '350e', stages: ['loader', 'maskrom'] }, reboot: true,
  },
]);

module.exports = { acceptedFlashProfiles };
