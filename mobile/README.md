# CoinPilot iOS app

The iOS target is a native SwiftUI app with Home, Orders, Assets, Market, and
More tabs. It does not embed the web dashboard or bundle its HTML screens. The
standalone browser dashboard lives under `public/`. `mobile/web` contains a
server-connection shell and an older native-WebView screen; neither is
packaged into this SwiftUI target.

For server sign-in, enter either the mobile-scoped `DASHBOARD_MOBILE_TOKEN` or
the full `DASHBOARD_TOKEN` / `operator` token. Both open the dashboard; the
mobile-scoped token still follows the allowlisted mutation surface while the
operator token additionally opens Socket.IO directly. The app is single-owner;
tokens are stored per server in the device Keychain.

The app supports a server data source and two separate bundled profiles:
fictional `bundled-preview` data for UI examples and `bundled-local` public
market data supplied explicitly at build time.

- **Server** connects to separate DRY_RUN and LIVE server addresses. The app
  reads and validates the server's reported mode before requesting account,
  history, market, or trade data or enabling mutations, so a mismatched server
  does not receive those private reads and a LIVE account cannot silently
  appear in the Paper workspace.
  It provides native market/candle charts, technical analysis, direct and
  conditional buy/sell orders, bundle suggestions, holdings, portfolio and
  activity history, configuration tuning, presets, candidate optimization,
  news, AI monitoring/consultations, validation reports, and paper-session and
  virtual-wallet controls. The tuning editor can also retarget the runtime
  market universe (`targetCoins` as a KRW-code list or `ALL`, plus
  `scalpMaxMarkets`/`maxPositions`). The server address and an operator token
  are saved on the device; the full `DASHBOARD_TOKEN` or the mobile-scoped
  `DASHBOARD_MOBILE_TOKEN` both work, and tokens are stored in Keychain
  separately for each server. Missing or stale server values stay
  distinguishable from a real zero. Authenticated scopes receive the same
  broadcast events as the web dashboard through `GET /api/stream`
  (Server-Sent Events), and a received event triggers a debounced refresh, so
  trades/signals/news/AI updates reach the app without Socket.IO. The server
  also accepts the mobile token on the Socket.IO handshake for clients that
  bundle that transport. iOS reads and writes use explicit route, query, body,
  mode, and idempotency allowlists. Upbit keys are encrypted and stored by the
  server after enrollment.
  The dedicated native enrollment flow sends them only to the matching HTTPS
  LIVE server, then clears the app's input fields; the app cannot retrieve
  registered key values. The trading worker remains server-side. The current
  exchange adapter is Upbit; the iOS app does not bundle exchange API keys or
  add a Bithumb adapter.
  The Home tab also reads the exact `GET /api/paper-validation/summary` route
  for closed paper-trade counts, recorded P&L, separate diagnostic books,
  continuity, configured-slippage sensitivity, and cross-session eligible
  sample counts. It omits mixed-configuration aggregate P&L unless the cohort
  explicitly provides comparable evidence. The compact response omits raw
  config and per-trade records. A routine summary refresh uses stored
  marks rather than requesting new tickers. The cost sensitivity is not an
  observed fill, and an empty or stale sample is never shown as zero profit.
  If LIVE balances or open orders for configured target markets are not yet
  reconciled, the server reports `SYNC_REQUIRED` and the app explains that new
  orders stay locked until that managed scope is verified.
  If the server enters `PROTECTIVE_ONLY` after a LIVE data gap, the app labels
  that state and explains that new analysis/entries are paused while
  server-side risk monitoring continues for existing managed positions. The
  server remains the authority for live order gates and protective handling.
- **Bundled Preview** reads a small, synthetic dataset packaged with the app.
  The UI labels it as example data. This mode makes no server requests, contains
  no account credentials, and cannot place trades. A local preview is not
  evidence of real account, order, settlement, fill, or background-worker
  behavior; its paper-result values are fictional examples. If the selected
  Preview profile has no valid bundled file, it remains offline and displays an
  unavailable state even when a prior server URL or token is saved.
- **Bundled Local Market Data** packages only a public KRW market list and its
  OHLCV candles. The native app opens directly to a Market-only offline screen.
  It shows no account, portfolio, live ledger, private record, API key, order
  or automation controls, and it makes no server requests or background
  refreshes. The packaged data is static until a new app build is installed;
  the app does not fetch or update it. A missing or invalid package produces an
  explicit unavailable state and never falls back to Server or Bundled Preview.
  Market details can run a deterministic single-market historical simulation
  over the full selected candle series. Replay requires at least 18 candles
  with valid, increasing timestamps, no gap beyond the Node simulator's
  `1.5 × interval` threshold, and an interval no coarser than the 30-minute
  maximum-hold rule. The 60-minute interval remains available for chart viewing
  but cannot be replayed at this strategy resolution. Replay does not fill
  gaps. It applies the pinned default strategy, 0.05% fee, and 0.10% adverse
  slippage on each side. Results are historical simulations, not live fills or
  persistent DRY_RUN activity; the newest five are saved in the app's private
  Application Support area. If stop-loss and take-profit both touch within one
  candle, stop-loss wins; if a candle opens below the stop, replay uses that
  worse open plus slippage.
  Market detail also provides an accelerated historical playback session at
  4, 10, or 20 candles per second. You can pause, resume, or restart it. The
  session shows each candle's historical close and the corresponding simulated
  balance; neither is a current quote, account balance, or fill. A bounded,
  versioned 16 KiB checkpoint ties the next candle to the dataset fingerprint,
  strategy config, and engine version. It is replaced atomically about once per
  second and when the session changes state. Relaunch restores the last saved
  cursor as paused and waits for you to resume. An abnormal process stop may
  replay up to one second of frames already shown. This is historical playback;
  it does not run continuous DRY_RUN automation. The SHA-256 checks detect
  package/checkpoint changes and do not authenticate the original market-data
  publisher or prove power-loss durability.
  Package reading and validation run away from the UI thread; the chart
  displays at most the newest 200 candles while replay uses the full series.
  Market detail labels the visible time range and full row count, offers a
  VoiceOver-readable range summary, and includes an expandable table of the 20
  latest OHLCV rows. No public market dataset is checked into this repository.

### Bundled local market data schema

Set `COINPILOT_DATA_MODE=bundled-local` and provide the absolute path to the
exact input file with `COINPILOT_LOCAL_MARKET_DATA_FILE`. The build phase copies
that file into the app as `CoinPilotBundledLocalMarketData.json` only after
validating it. The file is limited to 50 MiB. Server/default and
`bundled-preview` builds omit this resource.

Generate a current public-data pack outside the repository with:

Run the generator under a supported Node.js LTS version from the repository's
`.nvmrc`/`README.md` runtime setup. It uses public candle GETs and does not need
account credentials.

```sh
npm --prefix mobile run market-data:pack -- /private/tmp/coinpilot-public-market-v1.json
```

The generator defaults to the four existing scalp markets (BTC, ETH, XRP, SOL)
and the 1/5/15/60-minute intervals. Its optional second argument sets the
uniform candle count for each selected market/interval pair (default `200`):

```sh
npm --prefix mobile run market-data:pack -- /private/tmp/coinpilot-public-market-v1.json 1000
```

The count is collected newest-first through paged public Upbit GET requests,
with no more than 200 candles requested per API call and pacing between every
request. The installed app's build validator allows at most 20,000 candles in
total for each market across its selected intervals. Therefore, with `n`
selected intervals, the count cannot exceed `floor(20,000 / n)`; using all four
default intervals gives a per-interval ceiling of 5,000. The 50 MiB serialized
JSON limit can lower that ceiling further depending on the actual data. The
pack generator enforces both limits. It requires a new absolute output path and
never writes account, ledger, order, or credential data. The packaged values
are a static public-data snapshot, not a live ticker or fill record; the
installed app does not refresh it or run persistent DRY_RUN automation. The
offline historical simulation is isolated from server APIs, account state, and
orders. Regenerate and explicitly rebuild to refresh the snapshot.

The pack's `source` value is metadata supplied by the pack; it is not a signed
Upbit attestation. The SHA-256 sidecar checks that the bundled bytes still
match the build output, not where the data came from. The app does not apply a
maximum pack-age cutoff and does not check origin or freshness online, so this
historical dataset must not be treated as a current quote or used for orders.

The version 1 JSON schema is closed: unknown or duplicate keys are rejected at
build time, including keys nested under a market or candle. Its only fields are:

```json
{
  "schemaVersion": 1,
  "source": "upbit-public-market-api",
  "generatedAt": "2026-09-29T12:00:05.000Z",
  "markets": [
    {
      "market": "KRW-BTC",
      "candles": [
        {
          "intervalMinutes": 5,
          "timestamp": "2026-09-29T11:55:00.000Z",
          "open": 100.0,
          "high": 102.0,
          "low": 99.0,
          "close": 101.0,
          "volume": 2.0
        }
      ]
    }
  ]
}
```

`source` must be `upbit-public-market-api`; markets must be unique `KRW-…`
codes, and candle intervals must be 1, 5, 15 or 60 minutes. Candles must be
chronological within each interval, with finite, internally consistent OHLCV
values. `generatedAt` is the UTC time the input package was generated. Each
`timestamp` is the UTC start time from that source candle row. The Market screen
formats them as `YYYY. MM. DD. HH:mm:ss[.fraction] UTC`, retaining nonzero
fractional seconds; it does not infer a current exchange ticker or replace
candle times with app load time. When a selected interval has more than 200
rows, the chart displays only its newest 200 rows while preserving the full
packaged history.

The build host uses its Python 3 standard library for strict input validation.
At app launch, the native decoder repeats the size, version, field, market,
timestamp and OHLCV checks before exposing the package.

The app does not bundle or run the Node trading engine. Automated trading
continues on the configured server when iOS is suspended or closed. Every
user-originated order requires an on-device confirmation, is tied to the
selected server workspace, and is stored with an idempotency key before the
request is sent. An unresolved result locks later orders until that same
request is checked again.

## Local iPhone setup

1. Run the CoinPilot Node server on a reachable Mac or server.
2. Keep dashboard authentication enabled. Configure distinct
   `DASHBOARD_TOKEN`, `DASHBOARD_READ_ONLY_TOKEN`, and `DASHBOARD_MOBILE_TOKEN`
   values in the server's `.env`. In iOS, enter the value of either
   `DASHBOARD_MOBILE_TOKEN` (`mobile_operator` scope) or `DASHBOARD_TOKEN`
   (`operator` scope); both are accepted and stored per server. Either token is
   generated on the server, is not an App Store Connect token, and should stay
   private and out of source control. The mobile token is limited to native
   dashboard routes plus the `/api/stream` realtime channel and the Socket.IO
   handshake; it cannot retrieve existing exchange credentials. It can
   authorize the dedicated LIVE credential-registration request described
   below, but cannot read the saved key values. The operator token is the
   broadest scope and is appropriate only for the owner's own device.
3. If the build has bundled `COINPILOT_PAPER_SERVER`/`COINPILOT_LIVE_SERVER`
   values, this step is unnecessary: the app connects automatically and the
   addresses appear prefilled in Settings. Otherwise, in **More → Settings**,
   enter the Paper server address, then select **실거래**
   and enter the separate LIVE server address. Each workspace must point to a
   process configured for its matching `DRY_RUN` or `LIVE` mode. Use a private
   IPv4, unique-local IPv6 (fc00::/7), or .local address for a same-Wi-Fi server;
   public servers must use HTTPS.
4. Enter the matching server's `DASHBOARD_MOBILE_TOKEN` or `DASHBOARD_TOKEN`
   when the app asks. If the app is already open with read-only access, use
   **More → Settings → 서버 토큰 입력 또는 변경** to replace it. A read-only
   token still permits the limited observer screens but cannot send orders,
   edit settings, or control sessions. Enter Upbit keys only in the dedicated
   registration form while connected to the matching HTTPS LIVE server.
   Registration is available only while that server is stopped and
   `DASHBOARD_LIVE_CREDENTIAL_SETUP_MODE=true`; either operating token can
   register keys but cannot retrieve existing secret values. The app clears
   the input fields after the registration attempt.

Without either dashboard token, the server binds to loopback only unless it is
started with `DASHBOARD_HOST=0.0.0.0` and `DASHBOARD_ALLOW_INSECURE=true`; a
phone or Simulator cannot otherwise connect through the server computer's
private IP. On a trusted private network that opt-out pairing runs an
unauthenticated LAN dashboard that the app operates without any token. The app
rejects `localhost` and `127.0.0.1` because those addresses refer to the phone
itself. Unsigned development Simulator builds keep the test token in process
memory only because they do not have the physical app's Keychain entitlement;
the app asks again after it is relaunched. A signed physical-device build uses
Keychain. Never enter a production token in a Simulator.

iOS suspends most apps shortly after they move to the background. Keep the
trading process on a Mac or server that remains available. Native screens do
not show browser-install instructions; the iOS target is already a standalone
installed app.

## Build

Open ios/App/App.xcodeproj, choose the App scheme, and run it on an iOS
Simulator or a connected iPhone. The native target no longer needs the web
asset staging step.

The same target also builds a native macOS app on Apple Silicon with identical
features (server-mode screens, bundled server/token, SSE updates). Build and
run it without an Apple developer profile:

```sh
npm --prefix mobile run ios:build:mac
open ~/Library/Developer/Xcode/DerivedData/App-*/Build/Products/Debug/App.app
```

The macOS product is ad-hoc signed for local use. The iOS destination picker in
Xcode also lists "My Mac (Designed for iPad)", but that variant needs the Mac
registered to the development team — the native macOS build above does not.

`COINPILOT_DATA_MODE=server` is the default build mode and omits the sample
dataset from the installed app. Three additional build settings bake a
single-owner server profile into the bundle so the app connects with zero
setup: `COINPILOT_PAPER_SERVER` and `COINPILOT_LIVE_SERVER` are the default
server URLs for the Paper and LIVE workspaces (LAN HTTP and `.local` hostnames
are allowed; use HTTPS for external servers), and `COINPILOT_DEFAULT_TOKEN` is
an optional token tried automatically when the bundled server asks for sign-in.
A saved server address or token always wins over the bundled default. Leaving
these values empty keeps the manual Settings flow.

For a private single-owner build, `ios/App/LocalSecrets.json` (gitignored) is
the preferred way to ship a real credential inside the app: when the file
exists, the build phase copies it into the bundle as
`CoinPilotLocalSecrets.json`, and its `paper`, `live`, and `token` fields take
precedence over the build settings while still falling back to them when a
field is missing or invalid. The installed app itself becomes the credential —
a server that only defines `DASHBOARD_MOBILE_TOKEN` rejects every request that
does not carry it, so control is limited to devices running this build. Keep
the file out of version control; it ships inside every built `.app`.

The bundled default points at `http://<mac>.local:3000`; for a private LAN
setup the server can run with **no dashboard tokens at all** by starting it
with `DASHBOARD_HOST=0.0.0.0` and `DASHBOARD_ALLOW_INSECURE=true`. In that mode
any device on the network can read and mutate the dashboard, so use it only on
a trusted home network; the app treats an unauthenticated server as fully
operable and skips the token prompt entirely.

`LocalSecrets.json` may also declare `paperServers`/`liveServers` — arrays of
`{"label": "...", "url": "..."}` that appear in the server-address editor as
one-tap presets. This is the supported way to switch between exchanges: each
server process is pinned to one exchange via `EXCHANGE`, and the app shows the
connected exchange (Upbit `KRW-*` or Binance `USDT-*` codes, ₩/$ formatting)
automatically from `/api/auth/status` and `/api/status`. Example:

```json
{
  "paper": "http://mac.local:3000",
  "live": "http://mac.local:3001",
  "token": "...",
  "paperServers": [
    { "label": "업비트 모의", "url": "http://mac.local:3000" },
    { "label": "바이낸스 모의", "url": "http://mac.local:3002" }
  ],
  "liveServers": [
    { "label": "업비트 실전", "url": "http://mac.local:3001" },
    { "label": "바이낸스 실전", "url": "http://mac.local:3003" }
  ]
}
```

To make a local preview build, set
`COINPILOT_DATA_MODE=bundled-preview` in the Xcode build settings or the
`xcodebuild` command. That build packages the sample dataset and launches into
Bundled Preview. It can switch back to Server mode in Settings. The sample is
fictional and must not be treated as an account export. Server and preview
profiles keep separate mode preferences, so a previously selected Server mode
does not silently override the first launch of a preview build.

To package a caller-supplied public market data file, pass both build settings.
The local profile is selected by the build and ignores a previously saved
Server/Preview preference:

```sh
COINPILOT_DATA_MODE=bundled-local \
COINPILOT_LOCAL_MARKET_DATA_FILE=/absolute/path/to/coinpilot-public-market-v1.json \
xcodebuild -project mobile/ios/App/App.xcodeproj -scheme App \
  -sdk iphonesimulator -configuration Debug \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

The build fails when the input path is missing, relative, over 50 MiB,
malformed, outside schema version 1, or contains an unknown/duplicate field.
Supply only the public market and OHLCV schema above; account, ledger, order,
trade, credential or other records are rejected.

In a standalone browser, the mobile connection shell stays on its setup page
until the user submits a server address. It never redirects to a hard-coded or
previously saved host just because the page opened.

Run the native address, store, local replay, Node/Swift parity, persistence,
and simulator-build checks with:

```sh
npm run test:server-policy
npm run test:offline-replay
npm run verify:offline-replay-parity
npm run test:offline-replay-persistence
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
