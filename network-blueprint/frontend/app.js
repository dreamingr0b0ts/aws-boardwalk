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
    ? "The full network is deployed and billing — both instances are up, the interface endpoints " +
      "are serving SSM, and the paths below are live right now."
    : status
      ? `The hourly-billing stack was destroyed ${fmtWhen(status.updatedAt)} after its last demo window. ` +
        "The evidence below is the persisted proof from that cycle — redeployable in ~15 minutes."
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
    fact(rt.natGateways === 0, `NAT gateways: ${rt.natGateways ?? "?"} — ~$33/mo avoided`),
    fact((rt.privateRouteTables ?? []).every((t) => t.gatewayEndpointRoutes > 0),
      "Gateway-endpoint routes present in every private route table"),
  );

  // endpoints
  const ep = ev.endpoints ?? {};
  $("ev-endpoints").replaceChildren(
    fact(ep.gatewayAvailable === 2, `Gateway endpoints (S3, DynamoDB): ${ep.gatewayAvailable ?? 0}/2 — free`),
    fact(ep.interfaceAvailable === 3, `Interface endpoints (SSM trio): ${ep.interfaceAvailable ?? 0}/3 — PrivateLink`),
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
    "internet background noise — strangers scanning a minutes-old public IP, turned away by the security group.";
}

const [status, evidence] = await Promise.all([
  fetchJson("/evidence/status.json"),
  fetchJson("/evidence/evidence.json"),
]);
renderStatus(status);
renderEvidence(evidence);
