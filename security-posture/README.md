# Plank 8: Alpenglow Security Posture (Security & Governance)

**https://security.demos.planetek.org** · the boardwalk's first **deploy-demo-teardown** plank.

GuardDuty, Security Hub, AWS Config, and CloudTrail bill by the day, so the detection stack exists
only during demo windows. What persists between windows is the product: an auto-generated
**findings-to-evidence report** (JSON + standalone HTML), rebuilt from live AWS APIs on every
cycle and served by the always-on site — plus a set of **always-on live exhibits** (a policy desk
and the shared WAF's fence log) that keep working year-round because IAM and the edge ACL cost
nothing to leave on.

## Two Terraform roots

| root | lifecycle | contents |
|---|---|---|
| `infra/` | always-on, applied by CI like every other plank (state key `security-posture.tfstate`) | private S3 site behind CloudFront/OAC, custom domain, the persisted `evidence/` prefix, the same-origin `/api/*` exhibit API (HTTP API + `sec-exhibit-api`/`sec-drill-runner` Lambdas + `sec-exhibits` DynamoDB table), and the permissions-boundary role (IAM is free, so it lives here to power the always-on policy desk) |
| `demo/` | **local-only** `make demo` / `make teardown` (state key `security-posture-demo.tfstate`) | everything that bills daily, deliberately **excluded from the CI matrix** so a push to main can never silently re-enable it |

## Live exhibits (always on)

- **The policy desk** (`POST /api/policy/simulate`, `POST /api/policy/validate`): the permissions
  boundary proven live by `iam:SimulatePrincipalPolicy` (four curated cases covering the whole
  policy∩boundary intersection matrix), and any policy linted by Access Analyzer's own
  `ValidatePolicy` — pick a specimen or paste your own; the linter's findings are shown verbatim.
  Both APIs are free, so the desk answers whether or not the season stack is staffed.
- **The perimeter fence log** (`GET /api/fence`): the shared boardwalk edge WAF's last ~3 hours of
  real sampled requests across all thirteen sites, straight from `GetSampledRequests` at $0, plus
  24h block/allow totals from CloudWatch. Client IPs are masked. Nothing else on the boardwalk
  shows the WAF actually catching hostile traffic.
- **The practice-smoke drill** (`POST /api/drills`) is demo-gated — it needs the trail and Config —
  and answers 503 honestly between windows. See below.

## What a demo window deploys

- **CloudTrail**: multi-region trail, log-file integrity validation, delivering to an S3 bucket
  encrypted with a **customer-managed KMS key** (automatic rotation; key policy fenced to this
  trail via `aws:SourceArn`).
- **GuardDuty**: threat detection, seeded with AWS-generated *sample* findings (titles prefixed
  `[SAMPLE]`) so the severity histogram is populated without staging an attack.
- **Security Hub**: AWS Foundational Security Best Practices standard, evaluating the whole
  account (including the nine always-on planks); GuardDuty findings flow in automatically.
- **AWS Config**: recorder over all supported resource types + the AWS-published
  **NIST 800-53 rev 5 operational best practices conformance pack** (130 managed rules, vendored
  in `demo/templates/`, Apache-2.0 from awslabs/aws-config-rules).
- **The practice-smoke drill target**: an inert sandbox — a routeless VPC (no subnets, no gateway)
  and a security group attached to nothing, tagged `exhibit=practice-smoke`. A visitor's drill opens
  port 22 to the world on it (exposing nothing, since no ENI is attached) and two detectors race to
  catch it: an **EventBridge tripwire** on the CloudTrail `AuthorizeSecurityGroupIngress` event fires
  `sec-drill-responder` to revoke it automatically, while an **AWS Config `restricted-ssh` inspector**
  rules on the same group on its own periodic cadence. The always-on `sec-drill-runner` narrates both
  live and times the tripwire; its own failsafe revoke guarantees nothing is ever left open.
- **Evidence Lambda** (`sec-evidence-report`): reads all of the above and writes
  `evidence/evidence.json` + a printable `evidence/evidence.html` into the always-on bucket. It also
  keeps a **GuardDuty smoke field guide** (findings grouped by type, with a plain-language line per
  threat purpose) and appends one row per window to the **season ledger** (`evidence/seasons/`), so
  the page shows posture maturing across the season instead of only the latest snapshot.

## The permissions boundary (always-on exhibit)

The `sec-boundary-demo` role's identity policy grants read+write on the site bucket, but its boundary
ceilings read-only. Effective permission is the intersection, proven by `iam:SimulatePrincipalPolicy`
rather than assertion. This moved to the `infra/` root (IAM bills nothing) so the live policy desk can
demonstrate it between demo windows, not only in the persisted report.

## Lifecycle

```
make demo       # ~15 min: apply demo root, seed sample findings, wait, generate evidence
make report     # any time while deployed: refresh evidence (fuller after 30-60 min)
make teardown   # final evidence snapshot, destroy every daily-billing resource
make verify     # both modes: live exhibits when deployed; proof of $0 idle when not
make status     # is the demo stack up?
```

`make demo` prints a reminder that the stack bills until torn down, and a forgotten window is
bounded by the nightly **demo sweep** workflow (`.github/workflows/demo-sweep.yml`, 09:00 UTC),
which runs this plank's own `make teardown` if the demo root was left up. Costs per window: Config
configuration items + 130 rules' evaluations (about $1-3 for this account), GuardDuty/Security Hub
in free trial (then pennies/day), CloudTrail first management trail free. Idle between windows:
**$0** (a KMS key pending its 7-day deletion window bills nothing).

## Notes

- The always-on root must deploy before the demo root (the demo root reads its state for the
  site bucket).
- `make publish` syncs the frontend but never touches `evidence/*`; those objects belong to the
  demo lifecycle and outlive both the stack and any site deploy.
- First `make demo` on a fresh account also creates the `AWSServiceRoleForConfig` service-linked
  role (Terraform) and lets the conformance pack create `AWSServiceRoleForConfigConforms`.

## Design: the fire lookout

Every plank on the boardwalk carries its own visual identity. Plank 8 is **the fire lookout**: a
seasonally staffed watchtower over the Alpenglow Ranger District. The metaphor is load-bearing.
A lookout runs for fire season and closes for winter (deploy-demo-teardown), keeps a logbook in
ink (CloudTrail), watches for smoke and drills on practice smokes (GuardDuty sample findings),
reports every sighting to district dispatch (Security Hub), passes a station inspection
(the NIST 800-53 conformance pack), and files a season report that outlives the staffing
(the persisted evidence report).

- **Palette**: day watch (light mode) grounds on topo-map cream with timber browns and
  fire-danger placards; night watch (dark mode) is warm charcoal smoke with ember and
  lamp-amber accents.
- **Type**: Oswald for display, Public Sans for body text (the U.S. government's own open-source
  typeface, fitting for a NIST plank), Chivo Mono for readouts. All self-hosted woff2.
- **Motifs**: routed-sign log plates on each section, catwalk cross-brace dividers, an Osborne
  Firefinder sighting ring as the favicon, and the NIST compliance bar styled as a danger gauge.
- **Photos** (Unsplash free license, self-hosted per the CSP): Daniel Akselrod's Mt Rainier fire
  lookout (hero) and Haley Truong's smoke-dimmed Rockies (interlude).
- The standalone `evidence.html` artifact is styled as the district's season report.
