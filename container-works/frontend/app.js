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

let watchTimer = null;
let watchingId = null;
let logToken = null;
let drainPolls = 0; // extra polls after STOPPED so the log tail catches up

async function api(path, opts) {
  const res = await fetch(`/api${path}`, opts);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// ---- status / pipeline panel -------------------------------------------------

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

async function loadStatus() {
  const { body } = await api('/status');
  const { image, scan, lastBuild, usage, running } = body;

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
  return body;
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
  const src = r.source === 'schedule' ? '<span class="badge sched">scheduled</span>' : '<span class="badge">visitor</span>';
  const dur = r.durationMs ? `ran ${(r.durationMs / 1000).toFixed(0)}s` : '';
  btn.innerHTML = `<span class="id">${r.runId.slice(0, 8)}</span> ${src}
    <span class="desc">${r.job === 'fail' ? 'failing job (deliberate)' : 'nightly report job'} ${dur}</span>
    ${exit} <span class="age">${ago(r.createdAt)}</span>`;
  btn.addEventListener('click', () => watch(r.runId));
  return btn;
}

async function loadRuns() {
  const { body } = await api('/runs');
  const feed = $('feed');
  feed.innerHTML = '';
  if (!body.runs?.length) {
    feed.innerHTML = '<p class="muted">No runs in the last 48h yet — launch one!</p>';
    return;
  }
  for (const r of body.runs) feed.appendChild(runRow(r));
  highlightSelected();
}

function highlightSelected() {
  document.querySelectorAll('.req-row').forEach((el) => {
    el.classList.toggle('selected', el.dataset.runId === watchingId);
  });
}

// ---- launching -----------------------------------------------------------------

async function launch(job) {
  $('launch-error').hidden = true;
  $('launch-report').disabled = $('launch-fail').disabled = true;
  try {
    const { status, body } = await api('/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ job }),
    });
    if (status === 202) {
      watch(body.runId, true);
    } else if (status === 409 && body.runId) {
      $('watching').textContent = 'Someone else’s container is in flight — watching theirs:';
      watch(body.runId);
    } else {
      $('launch-error').textContent = body.message ?? `Launch failed (${status})`;
      $('launch-error').hidden = false;
    }
  } finally {
    $('launch-report').disabled = $('launch-fail').disabled = false;
  }
}

// ---- watching a run --------------------------------------------------------------

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

function renderLogs(lines) {
  if (!lines.length) return;
  $('term-empty').hidden = true;
  const pre = $('term-log');
  for (const l of lines) {
    const div = document.createElement('span');
    let m = l.m;
    if (/\[fail\]/.test(m)) div.className = 'fail';
    else if (/\[(boot|\d\/5)\]/.test(m)) div.className = 'step';
    div.textContent = m + '\n';
    pre.appendChild(div);
  }
  const term = $('term');
  term.scrollTop = term.scrollHeight;
}

function showResult(run, artifact) {
  $('result').hidden = false;
  const exit = $('result-exit');
  exit.textContent = `exit ${run.exitCode ?? '?'}`;
  exit.className = `badge ${run.exitCode === 0 ? 'ok' : 'bad'}`;
  $('result-duration').textContent = run.durationMs ? `container ran ${(run.durationMs / 1000).toFixed(1)}s` : '';
  $('result-reason').textContent = run.stoppedReason ?? '';
  const a = $('result-artifact');
  if (artifact) {
    a.href = artifact;
    a.hidden = false;
  } else {
    a.hidden = true;
  }
}

function watch(runId, fresh = false) {
  clearInterval(watchTimer);
  watchingId = runId;
  logToken = null;
  drainPolls = 0;
  $('term-log').textContent = '';
  $('term-empty').hidden = false;
  $('result').hidden = true;
  $('watching').textContent = `run ${runId.slice(0, 8)}… (task ${runId})`;
  if (fresh) $('watching').textContent = `your container: task ${runId}`;
  setLifecycle('PROVISIONING');
  highlightSelected();

  const poll = async () => {
    const { status, body } = await api(`/runs/${runId}${logToken ? `?nextToken=${encodeURIComponent(logToken)}` : ''}`);
    if (status !== 200) {
      clearInterval(watchTimer);
      return;
    }
    const { run, logs, nextToken, artifact } = body;
    if (nextToken) logToken = nextToken;
    setLifecycle(run.lastStatus, run.exitCode);
    renderLogs(logs);
    if (run.lastStatus === 'STOPPED') {
      showResult(run, artifact);
      // a couple more polls to drain any straggling log lines, then stop
      if (drainPolls++ >= 2) {
        clearInterval(watchTimer);
        loadRuns();
        loadStatus();
      }
    }
  };
  poll();
  watchTimer = setInterval(poll, 2500);
}

// ---- init ----------------------------------------------------------------------

$('launch-report').addEventListener('click', () => launch('report'));
$('launch-fail').addEventListener('click', () => launch('fail'));

loadStatus();
loadRuns().then(() => {
  // If a container is mid-flight when the page opens, show it live.
  api('/status').then(({ body }) => {
    if (body.running?.taskIds?.length) watch(body.running.taskIds[0]);
  });
});
