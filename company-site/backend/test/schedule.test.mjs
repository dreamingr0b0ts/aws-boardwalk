// Tests for the booking desk's outgoing mail, with SES and DynamoDB replaced
// by in-memory stubs (the Lambda has no npm deps, so the SDK imports are
// swapped at module-resolution time). The point: a booking can only ever mail
// info@ and the one address that was typed, and the visitor's copy carries
// nothing the visitor wrote.
//
//   node --test company-site/backend/test/schedule.test.mjs     (Node 22.15+)
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const sent = []; // SendEmail inputs, in order
const writes = []; // PutItem inputs
globalThis.__stub = { sent, writes };

const STUBS = {
  "@aws-sdk/client-sesv2": `
    export class SESv2Client { async send(c) { globalThis.__stub.sent.push(c.input); return {}; } }
    export class SendEmailCommand { constructor(input) { this.input = input; } }`,
  "@aws-sdk/client-dynamodb": `
    class Cmd { constructor(input) { this.input = input; } }
    export class QueryCommand extends Cmd {}
    export class UpdateItemCommand extends Cmd {}
    export class PutItemCommand extends Cmd {}
    export class DynamoDBClient {
      async send(c) {
        if (c instanceof QueryCommand) return { Items: [] };
        if (c instanceof PutItemCommand) globalThis.__stub.writes.push(c.input);
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
  RATE_TABLE: "rate", BOOK_TABLE: "book", CONTACT_EMAIL: CONTACT, CONFIG_SET: "cfg", VISITOR_EMAIL: "true",
});

const { handler } = await import("../schedule.mjs");

const call = (routeKey, body) =>
  handler({ routeKey, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { http: { sourceIp: "198.51.100.9" } } });

const firstSlot = async () => JSON.parse((await call("GET /api/schedule/slots")).body).slots[0];
const book = async (fields) => call("POST /api/schedule/book", { slot: await firstSlot(), ...fields });

/** Split a raw message into its top-level headers and decoded MIME parts. */
function parse(input) {
  const raw = Buffer.from(input.Content.Raw.Data).toString("utf8");
  const [head, ...rest] = raw.split("\r\n\r\n");
  const headers = head.split("\r\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]);
  const boundary = /boundary="([^"]+)"/.exec(head)[1];
  const parts = rest.join("\r\n\r\n").split(`--${boundary}`).slice(1, -1).map((p) => {
    const [h, b] = p.trim().split("\r\n\r\n");
    return { headers: h, text: Buffer.from(b, "base64").toString("utf8") };
  });
  return { raw, headers, header: Object.fromEntries(headers), boundary, parts };
}

const owner = () => parse(sent.find((m) => m.Destination.ToAddresses[0] === CONTACT));
const visitor = () => parse(sent.find((m) => m.Destination.ToAddresses[0] !== CONTACT));
const HEADER_NAMES = ["From", "To", "Reply-To", "Subject", "MIME-Version", "Content-Type"];

beforeEach(() => {
  sent.length = 0;
  writes.length = 0;
});

test("a normal booking mails the owner and the visitor, each explicitly addressed", async () => {
  const res = await book({ name: "Jane Doe", email: "jane.doe+aws@example.co.uk", company: "Acme", topic: "Landing zone" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.ok, true);
  assert.equal(body.confirmationEmailed, true);
  assert.match(body.ics, /SUMMARY:Planetek consultation with Jane Doe/);

  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((m) => m.Destination), [
    { ToAddresses: [CONTACT] },
    { ToAddresses: ["jane.doe+aws@example.co.uk"] },
  ]);

  const o = owner();
  assert.deepEqual(o.headers.map(([k]) => k), HEADER_NAMES);
  assert.equal(o.header.To, CONTACT);
  assert.equal(o.header["Reply-To"], '"Jane Doe" <jane.doe+aws@example.co.uk>');
  assert.match(o.parts[0].text, /Name: {4}Jane Doe\r\nEmail: {3}jane\.doe\+aws@example\.co\.uk\r\nCompany: Acme\r\nTopic: {3}Landing zone/);
  assert.match(o.parts[1].text, /BEGIN:VCALENDAR/);

  const v = visitor();
  assert.deepEqual(v.headers.map(([k]) => k), HEADER_NAMES);
  assert.equal(v.header.To, "jane.doe+aws@example.co.uk");
  assert.match(v.parts[0].text, /^Hello,\r\n\r\nYour free 30-minute consultation/);
});

test("extra recipients typed into the name reach nobody", async () => {
  const res = await book({ name: "a@evil.example, b@evil.example,", email: "victim@example.com" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sent.map((m) => m.Destination.ToAddresses), [[CONTACT], ["victim@example.com"]]);

  const v = visitor();
  assert.equal(v.header.To, "victim@example.com");
  assert.ok(!v.raw.includes("evil.example"), "visitor copy headers are clean");
  for (const p of v.parts) assert.ok(!p.text.includes("evil.example"), "visitor copy body and invite are clean");

  // The owner still sees what was typed, quoted so it cannot become an address list.
  assert.equal(owner().header["Reply-To"], '"a@evil.example, b@evil.example," <victim@example.com>');
});

test("line breaks, headers, and MIME parts in the name are inert", async () => {
  const name = 'x\r\nBcc: third@evil.example\r\n\r\n--pk-confirm\r\nContent-Type: text/html\r\n\r\n<a href="http://evil.example">click</a>';
  const res = await book({ name, email: "victim@example.com", topic: "t\r\n--pk-invite\r\nContent-Type: text/html\r\n\r\n<b>x</b>" });
  assert.equal(res.statusCode, 200);

  for (const m of [owner(), visitor()]) {
    assert.deepEqual(m.headers.map(([k]) => k), HEADER_NAMES, "no injected headers");
    assert.equal(m.parts.length, 2, "no injected MIME parts");
    assert.match(m.boundary, /^pk-[0-9a-f]{36}$/);
    for (const line of m.raw.split("\r\n")) assert.ok(line.length <= 200, "no over-long line");
  }
  assert.notEqual(owner().boundary, visitor().boundary);

  const v = visitor();
  for (const p of v.parts) {
    assert.ok(!/evil|click|Bcc|text\/html/.test(p.text), "the visitor's copy carries none of the visitor's text");
  }
  assert.match(v.parts[1].text, /SUMMARY:Consultation with Planetek/);

  // The stored booking and the owner's copy hold the name as a single line.
  assert.ok(!/[\r\n]/.test(writes[0].Item.name.S));
  assert.match(owner().parts[0].text, /Name: {4}x Bcc: third@evil\.example --pk-confirm Content-Type: text\/html <a href=/);
});

test("a 1,000-character single-line topic still produces a deliverable message", async () => {
  const res = await book({ name: "Jane", email: "jane@example.com", topic: "x".repeat(1000) });
  assert.equal(res.statusCode, 200);
  for (const line of owner().raw.split("\r\n")) assert.ok(line.length <= 998);
  assert.ok(owner().parts[0].text.includes("x".repeat(1000)));
});

test("addresses that could carry more than one recipient are refused before anything happens", async () => {
  const bad = [
    "a@x.com,evil", // passed the old pattern: "com,evil" looked like a TLD
    "a@x.com;b@y.org",
    "victim@x.com>,<b@y.org",
    "<a@x.com>",
    '"a b"@x.com',
    "a@x.com\r\nBcc:b@y.org",
    "a@x",
    "a@-x.com",
    "a..b@x.com",
    ".a@x.com",
    "a@x.c",
    "ä@x.com",
    `${"a".repeat(65)}@x.com`,
    `a@${"x".repeat(250)}.com`,
    "",
  ];
  for (const email of bad) {
    const res = await book({ name: "Jane", email });
    assert.equal(res.statusCode, 400, JSON.stringify(email));
  }
  assert.equal(sent.length, 0);
  assert.equal(writes.length, 0);
});

test("ordinary addresses are still accepted", async () => {
  for (const email of ["o'brien@example.com", "first.last@sub.example.io", "a_b-c+tag@example-site.org", "x@münchen.example".replace("münchen", "xn--mnchen-3ya")]) {
    sent.length = 0;
    const res = await book({ name: "Jane", email });
    assert.equal(res.statusCode, 200, email);
    assert.deepEqual(sent[1].Destination.ToAddresses, [email]);
  }
});

test("malformed bodies are a 400, not a crash", async () => {
  const slot = await firstSlot();
  for (const body of [null, [], "text", 7, { name: { a: 1 }, email: ["x@y.com"], slot }, { name: "J", email: "j@example.com", slot: 5 }]) {
    const res = await call("POST /api/schedule/book", body);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(sent.length, 0);
});

test("the honeypot still swallows bots without sending anything", async () => {
  const res = await book({ name: "Bot", email: "bot@example.com", website: "http://spam" });
  assert.deepEqual(JSON.parse(res.body), { ok: true });
  assert.equal(sent.length, 0);
});
