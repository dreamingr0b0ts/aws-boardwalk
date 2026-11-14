// Tests for the evidence report's GuardDuty section, with the AWS SDK replaced
// by in-memory stubs (the Lambda has no npm deps, so the SDK imports are
// swapped at module-resolution time).
//
// The point: the detector is the account's real, always-on one, and the
// report is a public page. Only AWS's practice findings may be counted or
// named on it. A real finding sitting in the same detector must not move a
// single number.
//
//   node --test security-posture/demo/test/report.test.mjs     (Node 22.15+)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const gd = { findings: [], listCalls: 0, getCalls: 0 };
globalThis.__gd = gd;

const EMPTY_CLIENT = (client, commands) => `
  export class ${client} { async send() { return {}; } }
  ${commands.map((c) => `export class ${c} { constructor(input) { this.input = input; } }`).join("\n")}`;

const STUBS = {
  "@aws-sdk/client-guardduty": `
    class Cmd { constructor(input) { this.input = input; } }
    export class ListFindingsCommand extends Cmd {}
    export class GetFindingsCommand extends Cmd {}
    export class GuardDutyClient {
      async send(c) {
        const g = globalThis.__gd;
        if (c instanceof ListFindingsCommand) {
          g.listCalls += 1;
          const active = g.findings.filter((f) => !f.Service?.Archived).map((f) => f.Id);
          const start = Number(c.input.NextToken ?? 0);
          const page = active.slice(start, start + c.input.MaxResults);
          const next = start + page.length;
          return { FindingIds: page, NextToken: next < active.length ? String(next) : undefined };
        }
        if (c instanceof GetFindingsCommand) {
          g.getCalls += 1;
          if (c.input.FindingIds.length > 50) throw new Error("GetFindings takes at most 50 ids");
          return { Findings: g.findings.filter((f) => c.input.FindingIds.includes(f.Id)) };
        }
        return {};
      }
    }`,
  "@aws-sdk/client-cloudtrail": EMPTY_CLIENT("CloudTrailClient", ["DescribeTrailsCommand", "GetTrailStatusCommand"]),
  "@aws-sdk/client-kms": EMPTY_CLIENT("KMSClient", ["DescribeKeyCommand", "GetKeyRotationStatusCommand"]),
  "@aws-sdk/client-securityhub": EMPTY_CLIENT("SecurityHubClient", ["GetEnabledStandardsCommand", "GetFindingsCommand"]),
  "@aws-sdk/client-config-service": EMPTY_CLIENT("ConfigServiceClient", [
    "DescribeConfigurationRecorderStatusCommand", "DescribeConformancePackComplianceCommand",
  ]),
  "@aws-sdk/client-iam": EMPTY_CLIENT("IAMClient", ["GetRoleCommand", "SimulatePrincipalPolicyCommand"]),
  "@aws-sdk/client-s3": EMPTY_CLIENT("S3Client", ["PutObjectCommand", "GetObjectCommand"]),
};

registerHooks({
  resolve(specifier, context, next) {
    return specifier in STUBS ? { url: `stub:${specifier}`, shortCircuit: true } : next(specifier, context);
  },
  load(url, context, next) {
    return url.startsWith("stub:")
      ? { format: "module", source: STUBS[url.slice(5)], shortCircuit: true }
      : next(url, context);
  },
});

process.env.DETECTOR_ID = "0123456789abcdef0123456789abcdef";
const { isPractice, collectGuardDuty } = await import("../lambda/report.mjs");

// Shapes copied from what GetFindings returned for the account's detector on
// 2026-11-14: a practice finding carries "sample": true inside the JSON string
// at Service.AdditionalInfo.Value, and its Title has NO "[SAMPLE]" prefix
// (that label exists only in the console).
let seq = 0;
const practice = (Type, Severity, extra = {}) => ({
  Id: `p${++seq}`,
  Type,
  Severity,
  Title: "The reconnaissance API GeneratedFindingAPIName was invoked from a Tor exit node.",
  Service: { Archived: false, AdditionalInfo: { Value: JSON.stringify({ ...extra, sample: true }), Type: "default" } },
});
const real = (Type, Severity, additionalInfo) => ({
  Id: `r${++seq}`,
  Type,
  Severity,
  Title: "An API was invoked from an unusual location.",
  Service: { Archived: false, ...(additionalInfo === undefined ? {} : { AdditionalInfo: additionalInfo }) },
});

beforeEach(() => {
  gd.findings = [];
  gd.listCalls = 0;
  gd.getCalls = 0;
  seq = 0;
});

test("a practice finding is recognised by AWS's sample marker, not by its title", () => {
  assert.equal(isPractice(practice("Recon:IAMUser/TorIPCaller", 5)), true);
  assert.equal(isPractice(practice("Recon:IAMUser/TorIPCaller", 5, { apiCalls: [{ name: "x", count: 2 }] })), true);

  assert.equal(isPractice(real("Recon:IAMUser/TorIPCaller", 5)), false, "no AdditionalInfo at all");
  assert.equal(isPractice(real("X:Y/Z", 5, { Value: "{}", Type: "default" })), false, "marker absent");
  assert.equal(isPractice(real("X:Y/Z", 5, { Value: '{"sample":false}', Type: "default" })), false, "marker false");
  assert.equal(isPractice(real("X:Y/Z", 5, { Value: "not json", Type: "default" })), false, "unreadable marker counts as real");
  assert.equal(isPractice({ ...real("X:Y/Z", 5), Title: "[SAMPLE] looks like one" }), false, "a title proves nothing");
  assert.equal(isPractice(undefined), false);
});

test("the report counts and names only practice findings; real ones move nothing", async () => {
  // 120 practice findings over three types and all three severity bands…
  for (let i = 0; i < 70; i++) gd.findings.push(practice("Recon:IAMUser/TorIPCaller", 5));
  for (let i = 0; i < 40; i++) gd.findings.push(practice("Policy:S3/BucketAnonymousAccessGranted", 8));
  for (let i = 0; i < 10; i++) gd.findings.push(practice("Discovery:S3/TorIPCaller", 2));
  // …and three real ones the detector raised itself, scattered through the list.
  const REAL_TYPE = "UnauthorizedAccess:IAMUser/InstanceCredentialExfiltration.OutsideAWS";
  gd.findings.splice(3, 0, real(REAL_TYPE, 8));
  gd.findings.splice(60, 0, real(REAL_TYPE, 8, { Value: "{}", Type: "default" }));
  gd.findings.push(real("Stealth:IAMUser/CloudTrailLoggingDisabled", 2, { Value: '{"sample":false}', Type: "default" }));

  const out = await collectGuardDuty();

  assert.equal(out.total, 120);
  assert.deepEqual(out.bySeverity, { HIGH: 40, MEDIUM: 70, LOW: 10 });
  assert.equal(out.distinctTypes, 3);
  assert.equal(out.fieldGuideSampled, 120);
  assert.deepEqual(out.fieldGuide.map((g) => [g.type, g.count]), [
    ["Recon:IAMUser/TorIPCaller", 70],
    ["Policy:S3/BucketAnonymousAccessGranted", 40],
    ["Discovery:S3/TorIPCaller", 10],
  ]);
  assert.equal(JSON.stringify(out).includes("InstanceCredentialExfiltration"), false, "a real finding's type reached the report");
  assert.equal(JSON.stringify(out).includes("CloudTrailLoggingDisabled"), false, "a real finding's type reached the report");
  assert.equal("detectorId" in out, false, "the permanent detector's id is not published");

  // 123 active ids: three pages of 50, then three batches of at most 50.
  assert.equal(gd.listCalls, 3);
  assert.equal(gd.getCalls, 3);
});

test("with no practice findings seeded, a real finding still shows as nothing", async () => {
  gd.findings.push(real("Recon:IAMUser/MaliciousIPCaller", 5));

  const out = await collectGuardDuty();

  assert.equal(out.total, 0);
  assert.deepEqual(out.bySeverity, { HIGH: 0, MEDIUM: 0, LOW: 0 });
  assert.deepEqual(out.fieldGuide, []);
});

test("archived practice findings from an earlier window are not counted again", async () => {
  gd.findings.push(practice("Recon:IAMUser/TorIPCaller", 5));
  const old = practice("Recon:IAMUser/TorIPCaller", 5);
  old.Service.Archived = true;
  gd.findings.push(old);

  assert.equal((await collectGuardDuty()).total, 1);
});
