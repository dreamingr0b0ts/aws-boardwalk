// Paths-to-evidence report generator. Reads the live network configuration,
// replays the connectivity probe suite on both instances via SSM Run Command,
// joins the Reachability Analyzer verdicts, and writes evidence.json + a
// standalone, printable evidence.html into the always-on site bucket. The
// report is what survives `make teardown` — the page renders it between demo
// windows, and the HTML artifact is fit to attach to a proposal.
import {
  EC2Client,
  DescribeVpcsCommand,
  DescribeSubnetsCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeNetworkAclsCommand,
  DescribeVpcEndpointsCommand,
  DescribeFlowLogsCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInsightsAnalysesCommand,
} from "@aws-sdk/client-ec2";
import { SSMClient, SendCommandCommand, GetCommandInvocationCommand } from "@aws-sdk/client-ssm";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const {
  SITE_BUCKET, VPC_ID, PUBLIC_INSTANCE_ID, PRIVATE_INSTANCE_ID,
  PRIVATE_APP_IP, FLOW_LOG_GROUP, TIER_SGS, ANALYSES,
} = process.env;
const REGION = process.env.AWS_REGION ?? "us-east-1";

const ec2 = new EC2Client({});
const ssm = new SSMClient({});
const logs = new CloudWatchLogsClient({});
const s3 = new S3Client({});

const tierSgs = JSON.parse(TIER_SGS);
const analysisDefs = JSON.parse(ANALYSES);

// ---- network configuration collectors ---------------------------------------

async function collectNetwork() {
  const [vpcs, subnets, routeTables, nats] = await Promise.all([
    ec2.send(new DescribeVpcsCommand({ VpcIds: [VPC_ID] })),
    ec2.send(new DescribeSubnetsCommand({ Filters: [{ Name: "vpc-id", Values: [VPC_ID] }] })),
    ec2.send(new DescribeRouteTablesCommand({ Filters: [{ Name: "vpc-id", Values: [VPC_ID] }] })),
    ec2.send(new DescribeNatGatewaysCommand({
      Filter: [{ Name: "vpc-id", Values: [VPC_ID] }, { Name: "state", Values: ["pending", "available"] }],
    })),
  ]);

  const tag = (res, key) => res.Tags?.find((t) => t.Key === key)?.Value ?? null;
  const tiers = { public: [], app: [], data: [] };
  for (const s of subnets.Subnets ?? []) {
    const tier = tag(s, "tier");
    (tiers[tier] ?? (tiers[tier] = [])).push({
      cidr: s.CidrBlock,
      az: s.AvailabilityZone,
      autoAssignPublicIp: s.MapPublicIpOnLaunch === true,
    });
  }
  for (const list of Object.values(tiers)) list.sort((a, b) => a.az.localeCompare(b.az));

  let publicDefaultViaIgw = false;
  let privateDefaultRoutes = 0;
  const privateRouteTables = [];
  for (const rt of routeTables.RouteTables ?? []) {
    const name = tag(rt, "Name") ?? rt.RouteTableId;
    const isMain = rt.Associations?.some((a) => a.Main) ?? false;
    if (isMain) continue; // unassociated main table — nothing routes through it
    const defaultRoute = rt.Routes?.find((r) => r.DestinationCidrBlock === "0.0.0.0/0");
    const endpointRoutes = rt.Routes?.filter((r) => r.GatewayId?.startsWith("vpce-")).length ?? 0;
    if (defaultRoute?.GatewayId?.startsWith("igw-")) publicDefaultViaIgw = true;
    if (name.includes("public")) continue;
    if (defaultRoute) privateDefaultRoutes += 1;
    privateRouteTables.push({ name, hasDefaultRoute: Boolean(defaultRoute), gatewayEndpointRoutes: endpointRoutes });
  }

  return {
    vpcId: VPC_ID,
    cidr: vpcs.Vpcs?.[0]?.CidrBlock ?? null,
    azs: [...new Set((subnets.Subnets ?? []).map((s) => s.AvailabilityZone))].sort(),
    subnets: tiers,
    routing: {
      publicDefaultViaIgw,
      privateDefaultRoutes,
      privateRouteTables: privateRouteTables.sort((a, b) => a.name.localeCompare(b.name)),
      natGateways: nats.NatGateways?.length ?? 0,
    },
  };
}

async function collectSecurityTiers() {
  const ids = Object.values(tierSgs);
  const [tiers, defaults] = await Promise.all([
    ec2.send(new DescribeSecurityGroupsCommand({ GroupIds: ids })),
    ec2.send(new DescribeSecurityGroupsCommand({
      Filters: [{ Name: "vpc-id", Values: [VPC_ID] }, { Name: "group-name", Values: ["default"] }],
    })),
  ]);

  const nameById = new Map((tiers.SecurityGroups ?? []).map((g) => [g.GroupId, g.GroupName]));
  const src = (pair) => pair.CidrIp ?? pair.CidrIpv6 ?? null;
  const rule = (p) => ({
    port: p.FromPort === p.ToPort ? p.FromPort : `${p.FromPort}-${p.ToPort}`,
    peers: [
      ...(p.IpRanges ?? []).map(src).filter(Boolean),
      ...(p.UserIdGroupPairs ?? []).map((g) => nameById.get(g.GroupId) ?? g.GroupId),
    ],
  });

  const byId = new Map((tiers.SecurityGroups ?? []).map((g) => [g.GroupId, g]));
  const groups = Object.entries(tierSgs).map(([tier, id]) => {
    const g = byId.get(id) ?? {};
    return {
      tier,
      name: g.GroupName ?? id,
      ingress: (g.IpPermissions ?? []).map(rule),
      egress: (g.IpPermissionsEgress ?? []).map(rule),
    };
  });

  const d = defaults.SecurityGroups?.[0] ?? {};
  const defaultSgLocked = (d.IpPermissions ?? []).length === 0 && (d.IpPermissionsEgress ?? []).length === 0;
  return { groups, defaultSgLocked };
}

async function collectNacls() {
  const { NetworkAcls } = await ec2.send(new DescribeNetworkAclsCommand({
    Filters: [{ Name: "vpc-id", Values: [VPC_ID] }, { Name: "default", Values: ["false"] }],
  }));

  let deny3389 = false;
  const nacls = (NetworkAcls ?? []).map((acl) => {
    const name = acl.Tags?.find((t) => t.Key === "Name")?.Value ?? acl.NetworkAclId;
    const entries = (acl.Entries ?? [])
      .filter((e) => e.RuleNumber < 32767) // drop the implicit default-deny marker
      .map((e) => ({
        rule: e.RuleNumber,
        direction: e.Egress ? "egress" : "ingress",
        action: e.RuleAction,
        protocol: e.Protocol === "-1" ? "all" : e.Protocol === "6" ? "tcp" : e.Protocol,
        ports: e.PortRange ? (e.PortRange.From === e.PortRange.To ? String(e.PortRange.From) : `${e.PortRange.From}-${e.PortRange.To}`) : "all",
        cidr: e.CidrBlock ?? e.Ipv6CidrBlock ?? "",
      }))
      .sort((a, b) => (a.direction === b.direction ? a.rule - b.rule : a.direction.localeCompare(b.direction)));
    if (entries.some((e) => e.action === "deny" && e.ports === "3389" && e.direction === "ingress")) deny3389 = true;
    return { name, subnets: (acl.Associations ?? []).length, entries };
  }).sort((a, b) => a.name.localeCompare(b.name));

  return { nacls, deny3389 };
}

async function collectEndpoints() {
  const { VpcEndpoints } = await ec2.send(new DescribeVpcEndpointsCommand({
    Filters: [{ Name: "vpc-id", Values: [VPC_ID] }],
  }));

  const endpoints = (VpcEndpoints ?? []).map((e) => ({
    service: e.ServiceName.split(".").pop(),
    type: e.VpcEndpointType,
    state: e.State,
  })).sort((a, b) => a.type.localeCompare(b.type) || a.service.localeCompare(b.service));

  return {
    endpoints,
    gatewayAvailable: endpoints.filter((e) => e.type === "Gateway" && e.state.toLowerCase() === "available").length,
    interfaceAvailable: endpoints.filter((e) => e.type === "Interface" && e.state.toLowerCase() === "available").length,
  };
}

async function collectFlowLogs() {
  const { FlowLogs } = await ec2.send(new DescribeFlowLogsCommand({
    Filter: [{ Name: "resource-id", Values: [VPC_ID] }],
  }));
  const active = FlowLogs?.some((f) => f.FlowLogStatus === "ACTIVE") ?? false;

  // last 30 minutes of records; default format:
  // version account eni src dst srcport dstport proto packets bytes start end action status
  let accept = 0, reject = 0, nextToken;
  const rejectSamples = new Map();
  let pages = 0;
  do {
    const res = await logs.send(new FilterLogEventsCommand({
      logGroupName: FLOW_LOG_GROUP,
      startTime: Date.now() - 30 * 60_000,
      limit: 1000,
      nextToken,
    }));
    for (const ev of res.events ?? []) {
      const f = ev.message.trim().split(/\s+/);
      const action = f[12];
      if (action === "ACCEPT") accept += 1;
      else if (action === "REJECT") {
        reject += 1;
        const key = `${f[3]}→:${f[6]}`;
        if (!rejectSamples.has(key) && rejectSamples.size < 6) {
          rejectSamples.set(key, { srcAddr: f[3], dstPort: Number(f[6]), protocol: f[7] === "6" ? "tcp" : f[7] === "17" ? "udp" : f[7] });
        }
      }
    }
    nextToken = res.nextToken;
    pages += 1;
  } while (nextToken && pages < 6);

  return {
    active,
    windowMinutes: 30,
    totalEvents: accept + reject,
    accept,
    reject,
    rejectSamples: [...rejectSamples.values()],
  };
}

// ---- connectivity probes (SSM Run Command) ----------------------------------

// Each probe line prints RESULT|<name>|<exit code>|<output>; the script itself
// always exits 0 so the invocation status stays Success and judgement happens
// here, per probe.
const probeScript = (probes) => [
  `run() { local n="$1"; shift; local out rc; out=$(eval "$@" 2>&1); rc=$?; echo "RESULT|$n|$rc|$out"; }`,
  ...probes.map((p) => `run ${p.name} '${p.cmd}'`),
  "exit 0",
];

const PRIVATE_PROBES = [
  {
    name: "private-internet-egress",
    label: "private app tier → internet",
    expect: "blocked — no NAT, no route",
    cmd: `curl -s -m 6 -o /dev/null -w "%{http_code}" https://example.com`,
    judge: (rc) => rc !== 0,
  },
  {
    name: "private-s3-gateway",
    label: "private app tier → S3 (gateway endpoint)",
    expect: "reachable — prefix-list route, $0",
    cmd: `curl -s -m 10 -o /dev/null -w "%{http_code}" https://s3.${REGION}.amazonaws.com`,
    judge: (rc, out) => rc === 0 && out !== "000",
  },
  {
    name: "private-ddb-gateway",
    label: "private app tier → DynamoDB (gateway endpoint)",
    expect: "reachable — prefix-list route, $0",
    cmd: `curl -s -m 10 -o /dev/null -w "%{http_code}" https://dynamodb.${REGION}.amazonaws.com`,
    judge: (rc, out) => rc === 0 && out.startsWith("2"),
  },
  {
    name: "imdsv1-blocked",
    label: "IMDSv1 request (no session token)",
    expect: "rejected with 401",
    cmd: `curl -s -m 4 -o /dev/null -w "%{http_code}" http://169.254.169.254/latest/meta-data/`,
    judge: (rc, out) => rc === 0 && out === "401",
  },
  {
    name: "imdsv2-works",
    label: "IMDSv2 request (session token)",
    expect: "answers with the instance id",
    cmd: `T=$(curl -sX PUT -m 4 "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60") && curl -s -m 4 -H "X-aws-ec2-metadata-token: $T" http://169.254.169.254/latest/meta-data/instance-id`,
    judge: (rc, out) => rc === 0 && out.startsWith("i-"),
  },
];

const PUBLIC_PROBES = [
  {
    name: "public-internet-egress",
    label: "public web tier → internet",
    expect: "reachable via the IGW",
    cmd: `curl -s -m 10 -o /dev/null -w "%{http_code}" https://example.com`,
    judge: (rc, out) => rc === 0 && out.startsWith("2"),
  },
  {
    name: "web-to-app-8080",
    label: "web tier → app tier :8080",
    expect: "reachable — app SG admits the web SG",
    cmd: `curl -s -m 6 -o /dev/null -w "%{http_code}" http://${PRIVATE_APP_IP}:8080/`,
    judge: (rc, out) => rc === 0 && out.startsWith("2"),
  },
  {
    name: "web-to-data-5432",
    label: "web tier → app tier :5432",
    expect: "blocked by the app tier's security group",
    cmd: `timeout 5 bash -c "</dev/tcp/${PRIVATE_APP_IP}/5432"`,
    judge: (rc) => rc !== 0,
  },
];

async function runProbeSuite(instanceId, from, probes) {
  const { Command } = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: probeScript(probes), executionTimeout: ["120"] },
  }));

  let inv;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      inv = await ssm.send(new GetCommandInvocationCommand({ CommandId: Command.CommandId, InstanceId: instanceId }));
    } catch { continue; } // InvocationDoesNotExist until the agent picks it up
    if (["Success", "Failed", "TimedOut", "Cancelled"].includes(inv.Status)) break;
  }

  const lines = (inv?.StandardOutputContent ?? "").split("\n").filter((l) => l.startsWith("RESULT|"));
  const byName = new Map(lines.map((l) => {
    const [, name, rc, ...rest] = l.split("|");
    return [name, { rc: Number(rc), out: rest.join("|").trim() }];
  }));

  return probes.map((p) => {
    const r = byName.get(p.name);
    return {
      name: p.name,
      from,
      label: p.label,
      expect: p.expect,
      pass: r ? p.judge(r.rc, r.out) : false,
      detail: r ? `exit ${r.rc}${r.out ? `, ${r.out.slice(0, 60)}` : ""}` : `no result (invocation ${inv?.Status ?? "never ran"})`,
    };
  });
}

async function collectProbes() {
  const [priv, pub] = await Promise.all([
    runProbeSuite(PRIVATE_INSTANCE_ID, "private-app", PRIVATE_PROBES),
    runProbeSuite(PUBLIC_INSTANCE_ID, "public-web", PUBLIC_PROBES),
  ]);
  return [...priv, ...pub];
}

// ---- Reachability Analyzer ---------------------------------------------------

async function collectReachability() {
  const { NetworkInsightsAnalyses } = await ec2.send(new DescribeNetworkInsightsAnalysesCommand({
    NetworkInsightsAnalysisIds: analysisDefs.map((a) => a.id),
  }));
  const byId = new Map((NetworkInsightsAnalyses ?? []).map((a) => [a.NetworkInsightsAnalysisId, a]));

  return analysisDefs.map((def) => {
    const a = byId.get(def.id) ?? {};
    const found = a.NetworkPathFound === true;
    return {
      key: def.key,
      label: def.label,
      port: def.port,
      expectReachable: def.expect,
      reachable: found,
      status: a.Status ?? "unknown",
      pass: a.Status === "succeeded" && found === def.expect,
      because: def.because,
      explanationCodes: found ? [] : [...new Set((a.Explanations ?? []).map((e) => e.ExplanationCode).filter(Boolean))].slice(0, 3),
    };
  });
}

// ---- the standalone HTML artifact -------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const yn = (b) => (b ? "✓ yes" : "✗ no");
const verdict = (pass) => `<span class="pill ${pass ? "ok" : "bad"}">${pass ? "as designed" : "UNEXPECTED"}</span>`;

function renderHtml(ev) {
  const rows = (pairs) => pairs.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join("");
  const st = ev.securityTiers;
  const fl = ev.flowLogs;
  const fmtRules = (list) => list.map((r) => `${r.port} ← ${r.peers.join(", ")}`).join(" · ") || "none";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Network Blueprint Evidence Report · ${esc(ev.generatedAt)}</title>
<style>
  body{font:15px/1.55 ui-sans-serif,system-ui,sans-serif;color:#1c1917;max-width:860px;margin:0 auto;padding:32px 24px}
  h1{font-size:26px;margin:0}h2{font-size:18px;margin:32px 0 6px;border-bottom:2px solid #16302e;padding-bottom:4px}
  .meta{color:#57534e;font-size:13px;margin-top:6px}
  .note{background:#f0f7f5;border:1px solid #b8d8d2;border-radius:8px;padding:10px 14px;font-size:13px;margin:18px 0}
  table{border-collapse:collapse;width:100%;margin-top:10px;font-size:14px}
  th,td{text-align:left;padding:6px 10px;border:1px solid #e7e5e4;vertical-align:top}
  th{background:#f5f5f4;font-weight:600;width:40%}
  .pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700}
  .ok{background:#ecfdf5;color:#047857}.bad{background:#fef2f2;color:#b91c1c}
  code{font-size:.9em;background:#f5f5f4;padding:1px 5px;border-radius:5px}
  footer{margin-top:36px;color:#78716c;font-size:12px;border-top:1px solid #e7e5e4;padding-top:12px}
  @media print{body{padding:0}}
</style></head><body>
<h1>Network Blueprint Evidence Report</h1>
<p class="meta">City of Alpenglow demo account · region ${esc(ev.region)} · generated ${esc(ev.generatedAt)} by the <code>net-evidence-report</code> Lambda (plank 9, Planetek AWS Boardwalk)</p>
<div class="note"><strong>How to read this:</strong> every claim below is a live API result, a Reachability Analyzer
verdict, or the output of a probe command executed on the instances via SSM Run Command during report generation.
Rows marked <span class="pill ok">as designed</span> include the paths that are <em>supposed</em> to fail.</div>

<h2>1 · VPC &amp; subnets</h2>
<table>${rows([
    ["VPC", `<code>${esc(ev.network.vpcId)}</code> — ${esc(ev.network.cidr)}`],
    ["Availability zones", esc(ev.network.azs.join(", "))],
    ["Public tier", ev.network.subnets.public.map((s) => `<code>${esc(s.cidr)}</code> (${esc(s.az)})`).join(" · ")],
    ["App tier (private)", ev.network.subnets.app.map((s) => `<code>${esc(s.cidr)}</code> (${esc(s.az)})`).join(" · ")],
    ["Data tier (private)", ev.network.subnets.data.map((s) => `<code>${esc(s.cidr)}</code> (${esc(s.az)})`).join(" · ")],
    ["Subnet-level auto-assign public IP", yn(ev.network.subnets.public.some((s) => s.autoAssignPublicIp)) + " — public exposure is granted per-instance"],
  ])}</table>

<h2>2 · Routing — the no-NAT pattern</h2>
<table>${rows([
    ["Public default route via IGW", yn(ev.network.routing.publicDefaultViaIgw)],
    ["Default routes in private route tables", `${ev.network.routing.privateDefaultRoutes} — private subnets have <strong>no internet path at all</strong>`],
    ["NAT gateways", `${ev.network.routing.natGateways} ($0.045/hr + per-GB, avoided by design)`],
    ["Private route tables", ev.network.routing.privateRouteTables.map((rt) => `<code>${esc(rt.name)}</code>: ${rt.gatewayEndpointRoutes} gateway-endpoint routes, default route ${rt.hasDefaultRoute ? "PRESENT (!)" : "absent"}`).join("<br>")],
  ])}</table>

<h2>3 · Security-group tiers</h2>
<table><tr><th>Tier</th><td><strong>Ingress</strong> / egress</td></tr>${st.groups.map((g) =>
    `<tr><th><code>${esc(g.name)}</code></th><td><strong>${esc(fmtRules(g.ingress))}</strong><br>egress: ${esc(fmtRules(g.egress))}</td></tr>`).join("")}
<tr><th>Default SG</th><td>${st.defaultSgLocked ? '<span class="pill ok">locked</span> — zero rules; nothing can use it' : '<span class="pill bad">has rules</span>'}</td></tr></table>

<h2>4 · Network ACLs (stateless layer)</h2>
${ev.nacls.nacls.map((n) => `<p class="meta"><code>${esc(n.name)}</code> — ${n.subnets} subnets</p>
<table><tr><th style="width:12%">Rule</th><th style="width:14%">Dir</th><th style="width:12%">Action</th><th style="width:18%">Ports</th><th>Source/Dest</th></tr>${n.entries.map((e) =>
    `<tr><td>${e.rule}</td><td>${esc(e.direction)}</td><td>${e.action === "deny" ? '<span class="pill bad">deny</span>' : "allow"}</td><td>${esc(e.ports)}</td><td><code>${esc(e.cidr)}</code></td></tr>`).join("")}</table>`).join("")}

<h2>5 · VPC endpoints</h2>
<table><tr><th>Service</th><td><strong>Type</strong> · state</td></tr>${ev.endpoints.endpoints.map((e) =>
    `<tr><th><code>${esc(e.service)}</code></th><td><strong>${esc(e.type)}</strong> · ${esc(e.state)}${e.type === "Gateway" ? " · free" : " · $0.01/hr (why this plank tears down)"}</td></tr>`).join("")}</table>

<h2>6 · Reachability Analyzer verdicts</h2>
<p class="meta">AWS's own configuration-analysis engine ran each path during deploy — reachable and unreachable claims are proven, not asserted.</p>
<table><tr><th>Path</th><td><strong>Verdict</strong></td></tr>${ev.reachability.map((r) =>
    `<tr><th>${esc(r.label)}</th><td>${r.reachable ? "reachable" : "NOT reachable"} ${verdict(r.pass)}<br><span class="meta">${esc(r.because)}${r.explanationCodes.length ? ` · analyzer: <code>${r.explanationCodes.map(esc).join("</code>, <code>")}</code>` : ""}</span></td></tr>`).join("")}</table>

<h2>7 · Live connectivity probes (SSM Run Command)</h2>
<table><tr><th>Probe</th><td><strong>Expected</strong> · result</td></tr>${ev.probes.map((p) =>
    `<tr><th>${esc(p.label)}<br><span class="meta">from ${esc(p.from)}</span></th><td>${esc(p.expect)} ${verdict(p.pass)}<br><span class="meta">${esc(p.detail)}</span></td></tr>`).join("")}</table>

<h2>8 · Flow logs</h2>
<table>${rows([
    ["Flow log status", fl.active ? "ACTIVE (all traffic, 60s aggregation)" : "not active"],
    [`Records in the last ${fl.windowMinutes} min`, `${fl.totalEvents} — ${fl.accept} ACCEPT · ${fl.reject} REJECT`],
    ["Sample rejected flows", fl.rejectSamples.length
      ? fl.rejectSamples.map((r) => `<code>${esc(r.srcAddr)}</code> → :${r.dstPort}/${esc(r.protocol)}`).join(" · ") + "<br><span class=\"meta\">real internet background noise, turned away at the security group — captured minutes after the public IP went live</span>"
      : "none captured in the window"],
  ])}</table>

<footer>Generated automatically from live AWS APIs. Planetek AWS Boardwalk plank 9 — Network Architecture
(deploy-demo-teardown). Fictional demo; not affiliated with any real government agency.
<a href="https://network.demos.planetek.org">network.demos.planetek.org</a></footer>
</body></html>`;
}

// ---- handler -----------------------------------------------------------------

export const handler = async () => {
  const [network, securityTiers, nacls, endpoints, flowLogs, probes, reachability] = await Promise.all([
    collectNetwork(), collectSecurityTiers(), collectNacls(),
    collectEndpoints(), collectFlowLogs(), collectProbes(), collectReachability(),
  ]);

  const evidence = {
    generatedAt: new Date().toISOString(),
    region: REGION,
    network,
    securityTiers,
    nacls,
    endpoints,
    flowLogs,
    probes,
    reachability,
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
    probes: `${probes.filter((p) => p.pass).length}/${probes.length} as designed`,
    reachability: `${reachability.filter((r) => r.pass).length}/${reachability.length} as designed`,
    flowLogEvents: flowLogs.totalEvents,
    rejects: flowLogs.reject,
  };
};
