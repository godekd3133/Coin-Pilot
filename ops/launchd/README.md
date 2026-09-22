# CoinPilot momentum shadow launchd recovery

The four plist files in this directory keep the research-only momentum owners
alive across terminal/session cleanup, restart an owner after an external
SIGTERM, and refresh the read-only orderbook evidence. They run
`runRegimeMomentumShadow.js` with fixed, regime, and BTC benchmark ledger
directories respectively; the fourth agent runs
`measureMomentumShadowQuotes.js` every 15 minutes.

These agents use public daily candles only. They do not contain exchange API
keys and cannot place live orders. The runner itself remains diagnostic-only;
`KeepAlive` is an operational continuity mechanism, not a promotion gate.

Install for the current macOS user:

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp ops/launchd/com.coinpilot.momentum-shadow.fixed.plist "$HOME/Library/LaunchAgents/"
cp ops/launchd/com.coinpilot.momentum-shadow.regime.plist "$HOME/Library/LaunchAgents/"
cp ops/launchd/com.coinpilot.momentum-shadow.benchmark.plist "$HOME/Library/LaunchAgents/"
cp ops/launchd/com.coinpilot.momentum-shadow.quotes.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.coinpilot.momentum-shadow.fixed.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.coinpilot.momentum-shadow.regime.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.coinpilot.momentum-shadow.benchmark.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.coinpilot.momentum-shadow.quotes.plist"
```

Read back the service and ledger state with:

```bash
launchctl print "gui/$(id -u)/com.coinpilot.momentum-shadow.fixed"
npm run research:momentum-shadow:preflight -- --json
```

The quote sampler is intentionally a scheduled one-shot process. It writes
`quote-quality.json` and `quote-history.jsonl` under the ignored persistent
`.coinpilot-runtime/momentum-shadow/` directory and exits after each five-sample
run. It is scheduled every 600 seconds while the UI and candidate preflight
allow a report age of 900 seconds, leaving a five-minute scheduler/sleep slack
without weakening the stale-report guard. The UI still treats a missing or
stale report as unavailable.

Do not load these agents with a changed ledger directory or execution model;
preserve the existing paper contract and let candidate preflight decide whether
an additional candidate is allowed.
