# Plank 10 - DevOps & SRE environment

**Live:** [ops.demos.planetek.org](https://ops.demos.planetek.org) · the meta-plank: it builds, scans, watches, and drills the rest of the boardwalk.

## What's in it

| Piece | Implementation |
|---|---|
| Keyless CI/CD | GitHub Actions → AWS via **OIDC**; zero stored access keys. Read-only `ops-gh-plan` role for PRs, `ops-gh-apply` (assumable only through the repo's `prod` environment) for applies. |
| Plan/apply gates | `terraform plan` + fmt/validate on every PR; apply only on merge to `main`, behind the `prod` environment gate. |
| DevSecOps scanning | **Checkov** (Terraform misconfig) + **Trivy** (IaC + dependency vulns) fail the build on every PR. |
| Observability | CloudWatch dashboard `ops-boardwalk` (CloudFront, API p95, Lambda errors, DynamoDB, Bedrock), 4 alarms → SNS email, X-Ray tracing on the runbook Lambda + Step Functions. |
| Synthetic monitoring | CloudWatch Synthetics heartbeat over every live plank, **parked by default** (`make canary-start` / `canary-stop` around demo windows). |
| Resilience runbook | Step Functions drill: snapshot the live permits table → restore to a scratch table → verify item-for-item → clean up → publish **measured RTO/RPO** to the status page. |

## Operating it

```bash
make deploy        # terraform apply + publish the status page
make verify        # end-to-end checks against the live account
make drill         # run the backup/restore drill, print the RTO/RPO report
make canary-start  # before a demo window
make canary-stop   # after: idle cost back to ~$0
```

## Security posture of the CI roles

- The **plan** role can read everything and change nothing (ReadOnlyAccess + the S3 state
  lockfile + `/boardwalk/*` SSM parameters for plan-time data sources).
- The **apply** role is PowerUser plus an IAM slice fenced to plank-prefixed names
  (`mwa-*`, `gai-*`, `hub-*`, `ops-*`), with an explicit deny on modifying the CI roles
  themselves, so a compromised workflow can't widen its own trust policy.
- Fork PRs get no cloud credentials at all: the trust policy names this repo, and the
  plan job only runs for same-repo events.

## Cost

Idle ≈ **$0**: the dashboard and alarms are inside the free tier, the canary is stopped,
the drill is on-demand (each run ≈ a cent), and the status page is S3 + CloudFront pennies.

## Design

**"Alpenglow Mountain Patrol"**: the ops plank is the boardwalk's ski patrol, the crew that
sweeps, gates, and watches every run before anyone else is allowed on the mountain. Sections
are trail runs (green circle, blue square, black diamond), the CI pipeline is the morning
sweep whose rope gate only drops after control work, the backup/restore drill is a timed
beacon drill, and observability is the lookout. Rope-line dividers close the hero and top
the footer.

- **Palette**: bluebird-morning light mode on glacial paper (never plain white); predawn
  grooming-shift dark mode in cold steel blues. Patrol red accents in both.
- **Type**: [Archivo](https://fonts.google.com/specimen/Archivo) (signage grotesque) +
  [Martian Mono](https://fonts.google.com/specimen/Martian+Mono) (radio/beacon readouts),
  self-hosted woff2 (the CSP allows no font CDNs).
- **Photos** (Unsplash free license, self-hosted): area-boundary sign hero by
  [Jim Moriarty](https://unsplash.com/@jimmoriarty), night groomers interlude by
  [Marek Piwnicki](https://unsplash.com/@marekpiwnicki).
- **Favicon**: white diamond marker on a patrol-red tile.
