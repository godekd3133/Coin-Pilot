# CoinPilot LIVE on the existing Lightsail host

The Paper dashboard stays at `https://52.78.156.161/`. The dedicated LIVE
process listens only on `127.0.0.1:3101`; Nginx serves it at
`https://52.78.156.161/live/` on the same static IP and certificate.
The IP, endpoint, and certificate relationship above are operator-supplied
deployment values; this repository review did not query the AWS account or
probe the host.

## Capacity gate

The existing operator notes identify this host as the `nano_3_0` bundle: 2
vCPUs, 0.5 GB RAM, and a 20 GB system disk. The current instance bundle and
free memory have not been independently checked from this repository. Running
a second Node process beside Paper on 0.5 GB could cause an out-of-memory
restart of either service. Check current memory on the host before starting
`coinpilot-live`; if it lacks headroom, keep the current instance unchanged and
approve a resize plan first. Checked 2026-09-30 against the public
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

The example enables `DASHBOARD_LIVE_MANUAL_PREPARE_ON_BOOT` and disables
`DASHBOARD_START_TRADER_ON_BOOT`. Manual-prepare synchronizes the account and
open orders but does not start the position-risk timer. A successful manual
LIVE buy records a strategy position without enabling background risk
monitoring. The current manual mode therefore requires direct position
oversight; it is not yet an unattended protection mode. A normal stop can
switch the same position into protective-only monitoring, which may submit a
SELL. This behavior awaits an explicit protection policy and recovery tests.

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
