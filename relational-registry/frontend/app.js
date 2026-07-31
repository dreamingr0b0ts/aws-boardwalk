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
  history: "Chain of title",
  plans: "Query planner",
  integrity: "Integrity & least privilege",
  concurrency: "Two clerks, one book",
  tenancy: "District desks",
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
  renderSealWatch(status);

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
    $("search-q").disabled = true;
    $("search-btn").disabled = true;
    document.querySelectorAll("#search-panel .chip").forEach((b) => (b.disabled = true));
    $("search-usage").textContent = "The search desk is closed while the stack is torn down.";
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

// ---- the seal watch --------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";
const mkSvg = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
};

let sealTimer = null;
let sealingRefreshAt = 0;

function drawAcuChart(series, maxAcu) {
  const svg = $("acu-chart");
  svg.replaceChildren();
  const W = 320, H = 84, PADX = 8, TOP = 12, BASE = H - 16;
  const yMax = Math.max(Number(maxAcu) || 1, 0.5);
  svg.append(
    mkSvg("line", { x1: PADX, y1: BASE, x2: W - PADX, y2: BASE, class: "grid" }),
    mkSvg("line", { x1: PADX, y1: TOP, x2: W - PADX, y2: TOP, class: "grid faint" })
  );
  const axisTop = mkSvg("text", { x: PADX, y: TOP - 3, class: "axis" });
  axisTop.textContent = `${yMax} ACU`;
  const axisZero = mkSvg("text", { x: PADX, y: BASE + 11, class: "axis" });
  axisZero.textContent = "0 (sealed)";
  svg.append(axisTop, axisZero);

  const t = series?.t ?? [];
  const v = series?.v ?? [];
  if (!t.length) {
    const note = mkSvg("text", { x: W / 2, y: (TOP + BASE) / 2, class: "axis", "text-anchor": "middle" });
    note.textContent = "no capacity samples in the last 3 hours";
    svg.append(note);
    return;
  }
  const t1 = Date.now();
  const t0 = t1 - 3 * 3600_000;
  const x = (ms) => PADX + ((W - 2 * PADX) * (Math.max(ms, t0) - t0)) / (t1 - t0);
  const y = (val) => BASE - ((BASE - TOP) * val) / yMax;

  // Solid between minute-adjacent samples, dashed bridges across quiet gaps.
  let solid = "";
  let bridges = "";
  for (let i = 0; i < t.length; i++) {
    const px = x(t[i]).toFixed(1);
    const py = y(v[i]).toFixed(1);
    if (i === 0) {
      solid += `M${px} ${py}`;
      continue;
    }
    if (t[i] - t[i - 1] <= 150_000) solid += `L${px} ${py}`;
    else {
      bridges += `M${x(t[i - 1]).toFixed(1)} ${y(v[i - 1]).toFixed(1)}L${px} ${py}`;
      solid += `M${px} ${py}`;
    }
  }
  if (bridges) svg.append(mkSvg("path", { d: bridges, class: "trace bridge" }));
  svg.append(mkSvg("path", { d: solid, class: "trace" }));
  // A dot on the latest sample.
  const last = t.length - 1;
  svg.append(
    mkSvg("path", {
      d: `M${x(t[last]).toFixed(1)} ${y(v[last]).toFixed(1)}l0 0.01`,
      class: "trace dot",
    })
  );
}

function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function updateSealCard(status) {
  const c = status.cluster ?? {};
  const big = $("seal-big");
  const note = $("seal-note");
  if (c.paused === true) {
    big.textContent = "SEALED";
    big.className = "sw-big sealed";
    note.textContent = "0 ACU. Compute bills nothing. Any exhibit unseals it and the wake is timed.";
    return;
  }
  const pauseMs = (c.autoPauseSeconds ?? 300) * 1000;
  const lastTouch = status.lastTouch ? new Date(status.lastTouch).getTime() : null;
  if (!lastTouch) {
    big.textContent = "awake";
    big.className = "sw-big";
    note.textContent = "No exhibit has touched the vault yet today; the seal clock starts on the first one.";
    return;
  }
  const remaining = lastTouch + pauseMs - Date.now();
  if (remaining > 0) {
    big.textContent = fmtClock(remaining);
    big.className = "sw-big";
    note.textContent = "Until the vault may seal. Every statement anyone runs winds the clock back up.";
  } else {
    big.textContent = "sealing…";
    big.className = "sw-big";
    note.textContent = "The idle allowance has run out. The stamp flips when the capacity meter reads 0 ACU.";
    // Nudge a status refresh occasionally so the SEALED stamp actually lands.
    if (Date.now() - sealingRefreshAt > 25_000) {
      sealingRefreshAt = Date.now();
      refreshStatus();
    }
  }
}

function renderSealWatch(status) {
  const el = $("seal-watch");
  if (status?.deployed !== true) {
    el.hidden = true;
    if (sealTimer) clearInterval(sealTimer);
    sealTimer = null;
    return;
  }
  el.hidden = false;
  drawAcuChart(status.cluster?.acuSeries, status.cluster?.maxAcu);
  const acu = status.cluster?.currentAcu;
  $("acu-read").textContent =
    acu === null || acu === undefined ? "no reading yet" : acu === 0 ? "0 ACU right now: sealed" : `${acu} ACU right now`;
  updateSealCard(status);
  if (sealTimer) clearInterval(sealTimer);
  sealTimer = setInterval(() => updateSealCard(status), 1000);
}

function drawWakeChart(wakes) {
  const svg = $("wake-chart");
  svg.replaceChildren();
  const W = 320, H = 84, PADX = 8, TOP = 14, BASE = H - 16;
  svg.append(mkSvg("line", { x1: PADX, y1: BASE, x2: W - PADX, y2: BASE, class: "grid" }));
  if (!wakes.length) {
    const note = mkSvg("text", { x: W / 2, y: (TOP + BASE) / 2, class: "axis", "text-anchor": "middle" });
    note.textContent = "no unsealings measured yet";
    svg.append(note);
    $("wake-read").textContent = "Let the vault seal, then run an exhibit: the wake lands here.";
    return;
  }
  const recent = wakes.slice(0, 12).reverse(); // chronological, oldest left
  const maxMs = Math.max(...recent.map((w) => w.ms));
  const plot = W - 2 * PADX;
  const gap = 3;
  const barW = Math.min(22, plot / recent.length - gap);
  recent.forEach((w, i) => {
    const h = Math.max(3, ((BASE - TOP) * w.ms) / maxMs);
    const bx = PADX + i * (plot / recent.length) + (plot / recent.length - barW) / 2;
    svg.append(mkSvg("rect", { x: bx.toFixed(1), y: (BASE - h).toFixed(1), width: barW.toFixed(1), height: h.toFixed(1), rx: 2, class: "bar" }));
    if (i === recent.length - 1) {
      const label = mkSvg("text", {
        x: Math.min(bx + barW / 2, W - PADX - 4).toFixed(1),
        y: (BASE - h - 4).toFixed(1),
        class: "dlabel",
        "text-anchor": "end",
      });
      label.textContent = `${(w.ms / 1000).toFixed(1)}s`;
      svg.append(label);
    }
  });
  const sorted = [...wakes].map((w) => w.ms).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  $("wake-read").textContent = `${wakes.length} on record · median ${(median / 1000).toFixed(1)}s from 0 ACU to answering`;
}

async function refreshWakes() {
  const { body } = await fetchJson("/api/wakes");
  if (body?.wakes) drawWakeChart(body.wakes);
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
          note.textContent = `Unsealed from 0 ACU in ${((Date.now() - startedAt) / 1000).toFixed(1)}s. That pause was $0 of compute, and the wake is now on the record below the vault status.`;
          $("result-body").appendChild(note);
          refreshWakes();
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
  } else if (res.kind === "sections") {
    for (const s of res.sections ?? []) {
      if (s.label) {
        const h = document.createElement("p");
        h.className = "muted section-label";
        h.textContent = s.label;
        body.appendChild(h);
      }
      if (s.rows) body.appendChild(rowsTable(s.rows));
      if (s.okText) body.appendChild(okBox(s.okText));
      if (s.error) body.appendChild(errBox(s.error));
      if (s.plan) {
        const pre = document.createElement("pre");
        pre.className = "plan";
        pre.textContent = s.plan;
        body.appendChild(pre);
      }
    }
  }
}

// ---- title search ----------------------------------------------------------

const SEARCH_SQL_SHOWN = `SELECT parcel_number, owner_name, address, zoning, acreage
  FROM registry.parcels
 WHERE owner_name ILIKE '%' || :q || '%'
 ORDER BY owner_name, parcel_number
 LIMIT 12;`;

async function runSearch(q) {
  if (running) return;
  running = true;
  document.querySelectorAll(".ex-btn, #search-panel .chip").forEach((b) => (b.disabled = true));

  $("search-result").hidden = false;
  $("search-sql").textContent = SEARCH_SQL_SHOWN;
  $("search-bound").textContent = "running…";
  $("search-body").replaceChildren();
  $("search-plan-wrap").hidden = true;

  const startedAt = Date.now();
  let woke = false;
  try {
    for (;;) {
      const { status, body } = await fetchJson("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q }),
      });
      if (status === 202) {
        woke = true;
        $("search-wake").hidden = false;
        $("search-wake-text").textContent = `Unsealing the vault: Aurora is resuming from 0 ACU… ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
        await new Promise((r) => setTimeout(r, 2500));
        continue;
      }
      $("search-wake").hidden = true;
      if (status === 200) {
        const b = body.bound ?? { name: "q", value: q };
        $("search-bound").textContent =
          `bound parameter  :${b.name} = ${JSON.stringify(b.value)}  (type ${b.type ?? "text"}, sent alongside the SQL, ` +
          `never concatenated into it)`;
        if (woke) $("search-body").appendChild(okBox(`Unsealed from 0 ACU in ${((Date.now() - startedAt) / 1000).toFixed(1)}s on the way to this answer.`));
        if (body.rows?.length) {
          $("search-body").appendChild(rowsTable(body.rows));
          $("search-body").appendChild(okBox(`${body.rows.length} matching entries in ${body.ms} ms. ILIKE plus the trigram index means any-case fragments work.`));
        } else {
          $("search-body").appendChild(
            okBox(
              "0 rows. No owner in the book matches that text. If that was an injection payload: it was bound as one literal, compared as data, and matched nothing. The registry never saw it as SQL."
            )
          );
        }
        if (body.plan) {
          $("search-plan").textContent = body.plan;
          $("search-plan-wrap").hidden = false;
        }
        usage = body.usage ?? usage;
        renderUsage();
        if (body.searchUsage) {
          $("search-usage").textContent =
            `This address: ${body.searchUsage.used}/${body.searchUsage.limit} searches today. The canned exhibits are not metered per address.`;
        }
      } else {
        $("search-bound").textContent = `request refused (${status})`;
        $("search-body").appendChild(errBox(body?.message ?? `Request failed (${status})`));
      }
      break;
    }
  } finally {
    running = false;
    document.querySelectorAll(".ex-btn, #search-panel .chip").forEach((b) => (b.disabled = false));
    refreshStatus();
  }
}

$("search-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("search-q").value.trim();
  if (q) runSearch(q);
});
document.querySelectorAll("#search-panel .chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    $("search-q").value = chip.dataset.q;
    runSearch(chip.dataset.q);
  })
);

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
    fact(p.seqScan?.usesSeqScan, `address lookup → Seq Scan (${p.seqScan?.executionMs} ms)`),
  );

  // Season additions: present only in evidence filed after the chain-of-title
  // release, so an older certified copy renders without empty claims.
  if (ev.history || ev.concurrency || ev.rls || ev.search) {
    $("ev-additions-card").hidden = false;
    const h = ev.history ?? {};
    const cc = ev.concurrency ?? {};
    const r = ev.rls ?? {};
    const s = ev.search ?? {};
    $("ev-additions").replaceChildren(
      fact(h.ok, `Chain of title: ${Number(h.totalEntries ?? 0).toLocaleString()} amendments on file; as-of reads '${h.asOf?.thenStatus}' then vs '${h.asOf?.nowStatus}' today; live trigger voided by rollback`),
      fact(cc.lockTimeout?.ok, "Lock timeout: second writer refused after its 2s allowance"),
      fact(cc.deadlock?.ok, "Deadlock detected; exactly one transaction cancelled"),
      fact(r.ok, `Row-level security: north desk ${r.north}, south desk ${r.south}, unassigned ${r.unassigned}; cross-district write died on the policy`),
      fact(s.ok, `Search binding: '${s.injectionPayload}' matched ${s.injectionMatches} rows, a real name matched ${s.nameMatches}${s.trgmIndexUsed ? ", via the trigram index" : ""}`),
    );
  }

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
refreshWakes();

// Keep the seal watch honest while the tab is open: status reads are control
// plane + CloudWatch only, so they never touch the database or wind its clock.
setInterval(() => {
  if (document.visibilityState === "visible" && !running) refreshStatus();
}, 60_000);
