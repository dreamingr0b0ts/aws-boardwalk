# Plank 8: Alpenglow Security Posture (Security & Governance)

**https://security.demos.planetek.org** · the boardwalk's first **deploy-demo-teardown** plank.

GuardDuty, Security Hub, AWS Config, and CloudTrail bill by the day, so this environment exists
only during demo windows. What persists between windows is the product: an auto-generated
**findings-to-evidence report** (JSON + standalone HTML), rebuilt from live AWS APIs on every
cycle and served by the always-on site.

## Two Terraform roots

| root | lifecycle | contents |
|---|---|---|
| `infra/` | always-on, applied by CI like every other plank (state key `security-posture.tfstate`) | private S3 site behind CloudFront/OAC, custom domain, and the persisted `evidence/` prefix |
| `demo/` | **local-only** `make demo` / `make teardown` (state key `security-posture-demo.tfstate`) | everything that bills daily, deliberately **excluded from the CI matrix** so a push to main can never silently re-enable it |

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
- **Permissions boundary exhibit**: `sec-boundary-demo` role whose identity policy grants
  read+write but whose boundary ceilings read-only: the report proves the intersection with
  `iam:SimulatePrincipalPolicy` (`s3:PutObject` → `implicitDeny`).
- **Evidence Lambda** (`sec-evidence-report`): reads all of the above and writes
  `evidence/evidence.json` + a printable `evidence/evidence.html` into the always-on bucket.

## Lifecycle

```
make demo       # ~15 min: apply demo root, seed sample findings, wait, generate evidence
make report     # any time while deployed: refresh evidence (fuller after 30-60 min)
make teardown   # final evidence snapshot, destroy every daily-billing resource
make verify     # both modes: live exhibits when deployed; proof of $0 idle when not
make status     # is the demo stack up?
```

`make demo` prints a reminder that the stack bills until torn down. Costs per window: Config
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
