# Approved Veylo brand exports

`veylo-black-emerald-master.png` is the untouched approved master: the black background,
emerald narrow V and upper-right connection node. Do not recolor or replace it with
the earlier gray-white candidate.

Run `pwsh -NoProfile -File assets/brand/export-icons.ps1` on Windows to reproduce the
PNG, ICO and self-contained SVG exports. The fixed 896px export window only removes
excess outer spacing; it does not redraw the mark. A 19% rounded black tile provides
transparent outer corners. The ICO includes 16, 20, 24, 32, 40, 48, 64, 128 and 256px
32-bit PNG frames. The app and installer share the same exported artwork.

The SVG wrappers embed the approved raster instead of substituting an approximate
vector redraw. The small canvas startup mark uses the same V/node silhouette, with
no opaque tile so the existing transparent particle transition remains transparent.
