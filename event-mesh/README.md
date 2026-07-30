# Event-Driven & Messaging — Alpenglow Service Dispatch

**Live:** https://events.demos.planetek.org · Plank 3 of the [Planetek AWS Boardwalk](https://demos.planetek.org)

A visualized event mesh for a fictional city's 311-style service requests. One submitted event fans
out through EventBridge to department SQS queues (with dead-letter queues and operator redrive), an
SNS pub/sub topic (Lambda + SQS subscribers), and a Step Functions escalation workflow that absorbs
a deliberate transient fault with its retry policy. Every hop writes a trace record, and the site
renders the journey live.

```
                          ┌─ rule category=roads ────→ SQS ─→ worker ─┐
                          ├─ rule category=utilities → SQS ─→ worker ─┼─→ (3 DLQs: peek + redrive via API)
POST /api/requests ─→ EventBridge bus (evt-bus)                       │
                          ├─ rule category=parks ────→ SQS ─→ worker ─┘
                          ├─ rule (all) ─→ SNS ─┬─→ notifier Lambda
                          │                     └─→ audit SQS queue
                          ├─ rule priority=urgent ─→ Step Functions (Express):
                          │                         triage → dispatch (retry ×2) → resolve
                          └─ archive (2 days, excludes replays) ⇄ visitor-triggered StartReplay
every hop ──────────────────────────────────────→ DynamoDB trace table (48h TTL)
```

## Interactive exhibits

- **The interlocking tester**: visitors edit an event and a pattern and run them through a real
  `TestEventPattern` call, plus the same event against the mesh's five live rules (their patterns
  are read off the deployed rule resources, so the tester can never drift). EventBridge's own
  `InvalidEventPatternException` reasons are surfaced verbatim as the error copy.
- **The block order**: the same cut of 10 numbered cars goes to a standard queue and a FIFO queue
  in one `SendMessageBatch` each; a Lambda consumer records every arrival's position (atomic
  DynamoDB counter) and the page renders the orders side by side. Car 7 is offered to the FIFO
  queue twice under one deduplication id: SQS answers the duplicate send with the original
  `MessageId` and delivers once, and the page shows that receipt.
- **The second section**: an EventBridge archive records the bus for 2 days, and a visitor-triggered
  `StartReplay` runs a chosen window (1h/6h/24h) through the mesh again. Replayed events arrive
  with a `replay-name` envelope field; every consumer hashes (original id, replay name) into a
  deterministic fresh trace id, so each re-run appears as its own "second section" on the arrivals
  board, flagged with the run it repeats. One replay at a time (DynamoDB lock, 409 hands a second
  visitor the in-flight name), 10/day.
- **The bad-order cards**: the DLQ strip can peek dead letters without consuming them
  (`ReceiveMessage` with `VisibilityTimeout=0`, a true peek): body, `ApproximateReceiveCount`,
  original enqueue time, and the `DeadLetterQueueSourceArn` receipt naming the track that
  sidelined it. Zero visibility timeout matters: even a 1s in-flight window can race a redrive
  into a completed-but-moved-nothing message move task.

## The deliberate failure modes

- **Poison message** (`simulate: "fail"`): the worker crashes on every delivery; after
  `maxReceiveCount = 3` SQS moves the message to that department's DLQ. The dashboard shows the DLQ
  depth and offers an operator **redrive** (`StartMessageMoveTask`); the redriven message is
  recognized by its trace and processes as *recovered*.
- **Transient fault** (`priority: "urgent"`): the workflow's dispatch step throws
  `TransientDispatchError` on its first attempt for every request (checked against the trace, not a
  dice roll), so the declarative retry policy fires visibly in every single demo.

## Cost posture

All six services are free-tier or fractions of a cent per million at demo volume, so the plank is
public with no credential gate (unlike planks 6/7, where requests spend real money). Guardrails are
for nuisance, not spend: 5 rps edge throttle, per-exhibit daily counters (1,000 requests, 500
pattern tests, 100 races, 10 replays; 429 past each), one replay at a time, 48h TTL on traces,
nightly DLQ purge + trace sweep at 09:00 UTC, and a heartbeat every 30 minutes so the dashboard
never looks dead. The archive stores a few hundred KB at most (2-day retention, and its pattern
excludes replayed events so replays can never compound). Idle cost ≈ $0.

## Operating it

```bash
make deploy    # bundle Lambdas, terraform apply, publish the frontend
make verify    # 52 end-to-end checks against the live URL (~12-15 min: DLQ drill,
               # pattern tester, FIFO race, archive replay + its own cleanup)
make reset     # sweep traces + purge DLQs now (also runs nightly)
make destroy
```

State lives in the shared boardwalk bucket (key `event-mesh.tfstate`); the custom domain and
wildcard cert come from `../platform`. CI (plank 10) plans and applies this plank on every push.

## Design

The plank's visual identity is **the switchyard**: Alpenglow's narrow-gauge classification
yard, run from an illuminated CTC dispatch board. Dark mode is the board at night (steel
green-black panel, lamp light); light mode is the employee timetable (warm ivory paper,
railroad rules). Every node on the mesh map carries a signal lamp that follows railroad
aspects: clear (green) when a hop completes, approach (pulsing amber) while work is in
flight, stop (red) on failures and dead letters. The dead-letter strip is the rip track;
redriving a message re-rails it.

- Type: Barlow Condensed (display), Barlow (text), Spline Sans Mono (readouts), self-hosted
  woff2 in `frontend/fonts/` (the CSP allows no font CDNs).
- Photos (Unsplash free license, resized via CDN params and self-hosted in the site bucket):
  hero is the Georgetown Loop locomotive #111 in the Colorado pines by Claud Richmond;
  the interlude is a night classification yard under mast lights by Yuriy Vertikov.
- Favicon: a turnout with a green lamp on the main and a red lamp on the siding
  (`favicon.svg` + PNG fallbacks).
