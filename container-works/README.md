# container-works — Alpenglow Batch Works (plank 4)

**Live:** https://containers.demos.planetek.org

Scale-to-zero containers: visitors launch a real Docker container on ECS Fargate
(`run-task`, no service, no idle cost) and watch it live — task lifecycle,
streaming CloudWatch logs, exit code, and the HTML report it uploads to S3 with
its task role. Every run now gets a **cold-start anatomy waterfall** (capacity →
pull → start → job → teardown, from `DescribeTasks` timestamps) and a **bake
ticket**: an itemized cost receipt with a live-ticking meter, priced from
published us-east-1 rates. The **bake-off** races two real tasks side by side
(¼ vCPU vs 1 vCPU on a fixed CPU workload; slim alpine vs heavy Debian image on
the same job), and the **failure museum** shows four honest endings: exit 1, a
real OOM kill at the 512 MiB task limit (exit 137), a SIGTERM trap that drains
cleanly, and a job that ignores SIGTERM until ECS SIGKILLs it at the 30s
stopTimeout — with a "pull the batch early" button that sends a genuine
`ecs:StopTask`. The image itself is built by an in-AWS pipeline: `app/` source →
S3 zip → CodeBuild `docker build` (both variants) → ECR with scan-on-push,
findings compared slim-vs-fat on the page. EventBridge Scheduler launches one
run per day (the scheduled-batch pattern; also keeps the feed warm).

## Architecture

- **Image pipeline:** `make image` zips `app/` to `ctr-build-<acct>/source/app.zip`
  and starts CodeBuild (`ctr-image-build`, BUILD_GENERAL1_SMALL — free-tier
  100 min/month), which builds BOTH variants and pushes `ctr-app:latest` +
  `:b<n>` (slim, alpine base) and `:fat` + `:fat-b<n>` (same app on full Debian
  node — exists only so the image race has a loser and the scan comparison has
  two columns). Basic scanning runs on every push; lifecycle rules keep the 5
  newest of each family. There is deliberately **no Docker on the dev machine**
  — every image ever run came through this pipeline. Base images are pulled
  from `public.ecr.aws` (Docker Hub anonymous pulls rate-limit CodeBuild's
  shared IPs).
- **Launch path:** `POST /api/runs` → concurrency gate (`ecs:ListTasks`, one
  LAUNCH in flight; extra requests get a 409 handing over the live run — or
  both lanes of a live race) → atomic DynamoDB daily counter (30/day global; a
  race claims 2 slots) → `ecs:RunTask` into the **default VPC's public subnets
  with a public IP** — the no-NAT pattern; the task SG has zero ingress and
  443-only egress. Three task definitions: `ctr-app` (0.25 vCPU/512 MiB, slim),
  `ctr-app-boost` (1 vCPU/2 GiB, slim), `ctr-app-fat` (0.25 vCPU/512 MiB, fat).
- **Watch path:** `GET /api/runs/{id}` = `DescribeTasks` + `GetLogEvents` on the
  awslogs stream `app/app/<task-id>`; the page polls every 2.5s. Every poll
  carries the full timestamp anatomy (`pullStartedAt`/`pullStoppedAt`/…) plus
  derived `pullMs`/`appMs`/`billedMs` and an itemized cost. An EventBridge
  task-state-change rule → `ctr-finalize` Lambda persists final state (exit
  code, duration, stopped reason, cost) even when nobody is watching.
- **Stop path:** `POST /api/runs/{id}/stop` = a real `ecs:StopTask` (SIGTERM →
  30s `stopTimeout` → SIGKILL). The `drain` job traps SIGTERM and exits 0; the
  `stubborn` job ignores it and gets exit 137. Both self-finish in ~3.5 min if
  nobody pulls them.
- **Task IAM split (the exhibit):** execution role = pull + logs only; task
  role = `s3:PutObject` on `artifacts/*` only. The container proves it by
  writing its report there; CloudFront serves it back at `/artifacts/<id>.html`
  (uncached behavior, S3 lifecycle expires after 2 days, run records TTL 48h —
  no reset Lambda needed).
- **Jobs:** `report` renders the fictional City of Alpenglow daily-operations
  report (deterministic, seeded by date); `fail` exits 1 after a deliberate
  "checksum mismatch"; `crunch` is the bake-off's fixed PBKDF2 workload
  (identical in both lanes, tunable via `WORK_ITERS` env without a rebuild);
  `oom` allocates until the task memory limit kills it; `drain`/`stubborn` are
  the two SIGTERM endings.

## Costs

Idle ≈ $0 (ECR storage pennies; the cluster, task definitions, and schedule are
free objects). A standard run is ~1–2 min of the smallest Fargate size +
public-IP time ≈ $0.001; a race adds a second lane (the 1 vCPU boost lane is
~$0.0015/min). Worst case with every cap burned as races ≈ $0.05/day + one
scheduled run. CodeBuild stays inside the always-free 100 build-min/month.

## Make targets

`make deploy` (bundle + apply + publish) · `make image` (CodeBuild → ECR; needed
once after first deploy, then after any `app/` change) · `make verify` (65-check
live E2E suite incl. races, OOM, and both SIGTERM endings; uses ~9 launch slots)
· `make publish` · `make destroy`.

## Design

"The bakehouse." Before it meant compute, a batch was a baking: one oven load
of bread, and the plank leans all the way in. The oven (Fargate) fires only
when a batch goes in and is stone cold between bakes; image pull is proofing,
scan-on-push is the health inspection, the EventBridge morning run is the
daily bake, and the fail job is the burnt batch. The newer exhibits keep the
frame: the bake-off is two ovens racing one recipe, the cost receipt is the
bake ticket (with the meter running mid-bake), the OOM job is the batch that
outgrows its pan, and StopTask is pulling the batch early — some loaves come
out gracefully, one refuses until the 30-second bell. Light mode is the bakery
at ten in the morning (flour, parchment, crust gold); dark mode is the
bakehouse at four, lit through the oven door (espresso, embers). The log
terminal is drawn as the oven window, arched with a coal-bed glow, and runs
are listed as bake tickets with a perforated edge. Brick courses divide hero
and footer.

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
