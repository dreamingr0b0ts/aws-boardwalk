// Shared plumbing for the per-service Lambdas behind the REST API's Lambda
// proxy integrations (payload format 1.0). Each service imports only this —
// there is deliberately no shared data layer, because each microservice owns
// its own table.
import { createHash } from 'node:crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

export type Handler = (event: APIGatewayProxyEvent) => Promise<APIGatewayProxyResult>;

// HTTP header names are case-insensitive but the proxy event preserves
// whatever case the client sent.
export function header(event: APIGatewayProxyEvent, name: string): string | undefined {
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    if (k.toLowerCase() === name && v !== undefined) return v;
  }
  return undefined;
}

const BASE_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
};

// RFC 8594/9745-style deprecation signalling on every v1 response. v1 keeps
// working (integration promise) but every reply points clients at v2.
const V1_HEADERS: Record<string, string> = {
  deprecation: 'version="v1"',
  sunset: 'Wed, 30 Jun 2027 23:59:59 GMT',
};

export function isV1(event: APIGatewayProxyEvent): boolean {
  return event.path.startsWith('/v1/');
}

export function json(
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): APIGatewayProxyResult {
  return { statusCode, headers: { ...BASE_HEADERS, ...extraHeaders }, body: JSON.stringify(body) };
}

export function v1Json(
  statusCode: number,
  body: unknown,
  successorPath: string
): APIGatewayProxyResult {
  return json(statusCode, body, {
    ...V1_HEADERS,
    link: `<${successorPath}>; rel="successor-version"`,
  });
}

// Conditional GET for the detail endpoints: a strong ETag over the exact
// response bytes, and a bodiless 304 when the client's If-None-Match still
// matches. The cheapest request is the one whose body never leaves the server.
export function cachedJson(
  event: APIGatewayProxyEvent,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): APIGatewayProxyResult {
  const payload = JSON.stringify(body);
  const etag = `"${createHash('sha256').update(payload).digest('hex').slice(0, 16)}"`;
  const inm = header(event, 'if-none-match');
  const matched = inm
    ?.split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*');
  if (matched) {
    return { statusCode: 304, headers: { etag, ...extraHeaders }, body: '' };
  }
  return { statusCode: 200, headers: { ...BASE_HEADERS, etag, ...extraHeaders }, body: payload };
}

export function errorJson(statusCode: number, error: string, message: string): APIGatewayProxyResult {
  return json(statusCode, { error, message });
}

export function notFound(what: string): APIGatewayProxyResult {
  return errorJson(404, 'not_found', `${what} does not exist.`);
}

// v2 list envelope. `nextToken` is an opaque cursor (base64url of DynamoDB's
// LastEvaluatedKey) — clients must treat it as a black box.
export function envelope(
  data: unknown[],
  lastEvaluatedKey?: Record<string, unknown>
): { data: unknown[]; meta: { count: number; nextToken?: string } } {
  const meta: { count: number; nextToken?: string } = { count: data.length };
  if (lastEvaluatedKey) {
    meta.nextToken = Buffer.from(JSON.stringify(lastEvaluatedKey)).toString('base64url');
  }
  return { data, meta };
}

export function decodeToken(token: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

// Clamp ?limit= to a sane page size; v1 has no paging and always gets the cap.
export function pageLimit(event: APIGatewayProxyEvent, cap = 50): number {
  const raw = event.queryStringParameters?.limit;
  if (!raw) return isV1(event) ? cap : 20;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return 20;
  return Math.min(n, cap);
}

export function route(routes: Record<string, Handler>): Handler {
  return async (event) => {
    const key = `${event.httpMethod} ${event.resource}`;
    const handler = routes[key];
    if (!handler) return errorJson(404, 'not_found', `No route for ${key}.`);
    try {
      return await handler(event);
    } catch (err) {
      if (err instanceof BadRequest) return errorJson(400, 'bad_request', err.message);
      console.error('unhandled', key, err);
      return errorJson(500, 'internal', 'Unexpected error — the request was not processed.');
    }
  };
}

export class BadRequest extends Error {}
