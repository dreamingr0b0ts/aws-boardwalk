// Tests for the booking desk, with SES and DynamoDB replaced by in-memory
// stubs (the Lambda has no npm deps, so the SDK imports are swapped at
// module-resolution time). Two things are pinned down here:
//
//   mail    a booking can only ever mail info@ and the one address that was
//           typed, and the visitor's copy carries nothing the visitor wrote
//   limits  the daily caps count the visitor (not CloudFront's address) and
//           count bookings made (not attempts), and a booking the owner was
//           never told about does not stay on the books
//
//   node --test company-site/backend/test/schedule.test.mjs     (Node 22.15+)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import { beforeEach, test } from "node:test";

const sent = []; // SendEmail inputs, in order
const writes = []; // PutItem inputs
const deletes = []; // DeleteItem inputs
const counters = new Map(); // rate table: pk -> n
const bookings = new Map(); // bookings table: slot -> item
const fail = { owner: false, visitor: false }; // make SES refuse one kind of mail
globalThis.__stub = { sent, writes, deletes, counters, bookings, fail, contact: "info@planetek.org" };

const STUBS = {
  "@aws-sdk/client-sesv2": `
    export class SESv2Client {
      async send(c) {
        const s = globalThis.__stub;
        const toOwner = c.input.Destination.ToAddresses[0] === s.contact;
        if (toOwner ? s.fail.owner : s.fail.visitor) {
          throw Object.assign(new Error("SES said no"), { name: toOwner ? "ServiceUnavailableException" : "MessageRejected" });
        }
        s.sent.push(c.input);
        return {};
      }
    }
    export class SendEmailCommand { constructor(input) { this.input = input; } }`,
  // Just enough DynamoDB to honour the conditions the handler relies on.
  "@aws-sdk/client-dynamodb": `
    class Cmd { constructor(input) { this.input = input; } }
    export class QueryCommand extends Cmd {}
    export class UpdateItemCommand extends Cmd {}
    export class PutItemCommand extends Cmd {}
    export class DeleteItemCommand extends Cmd {}
    const refuse = () => { throw Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" }); };
    export class DynamoDBClient {
      async send(c) {
        const s = globalThis.__stub, i = c.input;
        if (c instanceof QueryCommand) {
          const from = i.ExpressionAttributeValues[":now"].S;
          return { Items: [...s.bookings.keys()].filter((k) => k >= from).map((k) => ({ sk: { S: k } })) };
        }
        if (c instanceof UpdateItemCommand) {
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
        if (c instanceof PutItemCommand) {
          if (s.bookings.has(i.Item.sk.S)) refuse();
          s.bookings.set(i.Item.sk.S, i.Item);
          s.writes.push(i);
          return {};
        }
        if (c instanceof DeleteItemCommand) {
          const row = s.bookings.get(i.Key.sk.S);
          if (!row || row.bookingId.S !== i.ExpressionAttributeValues[":id"].S) refuse();
          s.bookings.delete(i.Key.sk.S);
          s.deletes.push(i);
          return {};
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
  RATE_TABLE: "rate", BOOK_TABLE: "book", CONTACT_EMAIL: CONTACT, CONFIG_SET: "cfg", VISITOR_EMAIL: "true",
  ORIGIN_VERIFY: "only-cloudfront-knows-this",
  DAILY_IP_LIMIT: "3", DAILY_LIMIT: "10", // the production values
});

const { handler } = await import("../schedule.mjs");

// What the Lambda sees for a request that came through CloudFront: the origin
// lock header, and an X-Forwarded-For chain ending "<visitor>, <CloudFront>".
// requestContext.http.sourceIp is CloudFront's address too. `from` is the
// visitor; `edge` is whichever CloudFront address carried the request; `typed`
// is anything the client put in X-Forwarded-For itself.
const EDGE = "203.0.113.250";
let lastVisitor = 0;
const freshVisitor = () => `198.51.100.${++lastVisitor}`;
const viaEdge = ({ from = freshVisitor(), edge = EDGE, typed = "" } = {}) => ({
  headers: { "x-origin-verify": process.env.ORIGIN_VERIFY, "x-forwarded-for": `${typed ? `${typed}, ` : ""}${from}, ${edge}` },
  requestContext: { http: { sourceIp: edge } },
});

// `headers` lets a test play a caller that went around CloudFront; otherwise
// every call is a new visitor unless `who` says which one.
const call = (routeKey, body, headers, who) => {
  const edge = viaEdge(who);
  return handler({
    routeKey,
    headers: headers === undefined ? edge.headers : headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: edge.requestContext,
  });
};

const openSlots = async () => JSON.parse((await call("GET /api/schedule/slots")).body).slots;
const firstSlot = async () => (await openSlots())[0];
const book = async (fields, who) => call("POST /api/schedule/book", { slot: await firstSlot(), ...fields }, undefined, who);

// Counter rows are keyed on a hash of the visitor's network, never the address.
const today = () => new Date().toISOString().slice(0, 10);
const keyOf = (network) => createHash("sha256").update(network).digest("hex").slice(0, 16);
const claimed = (network) => counters.get(`sched-visitor#${keyOf(network)}#${today()}`) ?? 0;
const deskTotal = () => counters.get(`sched-global#${today()}`) ?? 0;

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
  deletes.length = 0;
  counters.clear();
  bookings.clear();
  fail.owner = false;
  fail.visitor = false;
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

test("a request that did not come through CloudFront is refused before anything happens", async () => {
  const slot = await firstSlot();
  const booking = { name: "Jordan Reyes", email: "jordan@example.com", slot };
  const secret = process.env.ORIGIN_VERIFY;
  for (const headers of [undefined, {}, { "x-origin-verify": "" }, { "x-origin-verify": "guess" }, { "x-origin-verify": "x".repeat(secret.length) }]) {
    assert.equal((await handler({ routeKey: "GET /api/schedule/slots", headers })).statusCode, 403, JSON.stringify(headers));
    assert.equal((await call("POST /api/schedule/book", booking, headers ?? null)).statusCode, 403, JSON.stringify(headers));
  }
  assert.equal(sent.length, 0);

  // Fails closed: deployed without the secret, the function trusts nothing.
  delete process.env.ORIGIN_VERIFY;
  try {
    assert.equal((await call("POST /api/schedule/book", booking, {})).statusCode, 403);
    assert.equal((await call("POST /api/schedule/book", booking, { "x-origin-verify": "" })).statusCode, 403);
  } finally {
    process.env.ORIGIN_VERIFY = secret;
  }
  assert.equal(sent.length, 0);

  // The slot was never taken, so the real visitor can still have it.
  assert.equal((await call("POST /api/schedule/book", booking)).statusCode, 200);
});

// ---- limits -----------------------------------------------------------------

const person = (n) => ({ name: `Visitor ${n}`, email: `visitor${n}@example.com` });

test("the per-visitor cap follows the visitor, whichever CloudFront address carries them", async () => {
  const anna = "192.0.2.10";
  // Three bookings, each arriving through a different CloudFront address…
  for (const edge of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
    assert.equal((await book(person(1), { from: anna, edge })).statusCode, 200, edge);
  }
  // …and the fourth is refused, even through a fourth.
  const fourth = await book(person(1), { from: anna, edge: "203.0.113.4" });
  assert.equal(fourth.statusCode, 429);
  assert.equal(claimed(anna), 3);

  // Someone else sharing a CloudFront address with her is not caught up in it.
  assert.equal((await book(person(2), { from: "192.0.2.77", edge: "203.0.113.1" })).statusCode, 200);

  // Nothing was ever counted against a CloudFront address.
  for (const key of counters.keys()) assert.ok(!key.includes("203.0.113."), key);
});

test("the visitor's address is hashed in the counters and shown to the owner", async () => {
  await book(person(1), { from: "192.0.2.10" });
  for (const key of counters.keys()) assert.ok(!key.includes("192.0.2.10"), `address stored in a counter key: ${key}`);
  assert.equal(writes[0].Item.visitor.S, keyOf("192.0.2.10"));
  assert.equal(writes[0].Item.ip, undefined);
  assert.match(owner().parts[0].text, /\r\nIP: {6}192\.0\.2\.10\r\n/);
});

test("an X-Forwarded-For the client typed changes nothing", async () => {
  const mallory = "192.0.2.66";
  const forged = ["10.0.0.1", "8.8.8.8, 1.1.1.1", "192.0.2.10", "evil, <b>, 127.0.0.1"];
  for (let i = 0; i < 3; i++) {
    assert.equal((await book(person(i), { from: mallory, typed: forged[i] })).statusCode, 200, forged[i]);
  }
  assert.equal((await book(person(9), { from: mallory, typed: forged[3] })).statusCode, 429);
  assert.equal(claimed(mallory), 3);
  // The addresses she claimed to be were never charged.
  assert.equal(claimed("10.0.0.1") + claimed("1.1.1.1") + claimed("192.0.2.10") + claimed("127.0.0.1"), 0);
});

test("an IPv6 visitor is counted by their /64, however the address is written", async () => {
  const home = "2001:db8:abcd:12::/64";
  for (const from of ["2001:db8:abcd:12::1", "2001:0DB8:ABCD:0012:aaaa:bbbb:cccc:dddd", "2001:db8:abcd:12:0:0:0:99"]) {
    assert.equal((await book(person(1), { from })).statusCode, 200, from);
  }
  assert.equal((await book(person(1), { from: "2001:db8:abcd:12:ffff::2" })).statusCode, 429);
  assert.equal(claimed(home), 3);

  // The /64 next door is somebody else.
  assert.equal((await book(person(2), { from: "2001:db8:abcd:13::1" })).statusCode, 200);
  // An IPv4 address that arrives IPv6-mapped is still that IPv4 address.
  assert.equal((await book(person(3), { from: "::ffff:192.0.2.10" })).statusCode, 200);
  assert.equal(claimed("192.0.2.10"), 1);
});

test("asking for a slot someone else already has costs nothing", async () => {
  const slot = await firstSlot();
  assert.equal((await call("POST /api/schedule/book", { slot, ...person(1) }, undefined, { from: "192.0.2.1" })).statusCode, 200);
  assert.equal(deskTotal(), 1);

  // Ten tries at the taken slot: each is told so, and none is counted. Counted
  // the old way, these ten alone would have closed the desk for the day.
  const bob = "192.0.2.2";
  for (let i = 0; i < 10; i++) {
    const res = await call("POST /api/schedule/book", { slot, ...person(2) }, undefined, { from: bob });
    assert.equal(res.statusCode, 409);
  }
  assert.equal(claimed(bob), 0);
  assert.equal(deskTotal(), 1);
  assert.equal(sent.length, 2, "only the first booking produced mail");

  // He still has his full allowance for slots that are free.
  for (let i = 0; i < 3; i++) assert.equal((await book(person(2), { from: bob })).statusCode, 200);
  assert.equal(claimed(bob), 3);
});

test("the desk's daily cap counts bookings made, and a refusal there hands the visitor's claim back", async () => {
  for (let i = 1; i <= 10; i++) assert.equal((await book(person(i))).statusCode, 200, `booking ${i}`);
  assert.equal(deskTotal(), 10);

  const late = "192.0.2.200";
  assert.equal((await book(person(11), { from: late })).statusCode, 429);
  assert.equal(claimed(late), 0, "refused by the desk cap, so nothing is held against the visitor");
  assert.equal(deskTotal(), 10);
  assert.equal(bookings.size, 10);
});

test("if the owner's invite cannot be sent, the booking is undone and nothing is counted", async () => {
  const slot = await firstSlot();
  const carol = "192.0.2.30";
  fail.owner = true;

  const res = await call("POST /api/schedule/book", { slot, ...person(1) }, undefined, { from: carol });
  assert.equal(res.statusCode, 503);
  assert.match(JSON.parse(res.body).error, /couldn't confirm that booking/);

  assert.equal(bookings.size, 0, "the slot is free again");
  assert.equal(sent.length, 0, "no confirmation went to the visitor for a booking that did not happen");
  assert.equal(claimed(carol), 0);
  assert.equal(deskTotal(), 0);

  // The release names the row this request wrote, so it can never remove a
  // booking a later visitor was given for the same time.
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].ConditionExpression, "bookingId = :id");
  assert.equal(deletes[0].ExpressionAttributeValues[":id"].S, writes[0].Item.bookingId.S);
  assert.match(writes[0].Item.bookingId.S, /^[0-9a-f]{24}$/);

  // Once mail works again the same visitor can have the same slot.
  fail.owner = false;
  const again = await call("POST /api/schedule/book", { slot, ...person(1) }, undefined, { from: carol });
  assert.equal(again.statusCode, 200);
  assert.equal(claimed(carol), 1);
});

test("a visitor confirmation that bounces does not undo the booking", async () => {
  fail.visitor = true;
  const res = await book(person(1), { from: "192.0.2.40" });
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).confirmationEmailed, false);
  assert.equal(bookings.size, 1);
  assert.equal(deletes.length, 0);
  assert.deepEqual(sent.map((m) => m.Destination.ToAddresses), [[CONTACT]]);
  assert.equal(claimed("192.0.2.40"), 1);
});

test("requests refused before the caps are reached claim nothing", async () => {
  const dave = "192.0.2.50";
  const slot = await firstSlot();
  const refused = [
    { slot, name: "", email: "dave@example.com" },
    { slot, name: "Dave", email: "not-an-address" },
    { slot: "2030-01-07T03:00:00Z", name: "Dave", email: "dave@example.com" },
    { slot, name: "Bot", email: "bot@example.com", website: "http://spam" },
  ];
  for (const body of refused) await call("POST /api/schedule/book", body, undefined, { from: dave });
  assert.equal(counters.size, 0);
  assert.equal(bookings.size, 0);
});
