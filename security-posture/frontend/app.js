// Renders /evidence/status.json (written by make demo / make teardown) and
// /evidence/evidence.json (written by the sec-evidence-report Lambda).
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
    ? "The full security stack is deployed and billing — GuardDuty, Security Hub, and the Config " +
      "conformance pack are evaluating this account right now. The evidence below is refreshable live."
    : status
      ? `The daily-billing stack was destroyed ${fmtWhen(status.updatedAt)} after its last demo window. ` +
        "The evidence report below is the persisted output of that cycle — redeployable in ~15 minutes."
      : "No demo cycle has run yet. The first <code>make demo</code> will deploy the stack and generate evidence.";
  if (live) $("node-report").classList.add("live");
}

const pill = (label, value, cls = "") => {
  const s = document.createElement("span");
  s.className = `sev ${cls}`;
  s.textContent = `${label} ${value}`;
  return s;
};

const fact = (ok, text) => {
  const li = document.createElement("li");
  li.className = ok ? "ok" : "no";
  li.textContent = text;
  return li;
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

  // audit trail + encryption facts
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

  // guardduty
  const gd = ev.guardduty ?? { total: 0, bySeverity: {} };
  $("stat-gd").textContent = String(gd.total);
  $("ev-gd").replaceChildren(
    pill("total", gd.total),
    pill("high", gd.bySeverity.HIGH ?? 0, "bad"),
    pill("medium", gd.bySeverity.MEDIUM ?? 0, "warn"),
    pill("low", gd.bySeverity.LOW ?? 0, "ok"),
  );

  // security hub
  const sh = ev.securityHub ?? { compliance: {} };
  const c = sh.compliance;
  $("ev-sh").replaceChildren(
    pill("passed", c.PASSED ?? 0, "ok"),
    pill("failed", c.FAILED ?? 0, "bad"),
    pill("warning", c.WARNING ?? 0, "warn"),
  );
  $("ev-sh-note").textContent =
    "AWS Foundational Security Best Practices control findings across the whole demo account. " +
    "Checks keep landing for a couple of hours after each deploy, so early reports run lighter.";

  // nist conformance pack
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

  // permissions boundary simulations
  const tbody = $("ev-boundary").querySelector("tbody");
  tbody.replaceChildren();
  for (const sim of ev.boundary?.simulations ?? []) {
    const tr = document.createElement("tr");
    const action = document.createElement("td");
    const code = document.createElement("code");
    code.textContent = sim.action;
    action.appendChild(code);
    const decision = document.createElement("td");
    decision.appendChild(pill(sim.decision, "", sim.decision === "allowed" ? "ok" : "bad"));
    const note = document.createElement("td");
    note.className = "note";
    note.textContent =
      sim.allowedByBoundary === false
        ? "granted by the role's policy, blocked by the boundary"
        : sim.decision === "allowed"
          ? "inside both the policy and the boundary"
          : "granted by nothing";
    tr.append(action, decision, note);
    tbody.appendChild(tr);
  }
}

const [status, evidence] = await Promise.all([
  fetchJson("/evidence/status.json"),
  fetchJson("/evidence/evidence.json"),
]);
renderStatus(status);
renderEvidence(evidence);
