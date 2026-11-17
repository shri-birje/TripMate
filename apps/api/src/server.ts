import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadConfig } from './config';
import { createLogger } from './logger';

/**
 * Entry point for running the API on your own computer (Node).
 * Only this file knows about Node. app.ts is runtime-agnostic, so the same
 * app can later be deployed to a free edge host with a different entry file.
 */
const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = createApp(config, { logger });

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info('api_started', {
    port: info.port,
    environment: config.appEnv,
    version: config.version,
  });
});
