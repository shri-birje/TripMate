import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppConfig } from './config';
import { createDatabaseCheck, type DatabaseCheck } from './database';
import { AppError, type ErrorBody } from './errors';
import { createLogger, type Logger } from './logger';
import { healthRoutes } from './routes/health';

type Env = { Variables: { requestId: string } };

export interface AppDeps {
  logger?: Logger;
  checkDatabase?: DatabaseCheck;
}

/**
 * Builds the API. Everything is created inside this function (no global
 * state), which makes it easy to test: tests build an app with fake pieces
 * and call it directly without opening a network port.
 */
export function createApp(config: AppConfig, deps: AppDeps = {}) {
  const logger = deps.logger ?? createLogger(config.logLevel);
  const checkDatabase = deps.checkDatabase ?? createDatabaseCheck(config);

  const app = new Hono<Env>();

  // 1. Request id: lets us match a user-visible error to a log line.
  app.use('*', async (c, next) => {
    const requestId = c.req.header('x-request-id') ?? crypto.randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    await next();
  });

  // 2. CORS: only the configured web origins may call the API from a browser.
  app.use(
    '*',
    cors({
      origin: (origin) => (config.corsOrigins.includes(origin) ? origin : null),
      allowHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );

  // 3. Basic security headers for every response.
  app.use('*', async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
  });

  // 4. Access log (method, path, status, duration only - never bodies or tokens).
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    logger.info('request', {
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - start,
    });
  });

  // Routes are versioned under /v1.
  app.route('/v1', healthRoutes(config, checkDatabase));

  // Unknown URL -> standard error body.
  app.notFound((c) => {
    const body: ErrorBody = {
      error: {
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
        requestId: c.get('requestId'),
      },
    };
    return c.json(body, 404);
  });

  // Central error handler: the one place errors become HTTP responses.
  app.onError((err, c) => {
    const requestId = c.get('requestId');
    if (err instanceof AppError) {
      const body: ErrorBody = {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
          requestId,
        },
      };
      return c.json(body, err.status);
    }
    // Unexpected error: log details privately, tell the client nothing internal.
    logger.error('unhandled_error', {
      requestId,
      name: err.name,
      message: err.message,
    });
    const body: ErrorBody = {
      error: { code: 'INTERNAL', message: 'Something went wrong.', requestId },
    };
    return c.json(body, 500);
  });

  return app;
}
