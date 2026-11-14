// POST /api/contact — validates, rate-limits, and relays the form to SES.
// Daily caps count messages relayed, per visitor and for the form as a whole.
// A request that ends without a message sent hands its allowance back.
// No npm deps: uses the AWS SDK v3 bundled with the nodejs22.x runtime.
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { createHash, timingSafeEqual } from "node:crypto";

const ddb = new DynamoDBClient({});
const ses = new SESv2Client({});

const TABLE = process.env.TABLE_NAME;
const CONTACT = process.env.CONTACT_EMAIL;
const IP_LIMIT = parseInt(process.env.DAILY_IP_LIMIT || "10", 10);
const GLOBAL_LIMIT = parseInt(process.env.DAILY_LIMIT || "100", 10);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

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
// schedule.mjs; each Lambda ships as one file.)
function visitorOf(event) {
  const chain = String(event.headers?.["x-forwarded-for"] ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const seen = chain.length >= 2
    ? chain[chain.length - 2]
    : chain[0] ?? event.requestContext?.http?.sourceIp ?? "";
  // It is printed in the mail, so it has to look like an address.
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

// One conditional counter per key per UTC day; items expire via TTL. take()
// claims a unit if the key is still under its limit. giveBack() returns it
// when the request it was claimed for came to nothing.
const counterKey = (key, day) => ({ pk: { S: `${key}#${day}` } });

async function take(key, limit, day) {
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
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
      TableName: TABLE,
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
  let form;
  try {
    form = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { error: "Invalid request body." });
  }

  // Honeypot: real visitors never fill the hidden "website" field. Answer
  // success so bots don't learn anything.
  if (form.website) return json(200, { ok: true });

  const name = (form.name || "").trim().slice(0, 200);
  const email = (form.email || "").trim().slice(0, 200);
  const company = (form.company || "").trim().slice(0, 200);
  const phone = (form.phone || "").trim().slice(0, 50);
  const service = (form.service || "").trim().slice(0, 100);
  const message = (form.message || "").trim().slice(0, 5000);

  if (!name || !EMAIL_RE.test(email) || message.length < 10) {
    return json(400, { error: "Please provide your name, a valid email, and a message." });
  }

  // Claim today's allowance: the visitor's, then the form's. Whatever is
  // claimed is handed back if no message ends up sent.
  const who = visitorOf(event);
  const day = new Date().toISOString().slice(0, 10);
  const mine = `visitor#${who.key}`;
  const tooMany = () => json(429, { error: "Too many submissions today — please email us directly instead." });

  if (!(await take(mine, IP_LIMIT, day))) return tooMany();
  if (!(await take("global", GLOBAL_LIMIT, day))) {
    await giveBack(mine, day);
    return tooMany();
  }

  const lines = [
    `Name:    ${name}`,
    `Email:   ${email}`,
    company && `Company: ${company}`,
    phone && `Phone:   ${phone}`,
    service && `Service: ${service}`,
    `IP:      ${who.ip}`,
    "",
    message,
  ].filter(Boolean);

  try {
    await ses.send(new SendEmailCommand({
      ConfigurationSetName: process.env.CONFIG_SET,
      FromEmailAddress: `Planetek Website <${CONTACT}>`,
      Destination: { ToAddresses: [CONTACT] },
      ReplyToAddresses: EMAIL_RE.test(email) ? [email] : [],
      Content: {
        Simple: {
          Subject: { Data: `Website inquiry — ${service || "General"} — ${name}` },
          Body: { Text: { Data: lines.join("\n") } },
        },
      },
    }));
  } catch (err) {
    // Nothing was sent, so nothing counts against today, and the visitor is
    // told plainly instead of being left with a bare 500.
    console.error("contact relay failed", err.name, err.message);
    await Promise.all([giveBack(mine, day), giveBack("global", day)]);
    return json(503, { error: "We couldn't send that just now. Please try again in a minute." });
  }

  return json(200, { ok: true });
};
