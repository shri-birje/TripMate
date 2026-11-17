import { HealthResponseSchema, type HealthResponse } from '@tripmate/core';
import { getApiBaseUrl } from './config';

/**
 * The single place the app talks to the TripMate API.
 * Every response is validated against the shared contract from
 * @tripmate/core, so a server/app mismatch fails loudly here instead of
 * causing strange bugs on screen.
 */
export type ApiFailureKind = 'network' | 'timeout' | 'bad_response' | 'server';

export class ApiError extends Error {
  constructor(
    public readonly kind: ApiFailureKind,
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchHealth(options: ApiOptions = {}): Promise<HealthResponse> {
  const { baseUrl = getApiBaseUrl(), fetchImpl = fetch, timeoutMs = 6000 } = options;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}/v1/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new ApiError('timeout', 'The server took too long to respond.');
    }
    throw new ApiError('network', 'Could not reach the server.');
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError('bad_response', 'The server sent an unreadable response.', res.status);
  }

  // The API answers 503 with a valid health body when "degraded", so we try
  // to parse first and only treat it as a server error if the body is wrong.
  const parsed = HealthResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError(
      res.ok ? 'bad_response' : 'server',
      res.ok ? 'The server response did not match what the app expects.' : 'The server reported an error.',
      res.status,
    );
  }
  return parsed.data;
}
