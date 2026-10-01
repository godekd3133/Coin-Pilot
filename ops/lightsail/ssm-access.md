# Host shell access: SSH primary + SSM Session Manager fallback

Two access paths to `coinpilot-paper-seoul` (`52.78.156.161`,
account `303099472043`, region `ap-northeast-2`):

- **SSH (primary, free)** — port 22 open only to allowlisted IPs:
  `211.193.60.229/32` and `218.153.88.17/32` (operator Mac, 2026-10-01).
  Key: `~/.ssh/coinpilot-lightsail-ap-northeast-2.pem`, user `ubuntu`.
- **SSM (fallback, $0.05/session)** — IAM-authenticated, works from any
  network even when SSH is unreachable (IP drift, key unavailable).
  The agent sits idle at $0 until a session is started.

## SSM connect

```sh
aws ssm start-session \
  --target mi-0834fc78b5c575cad \
  --region ap-northeast-2 \
  --profile pc-supporter
```

The session lands as `ssm-user` with passwordless sudo. Requires
`session-manager-plugin` on PATH (installed at `/opt/homebrew/bin` on the
operator Mac).

## Provisioned resources

- IAM role `coinpilot-ssm-hybrid-activation` (trust `ssm.amazonaws.com`,
  `AmazonSSMManagedInstanceCore`)
- Hybrid activation `247b914e-1407-4dca-9a10-73aa168649ee` (limit 5,
  expires 2026-10-02 KST)
- Inline user policy `CoinPilotSSMSessionManager` on
  `pc-supporter-lightsail-ops`: `ssm:StartSession` on `mi-*` in
  `ap-northeast-2`, session discovery reads, `ssmmessages` channel
  actions, Terminate/Resume on own sessions only. No `ssm:SendCommand`.
- `amazon-ssm-agent` snap on the host, OnPrem identity,
  `snap.amazon-ssm-agent.amazon-ssm-agent.service` enabled +
  `Restart=always`. Managed node `mi-0834fc78b5c575cad`.

## Notes

- Costs: Session Manager on hybrid nodes is $0.05/session since
  2026-09-30 (registration free). Expected < $2/month at ops volume.
- Agent RSS ~15 MB on the 412 MB nano host. `snap install` on this host
  takes ~10 min under memory pressure — do not mistake a quiet SSH
  session for a hung one.
- If SSH is the only working path needed, remove SSM per "Removing
  access" — but keeping the idle agent costs nothing and covers IP-drift
  lockouts.

## Removing access

```sh
aws ssm deregister-managed-instance \
  --instance-id mi-0834fc78b5c575cad \
  --region ap-northeast-2 --profile aws-login
aws ssm delete-activation --activation-id 247b914e-1407-4dca-9a10-73aa168649ee \
  --region ap-northeast-2 --profile aws-login
aws iam delete-user-policy --user-name pc-supporter-lightsail-ops \
  --policy-name CoinPilotSSMSessionManager --profile aws-login
aws iam detach-role-policy --role-name coinpilot-ssm-hybrid-activation \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore --profile aws-login
aws iam delete-role --role-name coinpilot-ssm-hybrid-activation --profile aws-login
# on the host:
sudo snap remove --purge amazon-ssm-agent
sudo deluser --remove-home ssm-user; sudo rm -f /etc/sudoers.d/ssm-agent-users
```
