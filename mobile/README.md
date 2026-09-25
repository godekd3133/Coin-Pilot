# CoinPilot iOS shell

This is an iOS client for the existing CoinPilot dashboard. It does not
bundle or run the Node trading engine. The app opens a dashboard server URL
entered on the device, keeping Upbit keys and the always-on trading process on
the server.

## Local iPhone testing

1. Run the CoinPilot Node server on the Mac.
2. Set `DASHBOARD_TOKEN` and `DASHBOARD_HOST=0.0.0.0` in the server's `.env`.
   Without a token the server deliberately binds to loopback only.
3. Put the Mac and iPhone on the same Wi-Fi. In CoinPilot iOS, enter the Mac's
   LAN address, for example `http://192.168.0.12:3000`.
4. For access outside that Wi-Fi, use a public HTTPS endpoint protected by the
   dashboard token. Do not expose the server without authentication or place
   Upbit secrets in the iOS app.

iOS suspends most apps shortly after they move to the background, so this app
must not be used as the always-on trading worker. Keep that worker on a Mac or
server that remains available.

## Build

```sh
npm run ios:sync
open ios/App/App.xcodeproj
```

The default bundle identifier is `com.godekd3133.coinpilot`. Register that
identifier in the Apple Developer account used for signing. Xcode signing and
App Store Connect upload use the account configured in Xcode; do not put Apple
passwords, API keys, or 2FA codes in this repository.

The app supports local HTTP only for private/local network hosts; public
dashboard servers must use HTTPS. The iOS app's network permission and ATS
exception are scoped to local network access.

## Distribution note

The shell adds a first-run server setup screen and a native iOS container. A
remote beta review can still assess whether the dashboard offers enough
app-specific functionality under Apple's review guidelines. TestFlight upload,
Apple processing, tester availability, and actual installation are separate
checkpoints.
