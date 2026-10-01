# CoinPilot LIVE on the existing Lightsail host

The Paper dashboard stays at `https://52.78.156.161/`. The dedicated LIVE
process listens only on `127.0.0.1:3101`; Nginx serves it at
`https://52.78.156.161/live/` on the same static IP and certificate.
The IP, endpoint, and certificate relationship above are operator-supplied
deployment values; this repository review did not query the AWS account or
probe the host.

## Capacity gate

Verified on 2026-10-01: the instance is `nano_3_0` — 2 vCPUs, **412 MB**
usable RAM (0.5 GB nominal), 20 GB disk (15 GB free). `free -m` showed
136 MB available while Paper's node process used ~55 MB RSS. On the same day
the Paper process was SIGKILLed once (status=9/KILL, restarted by systemd) —
memory pressure already kills the single running process. Running a second
Node process beside Paper on this bundle is NOT currently viable without
either a Micro-bundle resize or strict `--max-old-space-size` caps on both
services; Paper already runs with `--max-old-space-size=256`. Checked against
the public
[Lightsail pricing](https://aws.amazon.com/lightsail/pricing/) and
[instance bundle table](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html):
the public-IPv4 Linux Nano bundle is $5/month (0.5 GB, 2 vCPUs, 20 GB), and
Micro is $7/month (1 GB, 2 vCPUs, 40 GB). Account credits, tax, and regional
data-transfer allowances can affect the actual bill. Public prices do not
establish this account's current bundle or available RAM.

## Install the LIVE code and state separately

Keep the LIVE release in `/opt/coinpilot-live/current`, separate from the
Paper checkout. Use the same reviewed application revision and install its
locked Node dependencies there. Keep persistent runtime files under
`/var/lib/coinpilot-live` so a code update cannot replace the portfolio,
execution evidence, log files, or encrypted Upbit credentials. The host-wide
public quota coordinator uses the separate `/var/lib/coinpilot-rate` directory;
profile state must remain separate from the shared rate state.

The systemd units invoke `/usr/bin/node` directly. Provision a supported Node
LTS runtime at that path before installing the release: CoinPilot accepts
Node.js `24.21.0` and later `24.x` patches. Keep the host on the latest
security-patched release for its selected LTS line. A user-local `nvm` install
is not sufficient unless `/usr/bin/node` is deliberately managed to point to
that verified release.

After placing the reviewed checkout at the release path, verify the exact
binary systemd will use and install only the lockfile dependencies as the
service owner:

```sh
cd /opt/coinpilot-live/current
/usr/bin/node --version
/usr/bin/node src/scripts/verifyNodeRuntime.js
sudo -u ubuntu npm ci --omit=dev
```

The version preflight must print `CoinPilot Node.js runtime` and exit zero
before either service is enabled. The coordinator unit is installed alongside
the LIVE unit; LIVE declares it as a required dependency so it starts before
the trading process. `UPBIT_RATE_COORDINATOR_STATE_DIR` points both units to
the coordinator's isolated shared state under `/var/lib/coinpilot-rate`.

Every other CoinPilot process on this host that makes public Upbit requests
must also set `UPBIT_RATE_COORDINATOR_REQUIRED=true` and the same
`UPBIT_RATE_COORDINATOR_STATE_DIR`, then require and start after
`coinpilot-upbit-rate.service`. Keep that process's `COINPILOT_STATE_DIR`
profile-specific. Its systemd unit must allow access to `/var/lib/coinpilot-rate`
and run as the same `ubuntu` account that owns the socket. Until the existing
Paper unit adopts this contract, the coordinator only covers LIVE requests;
the host's combined public-request quota is not coordinated.

```sh
sudo install -d -o ubuntu -g ubuntu -m 0700 /var/lib/coinpilot-live
sudo install -d -o root -g root -m 0755 /etc/coinpilot
sudo install -o root -g root -m 0644 ops/systemd/coinpilot-live.service /etc/systemd/system/coinpilot-live.service
sudo install -o root -g root -m 0644 ops/systemd/coinpilot-upbit-rate.service /etc/systemd/system/coinpilot-upbit-rate.service
sudo install -o root -g root -m 0600 ops/systemd/coinpilot-live.env.example /etc/coinpilot/coinpilot-live.env
```

Before starting the service, replace `DASHBOARD_MOBILE_TOKEN` with a private
token you can enter on the app's LIVE workspace, for example one generated on
the Lightsail host with `openssl rand -hex 32`. Reuse the Paper mobile token if
it is available on the host.
Do not put either Upbit key in this environment file. The native app registers
the pair once, after which the LIVE service validates it with an account-only
Upbit request and stores it encrypted under `/var/lib/coinpilot-live/secrets/`.

The example enables `DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT` and
`DASHBOARD_LIVE_MANUAL_RISK_PROTECTION`, and disables
`DASHBOARD_START_TRADER_ON_BOOT`. Manual-prepare synchronizes the account and
open orders, then keeps the position-risk monitor armed for manually filled
positions: strict strategy positions and exchange-recovered holdings are
watched for stop-loss, take-profit, and max-hold exits on the priority risk
lane. New automatic entries stay paused; only protective SELLs are
automated. Set `DASHBOARD_LIVE_MANUAL_RISK_PROTECTION=false` to keep the old
fully-manual posture, where a manual LIVE buy records a position without any
background exit monitoring.

Two protection limits remain structural:

- Upbit has no exchange-side stop orders. Protection is a process-owned
  monitor; if the service is killed hard (`SIGKILL`, host reboot, OOM) the
  monitor dies with it. `Restart=on-failure` plus boot reconciliation is the
  liveness backstop, not a guarantee.
- `TimeoutStopSec=infinity` means a stop waits for the protective drain. A
  forced power loss still abandons open positions until the next boot
  re-synchronizes them.

## Add the HTTPS path without replacing Paper

Install `ops/nginx/coinpilot-live-location.conf` as an Nginx snippet and add
this line inside the existing TLS virtual-host block for `52.78.156.161`:

```nginx
include /etc/nginx/snippets/coinpilot-live-location.conf;
```

The trailing slash on `proxy_pass` removes the `/live/` prefix before forwarding
to port `3101`. `X-Forwarded-Proto` is passed from the HTTPS request so the key
enrollment endpoint can reject plain HTTP. Port `3101` stays loopback-only and
does not need a Lightsail firewall rule.

After the LIVE environment file and Nginx include are installed, confirm the
capacity gate before starting the service. Starting LIVE also starts its
required coordinator dependency:

```sh
sudo install -o root -g root -m 0644 ops/nginx/coinpilot-live-location.conf /etc/nginx/snippets/coinpilot-live-location.conf
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now coinpilot-live
sudo systemctl reload nginx
curl -fsS https://52.78.156.161/live/health
```

Check `/live/api/auth/status` for an authentication-required response, then
sign in to the app's LIVE workspace using the configured mobile operator token.
The Paper workspace continues to use the root URL and its own token record.

## Stop and restart the LIVE service

The LIVE unit uses `TimeoutStopSec=infinity` because CoinPilot holds the profile
lock and keeps protective-only monitoring active until positions are flat and
exchange state is verified. A normal `systemctl stop` or `systemctl restart`
can therefore remain pending while a position is open or reconciliation is
unavailable. Check the service journal and wait for the protective drain to
complete before performing maintenance. Do not add a finite force-kill deadline
without replacing this process with a separately verified protection owner.

## Recovery semantics for manual LIVE orders

Every manual order path requires an `Idempotency-Key`. Before the first
exchange POST the request journal durably stores a request-level UUID; single
orders send that same UUID to Upbit as the order `identifier`. A same-key retry
after a crash resolves the request with a GET-only identifier readback — the
route is never replayed, a second POST never happens, and a record whose
outcome cannot be resolved stays `unknown` until operator reconciliation.

Multi-leg requests (`/api/trade/execute-bundle`, `/api/trade/smart-buy`,
`/api/trade/smart-sell`) bind a separate fresh UUID to each leg
(`sell`, `buy`, `buy:<market>`, `sell:<market>`) and persist it in the journal
before that leg's POST. A same-key retry resolves every journaled leg
independently; legs recorded as dispatched report their terminal fill, and
legs that provably never reached the exchange report `not_dispatched`. A
request with no journaled legs (crash before the first leg was attached)
stays `unknown` — dynamic plan legs are never recomputed or replayed.

## What this repository has proven vs. what remains operator-verified

Proven by code + tests at this revision:

- `DRY_RUN=false` alone cannot start automatic trading; the scalping
  `fixed_config` validation gate (promoted + fresh + confidence + no drift)
  must pass first.
- Live order intent is persisted before dispatch; a lost response resolves by
  identifier readback instead of a duplicate order.
- Orders only become positions after a complete observed fill plus settlement
  readback is recorded; ambiguous outcomes lock the market.
- The rate coordinator is a required systemd dependency and the risk lane is
  prioritized over analysis traffic.
- Manual LIVE sessions can run unattended position protection via
  `DASHBOARD_LIVE_MANUAL_RISK_PROTECTION=true` (this revision's change).

Verified on the real host (`coinpilot-paper-seoul`, 52.78.156.161) on
2026-10-01 via `ops/lightsail/verify-live-host.sh`, and LIVE was then
deployed (revision `de34760`):

- `nano_3_0` bundle confirmed: **412 MB** total RAM. A 1 GB swapfile was added
  (`/swapfile`, fstab-persisted) after the Paper process was found SIGKILLed
  once (status=9/KILL) the same day. After deployment `available` sits near
  160-210 MB; a Micro-bundle resize is still the clean fix.
- Node **24.21.0** is provisioned at `/usr/bin/node`; Paper keeps its
  `/usr/local/bin/node` v22 runtime untouched.
- `coinpilot-upbit-rate` and `coinpilot-live` are installed, enabled, and
  `active`; the coordinator socket is live at
  `/var/lib/coinpilot-rate/upbit-rate-coordinator/coordinator.sock`, and the
  LIVE unit `Requires=` it.
- Nginx serves `https://52.78.156.161/live/` → `127.0.0.1:3101`;
  `/live/health` returns 200 and `/live/service-ready` reports `ready:true`.
- LIVE boots in credential-setup mode (`LIVE 키 등록 대기`), with
  `liveManualPrepareOnBoot` and `liveManualRiskProtection` enabled and
  automatic trading disabled. `NODE_OPTIONS=--max-old-space-size=128` caps
  the LIVE heap for the nano bundle.
- `/etc/coinpilot.env` and `/etc/coinpilot/coinpilot-live.env` contain no
  plaintext Upbit keys.
- **Paper now shares the coordinator contract**: `coinpilot.service` was
  redeployed on revision `de34760` running as `ubuntu` (the coordinator
  socket is owner-only `0700`/`0600` by design), on `/usr/bin/node` 24.21,
  with `Requires=coinpilot-upbit-rate.service` and
  `UPBIT_RATE_COORDINATOR_REQUIRED=true`. `/service-ready` reports
  `marketDataCoordinator.available=true`; both services now share the host's
  public-IP quota. The previous tree is retained at
  `/opt/coinpilot/app.old-de34760` and the previous unit/env at
  `/etc/systemd/system/coinpilot.service.bak-precoord` /
  `/etc/coinpilot.env.bak-precoord` for rollback.

Resolved after deployment:

- **`no_authorization_ip` — RESOLVED**: after the owner added
  `52.78.156.161` to the Upbit key allowlist, `POST /api/live/credentials`
  validated, encrypted, and stored the keys; on boot the service synced the
  account (`불일치 없음`), reached `liveManualPrepared`, and armed the
  manual risk watch (`manualProtectionActive=true`).
- **Rejected-order wedge — RESOLVED in `29d7bc9`**: a real
  `insufficient_funds_bid` refusal left the request's idempotency key
  permanently `unknown` (identifier 404 readbacks were always treated as
  ambiguous). Definitive `ORDER_REJECTED` evidence is now indexed per
  intent; a 404 plus durable rejection resolves the record as a terminal
  400, while a bare 404 still stays unknown. Verified on the live host —
  the wedged key now replays as completed/400.
- **Round trip — PROVEN 2026-10-01**: `POST /api/trade/buy` 5,000 KRW filled
  2.47524752 XRP @2020 (+2.5 fee); after a SIGKILL restart the boot sync
  recovered the holding into the strategy and re-armed the risk watch;
  `POST /api/trade/sell` filled @2025 (+2.506 fee) with settlement readback
  observed; KRW wallet went 10,000.83 -> 10,008.20 (+7.37 net).
- **Upbit order-state semantics learned from real fills**: market `price`
  bids terminate as `state=cancel` (residual is sub-unit `locked` KRW dust)
  with no `remaining_volume`/`avg_price`; `market` asks end `done` but also
  leave `avg_price` empty. Both are normalized from `trades[]` sums. An
  `incomplete fill records` startup reason previously poisoned the evidence
  writer and made the protective drain non-terminating — recoverable
  reconciliation states now block the affected market only.

Still requires operator action — do not claim done:

- Add `52.78.156.161` to the Upbit key IP allowlist, then register keys via
  `POST /live/api/live/credentials` (or the app's LIVE workspace). On success
  the service validates the keys, stores them encrypted under
  `/var/lib/coinpilot-live/secrets/`, and runs manual-prepare (account/order
  reconciliation + protective monitor arm).
- A real-money order → fill → wallet settlement → realized P&L round trip
  after depositing ≥5,000 KRW:
  `npm run verify:live-settlement -- --coin KRW-XRP --amount 5100
  --confirm-real-money`; default invocation is a read-only probe. The only
  recorded live intent (2026-09-28) ended unfilled/cancelled.
- `systemctl stop`/restart drain behavior after keys/positions exist
  (script above re-checks `Requires`, `TimeoutStopSec`, and OOM history).
- Multi-process write contention on the portfolio and evidence stores beyond
  the same-host writer-lock tests.
- Optional but recommended: resize to the Micro bundle (1 GB). Swap now
  covers the gap, but real RAM headroom is ~160-210 MB with all three
  services up.

## Register Upbit keys in the app

Create the keys on Upbit's PC web Open API management page. Allowlist the
Lightsail static IP `52.78.156.161`, enable balance/account read and order
permissions, and leave withdrawals disabled. In CoinPilot select LIVE, use
`https://52.78.156.161/live`, and enter the Access Key and Secret Key. The app
sends them once over HTTPS; the server verifies account access, encrypts them
on disk, then reads balances and open orders. It leaves automated signal entry
stopped. The app's explicit automation control remains available if the owner
later chooses to start it.

Upbit's API uses an Access Key and Secret Key pair for private exchange APIs,
not an Upbit password/OTP login session. See the [key issuance guide](https://docs.upbit.com/kr/kr/docs/api-key),
[authentication guide](https://docs.upbit.com/kr/reference/auth), and
[API FAQ](https://docs.upbit.com/kr/kr/docs/faq-api).
