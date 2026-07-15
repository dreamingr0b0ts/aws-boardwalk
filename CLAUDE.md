# aws-boardwalk — agent notes

Portfolio of live AWS demo environments ("planks") for Planetek. Live: [demos.planetek.org](https://demos.planetek.org) (hub), [permits.demos.planetek.org](https://permits.demos.planetek.org) (plank 1), and [assistant.demos.planetek.org](https://assistant.demos.planetek.org) (plank 6, GenAI RAG).

## Conventions (locked — don't re-litigate)

- **Terraform for everything**, AWS provider ~> 6.0, region **us-east-1**, `default_tags` with `env:<plank-name>`, `project:aws-boardwalk`, `managed_by:terraform`.
- **State**: S3 backend, bucket `aws-boardwalk-tfstate-<account-id>` (passed via `-backend-config`, never hardcoded), one key per plank, `use_lockfile = true`.
- **Shared platform** (`platform/`): Route53 zone `demos.planetek.org` + wildcard ACM cert (ISSUED). Planks consume both via data sources and add A/AAAA aliases. **Never destroy the zone** — it's delegated from GoDaddy; `prevent_destroy` guards it.
- **Cost guardrails**: free-tier-first; banned always-on: NAT, ALB, RDS/OpenSearch instances, EKS, SageMaker endpoints, 24/7 Fargate. Budget tripwire at $35.
- Every plank has a **Makefile**: `deploy` / `publish` / `seed` (if data) / `verify` / `destroy`, and a `scripts/verify.sh` end-to-end suite. A plank isn't done until verify passes against the live URL.
- Frontends: private S3 + CloudFront OAC, strict security-headers policy (HSTS, CSP), custom domain via the wildcard cert. Same-origin `/api/*` CloudFront behavior when there's an API (no CORS).
- Naming: short per-plank resource prefix (`mwa-`, `hub-`, …).

## Demo accounts

Plank 1 (public by design, printed on its login page): admin@demo.planetek.org / Alpenglow-Admin1! · citizen@demo.planetek.org / Alpenglow-Citizen1!
Nightly reset Lambda (09:00 UTC) reseeds data and purges stranger sign-ups.

**Plank 6 is different on purpose:** its credential is NEVER printed on the site or committed —
every message costs Bedrock tokens. It lives in `genai-assistant/.demo-creds` (gitignored, on
the Mac); `make -C genai-assistant creds-show` prints it. Self-signup is disabled on that pool,
and per-user (40/day) + global (200/day) DynamoDB counters cap spend even if the credential
leaks. Keep it that way for any future plank whose requests cost real money.

## Build order (from Projects/AWS_SHOWCASE_PROJECTS.md)

✅ 1 Web App · ✅ Demo Hub · ✅ 6 GenAI (RAG) · ✅ 10 DevOps/SRE · **next: 7 IDP** · then 3, 5, 2, 4, 8, 9.
When a plank goes live: update its card in `demo-hub/site/index.html` (status chip + links), the root README table, and republish the hub (`cd demo-hub && make publish`).

## CI/CD (plank 10 — live)

Every push to `main` plans AND APPLIES all planks via GitHub Actions (OIDC roles `ops-gh-plan`/`ops-gh-apply`, no stored keys; account ID lives in the `AWS_ACCOUNT_ID` repo variable). Two consequences:

- **Variable defaults must match the live state.** CI runs plain `terraform apply` with no extra `-var` flags — a default that differs from production (like plank 1's old `custom_domain_enabled=false`) WILL be "corrected" into an outage on the next push.
- Checkov (`.checkov.yaml`) + Trivy (`.trivyignore`) gate every PR; both files carry justified, documented skips — add a reasoned entry rather than loosening the gate.

The gai demo password is read from SSM (`/boardwalk/genai-assistant/demo-password`, synced by `make -C genai-assistant creds`) so CI can apply that plank without the gitignored `.demo-creds`.

## Git

Public repo: https://github.com/dreamingr0b0ts/aws-boardwalk (HTTPS, token in macOS keychain). Never commit secrets, state files, or account-specific values; account ID is always derived at runtime via `aws sts get-caller-identity`.
