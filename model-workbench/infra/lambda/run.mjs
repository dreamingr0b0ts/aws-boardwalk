// The comparison engine: one prompt → up to four foundation models through
// the single Bedrock Converse API, in parallel, returning each model's answer
// with measured latency, token usage, and computed cost. Every run lands in
// the DynamoDB ledger — the audit-trail half of "responsible AI": who ran
// what, against which models, with which parameters, at what cost.
//
// The gate order is deliberate: cheap validation first, then the DynamoDB
// counters, and only if both caps admit the run do we touch Bedrock. Even a
// leaked credential is bounded to GLOBAL_DAILY_LIMIT runs/day.
//
// Two tiers share this handler. Signed-in users get custom prompts and the
// full ceilings. Visitors (the /api/public/* routes, no JWT) get a taste:
// scenario-library prompts only, a lower token ceiling, 5 runs per visitor
// per day, all drawn from a small anonymous pool that ALSO counts against
// the global kill switch — opening the door does not raise the spend ceiling.
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient, ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { SCENARIOS } from "./scenarios.mjs";

const TABLE = process.env.TABLE_NAME;
const MODELS = JSON.parse(process.env.MODELS);
const USER_DAILY_LIMIT = Number(process.env.USER_DAILY_LIMIT ?? 30);
const GLOBAL_DAILY_LIMIT = Number(process.env.GLOBAL_DAILY_LIMIT ?? 120);
const MAX_OUTPUT_TOKENS = Number(process.env.MAX_OUTPUT_TOKENS ?? 500);
const ANON_DAILY_LIMIT = Number(process.env.ANON_DAILY_LIMIT ?? 5);
const ANON_GLOBAL_DAILY_LIMIT = Number(process.env.ANON_GLOBAL_DAILY_LIMIT ?? 40);
const ANON_MAX_OUTPUT_TOKENS = Number(process.env.ANON_MAX_OUTPUT_TOKENS ?? 300);
const MAX_PROMPT_CHARS = 2000;
const GUARDRAIL_ID = process.env.GUARDRAIL_ID ?? "";
const GUARDRAIL_VERSION = process.env.GUARDRAIL_VERSION ?? "";
const JUDGE_MODEL_KEY = process.env.JUDGE_MODEL_KEY ?? "nova-lite";
const JUDGE_MAX_TOKENS = 400;

// Fallback rubric for custom prompts; scenarios carry their own.
const GENERIC_RUBRIC =
  "How well does the answer do what the prompt asked? Reward faithfulness to the instructions and constraints, factual care, clarity, and appropriate length. Penalize invented facts, ignored instructions, and padding.";

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

// Visitor identity: the viewer IP, reduced to a truncated hash so the ledger
// counts visitors without storing addresses. CloudFront appends the true
// viewer IP to X-Forwarded-For and API Gateway appends CloudFront's own, so
// the trustworthy entry is second-from-last — a client-supplied header only
// pushes the real entries further right.
const visitor = (event) => {
  const xff = (event.headers?.["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const ip = xff.length >= 2 ? xff[xff.length - 2] : xff[0] ?? event.requestContext?.http?.sourceIp ?? "unknown";
  return { sub: createHash("sha256").update(ip).digest("hex").slice(0, 16) };
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

// With a guardrail attached (trace enabled), summarize what it did so the
// card can say "4 identifiers masked" instead of making the visitor diff text.
function guardrailSummary(res) {
  if (!res?.trace?.guardrail) return null;
  const t = JSON.stringify(res.trace.guardrail);
  const masked = (t.match(/"action":"ANONYMIZED"/g) ?? []).length;
  const intervened = res.stopReason === "guardrail_intervened" || t.includes('"action":"BLOCKED"');
  return { applied: true, masked, intervened };
}

async function invokeModel(model, system, prompt, inferenceConfig, guardrailConfig) {
  const started = Date.now();
  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: model.id,
        ...(system ? { system: [{ text: system }] } : {}),
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig,
        ...(guardrailConfig ? { guardrailConfig } : {}),
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
      guardrail: guardrailSummary(res),
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

// ---- the judge pass ---------------------------------------------------------
// One extra call to the cheapest roster model AFTER the fan-out: it scores
// every answer against the scenario's rubric without knowing which model
// wrote which (answers are shuffled and labeled A-D). Blind, criteria-based,
// and itself audited: the judge's tokens and cost land in the ledger too.

async function judgeResults(rubric, taskText, results) {
  const judgeModel = MODELS.find((m) => m.key === JUDGE_MODEL_KEY);
  const answered = results.filter((r) => r.ok && r.text);
  if (!judgeModel || answered.length < 2) return null;

  const shuffled = [...answered].sort(() => Math.random() - 0.5);
  const label = (i) => String.fromCharCode(65 + i);
  const labels = shuffled.map((_, i) => label(i));
  // Small judge models will happily score just the first answer unless the
  // output contract is spelled out entry by entry — so spell it out.
  const skeleton = `{"scores":[${labels.map((l) => `{"label":"${l}","score":<integer 1-10>,"note":"<under 12 words>"}`).join(",")}]}`;
  const started = Date.now();
  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: judgeModel.id,
        system: [
          {
            text:
              `You are a strict, fair evaluator scoring ${shuffled.length} anonymous answers (${labels.join(", ")}) against a rubric. You do not know which AI wrote which answer. Respond with ONLY this JSON object, no code fences, exactly one entry per answer: ${skeleton}`,
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              {
                text:
                  `Rubric:\n${rubric}\n\nTask the answers respond to:\n${taskText.slice(0, 4000)}\n\n` +
                  shuffled.map((r, i) => `Answer ${label(i)}:\n${r.text}`).join("\n\n") +
                  `\n\nScore all ${shuffled.length} answers: ${labels.join(", ")}.`,
              },
            ],
          },
        ],
        inferenceConfig: { maxTokens: JUDGE_MAX_TOKENS, temperature: 0 },
      })
    );
    const raw = (res.output?.message?.content ?? []).map((b) => b.text ?? "").join("");
    const parsed = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1));
    const seen = new Set();
    const scores = (parsed.scores ?? [])
      .map((s) => {
        const idx = String(s.label ?? "").trim().toUpperCase().charCodeAt(0) - 65;
        const r = shuffled[idx];
        if (!r || seen.has(r.key)) return null;
        seen.add(r.key);
        return {
          key: r.key,
          score: Math.max(1, Math.min(10, Math.round(Number(s.score) || 0))),
          note: String(s.note ?? "").slice(0, 120),
        };
      })
      .filter(Boolean);
    if (scores.length !== shuffled.length) throw new Error(`judge scored ${scores.length}/${shuffled.length}`);
    const usage = res.usage ?? {};
    const inputTokens = usage.inputTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    return {
      ok: true,
      model: judgeModel.key,
      scores,
      latencyMs: Date.now() - started,
      usage: { inputTokens, outputTokens },
      costUsd: round6((inputTokens * judgeModel.inPerM + outputTokens * judgeModel.outPerM) / 1e6),
    };
  } catch (err) {
    console.error("judge failed", err);
    return { ok: false, model: judgeModel.key, error: String(err.name ?? "JudgeError"), latencyMs: Date.now() - started };
  }
}

// ---- routes ----------------------------------------------------------------

async function postRun(event, anon) {
  const who = anon ? visitor(event) : claims(event);
  let body;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }

  // resolve prompt: a scenario from the library, or a bounded custom prompt.
  // Visitors are scenario-only: nothing a stranger types ever reaches a model.
  let system = null;
  let prompt;
  let scenarioId = null;
  let rubric = GENERIC_RUBRIC;
  if (body.scenarioId) {
    const s = SCENARIOS.find((x) => x.id === body.scenarioId);
    if (!s) throw new HttpError(400, `Unknown scenario: ${body.scenarioId}`);
    scenarioId = s.id;
    system = s.system;
    prompt = s.prompt;
    rubric = s.rubric ?? GENERIC_RUBRIC;
  } else if (anon) {
    throw new HttpError(403, "Custom prompts require sign-in. Pick a scenario from the library, or sign in.");
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

  const tokenCeiling = anon ? ANON_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS;
  const temperature = body.temperature === undefined ? 0.2 : Number(body.temperature);
  if (!(temperature >= 0 && temperature <= 1)) throw new HttpError(400, "temperature must be 0–1");
  const maxTokens = body.maxTokens === undefined ? Math.min(300, tokenCeiling) : Number(body.maxTokens);
  if (!(maxTokens >= 50 && maxTokens <= tokenCeiling))
    throw new HttpError(400, `maxTokens must be 50–${tokenCeiling}`);

  const useGuardrail = Boolean(body.guardrail);
  const guardrailConfig =
    useGuardrail && GUARDRAIL_ID && GUARDRAIL_VERSION
      ? { guardrailIdentifier: GUARDRAIL_ID, guardrailVersion: GUARDRAIL_VERSION, trace: "enabled" }
      : undefined;
  if (useGuardrail && !guardrailConfig) throw new HttpError(503, "The guardrail is not configured on this deployment");

  // ---- cost guardrails: per-caller cap, then the global kill switch. A
  // visitor run must clear THREE counters (per-visitor, anonymous pool,
  // global) so the free tier can exhaust itself without touching the
  // signed-in ceiling, and total worst-case spend never moves. ----
  const today = new Date().toISOString().slice(0, 10);
  const userLimit = anon ? ANON_DAILY_LIMIT : USER_DAILY_LIMIT;
  let userCount;
  try {
    userCount = await bumpCounter(today, anon ? `ANON#${who.sub}` : `USER#${who.sub}`, userLimit);
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException)
      throw new HttpError(
        429,
        anon
          ? `Free visitor limit reached (${ANON_DAILY_LIMIT} runs/day). Sign in for ${USER_DAILY_LIMIT}/day, or come back after 00:00 UTC.`
          : `Daily demo limit reached (${USER_DAILY_LIMIT} runs). Resets at 00:00 UTC.`
      );
    throw err;
  }
  if (anon) {
    try {
      await bumpCounter(today, "ANON-GLOBAL", ANON_GLOBAL_DAILY_LIMIT);
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException)
        throw new HttpError(429, "Today's free visitor pool is used up. Sign in, or try again after 00:00 UTC.");
      throw err;
    }
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
  const results = await Promise.all(selected.map((m) => invokeModel(m, system, prompt, inferenceConfig, guardrailConfig)));

  // ---- the judge pass: blind, rubric-based, only when there is a comparison
  const judge = await judgeResults(rubric, (system ? system + "\n\n" : "") + prompt, results);

  const runId = randomUUID();
  const now = new Date().toISOString();

  // Whole-run cost includes the judge call: the evaluation is itself metered.
  const totalCostUsd = round6(results.reduce((a, r) => a + (r.costUsd ?? 0), 0) + (judge?.ok ? judge.costUsd : 0));

  // The audit ledger: parameters + per-model outcome (not the full response
  // text — the ledger is about accountability, not transcript storage).
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `RUN#${today}`,
        SK: `${now}#${runId}`,
        runId,
        email: anon ? `visitor:${who.sub.slice(0, 8)}` : who.email,
        scenarioId: scenarioId ?? "custom",
        promptChars: prompt.length,
        promptPreview: prompt.slice(0, 90),
        temperature,
        maxTokens,
        guardrail: useGuardrail,
        results: results.map((r) => ({
          key: r.key,
          ok: r.ok,
          latencyMs: r.latencyMs,
          inputTokens: r.usage?.inputTokens ?? 0,
          outputTokens: r.usage?.outputTokens ?? 0,
          costUsd: r.costUsd ?? 0,
          stopReason: r.stopReason ?? r.error ?? null,
          ...(useGuardrail ? { guardrailMasked: r.guardrail?.masked ?? 0, guardrailIntervened: r.guardrail?.intervened ?? false } : {}),
        })),
        ...(judge?.ok
          ? { judge: { model: judge.model, scores: judge.scores.map(({ key, score }) => ({ key, score })), costUsd: judge.costUsd } }
          : {}),
        totalCostUsd,
        ttl: Math.floor(Date.now() / 1000) + 30 * 86400,
      },
    })
  );

  return json(200, {
    runId,
    scenarioId: scenarioId ?? "custom",
    params: { temperature, maxTokens },
    guardrail: useGuardrail,
    results,
    judge,
    totalCostUsd,
    quota: {
      tier: anon ? "visitor" : "user",
      userUsed: userCount,
      userLimit,
      globalUsed: globalCount,
      globalLimit: GLOBAL_DAILY_LIMIT,
    },
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
      guardrail: it.guardrail ?? false,
      results: it.results,
      judge: it.judge ?? null,
      totalCostUsd: it.totalCostUsd,
    })),
  });
}

async function getQuota(event, anon) {
  const who = anon ? visitor(event) : claims(event);
  const today = new Date().toISOString().slice(0, 10);
  const [userUsed, globalUsed] = await Promise.all([
    readCounter(today, anon ? `ANON#${who.sub}` : `USER#${who.sub}`),
    readCounter(today, "GLOBAL"),
  ]);
  return json(200, {
    tier: anon ? "visitor" : "user",
    userUsed,
    userLimit: anon ? ANON_DAILY_LIMIT : USER_DAILY_LIMIT,
    globalUsed,
    globalLimit: GLOBAL_DAILY_LIMIT,
  });
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  try {
    if (method === "POST" && path === "/api/run") return await postRun(event, false);
    if (method === "POST" && path === "/api/public/run") return await postRun(event, true);
    if (method === "GET" && path === "/api/runs") return await getRuns(event);
    if (method === "GET" && path === "/api/me/quota") return await getQuota(event, false);
    if (method === "GET" && path === "/api/public/quota") return await getQuota(event, true);
    return json(404, { message: "Not found" });
  } catch (err) {
    if (err instanceof HttpError) return json(err.status, { message: err.message });
    console.error("unhandled", err);
    return json(500, { message: "Internal error" });
  }
};
