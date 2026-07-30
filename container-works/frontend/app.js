// Alpenglow Batch Works — dashboard. Same-origin API behind /api/*.

const $ = (id) => document.getElementById(id);

// ECS lastStatus → position on the 5-chip lifecycle lane
const STAGE = {
  PROVISIONING: 0,
  PENDING: 1,
  ACTIVATING: 1,
  RUNNING: 2,
  DEACTIVATING: 3,
  STOPPING: 3,
  DEPROVISIONING: 3,
  STOPPED: 4,
};

const JOB_LABEL = {
  report: 'nightly report job',
  fail: 'burnt batch (deliberate exit 1)',
  crunch: 'bake-off crunch lane',
  oom: 'outgrew the pan (OOM kill)',
  drain: 'overnight proof (clean drain)',
  stubborn: 'stubborn proof (ignored SIGTERM)',
};

const LANE_LABEL = {
  size: { standard: 'everyday oven · ¼ vCPU / 512 MiB', boost: 'hot oven · 1 vCPU / 2 GiB' },
  image: { standard: 'slim recipe · alpine base', fat: 'heavy recipe · full Debian base' },
};

let watchTimer = null;
let watchingId = null; // highlighted feed row (first lane when racing)
let single = null; // { runId, logToken, drain }
let race = null; // { kind, lanes: [{runId, variant, logToken, run, named}], drain }
let PRICES = null; // receipt rates, from /api/status
let feedRuns = []; // last loaded recent-runs payload
let statusBody = null;

async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- formatting ----------------------------------------------------------------

function fmtBytes(n) {
  if (!n) return '–';
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(0)} MB` : `${(n / 1024).toFixed(0)} KB`;
}
function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function fmtUsd(n) {
  if (n == null) return '–';
  return `$${n < 0.01 ? n.toFixed(5) : n.toFixed(3)}`;
}
const secs = (ms) => (ms == null ? '?' : `${(ms / 1000).toFixed(1)}s`);

// ---- status / pipeline panel -----------------------------------------------------

async function loadStatus() {
  const { body } = await api('/status');
  statusBody = body;
  const { image, scan, lastBuild, usage } = body;
  if (body.prices) PRICES = body.prices;

  $('stat-launches').textContent = `${usage?.used ?? 0} / ${usage?.limit ?? '–'}`;
  $('stat-image').textContent = fmtBytes(image?.sizeBytes);
  const findings = scan?.counts ? Object.values(scan.counts).reduce((a, b) => a + b, 0) : null;
  $('stat-scan').textContent = scan ? `${findings ?? 0}` : '–';
  $('stat-build').textContent = lastBuild ? `${lastBuild.status === 'SUCCEEDED' ? '✓' : lastBuild.status} ${ago(lastBuild.endTime ?? lastBuild.startTime)}` : '–';

  const buildNode = $('pipe-build');
  if (lastBuild) {
    $('pipe-build-detail').textContent = `build #${lastBuild.number} ${lastBuild.status} ${ago(lastBuild.endTime ?? lastBuild.startTime)}`;
    buildNode.classList.toggle('done', lastBuild.status === 'SUCCEEDED');
    buildNode.classList.toggle('fail', lastBuild.status === 'FAILED');
  }
  const imgNode = $('pipe-image');
  if (image) {
    const digest = image.digest?.replace('sha256:', '').slice(0, 12) ?? '?';
    $('pipe-image-detail').textContent = `ctr-app:latest · ${digest} · ${fmtBytes(image.sizeBytes)} · pushed ${ago(image.pushedAt)}`;
    imgNode.classList.add('done');
  }
  const scanNode = $('pipe-scan');
  if (scan) {
    $('pipe-scan-detail').textContent = `${scan.status ?? '?'} · ${findings ?? 0} findings`;
    scanNode.classList.add('done');
    const order = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFORMATIONAL', 'UNDEFINED'];
    $('scan-counts').innerHTML =
      '<span class="muted small">ECR basic scan of ctr-app:latest → </span>' +
      order
        .filter((s) => scan.counts[s])
        .map((s) => `<span class="sev ${s === 'CRITICAL' || s === 'HIGH' ? 'hot' : ''}">${s} ${scan.counts[s]}</span>`)
        .join('') +
      (findings === 0 ? '<span class="sev">no findings</span>' : '');
  }
  renderCompare();
  return body;
}

// Slim vs fat: registry facts from /status, pull times observed from real runs.
function renderCompare() {
  const b = statusBody;
  if (!b?.imageFat) return; // fat image not built yet
  const el = $('image-compare');
  el.hidden = false;

  const sevCell = (scan) => {
    if (!scan?.counts) return '<span class="muted">scan pending</span>';
    const total = Object.values(scan.counts).reduce((x, y) => x + y, 0);
    const hot = (scan.counts.CRITICAL ?? 0) + (scan.counts.HIGH ?? 0);
    return `<b>${total}</b> findings${hot ? ` <span class="sev hot">${hot} high or critical</span>` : ''}`;
  };
  const lastPull = (isFat) => {
    const r = feedRuns.find((x) => (x.variant === 'fat') === isFat && x.pullMs);
    return r ? `${secs(r.pullMs)} <span class="muted">(run ${r.runId.slice(0, 8)})</span>` : '<span class="muted">no run yet</span>';
  };
  const ratio =
    b.image?.sizeBytes && b.imageFat?.sizeBytes ? (b.imageFat.sizeBytes / b.image.sizeBytes).toFixed(1) : null;

  $('compare-table').innerHTML = `
    <tr><th></th><th>ctr-app:latest · slim</th><th>ctr-app:fat · heavy</th></tr>
    <tr><td>base image</td><td>node:22-alpine</td><td>node:22 (full Debian)</td></tr>
    <tr><td>compressed size</td><td>${fmtBytes(b.image?.sizeBytes)}</td>
        <td>${fmtBytes(b.imageFat?.sizeBytes)}${ratio ? ` <span class="sev hot">${ratio}x</span>` : ''}</td></tr>
    <tr><td>health inspection</td><td>${sevCell(b.scan)}</td><td>${sevCell(b.scanFat)}</td></tr>
    <tr><td>last observed Fargate pull</td><td>${lastPull(false)}</td><td>${lastPull(true)}</td></tr>`;
}

// ---- recent runs ---------------------------------------------------------------

function runRow(r) {
  const btn = document.createElement('button');
  btn.className = 'req-row';
  btn.dataset.runId = r.runId;
  const exit =
    r.lastStatus === 'STOPPED'
      ? r.exitCode === 0
        ? '<span class="badge ok">exit 0</span>'
        : `<span class="badge bad">exit ${r.exitCode ?? '?'}</span>`
      : `<span class="badge">${(r.lastStatus ?? '').toLowerCase()}</span>`;
  const src =
    r.source === 'schedule'
      ? '<span class="badge sched">scheduled</span>'
      : r.raceId
        ? `<span class="badge race">bake-off · ${r.variant}</span>`
        : '<span class="badge">visitor</span>';
  const bits = [];
  if (r.durationMs) bits.push(`ran ${(r.durationMs / 1000).toFixed(0)}s`);
  if (r.costUsd != null) bits.push(fmtUsd(r.costUsd));
  btn.innerHTML = `<span class="id">${r.runId.slice(0, 8)}</span> ${src}
    <span class="desc">${JOB_LABEL[r.job] ?? r.job} ${bits.join(' · ')}</span>
    ${exit} <span class="age">${ago(r.createdAt)}</span>`;
  btn.addEventListener('click', () => {
    if (r.raceId) {
      const lanes = feedRuns.filter((x) => x.raceId === r.raceId).map((x) => ({ runId: x.runId, variant: x.variant }));
      if (lanes.length === 2) return watchRace(r.raceKind, lanes);
    }
    watch(r.runId);
  });
  return btn;
}

async function loadRuns() {
  const { body } = await api('/runs');
  feedRuns = body.runs ?? [];
  const feed = $('feed');
  feed.innerHTML = '';
  if (!feedRuns.length) {
    feed.innerHTML = '<p class="muted">No runs in the last 48h yet. Fire the oven!</p>';
    return;
  }
  for (const r of feedRuns) feed.appendChild(runRow(r));
  highlightSelected();
  renderCompare(); // pull-time cells come from the feed
}

function highlightSelected() {
  document.querySelectorAll('.req-row').forEach((el) => {
    el.classList.toggle('selected', el.dataset.runId === watchingId);
  });
}

// ---- launching -----------------------------------------------------------------

const LAUNCH_IDS = ['launch-report', 'launch-fail', 'launch-oom', 'launch-drain', 'launch-stubborn', 'launch-race-size', 'launch-race-image'];
function setLaunchDisabled(v) {
  for (const id of LAUNCH_IDS) $(id).disabled = v;
}

async function launch(job) {
  $('launch-error').hidden = true;
  setLaunchDisabled(true);
  try {
    const { status, body } = await api('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job }),
    });
    if (status === 202 && body.lanes) {
      watchRace(body.raceKind, body.lanes, 'your bake-off: both ovens are lighting');
    } else if (status === 202) {
      watch(body.runId, true);
    } else if (status === 409 && body.lanes) {
      watchRace(body.raceKind, body.lanes, 'someone else started a bake-off, so you are watching theirs:');
    } else if (status === 409 && body.runId) {
      $('watching').textContent = 'Someone else’s container is in flight, so you’re watching theirs:';
      watch(body.runId);
    } else {
      $('launch-error').textContent = body.message ?? `Launch failed (${status})`;
      $('launch-error').hidden = false;
    }
  } finally {
    setLaunchDisabled(false);
  }
}

// ---- shared rendering ------------------------------------------------------------

function setLifecycle(lastStatus, exitCode) {
  const pos = STAGE[lastStatus] ?? 0;
  document.querySelectorAll('.lifecycle .stage').forEach((el) => {
    const s = Number(el.dataset.stage);
    el.classList.remove('lit', 'done', 'fail');
    if (s < pos) el.classList.add('done');
    else if (s === pos) {
      if (lastStatus === 'STOPPED') el.classList.add(exitCode === 0 ? 'done' : 'fail');
      else el.classList.add('lit');
    }
  });
}

function renderLogs(termEl, preEl, emptyEl, lines) {
  if (!lines.length) return;
  emptyEl.hidden = true;
  for (const l of lines) {
    const div = document.createElement('span');
    const m = l.m;
    if (/\[fail\]/.test(m)) div.className = 'fail';
    else if (/\[sigterm\]/.test(m)) div.className = 'sig';
    else if (/\[(boot|\d\/5|crunch|proof|oom)\]/.test(m)) div.className = 'step';
    div.textContent = m + '\n';
    preEl.appendChild(div);
  }
  termEl.scrollTop = termEl.scrollHeight;
}

// The cold-start anatomy bar: every phase of the task's life to scale, from
// ECS's own timestamps. Live segments extend to "now" until their end exists.
const WF_SEGS = [
  { label: 'capacity + ENI', from: 'createdAt', to: 'pullStartedAt', cls: 'seg-cap' },
  { label: 'image pull', from: 'pullStartedAt', to: 'pullStoppedAt', cls: 'seg-pull' },
  { label: 'container start', from: 'pullStoppedAt', to: 'startedAt', cls: 'seg-boot' },
  { label: 'the job runs', from: 'startedAt', to: 'executionStoppedAt', cls: 'seg-job' },
  { label: 'teardown', from: 'executionStoppedAt', to: 'stoppedAt', cls: 'seg-out' },
];

function renderWaterfall(el, run) {
  const t = (k) => (run[k] ? new Date(run[k]).getTime() : null);
  const start = t('createdAt');
  if (!start || !t('pullStartedAt')) {
    el.innerHTML = '<p class="muted small">waiting for Fargate to report its first timestamp…</p>';
    return;
  }
  const now = Date.now();
  const end = t('stoppedAt') ?? now;
  const total = Math.max(1, end - start);
  let bars = '';
  let legend = '';
  for (const s of WF_SEGS) {
    const a = t(s.from);
    if (a == null) continue;
    const open = t(s.to) == null;
    const b = t(s.to) ?? (t('stoppedAt') ?? now);
    const left = ((a - start) / total) * 100;
    const width = Math.max(0.5, ((b - a) / total) * 100);
    bars += `<i class="wf-seg ${s.cls}${open && !run.stoppedAt ? ' live' : ''}" style="left:${left}%;width:${width}%" title="${s.label}: ${secs(b - a)}"></i>`;
    legend += `<span class="wf-key"><i class="${s.cls}"></i>${s.label} <b>${secs(b - a)}</b></span>`;
  }
  el.innerHTML = `<div class="wf-bar">${bars}</div><div class="wf-legend">${legend}
    <span class="wf-total">cold oven to ${run.stoppedAt ? 'out' : 'now'}: <b>${secs(total)}</b></span></div>`;
}

// The bake ticket: final numbers once stopped, a live-ticking meter before.
function renderReceipt(el, run) {
  let c = run.cost;
  let live = false;
  if (!c && PRICES && run.pullStartedAt && run.cpu) {
    const now = Date.now();
    const billedH = Math.max(0, now - new Date(run.pullStartedAt).getTime()) / 3.6e6;
    const ipH = Math.max(0, now - new Date(run.createdAt).getTime()) / 3.6e6;
    const vcpuUsd = (run.cpu / 1024) * billedH * PRICES.vcpuHour;
    const memUsd = (run.memMiB / 1024) * billedH * PRICES.gbHour;
    const ipUsd = ipH * PRICES.pubIpHour;
    c = { vcpuUsd, memUsd, ipUsd, totalUsd: vcpuUsd + memUsd + ipUsd };
    live = true;
  }
  if (!c) {
    el.innerHTML = '';
    return;
  }
  const line = (label, usd) =>
    `<div class="rc-line"><span>${label}</span><span class="rc-dots"></span><span>${fmtUsd(usd)}</span></div>`;
  el.innerHTML = `<div class="rc${live ? ' rc-live' : ''}">
    <div class="rc-head">bake ticket${live ? ' · meter running' : ''}</div>
    ${line(`Fargate vCPU · ${(run.cpu ?? 256) / 1024} vCPU`, c.vcpuUsd)}
    ${line(`Fargate memory · ${run.memMiB ?? 512} MiB`, c.memUsd)}
    ${line('public IPv4 while attached', c.ipUsd)}
    <div class="rc-line rc-total"><span>this bake${live ? ' so far' : ''}</span><span class="rc-dots"></span><span>${fmtUsd(c.totalUsd)}</span></div>
    <div class="rc-note">published us-east-1 rates; Fargate bills from pull start to task stop</div>
  </div>`;
}

async function fetchRun(runId, token) {
  const { status, body } = await api(`/runs/${runId}${token ? `?nextToken=${encodeURIComponent(token)}` : ''}`);
  return status === 200 ? body : null;
}

function showView(mode) {
  $('single-view').hidden = mode !== 'single';
  $('race-view').hidden = mode !== 'race';
}

// ---- watching a single run --------------------------------------------------------

const IN_FLIGHT = ['PROVISIONING', 'PENDING', 'ACTIVATING', 'RUNNING'];

function updateStopRow(run) {
  const row = $('stoprow');
  if (IN_FLIGHT.includes(run.lastStatus) && run.source !== 'schedule') {
    row.hidden = false;
    if (!$('btn-stop').disabled && !$('stop-note').textContent) {
      $('stop-note').textContent =
        run.job === 'stubborn'
          ? 'this job ignores SIGTERM: expect a 30s standoff, then SIGKILL (exit 137)'
          : run.job === 'drain'
            ? 'this job traps SIGTERM and will drain cleanly (exit 0)'
            : 'sends a real ecs:StopTask; this job traps SIGTERM and exits cleanly';
    }
  } else if (run.lastStatus === 'STOPPED') {
    row.hidden = true;
  }
}

function watch(runId, fresh = false) {
  showView('single');
  clearInterval(watchTimer);
  race = null;
  single = { runId, logToken: null, drain: 0 };
  watchingId = runId;
  $('term-log').textContent = '';
  $('term-empty').hidden = false;
  $('result').hidden = true;
  $('anatomy').hidden = true;
  $('stoprow').hidden = true;
  $('btn-stop').disabled = false;
  $('stop-note').textContent = '';
  $('watching').textContent = fresh ? `your container: task ${runId}` : `run ${runId.slice(0, 8)}… (task ${runId})`;
  setLifecycle('PROVISIONING');
  highlightSelected();

  const poll = async () => {
    const body = await fetchRun(single.runId, single.logToken);
    if (!body) {
      clearInterval(watchTimer);
      return;
    }
    const { run, logs, nextToken, artifact } = body;
    if (nextToken) single.logToken = nextToken;
    setLifecycle(run.lastStatus, run.exitCode);
    renderLogs($('term'), $('term-log'), $('term-empty'), logs);
    if (run.pullStartedAt || run.stoppedAt) {
      $('anatomy').hidden = false;
      renderWaterfall($('waterfall'), run);
      renderReceipt($('receipt'), run);
    }
    updateStopRow(run);
    if (run.lastStatus === 'STOPPED') {
      showResult(run, artifact);
      // a couple more polls to drain any straggling log lines, then stop
      if (single.drain++ >= 2) {
        clearInterval(watchTimer);
        loadRuns();
        loadStatus();
      }
    }
  };
  poll();
  watchTimer = setInterval(poll, 2500);
}

function showResult(run, artifact) {
  $('result').hidden = false;
  const exit = $('result-exit');
  exit.textContent = `exit ${run.exitCode ?? '?'}`;
  exit.className = `badge ${run.exitCode === 0 ? 'ok' : 'bad'}`;
  $('result-duration').textContent = run.durationMs ? `container ran ${(run.durationMs / 1000).toFixed(1)}s` : '';
  const reason = [run.stoppedReason, run.containerReason].filter(Boolean).join(' · ');
  $('result-reason').textContent = reason;
  const a = $('result-artifact');
  if (artifact) {
    a.href = artifact;
    a.hidden = false;
  } else {
    a.hidden = true;
  }
}

// ---- watching a race ---------------------------------------------------------------

function watchRace(kind, lanes, note = '') {
  showView('race');
  clearInterval(watchTimer);
  single = null;
  race = { kind, drain: 0, lanes: lanes.map((l, idx) => ({ ...l, idx, logToken: null, run: null, named: false })) };
  watchingId = lanes[0]?.runId ?? null;
  $('race-note').textContent = note;
  $('race-verdict').hidden = true;
  $('watching').textContent = 'the bake-off: two real tasks, one wall clock';
  for (const lane of race.lanes) {
    const p = `lane-${lane.idx}`;
    $(`${p}-name`).textContent = LANE_LABEL[kind]?.[lane.variant] ?? lane.variant ?? `lane ${lane.idx + 1}`;
    $(`${p}-status`).textContent = 'waiting';
    $(`${p}-status`).className = 'badge';
    $(`${p}-log`).textContent = '';
    $(`${p}-empty`).hidden = false;
    $(`${p}-waterfall`).innerHTML = '';
    $(`${p}-receipt`).innerHTML = '';
  }
  highlightSelected();

  const poll = async () => {
    await Promise.all(
      race.lanes.map(async (lane) => {
        const body = await fetchRun(lane.runId, lane.logToken);
        if (!body) return;
        lane.run = body.run;
        if (body.nextToken) lane.logToken = body.nextToken;
        const p = `lane-${lane.idx}`;
        if (!lane.named && body.run.variant) {
          $(`${p}-name`).textContent = LANE_LABEL[race.kind ?? body.run.raceKind]?.[body.run.variant] ?? body.run.variant;
          lane.named = true;
        }
        const st = $(`${p}-status`);
        if (body.run.lastStatus === 'STOPPED') {
          st.textContent = `exit ${body.run.exitCode ?? '?'}`;
          st.className = `badge ${body.run.exitCode === 0 ? 'ok' : 'bad'}`;
        } else {
          st.textContent = body.run.lastStatus.toLowerCase();
          st.className = 'badge';
        }
        renderLogs($(`${p}-term`), $(`${p}-log`), $(`${p}-empty`), body.logs);
        renderWaterfall($(`${p}-waterfall`), body.run);
        renderReceipt($(`${p}-receipt`), body.run);
      })
    );
    if (race.lanes.every((l) => l.run?.lastStatus === 'STOPPED')) {
      renderVerdict();
      if (race.drain++ >= 2) {
        clearInterval(watchTimer);
        loadRuns();
        loadStatus();
      }
    }
  };
  poll();
  watchTimer = setInterval(poll, 2500);
}

function renderVerdict() {
  const el = $('race-verdict');
  const kind = race.kind ?? race.lanes[0]?.run?.raceKind;
  const byVariant = (v) => race.lanes.find((l) => l.run?.variant === v)?.run;
  if (kind === 'size') {
    const std = byVariant('standard');
    const boost = byVariant('boost');
    if (!std?.appMs || !boost?.appMs) return;
    const ratio = (std.appMs / boost.appMs).toFixed(1);
    let money = '';
    if (std.cost && boost.cost) {
      const rel = boost.cost.totalUsd / std.cost.totalUsd;
      money =
        rel < 1
          ? ` And the bigger oven billed LESS (${fmtUsd(boost.cost.totalUsd)} vs ${fmtUsd(std.cost.totalUsd)}): it held the meter for far fewer seconds.`
          : rel < 1.6
            ? ` The bigger oven billed ${fmtUsd(boost.cost.totalUsd)} vs ${fmtUsd(std.cost.totalUsd)}: nearly the same money, because Fargate bills by the second.`
            : ` The bigger oven billed ${fmtUsd(boost.cost.totalUsd)} vs ${fmtUsd(std.cost.totalUsd)} (${rel.toFixed(1)}x).`;
    }
    el.innerHTML = `<strong>Same batch, two ovens.</strong> The 1 vCPU oven crunched the identical workload ${ratio}x faster: ${secs(boost.appMs)} against ${secs(std.appMs)}.${money} That is the Fargate sizing decision on one screen.`;
  } else {
    const std = byVariant('standard');
    const fat = byVariant('fat');
    if (!std?.pullMs || !fat?.pullMs) return;
    const ratio = (fat.pullMs / std.pullMs).toFixed(1);
    el.innerHTML = `<strong>Same app, two recipes.</strong> Fargate pulled the slim image ${ratio}x faster: ${secs(std.pullMs)} against ${secs(fat.pullMs)} for the identical job. The race was lost in the pull phase, before either job ran a line, and the heavy base carries more scan findings too (see the health inspection below).`;
  }
  el.hidden = false;
}

// ---- stop button -----------------------------------------------------------------

$('btn-stop').addEventListener('click', async () => {
  if (!single) return;
  $('btn-stop').disabled = true;
  const { status, body } = await api(`/runs/${single.runId}/stop`, { method: 'POST' });
  $('stop-note').textContent =
    status === 202 ? 'SIGTERM sent: the 30 second stopTimeout clock is running' : (body.message ?? `stop failed (${status})`);
  if (status !== 202) $('btn-stop').disabled = false;
});

// ---- init ----------------------------------------------------------------------

$('launch-report').addEventListener('click', () => launch('report'));
$('launch-fail').addEventListener('click', () => launch('fail'));
$('launch-oom').addEventListener('click', () => launch('oom'));
$('launch-drain').addEventListener('click', () => launch('drain'));
$('launch-stubborn').addEventListener('click', () => launch('stubborn'));
$('launch-race-size').addEventListener('click', () => launch('race-size'));
$('launch-race-image').addEventListener('click', () => launch('race-image'));

loadStatus().then((body) => {
  loadRuns().then(async () => {
    // If containers are mid-flight when the page opens, show them live —
    // including both lanes of someone else's bake-off.
    const ids = body.running?.taskIds ?? [];
    if (!ids.length) return;
    if (ids.length >= 2) {
      const first = await fetchRun(ids[0]);
      if (first?.run?.raceId) {
        watchRace(first.run.raceKind, ids.slice(0, 2).map((runId) => ({ runId })), 'a bake-off was already in flight:');
        return;
      }
    }
    watch(ids[0]);
  });
});
