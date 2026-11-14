import { timingSafeEqual } from 'node:crypto';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';

export type ApiEvent = APIGatewayProxyEventV2;
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

/**
 * The origin lock. CloudFront adds a secret x-origin-verify header to every
 * request it forwards here (infra/cloudfront.tf). A request without it reached
 * the execute-api hostname directly: around the WAF, and with an
 * X-Forwarded-For chain the caller wrote themselves. Fails closed, so a
 * function deployed without the secret trusts nothing.
 */
export function fromEdge(headers: Record<string, string | undefined> | undefined): boolean {
  const want = Buffer.from(process.env.ORIGIN_VERIFY ?? '');
  const got = Buffer.from(headers?.['x-origin-verify'] ?? '');
  return want.length > 0 && got.length === want.length && timingSafeEqual(got, want);
}

/** Dispatch on API Gateway's routeKey ("POST /api/requests"). */
export function router(routes: Record<string, RouteFn>) {
  return async (event: ApiEvent): Promise<ApiResult> => {
    if (!fromEdge(event.headers)) return json(403, { message: 'Forbidden' });
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

export function requireOneOf(value: unknown, field: string, allowed: string[]): string {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new HttpError(400, `Field '${field}' must be one of: ${allowed.join(', ')}`);
  }
  return value;
}
