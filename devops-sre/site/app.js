// Boardwalk Ops page script. Everything here degrades quietly: if any
// exhibit endpoint is unreachable the page still reads as the narrative.
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const fetchJSON = async (url, opts) => {
    const r = await fetch(url, { cache: "no-store", ...opts });
    let body = null;
    try { body = await r.json(); } catch { /* non-JSON error page */ }
    return { status: r.status, ok: r.ok, body };
  };
  const fmtS = (s) => (s == null ? "—" : (s < 90 ? s + "s" : Math.round(s / 6) / 10 + " min"));
  const fmtMs = (ms) => (ms == null ? "" : (ms < 1000 ? ms + " ms" : (ms / 1000).toFixed(1) + " s"));
  const fmtBytes = (b) => (b == null ? "" : (b < 1024 ? b + " B" : Math.round(b / 1024) + " KB"));
  const fmtUsd = (n) => "$" + n.toFixed(2);
  const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---- drill record card (runbook/latest.json or a live drill's report) -----

  function renderReport(rep) {
    const chip = $("report-chip");
    const pass = rep.result === "PASS";
    chip.textContent = pass ? "pass" : "fail";
    chip.className = "chip " + (pass ? "pass" : "fail");
    $("report-when").textContent =
      "Last drill: " + new Date(rep.completedAt).toLocaleString() + " · execution " + rep.execution;
    $("rto").textContent = fmtS(rep.rtoSeconds);
    $("rpo").textContent = rep.pointInTimeRecovery?.enabled
      ? fmtS(rep.pointInTimeRecovery.rpoSeconds) : "PITR off";
    $("items").textContent = rep.itemCounts.restored + " / " + rep.itemCounts.source;
    $("report-stats").hidden = false;
  }

  (async () => {
    try {
      const { ok, body } = await fetchJSON("/runbook/latest.json");
      if (ok && body) renderReport(body);
    } catch { /* page still works without a report */ }
  })();

  // ---- day book (usage counters + attach to anything under way) -------------

  async function refreshStatus() {
    try {
      const { ok, body } = await fetchJSON("/api/status");
      if (!ok || !body) return null;
      $("drill-usage").textContent = `day book: ${body.drill.used} of ${body.drill.limit} drills today`;
      $("sweep-usage").textContent = `day book: ${body.sweep.used} of ${body.sweep.limit} sweeps today`;
      return body;
    } catch { return null; }
  }

  // ---- the beacon drill -----------------------------------------------------

  const drill = { timer: null, clock: null, runId: null };

  function setDrillNote(text) { $("drill-note").textContent = text; }

  function stopDrillClock() {
    if (drill.clock) { clearInterval(drill.clock); drill.clock = null; }
  }

  function startDrillClock(startedAt) {
    stopDrillClock();
    const c = $("drill-clock");
    c.hidden = false;
    drill.clock = setInterval(() => {
      const s = Math.max(0, Math.round((Date.now() - new Date(startedAt)) / 1000));
      c.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }, 250);
  }

  function renderStages(stages, running) {
    $("drill-timeline").hidden = false;
    for (const st of stages) {
      const stop = document.querySelector(`.stop[data-stage="${st.key}"]`);
      if (!stop) continue;
      stop.className = "stop " + (st.status === "pending" ? "" : st.status);
      const t = stop.querySelector(".s-time");
      if (st.startedAt) {
        const end = st.endedAt ? new Date(st.endedAt) : new Date();
        const secs = Math.max(0, Math.round((end - new Date(st.startedAt)) / 1000));
        t.textContent = st.endedAt ? fmtS(secs) : (running ? secs + "s…" : "");
      } else {
        t.textContent = "";
      }
    }
  }

  async function pollDrill() {
    const { ok, status, body } = await fetchJSON(`/api/drill/${drill.runId}`);
    if (!ok) {
      if (status === 404) stopDrill("That drill's record has expired.");
      return; // transient; next tick retries
    }
    if (body.startedAt && !drill.clock) startDrillClock(body.startedAt);
    renderStages(body.stages, body.status === "RUNNING");
    if (body.status === "RUNNING") return;

    stopDrill();
    stopDrillClock();
    const took = body.report ? fmtS(body.report.rtoSeconds) : null;
    if (body.status === "SUCCEEDED" && body.report) {
      setDrillNote(`Drill complete: beacon found and verified in ${took}. The record card below is the timed evidence, item for item.`);
      renderReport(body.report);
    } else if (body.status === "SUCCEEDED") {
      setDrillNote("Drill complete. Reloading the record…");
      fetchJSON("/runbook/latest.json").then(({ ok: o, body: b }) => { if (o && b) renderReport(b); });
    } else {
      setDrillNote("The drill did not complete cleanly. That result is published too: the record card shows whatever the last verified drill measured, and the state machine cleaned up after itself.");
    }
    refreshStatus();
    $("drill-btn").disabled = false;
    $("drill-btn").textContent = "Run the beacon drill";
  }

  function stopDrill(note) {
    if (drill.timer) { clearInterval(drill.timer); drill.timer = null; }
    if (note) { setDrillNote(note); $("drill-btn").disabled = false; }
  }

  function watchDrill(runId, note) {
    drill.runId = runId;
    $("drill-btn").disabled = true;
    $("drill-btn").textContent = "Drill under way…";
    if (note) setDrillNote(note);
    pollDrill();
    drill.timer = setInterval(pollDrill, 3000);
  }

  $("drill-btn")?.addEventListener("click", async () => {
    $("drill-btn").disabled = true;
    setDrillNote("Radioing the hut…");
    try {
      const { status, body } = await fetchJSON("/api/drill", { method: "POST" });
      if (status === 202) {
        watchDrill(body.runId, `Drill ${body.slot} of ${body.limit} today is under way. Watching the state machine live; a full drill runs about five minutes.`);
      } else if (status === 409 && body?.runId) {
        watchDrill(body.runId, body.message);
      } else {
        setDrillNote(body?.message ?? "The hut did not answer; try again in a minute.");
        $("drill-btn").disabled = false;
      }
    } catch {
      setDrillNote("The hut did not answer; try again in a minute.");
      $("drill-btn").disabled = false;
    }
  });

  // ---- the closing sweep ----------------------------------------------------

  const sweep = { timer: null, runId: null };

  function setSweepNote(text) { $("sweep-note").textContent = text; }

  function renderChecks(checks) {
    const tbody = $("sweep-rows");
    tbody.replaceChildren();
    for (const c of checks) {
      const tr = document.createElement("tr");
      const site = el("td", "msg");
      site.append(el("strong", null, c.name), " ", el("code", null, c.host));
      tr.append(site);

      const chip = el("span", "chip idle", "waiting");
      if (c.status === "checking") { chip.className = "chip idle"; chip.textContent = "on site…"; }
      if (c.status === "ok") { chip.className = "chip pass"; chip.textContent = "clear"; }
      if (c.status === "fail") { chip.className = "chip fail"; chip.textContent = c.error ?? ("HTTP " + c.httpStatus); }
      const st = el("td");
      st.append(chip);
      tr.append(st);

      tr.append(el("td", "mono", c.status === "ok" || c.status === "fail" ? fmtMs(c.ms) : ""));
      tr.append(el("td", "mono", c.status === "ok" ? fmtBytes(c.bytes) : ""));
      const mark = (v) => (c.status === "ok" || c.status === "fail")
        ? el("span", v ? "okx" : "badx", v ? "✓" : "✗") : el("span", null, "");
      const h = el("td"); h.append(mark(c.hsts)); tr.append(h);
      const p = el("td"); p.append(mark(c.csp)); tr.append(p);
      tr.append(el("td", "mono", c.xcache ?? ""));
      tbody.append(tr);
    }
    $("sweep-table").hidden = false;
  }

  async function pollSweep() {
    const { ok, status, body } = await fetchJSON(`/api/sweep/${sweep.runId}`);
    if (!ok) {
      if (status === 404) stopSweep("That sweep's record has expired.");
      return;
    }
    renderChecks(body.checks ?? []);
    if (body.status === "running") return;

    stopSweep();
    if (body.status === "done" && body.summary) {
      const s = body.summary;
      setSweepNote(s.ok === s.total
        ? `Sweep clear: all ${s.total} sites answered, checked in ${s.sweptInS}s. The mountain is closed for the night.`
        : `Sweep complete in ${s.sweptInS}s: ${s.ok} of ${s.total} sites clear. A closed run is exactly what this board is for.`);
    } else {
      setSweepNote("The sweep did not finish; patrol radios that in rather than guessing.");
    }
    refreshStatus();
    $("sweep-btn").disabled = false;
    $("sweep-btn").textContent = "Send patrol on the closing sweep";
  }

  function stopSweep(note) {
    if (sweep.timer) { clearInterval(sweep.timer); sweep.timer = null; }
    if (note) { setSweepNote(note); $("sweep-btn").disabled = false; }
  }

  function watchSweep(runId, note) {
    sweep.runId = runId;
    $("sweep-btn").disabled = true;
    $("sweep-btn").textContent = "Sweep under way…";
    if (note) setSweepNote(note);
    pollSweep();
    sweep.timer = setInterval(pollSweep, 1500);
  }

  $("sweep-btn")?.addEventListener("click", async () => {
    $("sweep-btn").disabled = true;
    setSweepNote("Radioing the hut…");
    try {
      const { status, body } = await fetchJSON("/api/sweep", { method: "POST" });
      if (status === 202) {
        watchSweep(body.runId, `Sweep ${body.slot} of ${body.limit} today. Patrol is skiing every live site, top of the mountain first.`);
      } else if (status === 409 && body?.runId) {
        watchSweep(body.runId, body.message);
      } else {
        setSweepNote(body?.message ?? "The hut did not answer; try again in a minute.");
        $("sweep-btn").disabled = false;
      }
    } catch {
      setSweepNote("The hut did not answer; try again in a minute.");
      $("sweep-btn").disabled = false;
    }
  });

  // ---- the sweep log (recent pipeline runs) ---------------------------------

  (async () => {
    try {
      const { ok, body } = await fetchJSON("/api/ci");
      if (!ok || !body?.runs) {
        $("ci-note").textContent = body?.message ?? "The sweep log is briefly unavailable.";
        return;
      }
      $("ci-note").hidden = true;
      $("ci-stale").hidden = !body.stale;

      if (body.legs) {
        const legs = $("ci-legs");
        legs.replaceChildren();
        const legChip = (label, l) => {
          if (!l.total) return null;
          const good = l.ok === l.total;
          return el("span", "chip " + (good ? "pass" : "fail"), `${label} ${l.ok}/${l.total}`);
        };
        legs.append(el("span", "legs-label", "latest run:"));
        for (const c of [legChip("scan", body.legs.scan), legChip("plan", body.legs.plan), legChip("apply", body.legs.apply)]) {
          if (c) legs.append(c);
        }
        legs.hidden = false;
      }

      const tbody = $("ci-rows");
      tbody.replaceChildren();
      for (const r of body.runs) {
        const tr = document.createElement("tr");
        tr.append(el("td", "mono", fmtWhen(r.startedAt)));
        const msg = el("td", "msg");
        const link = el("a", null, r.message || r.sha);
        link.href = r.url;
        msg.append(link, " ", el("code", null, r.sha));
        tr.append(msg);
        tr.append(el("td", "mono", r.durationS != null ? fmtS(r.durationS) : "…"));
        const chip = r.status !== "completed"
          ? el("span", "chip idle", "running")
          : el("span", "chip " + (r.conclusion === "success" ? "pass" : "fail"),
              r.conclusion === "success" ? "applied" : (r.conclusion ?? "failed"));
        const st = el("td"); st.append(chip); tr.append(st);
        tbody.append(tr);
      }
      $("ci-table").hidden = false;

      if (body.overnight) {
        const o = body.overnight;
        const good = o.conclusion === "success";
        $("ci-overnight").textContent =
          `Overnight patrol (demo-window sweep): last run ${fmtWhen(o.startedAt)}, ` +
          (good ? "all clear." : (o.conclusion ?? "in progress") + ".");
        $("ci-overnight").hidden = false;
      }
    } catch {
      $("ci-note").textContent = "The sweep log is briefly unavailable.";
    }
  })();

  // ---- the season ledger ----------------------------------------------------

  const ENV_NAMES = {
    "modern-web-app": "Permits",
    "genai-assistant": "Assistant",
    "doc-processing": "Documents",
    "model-workbench": "Models",
    "api-platform": "API",
    "event-mesh": "Events",
    "container-works": "Containers",
    "data-lake": "Data lake",
    "relational-registry": "Registry",
    "security-posture": "Security",
    "network-blueprint": "Network",
    "devops-sre": "Ops (this plank)",
    "demo-hub": "Demo Hub",
    "platform": "Shared edge (WAF + DNS)",
    "company-site": "planetek.org",
    "": "Untagged / shared",
  };

  async function loadCost(attempt = 0) {
    try {
      const { status, body } = await fetchJSON("/api/cost");
      if (status === 202 && attempt < 6) { setTimeout(() => loadCost(attempt + 1), 4000); return; }
      if (!body?.byService) {
        $("cost-note").textContent = "The ledger is briefly unavailable.";
        return;
      }

      $("cost-total").textContent = fmtUsd(body.total);
      $("cost-asof").textContent =
        `month to date since ${body.monthStart} · tallied ${fmtWhen(body.asOf)} · Cost Explorer lags about a day`;

      const bars = $("cost-env-bars");
      bars.replaceChildren();
      if (body.envReady) {
        const rows = body.byEnv.filter((e) => e.usd >= 0.005);
        const max = Math.max(...rows.map((e) => e.usd), 0.01);
        for (const e of rows) {
          const row = el("div", "bar-row");
          row.append(el("span", "k", ENV_NAMES[e.env] ?? e.env));
          const track = el("div", "bar-track");
          const fill = el("div", "bar-fill");
          fill.style.width = Math.max(2, Math.round((e.usd / max) * 100)) + "%";
          track.append(fill);
          row.append(track);
          row.append(el("span", "v", fmtUsd(e.usd)));
          bars.append(row);
        }
        $("cost-env-wrap").hidden = false;
      } else {
        $("cost-env-note").hidden = false;
      }

      const tbody = $("cost-svc-rows");
      tbody.replaceChildren();
      for (const s of body.byService) {
        const tr = document.createElement("tr");
        tr.append(el("td", "msg", s.service));
        tr.append(el("td", "mono", fmtUsd(s.usd)));
        tbody.append(tr);
      }
      $("cost-svc-table").hidden = false;
      $("cost-note").textContent =
        `Figures exclude credits, refunds, ${body.excluded.join(" and ")}. ` +
        `Refreshed at most once a day, when someone visits; each refresh is two Cost Explorer calls at $0.01 each, and that spend lands on this ledger too.`;
      $("cost-board").hidden = false;
    } catch {
      $("cost-note").textContent = "The ledger is briefly unavailable.";
    }
  }
  loadCost();

  // ---- attach to anything already under way on load -------------------------

  (async () => {
    const st = await refreshStatus();
    if (st?.drill?.running?.runId) {
      watchDrill(st.drill.running.runId, "A beacon drill is already under way; you are watching it live.");
    }
    if (st?.sweep?.running?.runId) {
      watchSweep(st.sweep.running.runId, "Patrol is already out on the closing sweep; you are watching it live.");
    }
  })();
})();
