# Event-Driven & Messaging — Alpenglow Service Dispatch

**Live:** https://events.demos.planetek.org · Plank 3 of the [Planetek AWS Boardwalk](https://demos.planetek.org)

A visualized event mesh for a fictional city's 311-style service requests. One submitted event fans
out through EventBridge to department SQS queues (with dead-letter queues and operator redrive), an
SNS pub/sub topic (Lambda + SQS subscribers), and a Step Functions escalation workflow that absorbs
a deliberate transient fault with its retry policy. Every hop writes a trace record, and the site
renders the journey live.

```
                          ┌─ rule category=roads ────→ SQS ─→ worker ─┐
                          ├─ rule category=utilities → SQS ─→ worker ─┼─→ (3 DLQs, redrive via API)
POST /api/requests ─→ EventBridge bus (evt-bus)                       │
                          ├─ rule category=parks ────→ SQS ─→ worker ─┘
                          ├─ rule (all) ─→ SNS ─┬─→ notifier Lambda
                          │                     └─→ audit SQS queue
                          └─ rule priority=urgent ─→ Step Functions (Express):
                                                    triage → dispatch (retry ×2) → resolve
every hop ──────────────────────────────────────→ DynamoDB trace table (48h TTL)
```

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
for nuisance, not spend: 5 rps edge throttle, a 1,000/day global counter (429 past it), 48h TTL on
traces, nightly DLQ purge + trace sweep at 09:00 UTC, and a heartbeat every 30 minutes so the
dashboard never looks dead. Idle cost ≈ $0.

## Operating it

```bash
make deploy    # bundle Lambdas, terraform apply, publish the frontend
make verify    # 25 end-to-end checks against the live URL (incl. DLQ + redrive drill)
make reset     # sweep traces + purge DLQs now (also runs nightly)
make destroy
```

State lives in the shared boardwalk bucket (key `event-mesh.tfstate`); the custom domain and
wildcard cert come from `../platform`. CI (plank 10) plans and applies this plank on every push.
