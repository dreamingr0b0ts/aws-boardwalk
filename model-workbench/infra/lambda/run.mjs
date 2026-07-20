// The comparison engine: one prompt → up to four foundation models through
// the single Bedrock Converse API, in parallel, returning each model's answer
// with measured latency, token usage, and computed cost. Every run lands in
// the DynamoDB ledger — the audit-trail half of "responsible AI": who ran
// what, against which models, with which parameters, at what cost.
//
// The gate order is deliberate: cheap validation first, then the DynamoDB
// counters, and only if both caps admit the run do we touch Bedrock. Even a
// leaked credential is bounded to GLOBAL_DAILY_LIMIT runs/day.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { SCENARIOS } from "./scenarios.mjs";

const TABLE = process.env.TABLE_NAME;
const MODELS = JSON.parse(process.env.MODELS);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 30);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 120);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 500);
const MAX_PROMPT_CHARS = 2000;

const bedrock = new BedrockRuntimeClient({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const json = (statusCode, body) => ({
  statusCode,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: JSON.stringify(body),
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const claims = (event) => {
  const c = event.requestContext?.authorizer?.jwt?.claims ?? {};
  if (!c.sub) throw new HttpError(401, "Unauthorized");
  return { sub: c.sub, email: c.email ?? "" };
};

// ---- counters --------------------------------------------------------------

async function bumpCounter(date, sk, limit) {
  const res = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `USAGE#${date}`, SK: sk },
      UpdateExpression: "ADD #n :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ConditionExpression: "attribute_not_exists(#n) OR #n < :limit",
      ExpressionAttributeNames: { "#n": "count", "#ttl": "ttl" },
      ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": Math.floor(Date.now() / 1000) + 2 * 86400 },
      ReturnValues: "UPDATED_NEW",
    })
  );
  return Number(res.Attributes?.count ?? 0);
}

async function readCounter(date, sk) {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `USAGE#${date}`, SK: sk } }));
  return Number(res.Item?.count ?? 0);
}

// ---- model invocation ------------------------------------------------------

const round6 = (n) => Math.round(n * 1e6) / 1e6;

async function invokeModel(model, system, prompt, inferenceConfig) {
  const started = Date.now();
  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: model.id,
        ...(system ? { system: [{ text: system }] } : {}),
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig,
      })
    );
    const text = (res.output?.message?.content ?? [])
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    const usage = res.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    return {
      key: model.key,
      label: model.label,
      vendor: model.vendor,
      ok: true,
      text,
      stopReason: res.stopReason ?? null,
      latencyMs: Date.now() - started,
      usage: { inputTokens, outputTokens },
      costUsd: round6((inputTokens * model.inPerM + outputTokens * model.outPerM) / 1e6),
    };
  } catch (err) {
    console.error("invoke failed", model.key, err);
    return {
      key: model.key,
      label: model.label,
      vendor: model.vendor,
      ok: false,
      error: String(err.name ?? "InvokeError"),
      latencyMs: Date.now() - started,
    };
  }
}

// ---- routes ----------------------------------------------------------------

async function postRun(event) {
  const who = claims(event);
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }

  // resolve prompt: a scenario from the library, or a bounded custom prompt
  let system = null;
  let prompt;
  let scenarioId = null;
  if (body.scenarioId) {
    const s = SCENARIOS.find((x) => x.id === body.scenarioId);
    if (!s) throw new HttpError(400, `Unknown scenario: ${body.scenarioId}`);
    scenarioId = s.id;
    system = s.system;
    prompt = s.prompt;
  } else {
    if (typeof body.prompt !== "string" || !body.prompt.trim()) throw new HttpError(400, "Provide scenarioId or prompt");
    if (body.prompt.length > MAX_PROMPT_CHARS) throw new HttpError(400, `Prompt too long (max ${MAX_PROMPT_CHARS} chars)`);
    prompt = body.prompt.trim();
  }

  const keys = Array.isArray(body.models) && body.models.length ? body.models : MODELS.map((m) => m.key);
  const selected = keys.map((k) => {
    const m = MODELS.find((x) => x.key === k);
    if (!m) throw new HttpError(400, `Unknown model: ${k}`);
    return m;
  });
  if (selected.length > MODELS.length) throw new HttpError(400, "Too many models");

  const temperature = body.temperature === undefined ? 0.2 : Number(body.temperature);
  if (!(temperature >= 0 && temperature <= 1)) throw new HttpError(400, "temperature must be 0–1");
  const maxTokens = body.maxTokens === undefined ? 300 : Number(body.maxTokens);
  if (!(maxTokens >= 50 && maxTokens <= MAX_OUTPUT_TOKENS))
    throw new HttpError(400, `maxTokens must be 50–${MAX_OUTPUT_TOKENS}`);

  // ---- cost guardrails: per-user cap, then global kill switch ----
  const today = new Date().toISOString().slice(0, 10);
  let userCount;
  try {
    userCount = await bumpCounter(today, `USER#${who.sub}`, USER_DAILY_LIMIT);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException)
      throw new HttpError(429, `Daily demo limit reached (${USER_DAILY_LIMIT} runs). Resets at 00:00 UTC.`);
    throw err;
  }
  let globalCount;
  try {
    globalCount = await bumpCounter(today, "GLOBAL", GLOBAL_DAILY_LIMIT);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException)
      throw new HttpError(429, "The demo has reached its global daily budget. Try again after 00:00 UTC.");
    throw err;
  }

  // ---- the fan-out: same prompt, same parameters, every selected model ----
  const inferenceConfig = { maxTokens, temperature };
  const results = await Promise.all(selected.map((m) => invokeModel(m, system, prompt, inferenceConfig)));

  const runId = randomUUID();
  const now = new Date().toISOString();

  // The audit ledger: parameters + per-model outcome (not the full response
  // text — the ledger is about accountability, not transcript storage).
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `RUN#${today}`,
        SK: `${now}#${runId}`,
        runId,
        email: who.email,
        scenarioId: scenarioId ?? "custom",
        promptChars: prompt.length,
        promptPreview: prompt.slice(0, 90),
        temperature,
        maxTokens,
        results: results.map((r) => ({
          key: r.key,
          ok: r.ok,
          latencyMs: r.latencyMs,
          inputTokens: r.usage?.inputTokens ?? 0,
          outputTokens: r.usage?.outputTokens ?? 0,
          costUsd: r.costUsd ?? 0,
          stopReason: r.stopReason ?? r.error ?? null,
        })),
        totalCostUsd: round6(results.reduce((a, r) => a + (r.costUsd ?? 0), 0)),
        ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    })
  );

  return json(200, {
    runId,
    scenarioId: scenarioId ?? "custom",
    params: { temperature, maxTokens },
    results,
    totalCostUsd: round6(results.reduce((a, r) => a + (r.costUsd ?? 0), 0)),
    quota: { userUsed: userCount, userLimit: USER_DAILY_LIMIT, globalUsed: globalCount, globalLimit: GLOBAL_DAILY_LIMIT },
  });
}

async function getRuns(event) {
  claims(event);
  const today = new Date().toISOString().slice(0, 10);
  const res = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": `RUN#${today}` },
      ScanIndexForward: false,
      Limit: 15,
    })
  );
  return json(200, {
    runs: (res.Items ?? []).map((it) => ({
      runId: it.runId,
      at: it.SK.slice(0, 24),
      scenarioId: it.scenarioId,
      promptPreview: it.promptPreview,
      temperature: it.temperature,
      maxTokens: it.maxTokens,
      results: it.results,
      totalCostUsd: it.totalCostUsd,
    })),
  });
}

async function getQuota(event) {
  const who = claims(event);
  const today = new Date().toISOString().slice(0, 10);
  const [userUsed, globalUsed] = await Promise.all([readCounter(today, `USER#${who.sub}`), readCounter(today, "GLOBAL")]);
  return json(200, { userUsed, userLimit: USER_DAILY_LIMIT, globalUsed, globalLimit: GLOBAL_DAILY_LIMIT });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  try {
    if (method === "POST" && path === "/api/run") return await postRun(event);
    if (method === "GET" && path === "/api/runs") return await getRuns(event);
    if (method === "GET" && path === "/api/me/quota") return await getQuota(event);
    return json(404, { message: "Not found" });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { message: err.message });
    console.error("unhandled", err);
    return json(500, { message: "Internal error" });
  }
};
