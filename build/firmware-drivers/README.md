# Optional authorized firmware driver resources

The public build does not supply manufacturer driver binaries. Only use these resource folders in a build whose distribution is authorized by the rights holders. Preserve the original signed INF, CAT and SYS files and their folder layout.

- `rk/rockusb.inf`, `rk/rockusb.cat`, `rk/rockusb.sys`
- `mtk/cdc-acm.inf`, `mtk/cdc-acm.cat`, `mtk/x64/usb2ser.sys`

The runtime verifies the approved package fingerprints before staging it and Windows verifies the catalog and driver during installation. Users of the public build can choose a supported local signed driver package from the install action.
