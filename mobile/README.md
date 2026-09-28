# CoinPilot iOS shell

This is an iOS client with its own bundled mobile interface. On first launch it
opens directly to the app's portfolio overview and reads account, market, and
activity information from the configured CoinPilot server. The native client
uses a small allowlist of read-only API routes; it does not load the web
dashboard as its screen. The dashboard token is kept in iPhone Keychain and is
scoped to the configured server.

The bundled server setup page remains available from the **서버** menu. Its
browser-only shell continues to open the configured web dashboard by default.
The main dashboard PWA remains same-origin on the server.

It does not bundle or run the Node trading engine. Upbit keys and the
always-on trading process stay on the server.

## Local iPhone testing

1. Run the CoinPilot Node server on the Mac.
2. Set `DASHBOARD_TOKEN` and `DASHBOARD_HOST=0.0.0.0` in the server's `.env`.
   Without a token the server deliberately binds to loopback only.
3. The app connects to the Lightsail API by default. For local testing,
   open the **서버** menu and enter the Mac's private IPv4, unique-local IPv6
   (`fc00::/7`), or `.local` address, for example
   `http://192.168.0.12:3000`. Scoped link-local IPv6 addresses are not
   supported because their interface scope is device-specific.
4. Enter the server's `DASHBOARD_TOKEN` in the app when prompted. It is saved
   in Keychain for that server. Keep dashboard authentication enabled and do
   not place Upbit secrets in the iOS app.

iOS suspends most apps shortly after they move to the background, so this app
must not be used as the always-on trading worker. Keep that worker on a Mac or
server that remains available.

## Build

```sh
npm run ios:sync
open ios/App/App.xcodeproj
```

Run the native URL allowlist regression cases on macOS with
`npm run test:server-policy` before staging an iOS build.

The default bundle identifier is `com.godekd3133.coinpilot`. Register that
identifier in the Apple Developer account used for signing. Xcode signing and
App Store Connect upload use the account configured in Xcode; do not put Apple
passwords, API keys, or 2FA codes in this repository.

The app supports local HTTP only for private/local network hosts; public
dashboard servers must use HTTPS. The iOS app's network permission and ATS
exception are scoped to local network access.

## Distribution note

The app bundle contains its portfolio, holdings, activity, and settings
screens. It reads from the configured server and does not run the trading
engine on iOS. A successful simulator build is separate from signing,
TestFlight upload, Apple processing, tester availability, and installation on
a physical iPhone.
