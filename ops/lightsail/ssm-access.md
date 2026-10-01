# IAM-based shell access to coinpilot-paper-seoul (SSM Session Manager)

Shell access to the Lightsail host no longer requires the SSH key or an
IP-allowlisted port 22 rule. The host is registered with AWS Systems
Manager as a hybrid managed node, so access is authenticated by IAM and
audited in CloudTrail.

Set up 2026-10-01 against account `303099472043`, region `ap-northeast-2`.

## Connect

```sh
aws ssm start-session \
  --target mi-08dc7f2c20a440870 \
  --region ap-northeast-2 \
  --profile pc-supporter
```

The session lands as `ssm-user` with passwordless sudo. `aws` CLI 2.x and
`session-manager-plugin` (installed at `/opt/homebrew/bin` on the operator
Mac) must be on PATH. The `pc-supporter` and `aws-login` profiles both
resolve to credentials that can start sessions.

## What was provisioned

- IAM role `coinpilot-ssm-hybrid-activation` — trust principal
  `ssm.amazonaws.com`, managed policy `AmazonSSMManagedInstanceCore`.
  This is the identity the agent on the host assumes.
- Hybrid activation `e7e0eb34-3ee4-4363-a50d-ae1ecea59da1`
  (registration limit 5, expires 2026-10-02 KST, role above). The
  activation code is consumed at registration and is not needed again
  for this host; create a fresh activation for additional nodes.
- Inline user policy `CoinPilotSSMSessionManager` on
  `pc-supporter-lightsail-ops` — `ssm:StartSession` scoped to `mi-*`
  nodes in `ap-northeast-2`, session discovery reads, `ssmmessages`
  channel actions, and Terminate/Resume limited to the caller's own
  sessions. `ssm:SendCommand` is intentionally not granted.
- On the host: the preinstalled `amazon-ssm-agent` snap was registered
  with the activation and restarted so it takes the `OnPrem` identity.
  Managed node id `mi-08dc7f2c20a440870`, service
  `snap.amazon-ssm-agent.amazon-ssm-agent.service`.

## Cost and capacity notes

The SSM advanced-instances tier was removed 2026-06-30. Hybrid node
registration is free; Session Manager on hybrid nodes is billed
pay-as-you-go at **$0.05 per session** from 2026-09-30 (Run Command is
$0.002/invocation). No monthly per-node charge.

The agent added roughly 15 MB RSS on the `nano_3_0` host (412 MB total).
Re-check `free -m` before adding more resident processes; see
`live-profile.md` for the capacity gate that already applies to the LIVE
process.

## Registering another node (e.g. kbo-fans-api-lightsail)

```sh
aws ssm create-activation \
  --default-instance-name <node-name> \
  --iam-role coinpilot-ssm-hybrid-activation \
  --registration-limit 1 \
  --region ap-northeast-2 --profile aws-login

# on the host:
sudo /snap/amazon-ssm-agent/current/amazon-ssm-agent -register -y \
  -id "<ActivationId>" -code "<ActivationCode>" --region ap-northeast-2
sudo snap restart amazon-ssm-agent   # required: picks up OnPrem identity
```

## Removing access

```sh
aws ssm deregister-managed-instance \
  --instance-id mi-08dc7f2c20a440870 \
  --region ap-northeast-2 --profile aws-login
aws ssm delete-activation --activation-id e7e0eb34-3ee4-4363-a50d-ae1ecea59da1 \
  --region ap-northeast-2 --profile aws-login
# then on the host: sudo snap remove amazon-ssm-agent --purge
```

Once SSM access is confirmed day-to-day, the port-22 rule can be removed
from the Lightsail firewall entirely; SSM needs only outbound 443. Keep
the local `coinpilot-lightsail-ap-northeast-2.pem` key in case the agent
needs recovery before then.
