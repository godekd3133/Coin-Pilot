# CoinPilot iOS app

The iOS target is a native SwiftUI app with Home, Assets, Activity, and
Settings tabs. It does not embed the web dashboard or bundle its HTML screens.
The standalone browser dashboard lives under `public/`. `mobile/web` contains
a server-connection shell and an older native-WebView screen; neither is
packaged into this SwiftUI target.

The app has a server data source. A build with `bundled-preview` selected also
packages and enables a second, local sample-data source:

- **Server** reads account, portfolio, market, and activity through the native
  client's GET allowlist. It never submits orders. The server address is saved
  on the device; the read-only token is stored in Keychain separately for each
  server. A missing or stale server value stays distinguishable from a real
  zero.
  The Home tab also reads the exact `GET /api/paper-validation/summary` route
  for closed paper-trade counts, recorded P&L, separate diagnostic books,
  continuity, configured-slippage sensitivity, and cross-session eligible
  sample counts. It omits mixed-configuration aggregate P&L unless the cohort
  explicitly provides comparable evidence. The response omits raw config,
  positions, and per-trade records; order and paper-session control routes
  remain outside the native allowlist. A routine summary refresh uses stored
  marks rather than requesting new tickers. The cost sensitivity is not an
  observed fill, and an empty or stale sample is never shown as zero profit.
  If LIVE balances or open orders for configured target markets are not yet
  reconciled, the server reports `SYNC_REQUIRED` and the app explains that new
  orders stay locked until that managed scope is verified.
  If the server enters `PROTECTIVE_ONLY` after a LIVE data gap, the app labels
  that state and explains that new analysis/entries are paused while
  server-side risk monitoring continues for existing managed positions. The
  app cannot resume trading or submit a protective order.
- **Bundled Preview** reads a small, synthetic dataset packaged with the app.
  The UI labels it as example data. This mode makes no server requests, contains
  no account credentials, and cannot place trades. A local preview is not
  evidence of real account, order, settlement, fill, or background-worker
  behavior; its paper-result values are fictional examples.

The app does not bundle or run the Node trading engine. Exchange keys and the
trading process stay on the server. The iOS app does not submit orders.

## Local iPhone setup

1. Run the CoinPilot Node server on a reachable Mac or server.
2. Keep dashboard authentication enabled. Configure distinct `DASHBOARD_TOKEN`
   and `DASHBOARD_READ_ONLY_TOKEN` values in the server's `.env`; use the
   read-only token in the iOS app. The server denies it access to order,
   settings, and Socket.IO routes.
3. In the app's Settings tab, enter the server's private IPv4, unique-local
   IPv6 (fc00::/7), or .local address, for example
   http://192.168.0.12:3000. Public servers must use HTTPS.
4. Enter the read-only token when the app requests it. Do not put the full
   dashboard token or Upbit credentials in the iOS app.

Without either dashboard token, the server binds to loopback only; a phone or
Simulator cannot connect through the server computer's private IP. The app
rejects `localhost` and `127.0.0.1` because those addresses refer to the phone
itself. Unsigned development Simulator builds keep the test token in process
memory only because they do not have the physical app's Keychain entitlement;
the app asks again after it is relaunched. A signed physical-device build uses
Keychain. Never enter a production token in a Simulator.

iOS suspends most apps shortly after they move to the background. Keep the
trading process on a Mac or server that remains available.

## Build

Open ios/App/App.xcodeproj, choose the App scheme, and run it on an iOS
Simulator or a connected iPhone. The native target no longer needs the web
asset staging step.

`COINPILOT_DATA_MODE=server` is the default build mode and omits the sample
dataset from the installed app. To make a local preview build, set
`COINPILOT_DATA_MODE=bundled-preview` in the Xcode build settings or the
`xcodebuild` command. That build packages the sample dataset and launches into
Bundled Preview. It can switch back to Server mode in Settings. The sample is
fictional and must not be treated as an account export. Server and preview
profiles keep separate mode preferences, so a previously selected Server mode
does not silently override the first launch of a preview build.

In a standalone browser, the mobile connection shell stays on its setup page
until the user submits a server address. It never redirects to a hard-coded or
previously saved host just because the page opened.

Run the native address, store, and simulator-build checks with:

```sh
npm run test:server-policy
npm run test:store
npm run ios:build:sim
npm run ios:build:preview
```

The default bundle identifier is com.godekd3133.coinpilot. Xcode signing and
App Store Connect upload use the account configured in Xcode; do not put Apple
passwords, API keys, or 2FA codes in this repository.

A successful simulator build is separate from distribution signing, TestFlight
upload, Apple processing, tester availability, and installation on a physical
iPhone.
