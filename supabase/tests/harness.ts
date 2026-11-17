import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

/**
 * Shared set-up for database tests.
 *
 * Runs the project's REAL migration files, in order, against a real Postgres
 * engine (PGlite, inside Node - no Docker). Supabase provides a few things we
 * have to imitate: the `anon` and `authenticated` roles, the auth.users table,
 * auth.uid(), and its habit of granting broad default permissions on new tables
 * (our migrations must remove those, so we reproduce them to prove they do).
 *
 * "Acting as" a user = switching to the `authenticated` role and setting the
 * session value Supabase derives from a login token.
 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

export function readMigration(file: string): string {
  return readFileSync(MIGRATIONS_DIR + file, 'utf8');
}

export const SUPABASE_STAND_IN = `
  create role anon nologin;
  create role authenticated nologin;
  create schema auth;
  create table auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    raw_user_meta_data jsonb
  );
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  grant usage on schema auth, public to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  -- Supabase's generous defaults, which the migrations have to tighten:
  alter default privileges in schema public grant all on tables to anon, authenticated;
  alter default privileges in schema public grant all on functions to anon, authenticated;
`;

export async function newDatabase(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STAND_IN);
  for (const file of migrationFiles()) await db.exec(readMigration(file));
  return db;
}

export class TestUsers {
  constructor(private db: PGlite) {}

  asAdmin = () => this.db.exec('reset role');
  asAnon = () => this.db.exec(`reset role; set role anon; select set_config('request.jwt.claim.sub', '', false)`);
  asUser = (id: string) =>
    this.db.exec(`reset role; set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false)`);

  /** Creates an account (the sign-up trigger makes the profile). Returns the new user id. */
  async signUp(email: string, displayName?: string): Promise<string> {
    await this.asAdmin();
    const meta = displayName ? JSON.stringify({ display_name: displayName }) : null;
    const r = await this.db.query<{ id: string }>(
      'insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id',
      [email, meta],
    );
    return r.rows[0]!.id;
  }
}
