# aws-boardwalk — agent notes

Portfolio of live AWS demo environments ("planks") for Planetek. Live: [demos.planetek.org](https://demos.planetek.org) (hub) and [permits.demos.planetek.org](https://permits.demos.planetek.org) (plank 1).

## Conventions (locked — don't re-litigate)

- **Terraform for everything**, AWS provider ~> 6.0, region **us-east-1**, `default_tags` with `env:<plank-name>`, `project:aws-boardwalk`, `managed_by:terraform`.
- **State**: S3 backend, bucket `aws-boardwalk-tfstate-<account-id>` (passed via `-backend-config`, never hardcoded), one key per plank, `use_lockfile = true`.
- **Shared platform** (`platform/`): Route53 zone `demos.planetek.org` + wildcard ACM cert (ISSUED). Planks consume both via data sources and add A/AAAA aliases. **Never destroy the zone** — it's delegated from GoDaddy; `prevent_destroy` guards it.
- **Cost guardrails**: free-tier-first; banned always-on: NAT, ALB, RDS/OpenSearch instances, EKS, SageMaker endpoints, 24/7 Fargate. Budget tripwire at $35.
- Every plank has a **Makefile**: `deploy` / `publish` / `seed` (if data) / `verify` / `destroy`, and a `scripts/verify.sh` end-to-end suite. A plank isn't done until verify passes against the live URL.
- Frontends: private S3 + CloudFront OAC, strict security-headers policy (HSTS, CSP), custom domain via the wildcard cert. Same-origin `/api/*` CloudFront behavior when there's an API (no CORS).
- Naming: short per-plank resource prefix (`mwa-`, `hub-`, …).

## Demo accounts (public by design, printed on plank-1 login page)

admin@demo.planetek.org / Alpenglow-Admin1! · citizen@demo.planetek.org / Alpenglow-Citizen1!
Nightly reset Lambda (09:00 UTC) reseeds data and purges stranger sign-ups.

## Build order (from Projects/AWS_SHOWCASE_PROJECTS.md)

✅ 1 Web App · ✅ Demo Hub · **next: 6 GenAI (RAG)** · then 10 DevOps/SRE · then 7, 3, 5, 2, 4, 8, 9.
When a plank goes live: update its card in `demo-hub/site/index.html` (status chip + links), the root README table, and republish the hub (`cd demo-hub && make publish`).

## Git

Public repo: https://github.com/dreamingr0b0ts/aws-boardwalk (HTTPS, token in macOS keychain). Never commit secrets, state files, or account-specific values; account ID is always derived at runtime via `aws sts get-caller-identity`.
