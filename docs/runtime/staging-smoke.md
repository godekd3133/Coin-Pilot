# CoinPilot staging smoke

Use the isolated staging runner for frontend/API smoke checks. Do not use `npm start` as a staging smoke command when the workspace contains a user `dry_portfolio.json`; the main entrypoint intentionally follows the configured portfolio file.

```bash
STAGING_PORT=3101 \
STAGING_TARGET_COINS=KRW-BTC,KRW-ETH \
npm run dashboard:staging
```

The runner guarantees:

- `DRY_RUN=true` regardless of the user environment.
- Empty API key values are passed to the child process; public market data only is used.
- The dashboard runs on the requested staging port.
- The default analysis interval is 30 seconds, leaving slack below the 60-second analysis-data fail-closed budget; override it with `STAGING_CHECK_INTERVAL_MS` when needed.
- Portfolio and paper ledger files are written under a timestamped `.staging-runtime/` directory.
- AI CLI advisory calls are disabled for the smoke.
- The root `dry_portfolio.json` is not read or written.

## Smoke gates

1. Open `http://localhost:3101/` and confirm the header says `모의투자` and `API 연결됨`.
2. Check `근거 로그`, `거래 실행`, `포트폴리오`, `시장 관찰`, `전략 연구`, `뉴스 센터`, `환경 설정`, `검증 기록`, and `AI 자문`.
3. Confirm the selected market shows a real public price and candle response.
4. Confirm the live order control remains locked because the process is `DRY_RUN`.
5. Confirm the browser console has no errors and the staging directory is the only runtime storage touched.
6. Stop with `Ctrl+C` after the smoke; do not run a live order from the staging UI.

For a mobile smoke, use a Chromium viewport of `390x844` and verify both `document.documentElement.scrollWidth <= window.innerWidth` and the fixed `.pilot-sidebar` rectangle does not overlap the first-viewport `데이터 상태` gate card. The current redesigned shell keeps the two-row, ten-button navigation but uses compact mobile sizing so the observed overlap is `0px`. The default staging analysis interval is 30 seconds because the core analysis-data fail-closed budget remains 60 seconds; a 60-second staging interval can stop on normal scheduler jitter rather than a real missing-market condition.

The staging runner is a validation lane, not profitability or live-settlement evidence.
