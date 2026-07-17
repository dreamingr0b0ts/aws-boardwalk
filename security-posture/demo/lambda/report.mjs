// Findings-to-evidence report generator. Reads the live state of every
// exhibit in the demo stack and writes evidence.json + a standalone,
// printable evidence.html into the always-on site bucket. The report is
// what survives `make teardown` — the page renders it between demo windows,
// and the HTML artifact is fit to attach to a proposal.
import { CloudTrailClient, DescribeTrailsCommand, GetTrailStatusCommand } from "@aws-sdk/client-cloudtrail";
import { KMSClient, DescribeKeyCommand, GetKeyRotationStatusCommand } from "@aws-sdk/client-kms";
import { GuardDutyClient, GetFindingsStatisticsCommand } from "@aws-sdk/client-guardduty";
import { SecurityHubClient, GetEnabledStandardsCommand, GetFindingsCommand } from "@aws-sdk/client-securityhub";
import {
  ConfigServiceClient,
  DescribeConfigurationRecorderStatusCommand,
  DescribeConformancePackComplianceCommand,
} from "@aws-sdk/client-config-service";
import { IAMClient, GetRoleCommand, SimulatePrincipalPolicyCommand } from "@aws-sdk/client-iam";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const {
  SITE_BUCKET, DETECTOR_ID, TRAIL_NAME, KMS_KEY_ID,
  CONFORMANCE_PACK, BOUNDARY_ROLE_ARN, SITE_BUCKET_ARN,
} = process.env;

const cloudtrail = new CloudTrailClient({});
const kms = new KMSClient({});
const guardduty = new GuardDutyClient({});
const securityhub = new SecurityHubClient({});
const config = new ConfigServiceClient({});
const iam = new IAMClient({});
const s3 = new S3Client({});

// ---- collectors (each returns its evidence section) ------------------------

async function collectCloudTrail() {
  const { trailList } = await cloudtrail.send(new DescribeTrailsCommand({ trailNameList: [TRAIL_NAME] }));
  const trail = trailList?.[0] ?? {};
  const status = await cloudtrail.send(new GetTrailStatusCommand({ Name: TRAIL_NAME }));
  return {
    name: TRAIL_NAME,
    logging: status.IsLogging === true,
    multiRegion: trail.IsMultiRegionTrail === true,
    logFileValidation: trail.LogFileValidationEnabled === true,
    kmsEncrypted: Boolean(trail.KmsKeyId),
    latestDeliveryAt: status.LatestDeliveryTime?.toISOString() ?? null,
  };
}

async function collectKms() {
  const [key, rotation] = await Promise.all([
    kms.send(new DescribeKeyCommand({ KeyId: KMS_KEY_ID })),
    kms.send(new GetKeyRotationStatusCommand({ KeyId: KMS_KEY_ID })),
  ]);
  return {
    alias: "alias/sec-trail",
    keyState: key.KeyMetadata?.KeyState ?? "UNKNOWN",
    customerManaged: key.KeyMetadata?.KeyManager === "CUSTOMER",
    rotationEnabled: rotation.KeyRotationEnabled === true,
  };
}

// GuardDuty reports severity as numbers: 7.0–8.9 high, 4.0–6.9 medium, else low.
async function collectGuardDuty() {
  const { FindingStatistics } = await guardduty.send(new GetFindingsStatisticsCommand({
    DetectorId: DETECTOR_ID,
    FindingStatisticTypes: ["COUNT_BY_SEVERITY"],
    FindingCriteria: { Criterion: { "service.archived": { Eq: ["false"] } } },
  }));
  const bySeverity = { HIGH: 0, MEDIUM: 0, LOW: 0 };
  let total = 0;
  for (const [sev, count] of Object.entries(FindingStatistics?.CountBySeverity ?? {})) {
    const n = Number(sev);
    const bucket = n >= 7 ? "HIGH" : n >= 4 ? "MEDIUM" : "LOW";
    bySeverity[bucket] += count;
    total += count;
  }
  return { detectorId: DETECTOR_ID, total, bySeverity, sampleFindings: true };
}

async function collectSecurityHub() {
  const { StandardsSubscriptions } = await securityhub.send(new GetEnabledStandardsCommand({}));
  const standards = (StandardsSubscriptions ?? []).map((s) => ({
    arn: s.StandardsArn,
    status: s.StandardsStatus,
  }));

  const compliance = { PASSED: 0, FAILED: 0, WARNING: 0, NOT_AVAILABLE: 0 };
  const failedSeverity = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFORMATIONAL: 0 };
  const failedControls = new Map();
  let nextToken;
  let pages = 0;
  let truncated = false;

  do {
    const res = await securityhub.send(new GetFindingsCommand({
      Filters: {
        ProductName: [{ Value: "Security Hub", Comparison: "EQUALS" }],
        RecordState: [{ Value: "ACTIVE", Comparison: "EQUALS" }],
      },
      MaxResults: 100,
      NextToken: nextToken,
    }));
    for (const f of res.Findings ?? []) {
      const status = f.Compliance?.Status ?? "NOT_AVAILABLE";
      compliance[status] = (compliance[status] ?? 0) + 1;
      if (status === "FAILED") {
        const sev = f.Severity?.Label ?? "INFORMATIONAL";
        failedSeverity[sev] = (failedSeverity[sev] ?? 0) + 1;
        const id = f.Compliance?.SecurityControlId ?? f.ProductFields?.ControlId ?? "unknown";
        const entry = failedControls.get(id) ?? { id, title: f.Title ?? id, count: 0 };
        entry.count += 1;
        failedControls.set(id, entry);
      }
    }
    nextToken = res.NextToken;
    pages += 1;
    if (pages >= 30 && nextToken) { truncated = true; break; }
  } while (nextToken);

  const topFailedControls = [...failedControls.values()].sort((a, b) => b.count - a.count).slice(0, 8);
  return { standards, compliance, failedSeverity, topFailedControls, truncated };
}

async function collectConfig() {
  const { ConfigurationRecordersStatus } = await config.send(new DescribeConfigurationRecorderStatusCommand({}));
  const recording = ConfigurationRecordersStatus?.some((r) => r.recording) ?? false;

  const rules = { COMPLIANT: 0, NON_COMPLIANT: 0, INSUFFICIENT_DATA: 0 };
  const noncompliantRules = [];
  let nextToken;
  do {
    const res = await config.send(new DescribeConformancePackComplianceCommand({
      ConformancePackName: CONFORMANCE_PACK,
      Limit: 100,
      NextToken: nextToken,
    }));
    for (const r of res.ConformancePackRuleComplianceList ?? []) {
      rules[r.ComplianceType] = (rules[r.ComplianceType] ?? 0) + 1;
      if (r.ComplianceType === "NON_COMPLIANT") {
        // strip the conformance-pack suffix Config appends to rule names
        noncompliantRules.push(r.ConfigRuleName.replace(/-conformance-pack-\w+$/, ""));
      }
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return {
    recorderOn: recording,
    conformancePack: CONFORMANCE_PACK,
    framework: "NIST 800-53 rev 5 (AWS operational best practices pack)",
    rules,
    totalRules: rules.COMPLIANT + rules.NON_COMPLIANT + rules.INSUFFICIENT_DATA,
    noncompliantRules: noncompliantRules.sort(),
  };
}

async function collectBoundary() {
  const roleName = BOUNDARY_ROLE_ARN.split("/").pop();
  const { Role } = await iam.send(new GetRoleCommand({ RoleName: roleName }));

  const simulate = async (action, resource) => {
    const { EvaluationResults } = await iam.send(new SimulatePrincipalPolicyCommand({
      PolicySourceArn: BOUNDARY_ROLE_ARN,
      ActionNames: [action],
      ResourceArns: [resource],
    }));
    const r = EvaluationResults?.[0] ?? {};
    return {
      action,
      decision: r.EvalDecision ?? "unknown",
      allowedByBoundary: r.PermissionsBoundaryDecisionDetail?.AllowedByPermissionsBoundary ?? null,
    };
  };

  return {
    role: roleName,
    boundaryPolicy: Role?.PermissionsBoundary?.PermissionsBoundaryArn ?? null,
    simulations: [
      // granted by policy AND inside the boundary → allowed
      await simulate("s3:GetObject", `${SITE_BUCKET_ARN}/evidence/status.json`),
      // granted by the role's own policy but OUTSIDE the boundary → implicitDeny
      await simulate("s3:PutObject", `${SITE_BUCKET_ARN}/evidence/status.json`),
      // granted by nothing → implicitDeny
      await simulate("iam:CreateUser", "*"),
    ],
  };
}

// ---- the standalone HTML artifact ------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const yn = (b) => (b ? "✓ yes" : "✗ no");

function renderHtml(ev) {
  const gd = ev.guardduty, sh = ev.securityHub, cf = ev.config, bd = ev.boundary;
  const shTotal = Object.values(sh.compliance).reduce((a, b) => a + b, 0);
  const rows = (pairs) => pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Security Posture Evidence Report · ${esc(ev.generatedAt)}</title>
<style>
  body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;color:#1c1917;max-width:860px;margin:0 auto;padding:32px 24px}
  h1{font-size:26px;margin:0}h2{font-size:18px;margin:32px 0 6px;border-bottom:2px solid #16302e;padding-bottom:4px}
  .meta{color:#57534e;font-size:13px;margin-top:6px}
  .note{background:#fef4f0;border:1px solid #fac5b4;border-radius:8px;padding:10px 14px;font-size:13px;margin:18px 0}
  table{border-collapse:collapse;width:100%;margin-top:10px;font-size:14px}
  th,td{text-align:left;padding:6px 10px;border:1px solid #e7e5e4;vertical-align:top}
  th{background:#f5f5f4;font-weight:600;width:40%}
  .pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700}
  .ok{background:#ecfdf5;color:#047857}.bad{background:#fef2f2;color:#b91c1c}.warn{background:#fffbeb;color:#b45309}
  ul{margin:8px 0;padding-left:22px;font-size:13px;column-count:2;column-gap:28px}
  footer{margin-top:36px;color:#78716c;font-size:12px;border-top:1px solid #e7e5e4;padding-top:12px}
  @media print{body{padding:0}}
</style></head><body>
<h1>Security Posture Evidence Report</h1>
<p class="meta">City of Alpenglow demo account · region us-east-1 · generated ${esc(ev.generatedAt)} by the <code>sec-evidence-report</code> Lambda (plank 8, Planetek AWS Boardwalk)</p>
<div class="note"><strong>Demo scope:</strong> the GuardDuty findings below are AWS-generated <em>sample</em> findings
(titles prefixed “[SAMPLE]”) created to exercise the detection→aggregation→evidence pipeline. Security Hub and
Config results are real evaluations of this live AWS account, including its nine always-on demo environments.</div>

<h2>1 · Audit trail — CloudTrail</h2>
<table>${rows([
    ["Trail", `<code>${esc(ev.cloudtrail.name)}</code>`],
    ["Logging now", yn(ev.cloudtrail.logging)],
    ["Multi-region", yn(ev.cloudtrail.multiRegion)],
    ["Log-file integrity validation", yn(ev.cloudtrail.logFileValidation)],
    ["Logs encrypted with customer-managed KMS key", yn(ev.cloudtrail.kmsEncrypted)],
    ["Latest log delivery", esc(ev.cloudtrail.latestDeliveryAt ?? "pending first delivery")],
  ])}</table>

<h2>2 · Encryption — KMS</h2>
<table>${rows([
    ["Key", `<code>${esc(ev.kms.alias)}</code>`],
    ["Customer-managed", yn(ev.kms.customerManaged)],
    ["Automatic annual rotation", yn(ev.kms.rotationEnabled)],
    ["Key state", esc(ev.kms.keyState)],
  ])}</table>

<h2>3 · Threat detection — GuardDuty</h2>
<table>${rows([
    ["Active findings (sample)", String(gd.total)],
    ["High severity", `<span class="pill bad">${gd.bySeverity.HIGH}</span>`],
    ["Medium severity", `<span class="pill warn">${gd.bySeverity.MEDIUM}</span>`],
    ["Low severity", `<span class="pill ok">${gd.bySeverity.LOW}</span>`],
  ])}</table>

<h2>4 · Posture management — Security Hub (AWS Foundational Security Best Practices)</h2>
<table>${rows([
    ["Standard status", esc(sh.standards.map((s) => s.status).join(", ") || "n/a")],
    ["Control findings evaluated", String(shTotal) + (sh.truncated ? " (truncated at 3,000)" : "")],
    ["Passed", `<span class="pill ok">${sh.compliance.PASSED}</span>`],
    ["Failed", `<span class="pill bad">${sh.compliance.FAILED}</span>`],
    ["Warning / not available", `${sh.compliance.WARNING} / ${sh.compliance.NOT_AVAILABLE}`],
    ["Failed by severity", `crit ${sh.failedSeverity.CRITICAL} · high ${sh.failedSeverity.HIGH} · med ${sh.failedSeverity.MEDIUM} · low ${sh.failedSeverity.LOW}`],
  ])}</table>
${sh.topFailedControls.length ? `<p class="meta">Top failed controls:</p><ul>${sh.topFailedControls.map((c) => `<li><code>${esc(c.id)}</code> — ${esc(c.title)} (${c.count})</li>`).join("")}</ul>` : ""}

<h2>5 · Compliance automation — AWS Config, NIST 800-53 rev 5</h2>
<table>${rows([
    ["Configuration recorder", ev.config.recorderOn ? "recording" : "stopped"],
    ["Conformance pack", `<code>${esc(cf.conformancePack)}</code> — ${esc(cf.framework)}`],
    ["Rules evaluated", String(cf.totalRules)],
    ["Compliant", `<span class="pill ok">${cf.rules.COMPLIANT}</span>`],
    ["Non-compliant", `<span class="pill bad">${cf.rules.NON_COMPLIANT}</span>`],
    ["Insufficient data (no applicable resources yet)", String(cf.rules.INSUFFICIENT_DATA)],
  ])}</table>
${cf.noncompliantRules.length ? `<p class="meta">Non-compliant rules:</p><ul>${cf.noncompliantRules.map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul>` : ""}

<h2>6 · Least privilege — IAM permissions boundary (simulated proof)</h2>
<p class="meta">Role <code>${esc(bd.role)}</code> carries boundary <code>${esc(bd.boundaryPolicy ?? "none")}</code>.
Effective permissions are the intersection of its policy and the boundary — proven below with
<code>iam:SimulatePrincipalPolicy</code>, not assertion.</p>
<table><tr><th style="width:40%">Action simulated</th><td><strong>Decision</strong></td></tr>${bd.simulations.map((s) =>
    `<tr><th><code>${esc(s.action)}</code></th><td><span class="pill ${s.decision === "allowed" ? "ok" : "bad"}">${esc(s.decision)}</span>${s.allowedByBoundary === false ? " — blocked by the boundary despite being granted by the role's policy" : ""}</td></tr>`).join("")}
</table>

<footer>Generated automatically from live AWS APIs. Planetek AWS Boardwalk plank 8 — Security &amp; Governance
(deploy-demo-teardown). Fictional demo; not affiliated with any real government agency.
<a href="https://security.demos.planetek.org">security.demos.planetek.org</a></footer>
</body></html>`;
}

// ---- handler ----------------------------------------------------------------

export const handler = async () => {
  const [ct, kmsEv, gd, sh, cf, bd] = await Promise.all([
    collectCloudTrail(), collectKms(), collectGuardDuty(),
    collectSecurityHub(), collectConfig(), collectBoundary(),
  ]);

  const evidence = {
    generatedAt: new Date().toISOString(),
    region: "us-east-1",
    cloudtrail: ct,
    kms: kmsEv,
    guardduty: gd,
    securityHub: sh,
    config: cf,
    boundary: bd,
  };

  const put = (key, body, type) => s3.send(new PutObjectCommand({
    Bucket: SITE_BUCKET,
    Key: key,
    Body: body,
    ContentType: type,
    CacheControl: "no-cache",
  }));

  await Promise.all([
    put("evidence/evidence.json", JSON.stringify(evidence, null, 2), "application/json"),
    put("evidence/evidence.html", renderHtml(evidence), "text/html; charset=utf-8"),
  ]);

  return {
    generatedAt: evidence.generatedAt,
    guarddutyFindings: gd.total,
    securityHub: sh.compliance,
    nistRules: cf.rules,
    boundary: bd.simulations.map((s) => `${s.action}=${s.decision}`),
  };
};
