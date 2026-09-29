# Physical iPhone TestFlight capture

- Device: paired iPhone 15 Pro Max
- Installed app: CoinPilot `1.0 (4)`, verified with `xcrun devicectl device info apps`
- New TestFlight build: CoinPilot `1.0 (5)`, `Ready to Submit`, attached to `CI CoinPilot Internal`; Build 5 is not installed on this phone yet
- Build 6 upload is complete; App Store Connect marks it Ready to Submit and lists it as Testing in CI CoinPilot Internal (1 tester). It is not installed on this phone
- Capture: `more-screen.png`, taken after launching `com.godekd3133.coinpilot`
- Screen: native More tab with dashboard feature entry points and five-tab navigation
- Orders, token entry, and account changes were not performed during this review
- The iPhone's saved Paper and LIVE addresses currently match
- Lightsail auth was updated with a separate mobile operator token; login returns `tokenScope=mobile_operator` and authenticated `GET /api/status` succeeds
- The API reports `DRY_RUN` and `isRunning=false`; `DASHBOARD_START_TRADER_ON_BOOT=false` preserves that stopped state across the service restart
- The token is stored outside the repository at `~/.ssh/coinpilot-mobile-token` with mode `0600`; its value was never printed
- The iPhone still needs that token entered in **More → Settings** so it can save it to Keychain; credential entry is handed to the device owner
- Only the Paper Lightsail instance exists; the saved Paper and LIVE URLs match, and the server has no Upbit API keys. A separate LIVE-mode endpoint and live account/write flow remain unverified
