import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;
export type ApiResult = APIGatewayProxyStructuredResultV2;
export type RouteFn = (event: ApiEvent) => Promise<ApiResult>;

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function json(statusCode: number, body: unknown): ApiResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Dispatch on API Gateway's routeKey ("GET /api/me/applications/{id}"). */
export function router(routes: Record<string, RouteFn>) {
  return async (event: ApiEvent): Promise<ApiResult> => {
    try {
      const fn = routes[event.routeKey];
      if (!fn) throw new HttpError(404, 'Not found');
      return await fn(event);
    } catch (err) {
      if (err instanceof HttpError) return json(err.status, { message: err.message });
      console.error('unhandled', err);
      return json(500, { message: 'Internal error' });
    }
  };
}

export interface Claims {
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

/**
 * JWT claims from the HTTP API authorizer. Cognito's group claim arrives as
 * the *string* "[admin citizen]", not an array — normalize defensively.
 */
export function claims(event: ApiEvent): Claims {
  const c = event.requestContext.authorizer?.jwt?.claims ?? {};
  const raw = c['cognito:groups'];
  let groups: string[] = [];
  if (Array.isArray(raw)) {
    groups = raw.map(String);
  } else if (typeof raw === 'string') {
    groups = raw
      .replace(/^\[|\]$/g, '')
      .split(/[\s,]+/)
      .filter(Boolean);
  }
  const email = String(c.email ?? '');
  return {
    sub: String(c.sub ?? ''),
    email,
    name: String(c.name ?? '') || email,
    groups,
  };
}

export function requireAdmin(event: ApiEvent): Claims {
  const who = claims(event);
  if (!who.groups.includes('admin')) {
    throw new HttpError(403, 'Requires the admin role');
  }
  return who;
}

export function pathParam(event: ApiEvent, name: string): string {
  const v = event.pathParameters?.[name];
  if (!v) throw new HttpError(400, `Missing path parameter: ${name}`);
  return v;
}

export function parseBody<T>(event: ApiEvent): T {
  if (!event.body) throw new HttpError(400, 'Request body required');
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return JSON.parse(raw) as T;
  } catch {
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

export function requireString(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new HttpError(400, `Field '${field}' must be a string of ${min}-${max} characters`);
  }
  return value.trim();
}
