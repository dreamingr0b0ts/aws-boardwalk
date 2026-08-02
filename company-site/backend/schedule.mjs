// The booking desk: GET /api/schedule/slots and POST /api/schedule/book.
// Availability is computed, never stored: weekdays 09:00-20:00 America/Denver
// in 30-minute slots, at least 24 hours out, up to three weeks ahead. A
// booking is one conditional DynamoDB write (double-booking is impossible by
// construction), then the invite lands at info@ as an .ics attachment. The
// SES account stays in the sandbox on purpose, so mail only flows info@ →
// info@ and the visitor gets their confirmation on the page instead.
// No npm deps: uses the AWS SDK v3 bundled with the nodejs22.x runtime.
import { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

// Same conditional day-counter as the contact form, in the shared table.
async function underLimit(key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: RATE_TABLE,
      Key: { pk: { S: `${key}#${day}` } },
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
    `SUMMARY:${icsEscape(`Planetek consultation with ${name}`)}`,
    `DESCRIPTION:${icsEscape(detail)}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

async function mailInvite(slotIso, name, email, company, topic, ip, now) {
  // Headers stay ASCII-safe; the full name still travels in the body and ICS.
  const asciiName = name.replace(/[^\x20-\x7e]/g, "").trim() || "visitor";
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

  const raw = [
    `From: Planetek Booking Desk <${CONTACT}>`,
    `To: ${CONTACT}`,
    `Reply-To: ${asciiName} <${email}>`,
    `Subject: Consultation booked: ${asciiName}, ${when} MT`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="pk-invite"`,
    ``,
    `--pk-invite`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
    `--pk-invite`,
    `Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="consultation.ics"`,
    `Content-Disposition: attachment; filename="consultation.ics"`,
    ``,
    buildIcs(slotIso, name, email, company, topic, now),
    `--pk-invite--`,
    ``,
  ].join("\r\n");

  await ses.send(new SendEmailCommand({
    ConfigurationSetName: CONFIG_SET,
    Content: { Raw: { Data: Buffer.from(raw) } },
  }));
}

// Confirmation to the visitor's own address. Only possible once the SES
// account has production access (the sandbox can only mail verified
// identities), so it sits behind VISITOR_EMAIL and any failure is the
// caller's to swallow: the booking and the owner invite must stand even
// when the visitor's address is dead.
async function mailVisitor(slotIso, name, email, now) {
  const asciiName = name.replace(/[^\x20-\x7e]/g, "").trim() || "there";
  const when = whenFmt.format(new Date(slotIso));
  const body = [
    `Hi ${name},`,
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

  const raw = [
    `From: Planetek <${CONTACT}>`,
    `To: ${asciiName} <${email}>`,
    `Reply-To: Planetek <${CONTACT}>`,
    `Subject: Booked: your Planetek consultation, ${when} MT`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="pk-confirm"`,
    ``,
    `--pk-confirm`,
    `Content-Type: text/plain; charset=UTF-8`,
    ``,
    body,
    `--pk-confirm`,
    `Content-Type: text/calendar; charset=UTF-8; method=PUBLISH; name="planetek-consultation.ics"`,
    `Content-Disposition: attachment; filename="planetek-consultation.ics"`,
    ``,
    buildIcs(slotIso, name, email, "", "", now),
    `--pk-confirm--`,
    ``,
  ].join("\r\n");

  await ses.send(new SendEmailCommand({
    ConfigurationSetName: CONFIG_SET,
    Content: { Raw: { Data: Buffer.from(raw) } },
  }));
}

export const handler = async (event) => {
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

  // Honeypot: same trick as the contact form; bots learn nothing.
  if (form.website) return json(200, { ok: true });

  const name = (form.name || "").trim().slice(0, 200);
  const email = (form.email || "").trim().slice(0, 200);
  const company = (form.company || "").trim().slice(0, 200);
  const topic = (form.topic || "").trim().slice(0, 1000);
  const slot = (form.slot || "").trim();

  if (!name || !EMAIL_RE.test(email)) {
    return json(400, { error: "Please provide your name and a valid email." });
  }
  if (!openSlots(now).includes(slot)) {
    return json(400, { error: "That time is not available. Please pick another slot." });
  }

  const ip = event.requestContext?.http?.sourceIp || "unknown";
  if (!(await underLimit(`sched-ip#${ip}`, IP_LIMIT)) || !(await underLimit("sched-global", GLOBAL_LIMIT))) {
    return json(429, { error: "Too many bookings today — please email us directly instead." });
  }

  try {
    await ddb.send(new PutItemCommand({
      TableName: BOOK_TABLE,
      Item: {
        pk: { S: "booking" },
        sk: { S: slot },
        name: { S: name },
        email: { S: email },
        ...(company && { company: { S: company } }),
        ...(topic && { topic: { S: topic } }),
        ip: { S: ip },
        // Bookings self-clean a week after the meeting.
        ttl: { N: String(Math.floor(Date.parse(slot) / 1000) + 7 * 86400) },
      },
      ConditionExpression: "attribute_not_exists(sk)",
    }));
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(409, { error: "Someone just took that time. Please pick another slot." });
    }
    throw err;
  }

  await mailInvite(slot, name, email, company, topic, ip, now);

  let confirmationEmailed = false;
  if (VISITOR_EMAIL) {
    try {
      await mailVisitor(slot, name, email, now);
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
