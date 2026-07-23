# container-works — Alpenglow Batch Works (plank 4)

**Live:** https://containers.demos.planetek.org

Scale-to-zero containers: visitors launch a real Docker container on ECS Fargate
(`run-task`, no service, no idle cost) and watch it live — task lifecycle,
streaming CloudWatch logs, exit code, and the HTML report it uploads to S3 with
its task role. The image itself is built by an in-AWS pipeline: `app/` source →
S3 zip → CodeBuild `docker build` → ECR with scan-on-push, findings rendered on
the page. EventBridge Scheduler launches one run per day (the scheduled-batch
pattern; also keeps the feed warm).

## Architecture

- **Image pipeline:** `make image` zips `app/` to `ctr-build-<acct>/source/app.zip`
  and starts CodeBuild (`ctr-image-build`, BUILD_GENERAL1_SMALL — free-tier
  100 min/month), which pushes `ctr-app:latest` + `:b<n>` to ECR. Basic scanning
  runs on every push; a lifecycle policy keeps the 5 newest images. There is
  deliberately **no Docker on the dev machine** — every image ever run came
  through this pipeline. Base image is pulled from `public.ecr.aws` (Docker Hub
  anonymous pulls rate-limit CodeBuild's shared IPs).
- **Launch path:** `POST /api/runs` → concurrency gate (`ecs:ListTasks`, max 1
  in flight; extra requests get a 409 pointing at the live run) → atomic
  DynamoDB daily counter (30/day global) → `ecs:RunTask` (Fargate, 0.25 vCPU /
  512 MiB, x86_64) into the **default VPC's public subnets with a public IP** —
  the no-NAT pattern; the task SG has zero ingress and 443-only egress.
- **Watch path:** `GET /api/runs/{id}` = `DescribeTasks` + `GetLogEvents` on the
  awslogs stream `app/app/<task-id>`; the page polls every 2.5s. An EventBridge
  task-state-change rule → `ctr-finalize` Lambda persists final state (exit
  code, duration, stopped reason) even when nobody is watching.
- **Task IAM split (the exhibit):** execution role = pull + logs only; task
  role = `s3:PutObject` on `artifacts/*` only. The container proves it by
  writing its report there; CloudFront serves it back at `/artifacts/<id>.html`
  (uncached behavior, S3 lifecycle expires after 2 days, run records TTL 48h —
  no reset Lambda needed).
- **Jobs:** `report` renders the fictional City of Alpenglow daily-operations
  report (deterministic, seeded by date); `fail` exits 1 after a deliberate
  "checksum mismatch" so the failure path is demonstrable on demand.

## Costs

Idle ≈ $0 (ECR storage pennies; the cluster, task definition, and schedule are
free objects). A run is ~1–2 min of the smallest Fargate size + public-IP time
≈ $0.001. Worst case with every cap burned: 30 runs/day ≈ $0.03/day + one
scheduled run. CodeBuild stays inside the always-free 100 build-min/month.

## Make targets

`make deploy` (bundle + apply + publish) · `make image` (CodeBuild → ECR; needed
once after first deploy, then after any `app/` change) · `make verify` (29-check
live E2E suite incl. failure path) · `make publish` · `make destroy`.

## Design

"The bakehouse." Before it meant compute, a batch was a baking: one oven load
of bread, and the plank leans all the way in. The oven (Fargate) fires only
when a batch goes in and is stone cold between bakes; image pull is proofing,
scan-on-push is the health inspection, the EventBridge morning run is the
daily bake, and the fail job is the burnt batch. Light mode is the bakery at
ten in the morning (flour, parchment, crust gold); dark mode is the bakehouse
at four, lit through the oven door (espresso, embers). The log terminal is
drawn as the oven window, arched with a coal-bed glow, and runs are listed as
bake tickets with a perforated edge. Brick courses divide hero and footer.

Type: Hepta Slab (display) · Karla (body) · Space Mono (tickets, logs,
readouts), self-hosted woff2 (the CSP allows no CDNs). Photography, Unsplash
free license: wood-fired oven hero by [Yasin Onuş](https://unsplash.com/@yasinonus),
bakery shelves by [Clark Young](https://unsplash.com/@cbyoung).

## Production deltas (called out on purpose)

- ECR tags are MUTABLE and the task definition tracks `:latest` so an image
  rebuild needs no task-definition revision; production pins digests/immutable
  tags.
- Tasks run in the default VPC; production gets dedicated subnets (still the
  public-IP/no-NAT pattern where outbound is only AWS APIs, or VPC endpoints
  when the budget owns them).
