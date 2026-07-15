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

/** Dispatch on API Gateway's routeKey ("POST /api/chat"). */
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
}

export function claims(event: ApiEvent): Claims {
  const c = event.requestContext.authorizer?.jwt?.claims ?? {};
  return {
    sub: String(c.sub ?? ''),
    email: String(c.email ?? ''),
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
