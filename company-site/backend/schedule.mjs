// The booking desk: GET /api/schedule/slots and POST /api/schedule/book.
// Availability is computed, never stored: weekdays 09:00-20:00 America/Denver
// in 30-minute slots, at least 24 hours out, up to three weeks ahead. A
// booking is one conditional DynamoDB write (double-booking is impossible by
// construction), then the invite lands at info@ as an .ics attachment. If the
// invite cannot be sent the booking is undone: a slot nobody was told about
// is worse than no booking.
//
// Daily caps count bookings made, per visitor and for the desk as a whole. A
// request that ends without a booking hands its allowance back.
//
// With VISITOR_EMAIL on (SES production access), a confirmation also goes to
// the address the visitor typed. That address is unverified, so this Lambda
// must never become a way to send someone else our mail with a stranger's
// words in it: every message names its recipient explicitly, the address has
// to pass a strict syntax check, and the visitor's copy carries none of the
// text the visitor supplied.
// No npm deps: uses the AWS SDK v3 bundled with the nodejs22.x runtime.
import {
  DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const ddb = new DynamoDBClient({});
const ses = new SESv2Client({});

const RATE_TABLE = process.env.RATE_TABLE;
const BOOK_TABLE = process.env.BOOK_TABLE;
const CONTACT = process.env.CONTACT_EMAIL;
const CONFIG_SET = process.env.CONFIG_SET;
const VISITOR_EMAIL = process.env.VISITOR_EMAIL === "true";
const IP_LIMIT = parseInt(process.env.DAILY_IP_LIMIT || "3", 10);
const GLOBAL_LIMIT = parseInt(process.env.DAILY_LIMIT || "10", 10);

const TZ = "America/Denver";
const OPEN_MIN = 9 * 60;    // 09:00 local
const CLOSE_MIN = 20 * 60;  // last slot starts 19:30
const STEP_MIN = 30;
const LEAD_MS = 24 * 3600e3;
const HORIZON_DAYS = 21;

// Strict on purpose: this address becomes an SMTP recipient and is written
// into raw headers. The local part is dot-separated RFC 5322 "atext" (none of
// those characters is a header delimiter), the domain is plain LDH labels.
// No quoting, comments, angle brackets, commas, whitespace, or non-ASCII.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
const EMAIL_RE = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@(?:${LABEL}\\.)+(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$`);
const validEmail = (s) => s.length <= 254 && s.indexOf("@") <= 64 && EMAIL_RE.test(s);

// Visitor text, made safe for where it lands. Control characters (CR, LF,
// tab, C1, the Unicode line separators) can never start a new line in a
// single-line field; free text keeps its line breaks, normalized to \n.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const oneLine = (v, max) =>
  (typeof v === "string" ? v : "").replace(CONTROLS, " ").replace(/ {2,}/g, " ").trim().slice(0, max);
const freeText = (v, max) =>
  (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/g, " ").trim().slice(0, max);

// For raw headers: printable ASCII only, minus the two characters that could
// close or escape a quoted display name.
const headerText = (s, max) => s.replace(/[^\x20-\x7e]/g, " ").replace(/["\\]/g, "").replace(/ {2,}/g, " ").trim().slice(0, max);

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
});
const offFmt = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" });
const whenFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, weekday: "short", month: "short", day: "numeric",
  year: "numeric", hour: "numeric", minute: "2-digit",
});

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

// "2026-08-04T15:00:00Z"-style keys: second precision, no millis.
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}/, "");

function denverDay(date) {
  const parts = Object.fromEntries(dayFmt.formatToParts(date).map((p) => [p.type, p.value]));
  const off = offFmt.formatToParts(date).find((p) => p.type === "timeZoneName").value; // "GMT-06:00"
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    offset: off.replace("GMT", "") || "+00:00",
  };
}

// Every slot currently offerable, as ISO-UTC strings. Probing each day at
// "now + n days" and deduping by local date keeps DST transitions honest
// (they happen on weekends; the offset is sampled on the day itself).
function openSlots(now) {
  const out = [];
  const seen = new Set();
  for (let d = 0; d <= HORIZON_DAYS; d++) {
    const { ymd, weekday, offset } = denverDay(new Date(now + d * 86400e3));
    if (seen.has(ymd) || weekday === "Sat" || weekday === "Sun") continue;
    seen.add(ymd);
    for (let m = OPEN_MIN; m < CLOSE_MIN; m += STEP_MIN) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      const t = Date.parse(`${ymd}T${hh}:${mm}:00${offset}`);
      if (t - now >= LEAD_MS) out.push(isoSec(t));
    }
  }
  return out;
}

async function bookedSlots(now) {
  const res = await ddb.send(new QueryCommand({
    TableName: BOOK_TABLE,
    KeyConditionExpression: "pk = :p AND sk >= :now",
    ExpressionAttributeValues: { ":p": { S: "booking" }, ":now": { S: isoSec(now) } },
    ProjectionExpression: "sk",
  }));
  return new Set((res.Items || []).map((i) => i.sk.S));
}

// Who is asking. Behind CloudFront, requestContext.http.sourceIp is one of
// CloudFront's own addresses: many visitors share one and one visitor arrives
// from many, so a cap keyed on it is neither fair nor a cap. The visitor is
// the second-from-last X-Forwarded-For entry: CloudFront appends the address
// it saw, then API Gateway appends CloudFront's. Everything before that was
// typed by the client and is ignored. The origin lock (fromEdge) is what makes
// that position trustworthy; without CloudFront in front, the caller writes
// the whole chain.
//
// Counters are keyed on a hash, so the rate table never holds an address, and
// an IPv6 visitor is counted by /64, the block one subscriber is handed,
// rather than by the single address they can change at will. (Same helper as
// contact.mjs; each Lambda ships as one file.)
function visitorOf(event) {
  const chain = String(event.headers?.["x-forwarded-for"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const seen = chain.length >= 2
    ? chain[chain.length - 2]
    : chain[0] ?? event.requestContext?.http?.sourceIp ?? "";
  // It is printed in the owner's mail, so it has to look like an address.
  const ip = /^[0-9A-Fa-f:.]{2,45}$/.test(seen) ? seen : "unknown";
  return { ip, key: createHash("sha256").update(network(ip)).digest("hex").slice(0, 16) };
}

// "2001:db8:1:2:aaaa:bbbb:cccc:dddd" and every other address in the same /64
// become "2001:db8:1:2::/64". IPv4, and anything unparseable, is returned as is.
function network(ip) {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// One conditional counter per key per UTC day, in the table the contact form
// shares; items expire via TTL. take() claims a unit if the key is still under
// its limit. giveBack() returns it when the request it was claimed for came to
// nothing.
const counterKey = (key, day) => ({ pk: { S: `${key}#${day}` } });

async function take(key, limit, day) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: RATE_TABLE,
      Key: counterKey(key, day),
      UpdateExpression: "ADD #n :one SET #t = if_not_exists(#t, :ttl)",
      ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
      ExpressionAttributeNames: { "#n": "n", "#t": "ttl" },
      ExpressionAttributeValues: {
        ":one": { N: "1" },
        ":limit": { N: String(limit) },
        ":ttl": { N: String(Math.floor(Date.now() / 1000) + 2 * 86400) },
      },
    }));
    return true;
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function giveBack(key, day) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: RATE_TABLE,
      Key: counterKey(key, day),
      UpdateExpression: "ADD #n :minus",
      ConditionExpression: "#n > :zero",
      ExpressionAttributeNames: { "#n": "n" },
      ExpressionAttributeValues: { ":minus": { N: "-1" }, ":zero": { N: "0" } },
    }));
  } catch (err) {
    // Best effort. The worst case is one unit of today's allowance lost.
    console.error("counter refund failed", key, err.name);
  }
}

// Undo a booking this request just made. The id check means it can only ever
// remove its own row, never one a later visitor was given for the same slot.
async function unbook(slot, bookingId) {
  try {
    await ddb.send(new DeleteItemCommand({
      TableName: BOOK_TABLE,
      Key: { pk: { S: "booking" }, sk: { S: slot } },
      ConditionExpression: "bookingId = :id",
      ExpressionAttributeValues: { ":id": { S: bookingId } },
    }));
    return true;
  } catch (err) {
    console.error("could not release slot; it stays blocked until removed by hand", slot, err.name);
    return false;
  }
}

const icsEscape = (s) => s.replace(/\\/g, "\\\\").replace(/[;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n");
const icsStamp = (iso) => iso.replace(/[-:]/g, "");

function buildIcs(slotIso, name, email, company, topic, now) {
  const end = isoSec(Date.parse(slotIso) + STEP_MIN * 60e3);
  const detail = [`Booked via planetek.org/schedule`, `Email: ${email}`,
    company && `Company: ${company}`, topic && `Topic: ${topic}`].filter(Boolean).join("\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Planetek//Booking Desk//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:consult-${icsStamp(slotIso)}@planetek.org`,
    `DTSTAMP:${icsStamp(isoSec(now))}`,
    `DTSTART:${icsStamp(slotIso)}`,
    `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsEscape(name ? `Planetek consultation with ${name}` : "Consultation with Planetek")}`,
    `DESCRIPTION:${icsEscape(detail)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

const b64 = (s) => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

// One text part plus the .ics attachment. Both bodies are base64, so nothing
// in them can be read as a header, a boundary, or an over-long SMTP line, and
// the boundary is random per message rather than a string a visitor could type.
function mimeMessage(headers, text, icsName, ics) {
  const boundary = `pk-${randomBytes(18).toString("hex")}`;
  return [
    ...headers,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64(text),
    `--${boundary}`,
    `Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="${icsName}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${icsName}"`,
    "",
    b64(ics),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

// The recipient is always passed to SES explicitly. Left out, SES would take
// recipients from the raw To/Cc/Bcc headers, and anything that reached those
// headers could add addresses.
const sendRaw = (to, raw) => ses.send(new SendEmailCommand({
  ConfigurationSetName: CONFIG_SET,
  Destination: { ToAddresses: [to] },
  Content: { Raw: { Data: Buffer.from(raw) } },
}));

async function mailInvite(slotIso, name, email, company, topic, ip, now) {
  // Headers stay ASCII-safe; the full name still travels in the body and ICS.
  const asciiName = headerText(name, 60);
  const when = whenFmt.format(new Date(slotIso));
  const body = [
    `Consultation booked from the website.`,
    ``,
    `When:    ${when} Mountain`,
    `Name:    ${name}`,
    `Email:   ${email}`,
    ...(company ? [`Company: ${company}`] : []),
    ...(topic ? [`Topic:   ${topic}`] : []),
    `IP:      ${ip}`,
    ``,
    `The attached invite adds it to the calendar in one click.`,
  ].join("\r\n");

  const raw = mimeMessage([
    `From: Planetek Booking Desk <${CONTACT}>`,
    `To: ${CONTACT}`,
    `Reply-To: ${asciiName ? `"${asciiName}" <${email}>` : email}`,
    `Subject: Consultation booked: ${asciiName || "visitor"}, ${headerText(when, 60)} MT`,
  ], body, "consultation.ics", buildIcs(slotIso, name, email, company, topic, now));

  await sendRaw(CONTACT, raw);
}

// Confirmation to the visitor's own address. Only possible once the SES
// account has production access (the sandbox can only mail verified
// identities), so it sits behind VISITOR_EMAIL and any failure is the
// caller's to swallow: the booking and the owner invite must stand even
// when the visitor's address is dead.
//
// Nobody has proved they own this address, so the message is fixed text plus
// the slot: no name, company, or topic. Whatever a stranger types into the
// form, the only thing they can cause is this exact note reaching the one
// address they entered.
async function mailVisitor(slotIso, email, now) {
  const when = whenFmt.format(new Date(slotIso));
  const body = [
    `Hello,`,
    ``,
    `Your free 30-minute consultation with Planetek is booked for ${when} Mountain time.`,
    `The attached invite adds it to your calendar.`,
    ``,
    `We'll reply from this address before the call to confirm and share a meeting link.`,
    `If the time stops working, or you didn't book this, just reply and we'll fix it.`,
    ``,
    `Planetek LLC`,
    `https://planetek.org · info@planetek.org · 303-356-2782`,
    ``,
    `You're receiving this one-time confirmation because a consultation was booked`,
    `at planetek.org/schedule with this address.`,
  ].join("\r\n");

  const raw = mimeMessage([
    `From: Planetek <${CONTACT}>`,
    `To: ${email}`,
    `Reply-To: Planetek <${CONTACT}>`,
    `Subject: Booked: your Planetek consultation, ${headerText(when, 60)} MT`,
  ], body, "planetek-consultation.ics", buildIcs(slotIso, "", email, "", "", now));

  await sendRaw(email, raw);
}

// The origin lock. CloudFront adds a secret x-origin-verify header to every
// request it forwards here (infra/cloudfront.tf). A request without it
// reached the execute-api hostname directly: around the WAF, and with an
// X-Forwarded-For chain the caller wrote themselves. Fails closed, so a
// function deployed without the secret trusts nothing.
function fromEdge(event) {
  const want = Buffer.from(process.env.ORIGIN_VERIFY ?? "");
  const got = Buffer.from(event.headers?.["x-origin-verify"] ?? "");
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

export const handler = async (event) => {
  if (!fromEdge(event)) return json(403, { error: "Forbidden." });
  const now = Date.now();
  const route = event.routeKey || "";

  if (route === "GET /api/schedule/slots") {
    const booked = await bookedSlots(now);
    return json(200, {
      timezone: TZ,
      slotMinutes: STEP_MIN,
      slots: openSlots(now).filter((s) => !booked.has(s)),
    });
  }

  let form;
  try {
    form = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  if (!form || typeof form !== "object" || Array.isArray(form)) {
    return json(400, { error: "Invalid request body." });
  }

  // Honeypot: same trick as the contact form; bots learn nothing.
  if (form.website) return json(200, { ok: true });

  const name = oneLine(form.name, 100);
  const email = typeof form.email === "string" ? form.email.trim() : "";
  const company = oneLine(form.company, 200);
  const topic = freeText(form.topic, 1000);
  const slot = typeof form.slot === "string" ? form.slot.trim() : "";

  if (!name || !validEmail(email)) {
    return json(400, { error: "Please provide your name and a valid email." });
  }
  if (!openSlots(now).includes(slot)) {
    return json(400, { error: "That time is not available. Please pick another slot." });
  }

  // Claim today's allowance: the visitor's, then the desk's. Whatever is
  // claimed is handed back if the request ends without a booking, so the caps
  // count bookings and not attempts. (Counted the other way, ten requests for a
  // slot that is already gone would close the desk for the day.)
  const who = visitorOf(event);
  const day = new Date(now).toISOString().slice(0, 10);
  const mine = `sched-visitor#${who.key}`;
  const tooMany = () => json(429, { error: "Too many bookings today — please email us directly instead." });

  if (!(await take(mine, IP_LIMIT, day))) return tooMany();
  if (!(await take("sched-global", GLOBAL_LIMIT, day))) {
    await giveBack(mine, day);
    return tooMany();
  }
  const handBack = () => Promise.all([giveBack(mine, day), giveBack("sched-global", day)]);

  const bookingId = randomBytes(12).toString("hex");
  try {
    await ddb.send(new PutItemCommand({
      TableName: BOOK_TABLE,
      Item: {
        pk: { S: "booking" },
        sk: { S: slot },
        bookingId: { S: bookingId },
        name: { S: name },
        email: { S: email },
        ...(company && { company: { S: company } }),
        ...(topic && { topic: { S: topic } }),
        // The hashed visitor key, not an address: the owner's invite carries
        // the address, and that is the only place it is kept.
        visitor: { S: who.key },
        // Bookings self-clean a week after the meeting.
        ttl: { N: String(Math.floor(Date.parse(slot) / 1000) + 7 * 86400) },
      },
      ConditionExpression: "attribute_not_exists(sk)",
    }));
  } catch (err) {
    await handBack();
    if (err.name === "ConditionalCheckFailedException") {
      return json(409, { error: "Someone just took that time. Please pick another slot." });
    }
    throw err;
  }

  // The owner has to hear about it, or it is not a booking. If the invite
  // cannot be sent, release the slot and say so, rather than leave a time
  // blocked that nobody knows was taken.
  try {
    await mailInvite(slot, name, email, company, topic, who.ip, now);
  } catch (err) {
    console.error("owner invite failed; releasing the slot", slot, err.name, err.message);
    await unbook(slot, bookingId);
    await handBack();
    return json(503, { error: "We couldn't confirm that booking just now. Please try again in a minute." });
  }

  let confirmationEmailed = false;
  if (VISITOR_EMAIL) {
    try {
      await mailVisitor(slot, email, now);
      confirmationEmailed = true;
    } catch (err) {
      // Suppressed, invalid, or sandbox-blocked address: the booking stands,
      // the visitor still has the on-page confirmation and .ics download.
      console.error("visitor confirmation failed", err.name, err.message);
    }
  }

  return json(200, {
    ok: true,
    when: `${whenFmt.format(new Date(slot))} Mountain`,
    confirmationEmailed,
    ics: buildIcs(slot, name, email, company, topic, now),
  });
};
