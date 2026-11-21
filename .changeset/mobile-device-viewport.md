---
'@e2e-dev/mobile': patch
---

Add `device.viewport()` to read the device's width and height in CSS pixels.
It uses snapshot geometry, with the last known size or logical screenshot
dimensions as fallbacks; fallback dimensions may not reflect a recent rotation.
