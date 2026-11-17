/**
 * One error type for everything we throw on purpose.
 * The central error handler (app.ts) turns it into the standard JSON error
 * shape documented in docs/API_DESIGN.md. Anything else becomes a generic 500
 * so internal details never leak to clients.
 */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 410 | 422 | 429 | 500;

export class AppError extends Error {
  constructor(
    public readonly status: ErrorStatus,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId: string;
  };
}
