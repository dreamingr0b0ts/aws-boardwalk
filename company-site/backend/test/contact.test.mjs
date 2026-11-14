// Tests for the contact form's daily caps, with SES and DynamoDB replaced by
// in-memory stubs (the Lambda has no npm deps, so the SDK imports are swapped
// at module-resolution time). The point: the caps count the visitor, not
// CloudFront's address, and count messages relayed, not attempts.
//
//   node --test company-site/backend/test/contact.test.mjs     (Node 22.15+)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const sent = []; // SendEmail inputs, in order
const counters = new Map(); // rate table: pk -> n
const fail = { ses: false };
globalThis.__stub = { sent, counters, fail };

const STUBS = {
  "@aws-sdk/client-sesv2": `
    export class SESv2Client {
      async send(c) {
        const s = globalThis.__stub;
        if (s.fail.ses) throw Object.assign(new Error("SES said no"), { name: "ServiceUnavailableException" });
        s.sent.push(c.input);
        return {};
      }
    }
    export class SendEmailCommand { constructor(input) { this.input = input; } }`,
  // Just enough DynamoDB to honour the two counter conditions.
  "@aws-sdk/client-dynamodb": `
    export class UpdateItemCommand { constructor(input) { this.input = input; } }
    const refuse = () => { throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" }); };
    export class DynamoDBClient {
      async send(c) {
        const s = globalThis.__stub, i = c.input;
        const pk = i.Key.pk.S, n = s.counters.get(pk);
        if (i.UpdateExpression.startsWith("ADD #n :one")) {
          if (n !== undefined && !(n < Number(i.ExpressionAttributeValues[":limit"].N))) refuse();
          s.counters.set(pk, (n ?? 0) + 1);
        } else {
          if (!(n > 0)) refuse();
          s.counters.set(pk, n - 1);
        }
        return {};
      }
    }`,
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

const CONTACT = "info@planetek.org";
Object.assign(process.env, {
  TABLE_NAME: "rate", CONTACT_EMAIL: CONTACT, CONFIG_SET: "cfg",
  ORIGIN_VERIFY: "only-cloudfront-knows-this",
  DAILY_IP_LIMIT: "2", DAILY_LIMIT: "5", // small, so the caps are quick to reach
});

const { handler } = await import("../contact.mjs");

// What the Lambda sees for a request that came through CloudFront: the origin
// lock header, and an X-Forwarded-For chain ending "<visitor>, <CloudFront>".
// requestContext.http.sourceIp is CloudFront's address too.
const EDGE = "203.0.113.250";
let lastVisitor = 0;
const freshVisitor = () => `198.51.100.${++lastVisitor}`;
const send = (fields = {}, { from = freshVisitor(), edge = EDGE, typed = "", headers } = {}) => handler({
  headers: headers === undefined
    ? { "x-origin-verify": process.env.ORIGIN_VERIFY, "x-forwarded-for": `${typed ? `${typed}, ` : ""}${from}, ${edge}` }
    : headers,
  requestContext: { http: { sourceIp: edge } },
  body: JSON.stringify({ name: "Jane Doe", email: "jane@example.com", message: "Hello, I have a question about AWS.", ...fields }),
});

const today = () => new Date().toISOString().slice(0, 10);
const keyOf = (network) => createHash("sha256").update(network).digest("hex").slice(0, 16);
const claimed = (network) => counters.get(`visitor#${keyOf(network)}#${today()}`) ?? 0;
const formTotal = () => counters.get(`global#${today()}`) ?? 0;

beforeEach(() => {
  sent.length = 0;
  counters.clear();
  fail.ses = false;
});

test("a message is relayed to info@ with the visitor's address, not CloudFront's", async () => {
  const res = await send({ company: "Acme", service: "Managed AWS" }, { from: "192.0.2.10" });
  assert.equal(res.statusCode, 200);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].Destination, { ToAddresses: [CONTACT] });
  assert.deepEqual(sent[0].ReplyToAddresses, ["jane@example.com"]);
  const text = sent[0].Content.Simple.Body.Text.Data;
  assert.match(text, /^IP: {6}192\.0\.2\.10$/m);
  assert.ok(!text.includes(EDGE));
});

test("the per-visitor cap follows the visitor, whichever CloudFront address carries them", async () => {
  const anna = "192.0.2.10";
  assert.equal((await send({}, { from: anna, edge: "203.0.113.1" })).statusCode, 200);
  assert.equal((await send({}, { from: anna, edge: "203.0.113.2" })).statusCode, 200);
  assert.equal((await send({}, { from: anna, edge: "203.0.113.3" })).statusCode, 429);
  assert.equal(claimed(anna), 2);

  // Someone else sharing a CloudFront address with her is not caught up in it.
  assert.equal((await send({}, { from: "192.0.2.77", edge: "203.0.113.1" })).statusCode, 200);

  for (const key of counters.keys()) {
    assert.ok(!key.includes("203.0.113."), `counted against a CloudFront address: ${key}`);
    assert.ok(!key.includes("192.0.2."), `address stored in a counter key: ${key}`);
  }
});

test("an X-Forwarded-For the client typed changes nothing", async () => {
  const mallory = "192.0.2.66";
  assert.equal((await send({}, { from: mallory, typed: "10.0.0.1" })).statusCode, 200);
  assert.equal((await send({}, { from: mallory, typed: "8.8.8.8, 192.0.2.10" })).statusCode, 200);
  assert.equal((await send({}, { from: mallory, typed: "evil, 127.0.0.1" })).statusCode, 429);
  assert.equal(claimed(mallory), 2);
  assert.equal(claimed("10.0.0.1") + claimed("192.0.2.10") + claimed("127.0.0.1"), 0);
});

test("an IPv6 visitor is counted by their /64", async () => {
  assert.equal((await send({}, { from: "2001:db8:abcd:12::1" })).statusCode, 200);
  assert.equal((await send({}, { from: "2001:0db8:abcd:0012:aaaa:bbbb:cccc:dddd" })).statusCode, 200);
  assert.equal((await send({}, { from: "2001:db8:abcd:12:ffff::2" })).statusCode, 429);
  assert.equal(claimed("2001:db8:abcd:12::/64"), 2);
  assert.equal((await send({}, { from: "2001:db8:abcd:13::1" })).statusCode, 200);
});

test("the form's daily cap counts messages relayed, and a refusal there hands the visitor's claim back", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await send()).statusCode, 200);
  assert.equal(formTotal(), 5);

  const late = "192.0.2.200";
  assert.equal((await send({}, { from: late })).statusCode, 429);
  assert.equal(claimed(late), 0);
  assert.equal(formTotal(), 5);
  assert.equal(sent.length, 5);
});

test("if the message cannot be relayed, the visitor is told and nothing is counted", async () => {
  const carol = "192.0.2.30";
  fail.ses = true;
  const res = await send({}, { from: carol });
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /couldn't send that just now/);
  assert.equal(claimed(carol), 0);
  assert.equal(formTotal(), 0);

  fail.ses = false;
  assert.equal((await send({}, { from: carol })).statusCode, 200);
  assert.equal(claimed(carol), 1);
});

test("requests refused before the caps are reached claim nothing", async () => {
  const dave = { from: "192.0.2.50" };
  assert.equal((await send({ name: "" }, dave)).statusCode, 400);
  assert.equal((await send({ email: "nope" }, dave)).statusCode, 400);
  assert.equal((await send({ message: "hi" }, dave)).statusCode, 400);
  assert.deepEqual(JSON.parse((await send({ website: "http://spam" }, dave)).body), { ok: true });
  assert.equal(counters.size, 0);
  assert.equal(sent.length, 0);
});

test("a request that did not come through CloudFront is refused before anything happens", async () => {
  for (const headers of [null, {}, { "x-origin-verify": "guess" }, { "x-forwarded-for": "192.0.2.10, 203.0.113.1" }]) {
    assert.equal((await send({}, { headers })).statusCode, 403, JSON.stringify(headers));
  }
  assert.equal(counters.size, 0);
  assert.equal(sent.length, 0);
});
