// Alpenglow Batch Works — the containerized job itself.
//
// A nightly-report batch job shaped like the real thing: generate the day's
// (fictional) service-request ledger, aggregate it, render an HTML report,
// upload it to S3 via the TASK ROLE (the container's own identity — the
// execution role that pulled this image can't touch S3, and this role can
// write only under artifacts/). Logs go to stdout → awslogs → CloudWatch,
// where the dashboard tails them live.
//
// JOB=report   → full run, exit 0
// JOB=fail     → hits a (deliberate) bad-input error after aggregation, exit 1,
//                so the dashboard's exit-code / stopped-reason handling is
//                demonstrable on demand.
// JOB=crunch   → fixed CPU-bound workload (PBKDF2), identical in every lane of
//                the bake-off; only the oven size changes the wall clock.
// JOB=oom      → allocates past the 512 MiB task limit until Fargate kills the
//                container (exit 137, OutOfMemoryError stopped reason).
// JOB=drain    → long-running proof that traps SIGTERM and exits 0 cleanly
//                inside the 30s stopTimeout grace window.
// JOB=stubborn → long-running proof that IGNORES SIGTERM, so ECS SIGKILLs it
//                when the 30s grace window runs out (exit 137).

import { hostname } from 'node:os';
import { pbkdf2Sync } from 'node:crypto';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const JOB = process.env.JOB ?? 'report';
const SOURCE = process.env.SOURCE ?? 'manual';
const VARIANT = process.env.VARIANT ?? 'standard';
const RACE_ID = process.env.RACE_ID ?? '';
const BUCKET = process.env.ARTIFACT_BUCKET;
const PREFIX = process.env.ARTIFACT_PREFIX ?? 'artifacts/';
// The bake-off workload is FIXED per race (both lanes hash the same count);
// the API can retune it via env override without an image rebuild.
const WORK_ITERS = Number(process.env.WORK_ITERS ?? '6000000');

const t0 = Date.now();
const log = (msg) => console.log(`+${String(Date.now() - t0).padStart(5, ' ')}ms ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fargate injects a per-task metadata endpoint; the task id doubles as the
// run id everywhere (API, DynamoDB record, artifact key, log stream name),
// and Limits carries the task sizing (the container's own cgroup is
// unlimited — Fargate enforces at the parent task cgroup, so metadata is
// the honest in-container source).
async function taskIdentity() {
  const base = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (!base) return { taskId: `local-${Date.now()}`, az: 'local', launchType: 'LOCAL', vcpu: '?', memMiB: '?' };
  const meta = await (await fetch(`${base}/task`)).json();
  return {
    taskId: meta.TaskARN.split('/').pop(),
    az: meta.AvailabilityZone ?? '?',
    launchType: meta.LaunchType ?? 'FARGATE',
    vcpu: meta.Limits?.CPU ?? '?',
    memMiB: meta.Limits?.Memory ?? '?',
  };
}

// Deterministic PRNG seeded from the date: the same day always produces the
// same fictional ledger, so re-runs are comparable and nothing needs storing.
function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEPARTMENTS = ['Roads', 'Utilities', 'Parks', 'Permitting', 'Animal Control'];
const PRIORITIES = ['normal', 'normal', 'normal', 'normal', 'elevated', 'urgent']; // weighted

function generateLedger(dateStr, rand) {
  const count = 380 + Math.floor(rand() * 240);
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      dept: DEPARTMENTS[Math.floor(rand() * DEPARTMENTS.length)],
      priority: PRIORITIES[Math.floor(rand() * PRIORITIES.length)],
      hour: Math.floor(rand() ** 1.4 * 24), // skews toward morning
      resolutionMin: 20 + Math.floor(rand() * 460),
    });
  }
  return rows;
}

function aggregate(rows) {
  const byDept = {};
  for (const d of DEPARTMENTS) byDept[d] = { total: 0, urgent: 0, resolutionMin: 0 };
  const byHour = new Array(24).fill(0);
  for (const r of rows) {
    const d = byDept[r.dept];
    d.total += 1;
    d.resolutionMin += r.resolutionMin;
    if (r.priority === 'urgent') d.urgent += 1;
    byHour[r.hour] += 1;
  }
  for (const d of DEPARTMENTS) {
    byDept[d].avgResolutionMin = Math.round(byDept[d].resolutionMin / Math.max(1, byDept[d].total));
    delete byDept[d].resolutionMin;
  }
  const busiestHour = byHour.indexOf(Math.max(...byHour));
  return { byDept, byHour, busiestHour, total: rows.length };
}

function renderReport({ dateStr, agg, identity, limits }) {
  const deptRows = DEPARTMENTS.map((d) => {
    const s = agg.byDept[d];
    return `<tr><td>${d}</td><td>${s.total}</td><td>${s.urgent}</td><td>${s.avgResolutionMin} min</td></tr>`;
  }).join('\n      ');
  const peak = Math.max(...agg.byHour);
  const bars = agg.byHour
    .map((n, h) => `<div class="bar" style="height:${Math.round((n / peak) * 64) + 2}px" title="${String(h).padStart(2, '0')}:00, ${n} requests"></div>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Alpenglow Daily Operations Report · ${dateStr}</title>
<style>
  body{font:15px/1.5 ui-sans-serif,system-ui,sans-serif;color:#2b1d12;background:#f7f1e5;margin:0;padding:32px 16px}
  .sheet{max-width:720px;margin:0 auto;background:#fffdf6;border:1px solid #e5d9c3;border-radius:14px;padding:32px}
  h1{font-size:22px;margin:0}  .sub{color:#8a7460;font-size:13px;margin-top:4px}
  h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#8a7460;margin:28px 0 10px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e5d9c3}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#8a7460}
  .chart{display:flex;align-items:flex-end;gap:3px;height:70px;margin-top:6px}
  .bar{flex:1;background:#c8871f;border-radius:2px 2px 0 0;min-height:2px}
  .meta{margin-top:28px;padding-top:14px;border-top:1px dashed #d3c3a5;font-size:12px;color:#8a7460}
  .meta code{background:#f1e8d6;padding:1px 5px;border-radius:5px}
  .stamp{display:inline-block;margin-top:14px;padding:3px 10px;border:1.5px solid #a06a1a;border-radius:999px;color:#a06a1a;font-weight:700;font-size:12px}
</style></head><body><div class="sheet">
<h1>City of Alpenglow · Daily Operations Report</h1>
<p class="sub">${dateStr} · ${agg.total} service requests · fictional data generated by a containerized batch job</p>
<span class="stamp">BUILT INSIDE A FARGATE CONTAINER</span>
<h2>By department</h2>
<table><tr><th>Department</th><th>Requests</th><th>Urgent</th><th>Avg resolution</th></tr>
      ${deptRows}</table>
<h2>Requests by hour (busiest: ${String(agg.busiestHour).padStart(2, '0')}:00)</h2>
<div class="chart">${bars}</div>
<div class="meta">Produced by ECS task <code>${identity.taskId}</code> (${identity.launchType}, ${identity.az},
${limits.vcpu} vCPU / ${limits.memMiB} MiB) and uploaded to S3 under <code>artifacts/</code> using the
task role, an IAM identity scoped to exactly that one prefix. This artifact expires after 48 hours.
Part of the <a href="https://demos.planetek.org">Planetek AWS Boardwalk</a>; not a real government document.</div>
</div></body></html>`;
}

// ---- bake-off lane: fixed CPU-bound workload -----------------------------------
// Both lanes of a race hash exactly the same number of PBKDF2-SHA512
// iterations; the only variable is how much oven Fargate gives each one.
async function runCrunch() {
  const CHUNKS = 50;
  const perChunk = Math.ceil(WORK_ITERS / CHUNKS);
  log(`[crunch] fixed workload: ${(WORK_ITERS / 1e6).toFixed(1)}M PBKDF2-SHA512 iterations, identical in every lane`);
  const t1 = Date.now();
  for (let c = 1; c <= CHUNKS; c++) {
    pbkdf2Sync('alpenglow', `salt-${c}`, perChunk, 64, 'sha512');
    if (c % 5 === 0) {
      const pct = (c / CHUNKS) * 100;
      log(`[crunch] ${String(pct).padStart(3, ' ')}% · ${(((c * perChunk) / 1e6)).toFixed(1)}M of ${(WORK_ITERS / 1e6).toFixed(1)}M iterations`);
    }
    await sleep(0); // yield so a SIGTERM handler could run between chunks
  }
  const secs = (Date.now() - t1) / 1000;
  log(`[crunch] done: ${(WORK_ITERS / 1e6).toFixed(1)}M iterations in ${secs.toFixed(1)}s (${Math.round(WORK_ITERS / secs / 1000)}k iters/s), exiting 0`);
}

// ---- the batch that outgrows its pan -------------------------------------------
// Fargate enforces memory at the TASK level (this container's own cgroup looks
// unlimited), so the honest way to show the limit is to walk into it. The
// kernel OOM killer ends this mid-sentence: no goodbye line, exit 137, and
// ECS records "OutOfMemoryError" as the container's stopped reason.
async function runOom(limits) {
  const held = [];
  const stepMiB = 48;
  log(`[oom] this batch will not stop rising: allocating ${stepMiB} MiB at a time inside a ${limits.memMiB} MiB pan`);
  log('[oom] note: the container cgroup reports NO limit; the task-level limit is what kills you');
  for (let i = 1; i <= 24; i++) {
    // fill() with a non-zero byte, or the kernel hands back copy-on-write
    // zero pages and never commits them — a zero-filled "allocation" can
    // balloon far past the task limit without tripping the OOM killer
    // (verified live: Buffer.alloc alone survived to 1152 MiB in a 512 pan).
    held.push(Buffer.allocUnsafe(stepMiB * 1024 * 1024).fill(0xa5));
    log(`[oom] holding ${held.length * stepMiB} MiB of a ${limits.memMiB} MiB pan`);
    await sleep(900);
  }
  // Unreachable once pages are really committed. Belt and braces for local runs.
  throw new Error('oom job survived past its pan somehow');
}

// ---- the overnight proofs: SIGTERM behavior, both endings -----------------------
// drain: traps SIGTERM, finishes its tray, exits 0 inside the 30s grace window.
// stubborn: ignores SIGTERM and keeps going until ECS SIGKILLs it (exit 137).
// Left alone, both come out on their own after ~3.5 minutes.
async function runProof(kind) {
  if (kind === 'drain') {
    process.on('SIGTERM', () => {
      log('[sigterm] stop requested: ECS sent SIGTERM, the 30s grace window is open');
      log('[sigterm] pulling the batch early: finishing the current tray, closing the ledger');
      setTimeout(() => {
        log('[sigterm] clean shutdown inside the grace window, exiting 0');
        process.exit(0);
      }, 700);
    });
    log('[proof] overnight proof started: this job traps SIGTERM and shuts down cleanly');
    log('[proof] press "pull the batch early" on the dashboard to send a real StopTask');
  } else {
    process.on('SIGTERM', () => {
      log('[sigterm] heard the bell, IGNORING it: this batch is not coming out');
      log('[sigterm] ECS will wait out the 30s stopTimeout, then SIGKILL (exit 137, no goodbye line)');
    });
    log('[proof] stubborn proof started: this job IGNORES SIGTERM on purpose');
    log('[proof] stop it and watch the 30s stopTimeout expire into a SIGKILL');
  }
  for (let tray = 1; tray <= 42; tray++) {
    await sleep(5000);
    log(`[proof] tray ${tray} of 42 still proofing`);
  }
  log('[proof] nobody pulled it: the batch came out on its own, exiting 0');
}

async function main() {
  const identity = await taskIdentity();
  const limits = { vcpu: identity.vcpu, memMiB: identity.memMiB };
  const dateStr = (process.env.REPORT_DATE ?? new Date().toISOString()).slice(0, 10);

  log(`[boot] Alpenglow Batch Works job starting: job=${JOB} source=${SOURCE}${RACE_ID ? ` race=${RACE_ID} lane=${VARIANT}` : ''}`);
  log(`[boot] task ${identity.taskId} on ${identity.launchType} in ${identity.az}, host ${hostname()}`);
  log(`[boot] node ${process.version} ${process.arch}, task limits: ${limits.vcpu} vCPU / ${limits.memMiB} MiB (task metadata endpoint)`);

  if (JOB === 'crunch') return runCrunch();
  if (JOB === 'oom') return runOom(limits);
  if (JOB === 'drain' || JOB === 'stubborn') return runProof(JOB);

  // report and fail both bake the ledger; report also traps SIGTERM so even
  // the everyday job demonstrates a clean drain if someone pulls it early.
  process.on('SIGTERM', () => {
    log('[sigterm] stop requested mid-bake: flushing and exiting 0 inside the grace window');
    setTimeout(() => process.exit(0), 500);
  });
  await sleep(1200);

  log(`[1/5] generating service-request ledger for ${dateStr} (seeded by date, deterministic)`);
  const seed = [...dateStr].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rows = generateLedger(dateStr, mulberry32(seed));
  log(`[1/5] ledger ready: ${rows.length} fictional requests across ${DEPARTMENTS.length} departments`);
  await sleep(1600);

  log('[2/5] aggregating: totals, urgent counts, resolution times, hourly histogram');
  const agg = aggregate(rows);
  log(`[2/5] aggregation done, busiest hour ${String(agg.busiestHour).padStart(2, '0')}:00`);
  await sleep(1600);

  if (JOB === 'fail') {
    log('[3/5] validating ledger against yesterday’s closing balance');
    await sleep(1200);
    throw new Error('ledger checksum mismatch: refusing to publish a bad report (this failure is the JOB=fail demo)');
  }

  log('[3/5] rendering HTML report');
  const html = renderReport({ dateStr, agg, identity, limits });
  log(`[3/5] rendered ${html.length} bytes`);
  await sleep(1400);

  const key = `${PREFIX}${identity.taskId}.html`;
  log(`[4/5] uploading to s3://${BUCKET}/${key} via the task role`);
  const s3 = new S3Client({});
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: html,
      ContentType: 'text/html; charset=utf-8',
      CacheControl: 'public, max-age=300',
    })
  );
  log('[4/5] upload complete');
  await sleep(800);

  log(`[5/5] done in ${Date.now() - t0}ms, report at /artifacts/${identity.taskId}.html, exiting 0`);
}

main().catch((err) => {
  console.error(`+${String(Date.now() - t0).padStart(5, ' ')}ms [fail] ${err.message}`);
  console.error(`+${String(Date.now() - t0).padStart(5, ' ')}ms [fail] exiting 1; ECS will record the exit code and stopped reason`);
  process.exit(1);
});
