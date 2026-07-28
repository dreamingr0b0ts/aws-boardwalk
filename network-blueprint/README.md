# Plank 9: Alpenglow Network Blueprint (Network Architecture)

**https://network.demos.planetek.org** · deploy-demo-teardown, and the boardwalk's final plank.

A textbook multi-AZ VPC whose every segmentation claim is proven twice: by **VPC Reachability
Analyzer** (AWS's configuration-analysis engine) and by **probe commands executed on the instances**
via SSM Run Command. Instances, interface endpoints, and flow logs bill hourly, so the stack exists
only during demo windows; the auto-generated evidence report (JSON + standalone HTML) survives
teardown on the always-on site.

## Two Terraform roots

| root | lifecycle | contents |
|---|---|---|
| `infra/` | always-on, applied by CI like every other plank (state key `network-blueprint.tfstate`) | private S3 site behind CloudFront/OAC, custom domain, the persisted `evidence/` prefix, and the **inspection API** (HTTP API + two Lambdas + DynamoDB) that lets visitors trigger live probe rounds |
| `demo/` | **local-only** `make demo` / `make teardown` (state key `network-blueprint-demo.tfstate`) | everything that bills hourly, deliberately **excluded from the CI matrix** so a push to main can never silently re-start it; also writes the SSM discovery parameters the inspection API uses to find the stack |

## What a demo window deploys

- **VPC 10.42.0.0/16**, two AZs, three subnet tiers (public / app / data), custom NACLs (with an
  explicit RDP deny, the layer security groups can't express), a locked default SG, and
  subnet-level public-IP auto-assign kept off (exposure is per-instance).
- **The no-NAT pattern**: private route tables have no default route at all; **S3 and DynamoDB
  gateway endpoints** (free) are the only non-local routes. The private instance proves it live:
  internet unreachable, both services reachable.
- **Security-group tiering**: 443 (world) → `net-web-sg` → 8080 → `net-app-sg` → 5432 →
  `net-data-sg`, rules referencing groups rather than CIDRs. The data tier is defined but
  deliberately vacant (a third instance adds cost, not proof; the 5432 chain is still exercised).
- **Two t4g.nano instances**, both SSM-managed with **no SSH anywhere**: the public one registers
  over the internet, the private one over three **PrivateLink interface endpoints** (ssm /
  ssmmessages / ec2messages, the plank's main running cost). IMDSv2 enforced and probed.
- **Reachability Analyzer**: four paths analyzed on every apply ($0.10 each): internet→web:443 ✓,
  internet→app:8080 ✗, web→app:8080 ✓, web→app:5432 ✗. The ✗ verdicts passing is the exhibit.
- **VPC flow logs** (ALL traffic, 60s aggregation): the evidence samples genuine REJECT records,
  internet scanners probing the fresh public IP, turned away at the security group.
- **Evidence Lambda** (`net-evidence-report`) reads all of the above, re-runs the probe suites,
  and writes `evidence/evidence.json` + a printable `evidence/evidence.html` into the always-on
  bucket.

## The field inspection, on demand

While the stack is deployed, any visitor can press **Walk the site** (Sheet 03) and watch a real
inspection round: the always-on `net-inspection-api` Lambda gates the request, and the async
`net-inspection-runner` Lambda executes the eight probe commands on the two instances via SSM Run
Command, **one probe per command**, so the page's field book streams and the plan-view edges trace
as each result lands. The round closes by re-reading the four Reachability Analyzer verdicts and
checking the field results agree with the plan.

Guardrails, mirroring the containers plank:

- **One inspector at a time**: a DynamoDB lock; a second trigger gets a **409 carrying the id of
  the round already under way**, and the page attaches to that round so everyone shares the view.
- **30 rounds per UTC day** across all visitors (atomic DynamoDB counter → 429 after that).
- A round costs **$0** (SSM Run Command is free; no new analyses are started), so the caps bound
  nuisance, not spend.
- The API discovers the stack through SSM parameters the demo root writes
  (`/boardwalk/network-blueprint/*`). Torn down → parameters gone → `POST /api/runs` answers an
  honest **503** while the rest of the page keeps serving the persisted evidence. Round records
  expire after 48h.

## Lifecycle

```
make demo       # ~15 min: apply (runs the analyzer paths), wait for SSM + flow logs, evidence
make report     # any time while deployed: fresh probes + flow-log samples
make teardown   # final evidence snapshot, destroy every hourly-billing resource
make verify     # both modes: live exhibits when deployed; proof of $0 idle when not
make status     # is the demo stack up?
```

Costs per window: 2 × t4g.nano ($0.0084/hr) + 3 interface endpoints ($0.03/hr) + 4 analyses
($0.40) + flow-log pennies → **≈ $0.04/hr + $0.40 fixed**; a 2-hour window is about fifty cents.
Idle between windows: **$0**.

A forgotten `make teardown` cannot bill for long: the nightly **demo sweep** workflow
(`.github/workflows/demo-sweep.yml`, 09:00 UTC, also manually dispatchable) tears down any demo
window left open, running this same `make teardown` so the final evidence snapshot and status
flip still happen.

## Design

**"The Engineer's Drafting Room."** The plank is named Network Blueprint, so it dresses as one.
Light mode is the drafting vellum: warm paper on a faint blueline grid, graphite ink, Prussian-blue
accents, red-pencil marks for the paths that are supposed to fail. Dark mode is the cyanotype print
itself: Prussian-blue ground, pale linework. The metaphor carries the exhibits: Reachability
Analyzer is the plan check, the SSM probe suite is the field inspection, the persisted report is
the as-built record filed with the town, and deploy-demo-teardown is the structure being staked
out for inspection and struck while the drawings stay on file. Sections wear engineering
title-block plates (Sheet 01–05), headings get scale-bar underlines, the ghost NAT gateway is
struck from the drawing, and the standalone evidence report renders as a stamped as-built sheet.

- **Type**: Big Shoulders (condensed drafting-caps display) · Instrument Sans (body) ·
  Sometype Mono (readouts, plates, spec voice). Static woff2 vendored in `frontend/fonts/`.
- **Photos** (Unsplash free license, self-hosted per the boardwalk CSP): hero is a hand-lettered
  1900s renovation blueprint for Damrak 70, Amsterdam (Amsterdam City Archives); the interlude is
  an architect's hands at the drafting table by Daniel McCullough.
- **Favicon**: a Prussian-blue drawing sheet with its drawn frame and the three subnet tiers as
  white bars, the VPC diagram in miniature.

## Notes

- The always-on root must deploy before the demo root (the demo root reads its state for the
  site bucket).
- `make publish` syncs the frontend but never touches `evidence/*`: those objects belong to the
  demo lifecycle and outlive both the stack and any site deploy.
- Interface endpoints sit in ONE subnet (one AZ), not two: halves the cost, and AZ resilience for
  a demo-window management path isn't worth paying for.
- Production would differ in the honest ways the page says out loud: NAT (or egress-only IPv6)
  where private tiers genuinely need the internet, per-AZ endpoint redundancy, and a real data
  tier.
