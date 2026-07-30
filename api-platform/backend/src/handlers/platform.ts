// Platform microservice — the exchange's own front office. It is the only
// Lambda allowed to touch the API Gateway control plane, and only for three
// narrow jobs: read the party line's meter (GetUsage), install a visitor's
// personal line (CreateApiKey + attach to the visitor usage plan), and sweep
// expired visitor keys on the nightly schedule. Its DynamoDB table holds only
// issuance counters and key audit records, all TTL'd.
//
// Self-service keys are fenced like every boardwalk visitor tier: per-IP and
// global daily caps enforced with conditional writes, and the nightly sweep
// deletes visitor keys older than 24h — only names carrying the
// apx-visitor- prefix, so the demo and partner keys can never match.
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { createHash } from 'node:crypto';
import {
  APIGatewayClient,
  CreateApiKeyCommand,
  CreateUsagePlanKeyCommand,
  DeleteApiKeyCommand,
  GetApiKeysCommand,
  GetUsageCommand,
  GetUsagePlansCommand,
} from '@aws-sdk/client-api-gateway';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../lib/ddb.js';
import { errorJson, header, json, route } from '../lib/http.js';

const apigw = new APIGatewayClient({});

const TABLE = process.env.TABLE_NAME!;
// Names, not ids: the plans/keys are created by the same Terraform apply that
// wires this Lambda into the API body, so passing their generated ids through
// the environment would be a dependency cycle. Names are static; ids resolve
// once per container below.
const DEMO_PLAN_NAME = process.env.DEMO_PLAN_NAME!;
const DEMO_KEY_NAME = process.env.DEMO_KEY_NAME!;
const VISITOR_PLAN_NAME = process.env.VISITOR_PLAN_NAME!;
const DEMO_QUOTA = Number(process.env.DEMO_QUOTA!);
const VISITOR_QUOTA = Number(process.env.VISITOR_QUOTA!);
const KEYS_PER_IP_PER_DAY = Number(process.env.KEYS_PER_IP_PER_DAY!);
const KEYS_PER_DAY_GLOBAL = Number(process.env.KEYS_PER_DAY_GLOBAL!);

const VISITOR_KEY_PREFIX = 'apx-visitor-';
const KEY_LIFETIME_MS = 24 * 3600 * 1000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ControlIds {
  demoPlanId: string;
  demoKeyId: string;
  visitorPlanId: string;
}

let controlIds: ControlIds | null = null;

async function resolveIds(): Promise<ControlIds> {
  if (controlIds) return controlIds;
  const plans: { id?: string; name?: string }[] = [];
  let position: string | undefined;
  do {
    const page = await apigw.send(new GetUsagePlansCommand({ limit: 500, position }));
    plans.push(...(page.items ?? []));
    position = page.position;
  } while (position);
  const demoPlan = plans.find((p) => p.name === DEMO_PLAN_NAME);
  const visitorPlan = plans.find((p) => p.name === VISITOR_PLAN_NAME);
  const keys = await apigw.send(new GetApiKeysCommand({ nameQuery: DEMO_KEY_NAME, includeValues: false }));
  const demoKey = keys.items?.find((k) => k.name === DEMO_KEY_NAME);
  if (!demoPlan?.id || !visitorPlan?.id || !demoKey?.id) {
    throw new Error('usage plans or demo key not found by name — was the stack partially applied?');
  }
  controlIds = { demoPlanId: demoPlan.id, demoKeyId: demoKey.id, visitorPlanId: visitorPlan.id };
  return controlIds;
}

// Behind CloudFront, requestContext sourceIp is a CloudFront edge address —
// the visitor's real IP is in X-Forwarded-For. CloudFront appends the address
// it was called from, so the trustworthy entry is second-from-last; a
// client-supplied header only pushes the real entries further right. (Same
// derivation as plank 12's visitor tier.)
function ipHash(event: APIGatewayProxyEvent): string {
  const xff = (header(event, 'x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const ip = xff.length >= 2 ? xff[xff.length - 2] : xff[0] ?? event.requestContext.identity?.sourceIp ?? 'unknown';
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

// Atomic counter with a cap, enforced by the condition — two racing requests
// cannot both take the last slot. Returns false when the cap is already spent.
async function takeSlot(sk: string, cap: number): Promise<boolean> {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `CNT#${todayUtc()}`, SK: sk },
        UpdateExpression: 'ADD n :one SET #ttl = if_not_exists(#ttl, :ttl)',
        ConditionExpression: 'attribute_not_exists(n) OR n < :cap',
        ExpressionAttributeNames: { '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':one': 1,
          ':cap': cap,
          ':ttl': Math.floor(Date.now() / 1000) + 48 * 3600,
        },
      })
    );
    return true;
  } catch (err) {
    if ((err as Error).name === 'ConditionalCheckFailedException') return false;
    throw err;
  }
}

async function releaseSlot(sk: string): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `CNT#${todayUtc()}`, SK: sk },
      UpdateExpression: 'ADD n :minus',
      ExpressionAttributeValues: { ':minus': -1 },
    })
  );
}

async function issuedTodayGlobal(): Promise<number> {
  const res = await ddb.send(new GetCommand({ TableName: TABLE, Key: { PK: `CNT#${todayUtc()}`, SK: 'GLOBAL' } }));
  return (res.Item?.n as number | undefined) ?? 0;
}

// ---- nightly sweep -----------------------------------------------------------

async function sweepExpiredKeys(): Promise<{ deleted: number; kept: number }> {
  const cutoff = Date.now() - KEY_LIFETIME_MS;
  let deleted = 0;
  let kept = 0;
  let position: string | undefined;
  do {
    const page = await apigw.send(
      new GetApiKeysCommand({ nameQuery: VISITOR_KEY_PREFIX, includeValues: false, limit: 500, position })
    );
    for (const key of page.items ?? []) {
      // Only keys carrying the visitor prefix are sweepable — the demo and
      // partner keys are apx-demo-key / apx-partner-key and can never match.
      const isVisitor = key.name?.startsWith(VISITOR_KEY_PREFIX);
      if (isVisitor && key.createdDate && key.createdDate.getTime() < cutoff) {
        await apigw.send(new DeleteApiKeyCommand({ apiKey: key.id! }));
        deleted += 1;
      } else if (isVisitor) {
        kept += 1;
      }
    }
    position = page.position;
  } while (position);
  console.log(JSON.stringify({ sweep: 'visitor-keys', deleted, kept }));
  return { deleted, kept };
}

// ---- routes ------------------------------------------------------------------

// GetUsage answers from the usage-plan meter itself (the same counters that
// enforce the quota), so the page shows the real meter, not an estimate.
// Cached for 30s per container to stay polite to the control plane.
let usageCache: { at: number; body: unknown } | null = null;

const apiRoutes = route({
  'GET /v2/platform/usage': async () => {
    if (usageCache && Date.now() - usageCache.at < 30_000) {
      return json(200, usageCache.body);
    }
    const date = todayUtc();
    const { demoPlanId, demoKeyId } = await resolveIds();
    const usage = await apigw.send(
      new GetUsageCommand({ usagePlanId: demoPlanId, keyId: demoKeyId, startDate: date, endDate: date })
    );
    // items: { "<keyId>": [[used, remaining]] } — one pair per day requested.
    const pair = usage.items?.[demoKeyId]?.[0] ?? [0, DEMO_QUOTA];
    const used = pair[0] ?? 0;
    const body = {
      data: {
        date,
        partyLine: {
          plan: 'demo',
          used,
          remaining: pair[1] ?? Math.max(0, DEMO_QUOTA - used),
          quota: DEMO_QUOTA,
          resets: 'midnight UTC',
        },
        privateLines: {
          plan: 'visitor',
          issuedToday: await issuedTodayGlobal(),
          dailyCap: KEYS_PER_DAY_GLOBAL,
          quotaPerKey: VISITOR_QUOTA,
        },
        note: 'Usage as metered by the API Gateway usage plan; the meter can lag live traffic by a few minutes.',
      },
    };
    usageCache = { at: Date.now(), body };
    return json(200, body);
  },

  // The one keyless write on the whole board, because you cannot present a key
  // you do not have yet. The gateway has already validated the body against
  // the KeyRequest model.
  'POST /v2/platform/keys': async (event) => {
    const { label } = JSON.parse(event.body!) as { label: string };
    const hash = ipHash(event);

    if (!(await takeSlot(`IP#${hash}`, KEYS_PER_IP_PER_DAY))) {
      return errorJson(429, 'key_limit', `This address has already been issued ${KEYS_PER_IP_PER_DAY} personal keys today. The party-line demo key on the docs page still works.`);
    }
    if (!(await takeSlot('GLOBAL', KEYS_PER_DAY_GLOBAL))) {
      await releaseSlot(`IP#${hash}`);
      return errorJson(429, 'key_limit', 'The exchange has issued its full allotment of personal keys for today. The shared demo key still works; personal lines reopen at midnight UTC.');
    }

    const { visitorPlanId } = await resolveIds();
    const issuedAt = new Date();
    const key = await apigw.send(
      new CreateApiKeyCommand({
        name: `${VISITOR_KEY_PREFIX}${todayUtc()}-${hash.slice(0, 8)}-${label}`,
        description: 'Self-issued visitor key from the docs page. Expires ~24h after issue; removed by the nightly sweep.',
        enabled: true,
      })
    );
    await apigw.send(
      new CreateUsagePlanKeyCommand({ usagePlanId: visitorPlanId, keyId: key.id!, keyType: 'API_KEY' })
    );
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `KEY#${key.id}`,
          SK: 'META',
          label,
          ipHash: hash,
          issuedAt: issuedAt.toISOString(),
          ttl: Math.floor(issuedAt.getTime() / 1000) + 25 * 3600,
        },
      })
    );

    return json(
      201,
      {
        data: {
          apiKey: key.value,
          keyId: key.id,
          label,
          plan: 'visitor',
          limits: { ratePerSecond: 2, burst: 5, quotaPerDay: VISITOR_QUOTA },
          issuedAt: issuedAt.toISOString(),
          expiresAt: new Date(issuedAt.getTime() + KEY_LIFETIME_MS).toISOString(),
          note: 'Shown once and never again — the nightly sweep removes this key about 24 hours from now.',
        },
      },
      { location: '/v2/platform/keys' }
    );
  },
});

export const handler = async (event: APIGatewayProxyEvent | { source?: string }) => {
  // The nightly EventBridge rule invokes this same function with a marker
  // payload instead of a proxy event.
  if ('source' in event && event.source === 'boardwalk.cleanup') {
    return sweepExpiredKeys();
  }
  return apiRoutes(event as APIGatewayProxyEvent);
};
