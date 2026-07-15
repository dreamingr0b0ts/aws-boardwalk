import { fetchAuthSession } from 'aws-amplify/auth';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface Options {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  auth?: boolean;
}

/**
 * Same-origin API client: CloudFront routes /api/* to API Gateway, so there
 * is no cross-origin hop and no CORS. Authenticated calls attach the Cognito
 * ID token; Amplify refreshes it transparently.
 */
export async function api<T>(path: string, { method = 'GET', body, auth = false }: Options = {}): Promise<T> {
  const headers: Record<string, string> = {};

  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth) {
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();
    if (!token) throw new ApiError(401, 'Your session has expired — please sign in again.');
    headers.authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = (await res.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }

  return (await res.json()) as T;
}
