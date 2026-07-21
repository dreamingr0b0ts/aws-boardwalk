# aws-boardwalk — agent notes

Portfolio of live AWS demo environments ("planks") for Planetek. Live: [demos.planetek.org](https://demos.planetek.org) (hub), [permits.demos.planetek.org](https://permits.demos.planetek.org) (plank 1), [api.demos.planetek.org](https://api.demos.planetek.org) (plank 2, API & microservices), [events.demos.planetek.org](https://events.demos.planetek.org) (plank 3, event mesh), [containers.demos.planetek.org](https://containers.demos.planetek.org) (plank 4, containers), [data.demos.planetek.org](https://data.demos.planetek.org) (plank 5, data lake), [assistant.demos.planetek.org](https://assistant.demos.planetek.org) (plank 6, GenAI RAG), [documents.demos.planetek.org](https://documents.demos.planetek.org) (plank 7, IDP), [security.demos.planetek.org](https://security.demos.planetek.org) (plank 8, security & governance — evidence page always on, stack deploy-demo-teardown), [network.demos.planetek.org](https://network.demos.planetek.org) (plank 9, network architecture — same pattern as plank 8), [ops.demos.planetek.org](https://ops.demos.planetek.org) (plank 10, DevOps/SRE), [registry.demos.planetek.org](https://registry.demos.planetek.org) (plank 11, relational database — Aurora Serverless v2 scale-to-zero, same deploy-demo-teardown pattern as planks 8/9), and [models.demos.planetek.org](https://models.demos.planetek.org) (plank 12, foundation-model workbench).

## Conventions (locked — don't re-litigate)

- **Terraform for everything**, AWS provider ~> 6.0, region **us-east-1**, `default_tags` with `env:<plank-name>`, `project:aws-boardwalk`, `managed_by:terraform`.
- **State**: S3 backend, bucket `aws-boardwalk-tfstate-<account-id>` (passed via `-backend-config`, never hardcoded), one key per plank, `use_lockfile = true`.
- **Shared platform** (`platform/`): Route53 zone `demos.planetek.org` + wildcard ACM cert (ISSUED). Planks consume both via data sources and add A/AAAA aliases. **Never destroy the zone** — it's delegated from GoDaddy; `prevent_destroy` guards it.
- **Company site** (`company-site/`, prefix `www-`): planetek.org homepage on the same patterns, plus the **apex Route53 zone for planetek.org itself — it carries the iCloud mail records for info@planetek.org (MX/SPF/DKIM/DMARC). NEVER destroy or carelessly edit that zone**; `prevent_destroy` guards it. Contact form = HTTP API → `www-contact` Lambda → SESv2 (sandbox by design: info@ → info@, visitor address in Reply-To). `custom_domain_enabled` follows the mwa rule: its default must always equal live state.
- **Cost guardrails**: free-tier-first; banned always-on: NAT, ALB, RDS/OpenSearch instances, EKS, SageMaker endpoints, 24/7 Fargate. Budgets: `Planetek-Infra-Tripwire` $15/mo (infra-only; excludes the Skill Builder subscription and tax) and `Planetek-100-Monthly-Cap` $100/mo all-in. **One deliberate paid exception (owner-approved 2026-07-20): the shared WAF web ACL** `platform-edge-acl` (platform root, ~$8/mo total) — CLOUDFRONT scope, attached to every distribution via data-source lookup; per-IP rate limit (300/5min) + Amazon IP reputation + Known Bad Inputs; NO Core Rule Set (would false-positive on plank 11/12's SQL-text and prompt bodies) and NO WAF logging (cost). New planks must attach it (copy any plank's `data "aws_wafv2_web_acl"` block).
- Every plank has a **Makefile**: `deploy` / `publish` / `seed` (if data) / `verify` / `destroy`, and a `scripts/verify.sh` end-to-end suite. A plank isn't done until verify passes against the live URL.
- Frontends: private S3 + CloudFront OAC, strict security-headers policy (HSTS, CSP), custom domain via the wildcard cert. Same-origin `/api/*` CloudFront behavior when there's an API (no CORS).
- Every Lambda gets an explicit `aws_cloudwatch_log_group` (each root's `logs.tf`, 14-day retention) — auto-created groups never expire.
- Naming: short per-plank resource prefix (`mwa-`, `hub-`, …).

## Demo accounts

Plank 1 (public by design, printed on its login page): admin@demo.planetek.org / Alpenglow-Admin1! · citizen@demo.planetek.org / Alpenglow-Citizen1!
Nightly reset Lambda (09:00 UTC) reseeds data and purges stranger sign-ups.

**Planks 6, 7, and 12 are different on purpose:** their credentials are NEVER printed on the site or
committed — plank 6 messages cost Bedrock tokens, plank 7 uploads cost Textract/Comprehend/Bedrock,
plank 12 runs fan one prompt out to four Bedrock models.
Each lives in `<plank>/.demo-creds` (gitignored, on the Mac); `make -C <plank> creds-show` prints it.
Self-signup is disabled on those pools, and per-user + global daily DynamoDB counters cap spend even
if a credential leaks (gai: 40/200 messages; idp: 8/20 documents, plus 4 MB + 6-page caps enforced
before OCR starts; fmw: 30/120 runs, 500-output-token ceiling). Keep it that way for any future
plank whose requests cost real money.

## Build order (from Projects/AWS_SHOWCASE_PROJECTS.md)

✅ 1 Web App · ✅ Demo Hub · ✅ 6 GenAI (RAG) · ✅ 10 DevOps/SRE · ✅ 7 IDP · ✅ 3 Events · ✅ 5 Data · ✅ 2 API · ✅ 4 Containers · ✅ 8 Security · ✅ 9 Network · ✅ 11 Relational Registry · ✅ 12 Model Workbench — **all 12 planks + hub are live.**
When a plank's page or exhibits change: update its card in `demo-hub/site/index.html`, the root README table, and republish the hub (`cd demo-hub && make publish`).

## CI/CD (plank 10 — live)

Every push to `main` plans AND APPLIES all planks via GitHub Actions (OIDC roles `ops-gh-plan`/`ops-gh-apply`, no stored keys; account ID lives in the `AWS_ACCOUNT_ID` repo variable). Applies wait on a single `gate` job (the `prod` environment, required reviewer `dreamingr0b0ts`) — one approval in the Actions UI releases the whole dependency-ordered apply matrix; the matrix legs deliberately do NOT carry the environment (a max-parallel-1 matrix inside a reviewed environment prompts once per leg), and the `ops-gh-apply` trust policy matches `ref:refs/heads/main`, not `environment:prod`. Two consequences:

- **Variable defaults must match the live state.** CI runs plain `terraform apply` with no extra `-var` flags — a default that differs from production (like plank 1's old `custom_domain_enabled=false`) WILL be "corrected" into an outage on the next push.
- Checkov (`.checkov.yaml`) + Trivy (`.trivyignore`) gate every PR; both files carry justified, documented skips — add a reasoned entry rather than loosening the gate.

The gai demo password is read from SSM (`/boardwalk/genai-assistant/demo-password`, synced by `make -C genai-assistant creds`) so CI can apply that plank without the gitignored `.demo-creds`.

**New plank checklist:** add its folder to BOTH matrix lists in `.github/workflows/terraform.yml` (plan + apply, apply list is dependency-ordered); deploy locally first so CI's plan starts from live state; **apply the new `<prefix>-*` fence line in devops-sre locally BEFORE pushing** — the CI apply role carries a `NeverSelfModify` deny on the `ops-gh-*` roles, so a fence change pushed unapplied fails `apply (devops-sre)` by design (re-run the job after a local apply); any secret it needs goes in SSM under `/boardwalk/<plank>/…` (both CI roles can read that path); if its requests cost real money, copy plank 6's pattern — creds never printed or committed, self-signup off, per-user + global daily caps in DynamoDB.

**Deploy-demo-teardown planks (8 Security, 9 Network, 11 Relational Registry — all live) use TWO Terraform roots:** an always-on `infra/` root (static site + persisted artifacts, in the CI matrix like any plank) and a `demo/` root holding every daily-billing resource, driven ONLY by local `make demo` / `make teardown` and **never added to the CI matrix** — CI applying it would silently re-enable daily billing on the next push. The CI scan job still lints the whole repo, so the demo root's Terraform must pass Checkov/Trivy too. Plank 8 (`security-posture/`) is the reference implementation: evidence report outlives the stack in the site bucket's `evidence/` prefix (excluded from `make publish` sync), status.json flips the page's live/torn-down banner. Plank 11 adds a twist: its always-on root ALSO carries the public query API, which discovers the Aurora cluster via SSM parameters the demo root writes and answers 503 honestly between windows.

## Git

Public repo: https://github.com/dreamingr0b0ts/aws-boardwalk (HTTPS, token in macOS keychain). Never commit secrets, state files, or account-specific values; account ID is always derived at runtime via `aws sts get-caller-identity`.
