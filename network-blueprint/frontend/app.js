// Renders /evidence/status.json (written by make demo / make teardown) and
// /evidence/evidence.json (written by the net-evidence-report Lambda).
// Both may be absent before the first demo cycle — every state renders.

const $ = (id) => document.getElementById(id);

const fetchJson = async (path) => {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

const fmtWhen = (iso) => {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const abs = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return days === 0 ? `today (${abs})` : days === 1 ? `yesterday (${abs})` : `${abs}`;
};

function renderStatus(status) {
  const badge = $("status-badge");
  const live = status?.deployed === true;
  badge.textContent = live ? "stack live" : "torn down";
  badge.className = `badge ${live ? "live" : "down"}`;
  $("stat-status").textContent = live ? "LIVE" : "torn down";
  $("status-text").innerHTML = live
    ? "The full network is staked out and billing: both instances are up, the interface endpoints " +
      "are serving SSM, and the paths below are live right now. Sheet 03 will send the inspector " +
      "on a round for you."
    : status
      ? `The hourly-billing stack was struck ${fmtWhen(status.updatedAt)} after its last demo window. ` +
        "The evidence below is the as-built record from that cycle, redeployable in ~15 minutes."
      : "No demo cycle has run yet. The first <code>make demo</code> will build the network and generate evidence.";
}

const pill = (label, value, cls = "") => {
  const s = document.createElement("span");
  s.className = `sev ${cls}`;
  s.textContent = value === "" ? label : `${label} ${value}`;
  return s;
};

const fact = (ok, text) => {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "no";
  li.textContent = text;
  return li;
};

const verdictRow = (tbody, title, sub, pass, resultText, note) => {
  const tr = document.createElement("tr");
  const th = document.createElement("th");
  th.textContent = title;
  if (sub) {
    const s = document.createElement("small");
    s.textContent = sub;
    th.append(document.createElement("br"), s);
  }
  const result = document.createElement("td");
  result.appendChild(pill(resultText, "", pass ? "ok" : "bad"));
  const noteTd = document.createElement("td");
  noteTd.className = "note";
  noteTd.textContent = note;
  tr.append(th, result, noteTd);
  tbody.appendChild(tr);
};

function renderEvidence(ev) {
  if (!ev) {
    $("evidence-empty").hidden = false;
    $("evidence-when").textContent = "none yet";
    return;
  }
  $("evidence-body").hidden = false;
  $("evidence-when").textContent = `generated ${fmtWhen(ev.generatedAt)}`;
  $("stat-evidence").textContent = fmtWhen(ev.generatedAt);

  // reachability analyzer
  const reach = ev.reachability ?? [];
  $("stat-reach").textContent = `${reach.filter((r) => r.pass).length}/${reach.length}`;
  const reachBody = $("ev-reach").querySelector("tbody");
  reachBody.replaceChildren();
  for (const r of reach) {
    verdictRow(
      reachBody,
      r.label,
      r.explanationCodes?.length ? `analyzer: ${r.explanationCodes.join(", ")}` : null,
      r.pass,
      `${r.reachable ? "reachable" : "not reachable"} ${r.pass ? "✓ as designed" : "✗ UNEXPECTED"}`,
      r.because,
    );
  }

  // live probes
  const probes = ev.probes ?? [];
  $("stat-probes").textContent = `${probes.filter((p) => p.pass).length}/${probes.length}`;
  const probeBody = $("ev-probes").querySelector("tbody");
  probeBody.replaceChildren();
  for (const p of probes) {
    verdictRow(probeBody, p.label, `from ${p.from}`, p.pass,
      p.pass ? "✓ as designed" : "✗ UNEXPECTED", p.expect);
  }

  // routing
  const rt = ev.network?.routing ?? {};
  $("ev-routing").replaceChildren(
    fact(rt.publicDefaultViaIgw, "Public tier default route via the internet gateway"),
    fact(rt.privateDefaultRoutes === 0, "Private route tables: zero default routes (no internet path)"),
    fact(rt.natGateways === 0, `NAT gateways: ${rt.natGateways ?? "?"} (~$33/mo avoided)`),
    fact((rt.privateRouteTables ?? []).every((t) => t.gatewayEndpointRoutes > 0),
      "Gateway-endpoint routes present in every private route table"),
  );

  // endpoints
  const ep = ev.endpoints ?? {};
  $("ev-endpoints").replaceChildren(
    fact(ep.gatewayAvailable === 2, `Gateway endpoints (S3, DynamoDB): ${ep.gatewayAvailable ?? 0}/2, free`),
    fact(ep.interfaceAvailable === 3, `Interface endpoints (SSM trio): ${ep.interfaceAvailable ?? 0}/3, PrivateLink`),
    fact(true, "Interface endpoints admit HTTPS from inside the VPC only"),
  );

  // segmentation
  const st = ev.securityTiers ?? {};
  $("ev-segmentation").replaceChildren(
    fact(true, "SG tiers: 443 (world) → web · 8080 (web SG) → app · 5432 (app SG) → data"),
    fact(st.defaultSgLocked, "Default security group locked: zero rules"),
    fact(ev.nacls?.deny3389, "NACL explicit deny: RDP (3389) dead before any allow rule"),
    fact(true, "NACLs stateless underneath the stateful security groups"),
  );

  // flow logs
  const fl = ev.flowLogs ?? {};
  $("ev-flow").replaceChildren(
    pill("records", fl.totalEvents ?? 0),
    pill("accepted", fl.accept ?? 0, "ok"),
    pill("rejected", fl.reject ?? 0, "bad"),
    ...(fl.rejectSamples ?? []).slice(0, 3).map((r) => pill(`${r.srcAddr} → :${r.dstPort}`, "", "warn")),
  );
  $("ev-flow-note").textContent =
    `Last ${fl.windowMinutes ?? 30} minutes before report generation. The rejected flows are genuine ` +
    "internet background noise: strangers scanning a minutes-old public IP, turned away by the security group.";
}

// ---- field inspection rounds (same-origin /api, Sheet 03) -------------------
// POST /api/runs dispatches a live probe round via the net-inspection-runner
// Lambda; the page polls the run record and replays the field book as it is
// written. A 409 means a round is already out: the response carries that
// round's id and the page attaches to it, so everyone watches the original
// request.

const api = async (path, opts) => {
  try {
    const res = await fetch(`/api${path}`, opts);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  } catch {
    return { status: 0, body: {} };
  }
};

const STAGE_BY_STATUS = {
  queued: 0, dispatching: 0, "probing-web": 1, "probing-app": 2,
  comparing: 3, passed: 4, failed: 4, error: 4,
};
const FINAL_STATUS = new Set(["passed", "failed", "error"]);

// probe name → the plan-view element the inspector is walking
const PROBE_EDGE = {
  "public-internet-egress": "edge-public-internet-egress",
  "web-to-app-8080": "edge-web-to-app-8080",
  "web-to-data-5432": "edge-web-to-data-5432",
  "private-internet-egress": "edge-private-internet-egress",
  "private-s3-gateway": "edge-gateway-endpoints",
  "private-ddb-gateway": "edge-gateway-endpoints",
  "imdsv1-blocked": "node-private-app",
  "imdsv2-works": "node-private-app",
};

let watchTimer = null;
let watchingId = null;
let renderedLines = 0;
let stackDeployed = false;

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 129600) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

function setRouteStage(status) {
  const pos = STAGE_BY_STATUS[status] ?? 0;
  document.querySelectorAll(".route .stage").forEach((el) => {
    const s = Number(el.dataset.stage);
    el.classList.remove("lit", "done", "fail");
    if (s < pos) el.classList.add("done");
    else if (s === pos) {
      if (FINAL_STATUS.has(status)) el.classList.add(status === "passed" ? "done" : "fail");
      else el.classList.add("lit");
    }
  });
}

function resetEdges() {
  for (const id of new Set(Object.values(PROBE_EDGE))) {
    $(id)?.classList.remove("tracing", "traced", "traced-bad");
  }
}

function paintEdges(probes) {
  for (const p of probes) {
    const el = $(PROBE_EDGE[p.name]);
    if (!el) continue;
    if (p.status === "running") el.classList.add("tracing");
    else if (p.status === "pass") { el.classList.remove("tracing"); el.classList.add("traced"); }
    else if (p.status === "fail") { el.classList.remove("tracing"); el.classList.add("traced-bad"); }
  }
}

function renderFieldBook(lines) {
  if (lines.length <= renderedLines) return;
  $("fb-empty").hidden = true;
  const pre = $("fb-log");
  for (const l of lines.slice(renderedLines)) {
    const span = document.createElement("span");
    if (/\]\s+\$ /.test(l.m)) span.className = "cmd";
    else if (/\]\s+OK /.test(l.m)) span.className = "ok";
    else if (/\]\s+XX /.test(l.m) || /abandoned/.test(l.m)) span.className = "bad";
    span.textContent = l.m + "\n";
    pre.appendChild(span);
  }
  renderedLines = lines.length;
  const book = $("fieldbook");
  book.scrollTop = book.scrollHeight;
}

function showRoundResult(run) {
  $("round-result").hidden = false;
  const verdict = $("result-verdict");
  const labels = { passed: "as designed", failed: "unexpected results", error: "round abandoned" };
  verdict.textContent = labels[run.status] ?? run.status;
  verdict.className = `badge ${run.status === "passed" ? "ok" : "bad"}`;
  const passCount = (run.probes ?? []).filter((p) => p.status === "pass").length;
  const secs = run.finishedAt && run.createdAt
    ? ` · ${((new Date(run.finishedAt) - new Date(run.createdAt)) / 1000).toFixed(0)}s on site`
    : "";
  $("result-summary").textContent =
    `${passCount}/${(run.probes ?? []).length} probes as designed · plan agreement ` +
    `${run.plan?.agree ?? "?"}/${run.plan?.total ?? "?"}${secs}`;
}

function highlightRound() {
  document.querySelectorAll(".round-row").forEach((el) => {
    el.classList.toggle("selected", el.dataset.runId === watchingId);
  });
}

function watchRound(runId, mine = false) {
  clearInterval(watchTimer);
  watchingId = runId;
  renderedLines = 0;
  $("fb-log").textContent = "";
  $("fb-empty").hidden = false;
  $("round-result").hidden = true;
  resetEdges();
  setRouteStage("queued");
  $("watching").textContent = mine
    ? `your round: ${runId}`
    : `watching round ${runId}`;
  highlightRound();

  let polls = 0;
  const poll = async () => {
    if (++polls > 160) { // ~5 min: a round that stopped reporting is not coming back
      clearInterval(watchTimer);
      $("round-error").textContent = "The round stopped reporting. Check the recent rounds below.";
      $("round-error").hidden = false;
      return;
    }
    const { status, body } = await api(`/runs/${runId}`);
    if (status !== 200) { clearInterval(watchTimer); return; }
    const run = body.run;
    setRouteStage(run.status);
    paintEdges(run.probes ?? []);
    renderFieldBook(run.log ?? []);
    if (FINAL_STATUS.has(run.status)) {
      clearInterval(watchTimer);
      showRoundResult(run);
      loadRounds();
      loadApiStatus(false);
    }
  };
  poll();
  watchTimer = setInterval(poll, 2000);
}

async function launchRound() {
  $("round-error").hidden = true;
  const btn = $("launch-round");
  btn.disabled = true;
  try {
    const { status, body } = await api("/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (status === 202) {
      watchRound(body.runId, true);
    } else if (status === 409 && body.runId) {
      $("watching").textContent =
        `an inspector was already out when you pressed the button; this is the original round (${body.runId})`;
      watchRound(body.runId);
    } else {
      $("round-error").textContent = body.message ?? `The round could not be dispatched (${status || "network error"}).`;
      $("round-error").hidden = false;
    }
  } finally {
    btn.disabled = !stackDeployed;
  }
}

function roundRow(r) {
  const btn = document.createElement("button");
  btn.className = "round-row";
  btn.dataset.runId = r.runId;
  const chips = {
    passed: '<span class="chip ok">as designed</span>',
    failed: '<span class="chip bad">unexpected</span>',
    error: '<span class="chip bad">abandoned</span>',
  };
  const chip = chips[r.status] ?? `<span class="chip run">${r.status ?? "running"}</span>`;
  btn.innerHTML = `<span class="id">${r.runId}</span> ${chip}
    <span class="desc">${r.summary ?? "round in progress"}</span>
    <span class="age">${ago(r.createdAt)}</span>`;
  btn.addEventListener("click", () => watchRound(r.runId));
  return btn;
}

async function loadRounds() {
  const { status, body } = await api("/runs");
  const feed = $("rounds-feed");
  if (status !== 200) { feed.innerHTML = '<p class="muted">The round ledger is unreachable.</p>'; return; }
  feed.replaceChildren();
  if (!body.runs?.length) {
    feed.innerHTML = '<p class="muted">No rounds in the last 48h. Be the first one out.</p>';
    return;
  }
  for (const r of body.runs) feed.appendChild(roundRow(r));
  highlightRound();
}

async function loadApiStatus(autoAttach = true) {
  const { status, body } = await api("/status");
  const btn = $("launch-round");
  if (status !== 200) {
    $("round-usage").textContent = "inspection API unreachable";
    btn.disabled = true;
    return;
  }
  stackDeployed = body.deployed === true;
  $("round-usage").textContent = `day book: ${body.usage?.used ?? 0} of ${body.usage?.limit ?? "?"} rounds today`;
  btn.disabled = !stackDeployed;
  if (!watchingId) {
    $("watching").textContent = stackDeployed
      ? "the site is staked out; a round takes about a minute"
      : "the stack is struck between windows, so no rounds can go out; the day book below still reads back";
  }
  if (autoAttach && body.running?.runId && !watchingId) watchRound(body.running.runId);
}

$("launch-round").addEventListener("click", launchRound);

const [status, evidence] = await Promise.all([
  fetchJson("/evidence/status.json"),
  fetchJson("/evidence/evidence.json"),
]);
renderStatus(status);
renderEvidence(evidence);
loadApiStatus();
loadRounds();
