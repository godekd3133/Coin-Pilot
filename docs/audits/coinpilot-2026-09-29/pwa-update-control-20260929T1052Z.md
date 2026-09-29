# PWA update control target audit — 2026-09-29

## Surface and capture

- Product: CoinPilot PWA on the current shared source.
- Task: distinguish the update action from the adjacent Paper/LIVE mode control in a narrow viewport.
- State: loopback-only `runPaperDashboard` observer attached to the active r5 paper ledger. The observer was read-only. The update banner was made visible by setting its existing `hidden` property to `false` in the isolated browser DOM; this simulates layout only and does not prove that a real waiting Service Worker was activated.
- Viewport: 360 × 800 CSS px. The accepted, inspected screenshot is [`pwa-update-control-360-20260929T1052Z.png`](pwa-update-control-360-20260929T1052Z.png).

## Step 1 — Paper/LIVE controls and waiting-update presentation

- The selected Paper control remains visually distinct; LIVE carries a lock icon. The read-only banner says orders and changes are locked. No install or mode control was clicked.
- At 360px, the LIVE control measured `x=180, y=17, w=162, h=40`; the update button measured `x=279, y=76, w=67, h=32`. Their boxes do not overlap and have a 19px vertical gap.
- At 390px, the update button measured `75 × 36px`, with a 17px vertical gap from LIVE. At 602px, the same `75 × 36px` size and 17px gap were observed. Thus the earlier automation mis-target is not reproduced as a geometric overlap in these layouts; stale/misaligned automation coordinates remain a plausible, unproven cause.
- The update target is only 32px high at 360px and 36px at 390/602px, smaller than the neighboring 44px install action. Consider increasing its touch target while preserving the current 40px reserved row and zero-overlap geometry.
- The accessibility snapshot exposes a button named `새 버전 적용`. The PWA API refresh, including `/api/market/prices/snapshot`, returned HTTP 200; browser console errors were 0. Socket.IO polling was local to staging. No trade or order route was called.

## Limits

- This is a local read-only paper observer, not production or physical-device acceptance.
- No actual Service Worker `waiting` event, `SKIP_WAITING`, controller change, app-installed state, keyboard focus path, VoiceOver/TalkBack, or installation action was exercised.
- The earlier CUA click miss was not replayed with its original coordinate trace. Therefore this audit cannot determine whether the miss came from a stale target coordinate or another automation issue.
- No PWA source file was changed in this audit; the current UI files already contain dirty WIP.
