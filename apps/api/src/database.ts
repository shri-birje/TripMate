import type { AppConfig } from './config';

export type DatabaseStatus = 'ok' | 'not_configured' | 'error';

/**
 * Foundation-level database check.
 *
 * Real data access (queries, write functions) arrives in later milestones.
 * For now we only answer: "is a database configured, and can we reach it?"
 *
 * We call the Supabase REST root, which needs the service key. It is read
 * from configuration only and is never logged or returned to clients.
 */
export type DatabaseCheck = () => Promise<DatabaseStatus>;

export function createDatabaseCheck(
  config: Pick<AppConfig, 'supabaseUrl' | 'supabaseServiceRoleKey'>,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 2500,
): DatabaseCheck {
  return async () => {
    if (!config.supabaseUrl || !config.supabaseServiceRoleKey) return 'not_configured';
    try {
      const res = await fetchImpl(`${config.supabaseUrl}/rest/v1/`, {
        headers: {
          apikey: config.supabaseServiceRoleKey,
          Authorization: `Bearer ${config.supabaseServiceRoleKey}`,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      return res.ok ? 'ok' : 'error';
    } catch {
      return 'error';
    }
  };
}
