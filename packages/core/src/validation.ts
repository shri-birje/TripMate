import type { ZodType } from 'zod';

/**
 * Turns Zod validation into the simple shape forms need:
 * either the clean, typed data, or one friendly message per field.
 */
export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: Record<string, string> };

export function validate<T>(schema: ZodType<T>, input: unknown): ValidationResult<T> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };

  const errors: Record<string, string> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path.length > 0 ? String(issue.path[0]) : '_form';
    if (!(field in errors)) errors[field] = issue.message; // keep the first message per field
  }
  return { ok: false, errors };
}
