// Fire-lookout plank. Renders the persisted evidence (status.json,
// evidence.json, seasons/index.json — all written by the report Lambda and
// make demo/teardown) and drives the live exhibits behind /api/*:
//   • the practice-smoke drill  (POST /api/drills, poll GET /api/drills/{id})
//   • the policy desk           (POST /api/policy/simulate | /validate)
//   • the perimeter fence log   (GET /api/fence)
// The policy desk and fence log work year-round; the drill needs a staffed
// season and answers 503 honestly between windows.

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v;
    else n.setAttribute(k, v);
  }
  for (const kid of kids) if (kid != null) n.append(kid);
  return n;
}

const fetchJson = async (path) => {
  try {
    const res = await fetch(path, { cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
};

// API calls can transiently be answered by the shared WAF with an HTML 403
// block page (plank 4's lesson). Parse defensively: never throw on non-JSON.
async function api(method, path, body) {
  try {
    const res = await fetch(path, {
      method,
      cache: "no-store",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (text.startsWith("<")) return { status: 503, blocked: true, body: {} };
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch { return { status: res.status, body: {} }; }
    return { status: res.status, body: json };
  } catch {
    return { status: 0, body: {} };
  }
}

const fmtWhen = (iso) => {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "–";
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const abs = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  return days === 0 ? `today (${abs})` : days === 1 ? `yesterday (${abs})` : `${abs}`;
};

const fmtClock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// ---- status + evidence (persisted) ------------------------------------------

function renderStatus(status) {
  const badge = $("status-badge");
  const live = status?.deployed === true;
  badge.textContent = live ? "tower staffed · stack live" : "off season · torn down";
  badge.className = `badge ${live ? "live" : "down"}`;
  $("stat-status").textContent = live ? "LIVE" : "torn down";
  $("status-text").innerHTML = live
    ? "The tower is staffed: GuardDuty, Security Hub, and the Config conformance pack are " +
      "evaluating this account right now, and the evidence below is refreshable live."
    : status
      ? `The daily-billing stack was destroyed ${fmtWhen(status.updatedAt)} after its last demo window. ` +
        "The evidence report below is the persisted logbook of that cycle, redeployable in about 15 minutes."
      : "No demo cycle has run yet. The first <code>make demo</code> will staff the tower and generate evidence.";
  if (live) $("node-report").classList.add("live");
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

function renderFieldGuide(gd) {
  const wrap = $("ev-fieldguide");
  const guide = gd?.fieldGuide ?? [];
  if (!guide.length) {
    $("ev-fg-note").textContent = "The field guide populates once GuardDuty has sample findings to catalogue.";
    wrap.replaceChildren();
    return;
  }
  $("ev-fg-note").textContent =
    `${gd.distinctTypes} distinct finding types in a ${gd.fieldGuideSampled}-finding sample. ` +
    "Each GuardDuty type names its own threat purpose; the plain-language line is what the lookout would do about it.";
  wrap.replaceChildren(...guide.map((c) => {
    const sevCls = c.severity === "HIGH" ? "bad" : c.severity === "MEDIUM" ? "warn" : "ok";
    return el("div", { class: "guide-card" },
      el("div", { class: "guide-top" },
        el("code", { text: c.type }),
        pill(c.severity.toLowerCase(), `·${c.count}`, sevCls),
      ),
      el("p", { class: "guide-plain", text: c.plain }),
      el("p", { class: "guide-tax", text: `${c.threatPurpose} · ${c.resource || "—"}${c.family ? " · " + c.family : ""}` }),
    );
  }));
}

function renderEvidence(ev) {
  if (!ev) {
    $("evidence-empty").hidden = false;
    $("evidence-when").textContent = "none yet";
    return;
  }
  $("evidence-body").hidden = false;
  $("evidence-when").textContent = `generated ${fmtWhen(ev.generatedAt)}`;
  $("stat-evidence").textContent = fmtWhen(ev.generatedAt);

  const ct = ev.cloudtrail ?? {};
  $("ev-cloudtrail").replaceChildren(
    fact(ct.logging, "CloudTrail logging (management events, all regions)"),
    fact(ct.logFileValidation, "Log-file integrity validation enabled"),
    fact(ct.kmsEncrypted, "Logs encrypted with a customer-managed KMS key"),
  );
  const km = ev.kms ?? {};
  $("ev-kms").replaceChildren(
    fact(km.customerManaged, "Customer-managed key (not AWS-managed)"),
    fact(km.rotationEnabled, "Automatic annual rotation enabled"),
    fact(km.keyState === "Enabled", `Key state: ${km.keyState ?? "unknown"}`),
  );

  const gd = ev.guardduty ?? { total: 0, bySeverity: {} };
  $("stat-gd").textContent = String(gd.total);
  $("ev-gd").replaceChildren(
    pill("total", gd.total),
    pill("high", gd.bySeverity.HIGH ?? 0, "bad"),
    pill("medium", gd.bySeverity.MEDIUM ?? 0, "warn"),
    pill("low", gd.bySeverity.LOW ?? 0, "ok"),
  );
  renderFieldGuide(gd);

  const sh = ev.securityHub ?? { compliance: {} };
  const c = sh.compliance;
  $("ev-sh").replaceChildren(
    pill("passed", c.PASSED ?? 0, "ok"),
    pill("failed", c.FAILED ?? 0, "bad"),
    pill("warning", c.WARNING ?? 0, "warn"),
  );
  $("ev-sh-note").textContent =
    "AWS Foundational Security Best Practices control findings across the whole demo account. " +
    "Checks keep arriving at dispatch for a couple of hours after each deploy, so early reports run lighter.";

  const cf = ev.config ?? { rules: {} };
  const r = cf.rules;
  const compliant = r.COMPLIANT ?? 0, non = r.NON_COMPLIANT ?? 0, insufficient = r.INSUFFICIENT_DATA ?? 0;
  const evaluated = compliant + non;
  $("stat-nist").textContent = evaluated ? `${compliant}/${evaluated}` : "–";
  const bar = $("ev-nist-bar");
  bar.replaceChildren();
  const total = compliant + non + insufficient || 1;
  for (const [cls, n] of [["c", compliant], ["n", non], ["i", insufficient]]) {
    const span = document.createElement("span");
    span.className = cls;
    span.style.width = `${(n / total) * 100}%`;
    bar.appendChild(span);
  }
  $("ev-nist").replaceChildren(
    pill("compliant", compliant, "ok"),
    pill("non-compliant", non, "bad"),
    pill("no applicable resources", insufficient),
  );

  const tbody = $("ev-boundary").querySelector("tbody");
  tbody.replaceChildren();
  for (const sim of ev.boundary?.simulations ?? []) {
    const note = sim.decision === "allowed"
      ? "inside both the policy and the boundary"
      : sim.grantedByPolicy
        ? "granted by the role's policy, blocked by the boundary"
        : "granted by nothing";
    tbody.appendChild(el("tr", {},
      el("td", {}, el("code", { text: sim.action })),
      el("td", {}, pill(sim.decision, "", sim.decision === "allowed" ? "ok" : "bad")),
      el("td", { class: "note", text: note }),
    ));
  }
}

// ---- the season ledger ------------------------------------------------------

function renderLedger(index) {
  const seasons = index?.seasons ?? [];
  if (!seasons.length) return;
  $("ledger-panel").hidden = false;

  const maxFsbp = Math.max(1, ...seasons.map((s) => s.fsbpEvaluated || 0));
  const maxNist = Math.max(1, ...seasons.map((s) => s.nistEvaluated || 0));
  const rows = seasons.slice().reverse().map((s) => {
    const fsbpPct = s.fsbpEvaluated ? Math.round((s.fsbpPassed / s.fsbpEvaluated) * 100) : 0;
    const nistPct = s.nistEvaluated ? Math.round((s.nistCompliant / s.nistEvaluated) * 100) : 0;
    return el("div", { class: "ledger-row" },
      el("div", { class: "ledger-date" },
        el("strong", { text: s.date }),
        el("span", { class: "muted small", text: `${s.guardduty} GuardDuty findings` }),
      ),
      el("div", { class: "ledger-metric" },
        el("div", { class: "ledger-metric-head" },
          el("span", { text: "FSBP passing" }),
          el("span", { class: "mono-id", text: `${s.fsbpPassed}/${s.fsbpEvaluated} · ${fsbpPct}%` }),
        ),
        meterBar(s.fsbpPassed, s.fsbpEvaluated, maxFsbp, "ok"),
      ),
      el("div", { class: "ledger-metric" },
        el("div", { class: "ledger-metric-head" },
          el("span", { text: "NIST 800-53 compliant" }),
          el("span", { class: "mono-id", text: `${s.nistCompliant}/${s.nistEvaluated} · ${nistPct}%` }),
        ),
        meterBar(s.nistCompliant, s.nistEvaluated, maxNist, "amber"),
      ),
    );
  });

  const body = $("ledger-body");
  body.replaceChildren(...rows);
  if (seasons.length === 1) {
    body.append(el("p", { class: "muted small", text:
      "One window recorded so far. The ledger fills as the tower is staffed across the season." }));
  }
}

// Two-layer bar: the full evaluated count scaled against the widest window
// (so windows are comparable), with the passing portion filled.
function meterBar(passed, evaluated, max, cls) {
  const outerPct = max ? (evaluated / max) * 100 : 0;
  const fillPct = evaluated ? (passed / evaluated) * 100 : 0;
  return el("div", { class: "meter" },
    el("div", { class: "meter-track", style: `width:${outerPct}%` },
      el("div", { class: `meter-fill ${cls}`, style: `width:${fillPct}%` }),
    ),
  );
}

// ---- the practice-smoke drill -----------------------------------------------

const STAGE_ORDER = [
  { key: "stage", title: "Stage the smoke" },
  { key: "tripwire", title: "The tripwire" },
  { key: "inspector", title: "The inspector" },
];

const drill = { polling: false, runId: null, startAt: 0, timer: null };

function stageDot(state) {
  const cls = state === "ok" ? "ok" : state === "warn" ? "warn" : state === "running" ? "running" : "idle";
  return el("span", { class: `dot ${cls}` });
}

function renderDrill(run) {
  $("drill-board").hidden = false;
  $("drill-run-id").textContent = run.runId;

  const stagesEl = $("drill-stages");
  stagesEl.replaceChildren(...STAGE_ORDER.map(({ key, title }) => {
    const s = run.stages?.[key];
    const state = s?.state ?? "idle";
    const bits = [el("div", { class: "stage-head" }, stageDot(state), el("span", { class: "stage-title", text: s?.label ?? title }))];
    if (s?.elapsedSec != null && key === "tripwire" && state === "running") {
      bits.push(el("span", { class: "mono-id", text: `watching · ${s.elapsedSec}s` }));
    }
    if (s?.compliance) {
      const cls = s.compliance === "NON_COMPLIANT" ? "bad" : s.compliance === "COMPLIANT" ? "ok" : "warn";
      bits.push(pill(s.compliance.toLowerCase().replace("_", "-"), "", cls));
    }
    const li = el("li", { class: `stage ${state}` }, el("div", { class: "stage-row" }, ...bits));
    if (s?.detail) li.append(el("p", { class: "stage-detail", text: s.detail }));
    return li;
  }));

  const logEl = $("drill-log");
  logEl.replaceChildren(...(run.log ?? []).map((l) => el("div", { class: "log-line", text: l.m })));
  logEl.scrollTop = logEl.scrollHeight;

  const done = run.status === "passed" || run.status === "failed";
  const sum = $("drill-summary");
  if (done && run.summary) {
    sum.hidden = false;
    sum.className = `summary-line ${run.status === "passed" ? "ok" : "bad"}`;
    sum.textContent = run.summary.headline ?? run.summary.reason ?? "Drill complete.";
  }
  return done;
}

function tickElapsed() {
  if (!drill.startAt) return;
  $("drill-elapsed").textContent = fmtClock(Date.now() - drill.startAt);
}

async function pollDrill(runId) {
  drill.runId = runId;
  drill.polling = true;
  for (let i = 0; i < 200 && drill.polling; i += 1) {
    const { status, body } = await api("GET", `/api/drills/${runId}`);
    if (status === 200 && body.run) {
      if (!drill.startAt) drill.startAt = new Date(body.run.startedAt ?? body.run.createdAt).getTime();
      const done = renderDrill(body.run);
      if (done) {
        drill.polling = false;
        clearInterval(drill.timer);
        $("drill-elapsed").textContent = fmtClock(Date.now() - drill.startAt);
        await refreshDrillStatus();
        loadRecentDrills();
        return;
      }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
  drill.polling = false;
  clearInterval(drill.timer);
}

async function startDrill() {
  const btn = $("drill-btn");
  btn.disabled = true;
  $("drill-msg").hidden = true;
  const { status, body } = await api("POST", "/api/drills");

  if (status === 202 && body.runId) {
    drill.startAt = Date.now();
    clearInterval(drill.timer);
    drill.timer = setInterval(tickElapsed, 1000);
    pollDrill(body.runId);
    return;
  }
  if (status === 409 && body.runId) {
    // Someone else's drill is on the board — attach and watch it.
    drill.startAt = 0;
    clearInterval(drill.timer);
    drill.timer = setInterval(tickElapsed, 1000);
    showDrillMsg(body.message);
    pollDrill(body.runId);
    return;
  }
  btn.disabled = false;
  showDrillMsg(
    body.message ||
    (status === 429 ? "The drill book is full for today." :
     status === 503 ? "The tower is dark. Deploy a demo window to run a live drill." :
     "The drill could not be started; try again in a moment."));
}

function showDrillMsg(m) {
  const p = $("drill-msg");
  p.textContent = m;
  p.hidden = false;
}

async function refreshDrillStatus() {
  const { status, body } = await api("GET", "/api/status");
  const btn = $("drill-btn");
  if (status !== 200) {
    $("drill-usage").textContent = "the tower could not be reached";
    return null;
  }
  if (!body.deployed) {
    btn.disabled = true;
    $("drill-usage").textContent = "the tower is dark: deploy a window to run a live drill";
    return body;
  }
  const used = body.drill?.used ?? 0, limit = body.drill?.limit ?? 0;
  const spent = used >= limit;
  btn.disabled = spent || drill.polling;
  $("drill-usage").textContent = spent
    ? `all ${limit} of today's drills are spent (resets 00:00 UTC)`
    : `drills today: ${used} of ${limit}`;
  return body;
}

async function loadRecentDrills() {
  const { status, body } = await api("GET", "/api/drills");
  const runs = (status === 200 ? body.runs : []) ?? [];
  if (!runs.length) { $("drill-recent").hidden = true; return; }
  $("drill-recent").hidden = false;
  $("drill-recent-list").replaceChildren(...runs.map((run) =>
    el("li", {},
      el("span", { class: "mono-id", text: run.runId }),
      el("span", { class: `tag-mini ${run.status === "passed" ? "ok" : run.status === "failed" ? "bad" : "run"}`, text: run.status }),
      el("span", { class: "muted small", text: fmtWhen(run.createdAt) }),
    )));
}

async function initDrill() {
  $("drill-btn").addEventListener("click", startDrill);
  const s = await refreshDrillStatus();
  loadRecentDrills();
  // If a drill is already out, attach to it so every visitor shares the view.
  if (s?.drill?.running?.runId) {
    drill.timer = setInterval(tickElapsed, 1000);
    pollDrill(s.drill.running.runId);
  }
}

// ---- the policy desk --------------------------------------------------------

async function runSimulate() {
  const out = $("sim-out");
  out.replaceChildren(el("p", { class: "muted small", text: "simulating…" }));
  const { status, body } = await api("POST", "/api/policy/simulate");
  if (status !== 200) {
    out.replaceChildren(el("p", { class: "muted small", text: body.message || "The desk is closed right now." }));
    return;
  }
  const table = el("table", { class: "sim" },
    el("thead", {}, el("tr", {},
      el("th", { text: "Action" }), el("th", { text: "In policy" }),
      el("th", { text: "In boundary" }), el("th", { text: "Decision" }))),
  );
  const tb = el("tbody", {});
  for (const r of body.rows ?? []) {
    tb.append(el("tr", {},
      el("td", {}, el("code", { text: r.action })),
      el("td", { class: "ctr", text: r.inPolicy ? "✓" : "—" }),
      el("td", { class: "ctr", text: r.inBoundary ? "✓" : "—" }),
      el("td", {}, pill(r.decision, "", r.decision === "allowed" ? "ok" : "bad"),
        el("p", { class: "note", text: r.note })),
    ));
  }
  table.append(tb);
  out.replaceChildren(table);
}

const VALIDATE_CHIPS = [
  { id: "typo-action", label: "Typo in an action" },
  { id: "star-passrole", label: "PassRole on *" },
  { id: "missing-version", label: "No Version element" },
  { id: "clean", label: "A clean grant" },
];

const FINDING_CLASS = { SECURITY_WARNING: "bad", ERROR: "bad", WARNING: "warn", SUGGESTION: "" };

async function runValidate(payload) {
  const out = $("validate-out");
  out.replaceChildren(el("p", { class: "muted small", text: "linting…" }));
  const { status, body } = await api("POST", "/api/policy/validate", payload);
  if (status !== 200) {
    out.replaceChildren(el("p", { class: "muted small", text: body.message || "The linter could not read that." }));
    return;
  }
  const kids = [];
  if (body.policy) {
    kids.push(el("pre", { class: "policy-json", text: JSON.stringify(body.policy, null, 2) }));
  }
  if (body.serviceError) {
    kids.push(el("div", { class: "finding bad" },
      el("p", { class: "finding-head", text: "Access Analyzer rejected the document" }),
      el("p", { class: "finding-body", text: body.serviceError.message })));
  } else if (!(body.findings ?? []).length) {
    kids.push(el("p", { class: "clean-note", text: "Access Analyzer found nothing to flag. A clean grant is evidence too." }));
  } else {
    for (const f of body.findings) {
      kids.push(el("div", { class: `finding ${FINDING_CLASS[f.findingType] ?? ""}` },
        el("p", { class: "finding-head" },
          pill((f.findingType || "note").replace("_", " ").toLowerCase(), "", FINDING_CLASS[f.findingType] ?? ""),
          el("code", { text: f.issueCode || "" })),
        el("p", { class: "finding-body", text: f.findingDetails || "" })));
    }
  }
  out.replaceChildren(...kids);
}

function initPolicyDesk() {
  $("sim-btn").addEventListener("click", runSimulate);
  const chipsEl = $("validate-chips");
  chipsEl.replaceChildren(...VALIDATE_CHIPS.map((c) => {
    const b = el("button", { class: "chip", type: "button", text: c.label });
    b.addEventListener("click", () => {
      chipsEl.querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      runValidate({ exhibitId: c.id });
    });
    return b;
  }));
  $("validate-btn").addEventListener("click", () => {
    const text = $("validate-text").value.trim();
    if (!text) { showValidateHint(); return; }
    $("validate-chips").querySelectorAll(".chip").forEach((x) => x.classList.remove("on"));
    runValidate({ policy: text });
  });
}

function showValidateHint() {
  $("validate-out").replaceChildren(el("p", { class: "muted small", text: "Paste a policy document first, or pick a specimen above." }));
}

// ---- the perimeter fence log ------------------------------------------------

async function loadFence() {
  const btn = $("fence-btn");
  btn.disabled = true;
  const out = $("fence-out");
  out.replaceChildren(el("p", { class: "muted small", text: "reading the last few hours of sampled traffic…" }));
  const { status, body } = await api("GET", "/api/fence");
  btn.disabled = false;
  if (status !== 200) {
    out.replaceChildren(el("p", { class: "muted small", text: "The fence log could not be read right now." }));
    return;
  }

  const t = body.totals ?? {};
  $("fence-totals").textContent = (t.blocked24h != null || t.allowed24h != null)
    ? `last 24h · ${t.blocked24h ?? 0} blocked · ${t.allowed24h ?? 0} allowed`
    : "";

  const anyHits = (body.rules ?? []).some((r) => r.sampleCount > 0);
  if (!anyHits) {
    out.replaceChildren(el("p", { class: "muted small", text:
      "The fence has been quiet in the sampled window. Refresh in a while; the internet rarely stays polite for long." }));
    return;
  }

  out.replaceChildren(...(body.rules ?? []).map((r) => {
    const actions = Object.entries(r.actions ?? {}).map(([a, n]) =>
      pill(a.toLowerCase(), n, a === "BLOCK" ? "bad" : a === "ALLOW" ? "ok" : "warn"));
    const card = el("div", { class: "fence-card" },
      el("div", { class: "fence-head" },
        el("h3", { text: r.label }),
        el("span", { class: "mono-id", text: `${r.sampleCount} sampled` })),
      el("div", { class: "scan-counts" }, ...actions));
    if (r.recent?.length) {
      const rows = r.recent.map((h) => el("tr", {},
        el("td", { class: "mono-id", text: h.at ? new Date(h.at).toLocaleTimeString() : "—" }),
        el("td", { text: h.country }),
        el("td", { class: "mono-id", text: `${h.method} ${h.uri}` }),
        el("td", {}, pill(h.action.toLowerCase(), "", h.action === "BLOCK" ? "bad" : "ok")),
        el("td", { class: "mono-id", text: h.ip })));
      card.append(el("div", { class: "fence-table-wrap" },
        el("table", { class: "fence-table" },
          el("thead", {}, el("tr", {},
            el("th", { text: "time" }), el("th", { text: "geo" }),
            el("th", { text: "request" }), el("th", { text: "action" }), el("th", { text: "source" }))),
          el("tbody", {}, ...rows))));
    }
    return card;
  }));
}

function initFence() {
  $("fence-btn").addEventListener("click", loadFence);
}

// ---- boot -------------------------------------------------------------------

const [status, evidence, ledger] = await Promise.all([
  fetchJson("/evidence/status.json"),
  fetchJson("/evidence/evidence.json"),
  fetchJson("/evidence/seasons/index.json"),
]);
renderStatus(status);
renderEvidence(evidence);
renderLedger(ledger);

initDrill();
initPolicyDesk();
initFence();
