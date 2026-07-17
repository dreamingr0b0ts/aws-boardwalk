// POST /api/contact — validates, rate-limits, and relays the form to SES.
// No npm deps: uses the AWS SDK v3 bundled with the nodejs22.x runtime.
import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

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

// One conditional counter per key per UTC day; items expire via TTL.
async function underLimit(key, limit) {
  const day = new Date().toISOString().slice(0, 10);
  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
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

export const handler = async (event) => {
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

  const ip = event.requestContext?.http?.sourceIp || "unknown";
  if (!(await underLimit(`ip#${ip}`, IP_LIMIT)) || !(await underLimit("global", GLOBAL_LIMIT))) {
    return json(429, { error: "Too many submissions today — please email us directly instead." });
  }

  const lines = [
    `Name:    ${name}`,
    `Email:   ${email}`,
    company && `Company: ${company}`,
    phone && `Phone:   ${phone}`,
    service && `Service: ${service}`,
    `IP:      ${ip}`,
    "",
    message,
  ].filter(Boolean);

  await ses.send(new SendEmailCommand({
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

  return json(200, { ok: true });
};
