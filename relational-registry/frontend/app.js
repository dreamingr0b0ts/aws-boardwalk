// Alpenglow Land & Records Registry — zero-build frontend.
// Renders /api/status (live cluster card), the exhibit catalog, exhibit
// results (rows / plans / integrity verdicts, verbatim from the engine), and
// the persisted evidence report. A 202 from /api/run/* means Aurora is
// resuming from 0 ACU — we retry on a timer and show the measured wake.

const $ = (id) => document.getElementById(id);

const fetchJson = async (path, opts) => {
  try {
    const res = await fetch(path, { cache: "no-store", ...opts });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
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

const GROUP_LABELS = {
  serverless: "Scale to zero",
  read: "Reads, joins & views",
  plans: "Query planner",
  integrity: "Integrity & least privilege",
  schema: "Schema as code",
};

let exhibits = [];
let usage = null;

// ---- status ----------------------------------------------------------------

function renderStatus(status) {
  const badge = $("status-badge");
  const deployed = status?.deployed === true;
  usage = status?.usage ?? usage;
  renderUsage();

  if (!deployed) {
    badge.textContent = "torn down";
    badge.className = "badge down";
    $("stat-status").textContent = "torn down";
    $("stat-acu").textContent = "$0";
    $("status-text").innerHTML =
      "The Aurora cluster is destroyed right now; idle ≈ $0. The evidence report below is the " +
      "certified copy from its last demo cycle, and <code>make demo</code> raises the whole stack " +
      "again in about 15 minutes.";
    $("exhibit-panel").querySelectorAll("button").forEach((b) => (b.disabled = true));
    return;
  }

  const c = status.cluster ?? {};
  const paused = c.paused === true;
  badge.textContent = paused ? "live · sealed at 0 ACU" : "live";
  badge.className = "badge live";
  $("stat-status").textContent = c.status ?? "live";
  $("stat-acu").textContent = c.currentAcu === null ? "–" : `${c.currentAcu} ACU`;
  $("node-aurora").classList.add("live");
  $("status-text").innerHTML = paused
    ? `The cluster is deployed and <strong>sealed at 0 ACU</strong>: compute billing is zero right ` +
      `now. Run any exhibit to unseal it (~15s) and watch <code>${c.engine ?? "PostgreSQL"}</code> come back.`
    : `The cluster is awake at ${c.currentAcu ?? "≤1"} ACU (${c.engine ?? ""}, ${c.minAcu}–${c.maxAcu} ` +
      `ACU, auto-pause after ${c.autoPauseSeconds}s idle). Leave it alone for five minutes and it seals itself.`;
}

function renderUsage() {
  if (!usage) return;
  $("usage-line").textContent =
    `Shared demo budget: ${usage.used}/${usage.limit} exhibit runs today. Queries are canned; ` +
    `the cap just bounds how long strangers can keep the vault awake.`;
}

// ---- exhibit catalog -------------------------------------------------------

function renderCatalog() {
  const wrap = $("exhibit-groups");
  wrap.replaceChildren();
  const groups = [...new Set(exhibits.map((e) => e.group))];
  for (const g of groups) {
    const box = document.createElement("div");
    const label = document.createElement("div");
    label.className = "ex-group-label";
    label.textContent = GROUP_LABELS[g] ?? g;
    const row = document.createElement("div");
    row.className = "ex-row";
    for (const ex of exhibits.filter((e) => e.group === g)) {
      const btn = document.createElement("button");
      btn.className = "ex-btn";
      btn.type = "button";
      btn.textContent = ex.title;
      btn.dataset.id = ex.id;
      btn.addEventListener("click", () => runExhibit(ex, btn));
      row.appendChild(btn);
    }
    box.append(label, row);
    wrap.appendChild(box);
  }
}

// ---- running ---------------------------------------------------------------

let running = false;

async function runExhibit(ex, btn) {
  if (running) return;
  running = true;
  document.querySelectorAll(".ex-btn").forEach((b) => b.classList.toggle("active", b === btn));
  document.querySelectorAll(".ex-btn").forEach((b) => (b.disabled = true));

  $("result").hidden = false;
  $("result-title").textContent = ex.title;
  $("result-blurb").textContent = ex.blurb;
  $("result-sql").textContent = ex.sql.join("\n");
  $("result-meta").textContent = "running…";
  $("result-body").replaceChildren();

  const startedAt = Date.now();
  let woke = false;
  try {
    for (;;) {
      const { status, body } = await fetchJson(`/api/run/${ex.id}`, { method: "POST" });
      if (status === 202) {
        woke = true;
        $("wake").hidden = false;
        $("wake-text").textContent = `Unsealing the vault: Aurora is resuming from 0 ACU… ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      $("wake").hidden = true;
      if (status === 200) {
        if (woke) {
          const note = document.createElement("div");
          note.className = "ok-box";
          note.textContent = `Unsealed from 0 ACU in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. That pause was $0 of compute.`;
          $("result-body").appendChild(note);
        }
        renderResult(body);
        usage = body.usage ?? usage;
        renderUsage();
      } else {
        const err = document.createElement("div");
        err.className = "err-box";
        err.textContent = body?.message ?? `Request failed (${status})`;
        $("result-body").appendChild(err);
      }
      break;
    }
  } finally {
    running = false;
    document.querySelectorAll(".ex-btn").forEach((b) => (b.disabled = false));
    refreshStatus();
  }
}

// ---- result renderers ------------------------------------------------------

function rowsTable(rows) {
  const wrap = document.createElement("div");
  wrap.className = "tbl-wrap";
  if (!rows?.length) {
    wrap.textContent = "(no rows)";
    return wrap;
  }
  const table = document.createElement("table");
  table.className = "rows";
  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  for (const k of Object.keys(rows[0])) {
    const th = document.createElement("th");
    th.textContent = k;
    hr.appendChild(th);
  }
  thead.appendChild(hr);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const v of Object.values(row)) {
      const td = document.createElement("td");
      td.textContent = v === null ? "∅" : String(v);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  wrap.appendChild(table);
  return wrap;
}

function errBox(text) {
  const el = document.createElement("div");
  el.className = "err-box";
  el.textContent = text;
  return el;
}

function okBox(text) {
  const el = document.createElement("div");
  el.className = "ok-box";
  el.textContent = text;
  return el;
}

function renderResult(res) {
  const body = $("result-body");
  $("result-meta").textContent = `${res.totalMs} ms total${res.ms ? ` · ${res.ms} ms in SQL` : ""}`;

  if (res.kind === "rows") {
    body.appendChild(rowsTable(res.rows));
  } else if (res.kind === "plans") {
    for (const p of res.plans) {
      const h = document.createElement("p");
      h.className = "muted";
      h.style.marginTop = "12px";
      h.textContent = p.label;
      const pre = document.createElement("pre");
      pre.className = "plan";
      pre.textContent = p.plan;
      body.append(h, pre);
    }
  } else if (res.kind === "integrity") {
    body.appendChild(res.ok ? okBox(`✓ ${res.verdict}. The registry is untouched.`) : errBox("Unexpected: the engine accepted it"));
    if (res.error) body.appendChild(errBox(res.error));
    const note = document.createElement("p");
    note.className = "muted small";
    note.style.marginTop = "10px";
    note.textContent = res.note ?? "";
    body.appendChild(note);
  } else if (res.kind === "txn") {
    for (const s of res.steps) {
      body.appendChild(s.failed ? errBox(`${s.label} → ${s.error}`) : okBox(`${s.label} → succeeded (inside the transaction)`));
    }
    body.appendChild(
      res.unchanged
        ? okBox("Transaction rolled back: both steps undone, balances identical before and after.")
        : errBox("Balances differ. This should not happen.")
    );
    body.appendChild(rowsTable(res.after));
  } else if (res.kind === "denials") {
    for (const a of res.attempts) {
      body.appendChild(a.failed ? errBox(`${a.label} → ${a.error}`) : errBox(`${a.label} → UNEXPECTEDLY ALLOWED`));
    }
    if (res.ok) body.appendChild(okBox("Both attempts denied in the engine. app_user's fence holds below the IAM layer too."));
  }
}

// ---- evidence --------------------------------------------------------------

const fact = (ok, text) => {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "no";
  li.textContent = text;
  return li;
};

const pill = (label, value, cls = "") => {
  const s = document.createElement("span");
  s.className = `sev ${cls}`;
  s.textContent = `${label} ${value}`;
  return s;
};

function renderEvidence(ev) {
  if (!ev) {
    $("evidence-empty").hidden = false;
    $("evidence-when").textContent = "none yet";
    $("stat-evidence").textContent = "–";
    return;
  }
  $("evidence-body").hidden = false;
  $("evidence-when").textContent = `generated ${fmtWhen(ev.generatedAt)}`;
  $("stat-evidence").textContent = fmtWhen(ev.generatedAt);

  const c = ev.cluster ?? {};
  $("ev-cluster").replaceChildren(
    fact(true, `${c.engine ?? "aurora-postgresql"}`),
    fact(c.scalesToZero, `Scales to zero: ${c.serverlessV2?.minAcu}–${c.serverlessV2?.maxAcu} ACU, pause after ${c.serverlessV2?.autoPauseSeconds}s`),
    fact(c.dataApiEnabled, "Data API only, no database sockets"),
    fact(c.storageEncrypted, "Storage encrypted at rest"),
    ev.wake?.observed
      ? fact(true, `Resume from 0 ACU observed: ~${(ev.wake.ms / 1000).toFixed(1)}s`)
      : fact(true, "Cluster already awake during report"),
  );

  const i = ev.integrity ?? {};
  $("ev-integrity").replaceChildren(
    fact(i.fkViolation?.ok, "Orphan INSERT rejected (foreign key)"),
    fact(i.checkViolation?.ok, "Invalid value rejected (CHECK)"),
    fact(i.txnRollback?.ok, "Failed transfer fully rolled back"),
    fact(i.leastPrivilege?.ok, "app_user DELETE + DROP both denied"),
  );

  const n = ev.data?.counts ?? {};
  const total = ["parcels", "contractors", "permits", "inspections"].reduce((a, k) => a + Number(n[k] ?? 0), 0);
  $("stat-rows").textContent = total ? total.toLocaleString() : "–";
  $("ev-counts").replaceChildren(
    pill("parcels", Number(n.parcels ?? 0).toLocaleString()),
    pill("contractors", Number(n.contractors ?? 0).toLocaleString()),
    pill("permits", Number(n.permits ?? 0).toLocaleString(), "ok"),
    pill("inspections", Number(n.inspections ?? 0).toLocaleString(), "ok"),
  );

  const p = ev.plans ?? {};
  $("ev-plans").replaceChildren(
    fact(p.indexed?.usesIndexScan, `parcel_number lookup → Index Scan (${p.indexed?.executionMs} ms)`),
    fact(p.seqScan?.usesSeqScan, `owner_name lookup → Seq Scan (${p.seqScan?.executionMs} ms)`),
  );

  const tbody = $("ev-migrations").querySelector("tbody");
  tbody.replaceChildren();
  for (const m of ev.migrations ?? []) {
    const tr = document.createElement("tr");
    const id = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = m.id;
    id.appendChild(code);
    const sum = document.createElement("td");
    sum.innerHTML = `<code>${String(m.checksum).slice(0, 12)}…</code>`;
    const when = document.createElement("td");
    when.className = "note";
    when.textContent = fmtWhen(m.applied_at);
    tr.append(id, sum, when);
    tbody.appendChild(tr);
  }
}

// ---- boot ------------------------------------------------------------------

async function refreshStatus() {
  const { body } = await fetchJson("/api/status");
  if (body) renderStatus(body);
}

const [statusRes, exhibitsRes, evidenceRes] = await Promise.all([
  fetchJson("/api/status"),
  fetchJson("/api/exhibits"),
  fetchJson("/evidence/evidence.json"),
]);
exhibits = exhibitsRes.body?.exhibits ?? [];
renderCatalog();
if (statusRes.body) renderStatus(statusRes.body);
renderEvidence(evidenceRes.body);
