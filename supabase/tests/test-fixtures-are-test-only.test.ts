import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as core from '../../packages/core/src/index';

/**
 * The golden vectors are test fixtures. They live in packages/core/test-fixtures/, outside the production source folder,
 * and must never become part of the package surface or of an application bundle.
 */
const SRC = fileURLToPath(new URL('../../packages/core/src/', import.meta.url));
const APP = fileURLToPath(new URL('../../apps/app/src/', import.meta.url));
const API = fileURLToPath(new URL('../../apps/api/src/', import.meta.url));

function* files(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir + entry.name;
    if (entry.isDirectory()) yield* files(full + '/');
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}
const production = (dir: string) => [...files(dir)].filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith('/testkit.ts'));

describe('the golden vectors are test-only', () => {
  it('are not part of the package surface (index.ts does not export them)', () => {
    for (const forbidden of ['SPLIT_VECTORS', 'LEDGER_VECTORS', 'MEMBER_IDS', 'vid']) expect(Object.keys(core)).not.toContain(forbidden);
    expect(readFileSync(SRC + 'index.ts', 'utf8')).not.toMatch(/test-fixtures|expenseVectors/);
  });

  it('are never imported by production code in the core package, the app or the API (only by tests)', () => {
    for (const dir of [SRC, APP, API]) {
      for (const f of production(dir)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/test-fixtures|expenseVectors/);
    }
  });

  it('the production source folder holds no fixture file, and the fixture folder exists on its own', () => {
    expect(readdirSync(SRC).filter((f) => /vector|fixture/i.test(f) && !f.endsWith('.test.ts'))).toEqual([]);
    expect(readdirSync(SRC + '../test-fixtures/')).toContain('expenseVectors.ts');
  });

  it('the package exports only its source entry point, so the fixtures folder cannot be imported by name from outside', () => {
    const pkg = JSON.parse(readFileSync(SRC + '../package.json', 'utf8')) as { exports: Record<string, string> };
    expect(pkg.exports).toEqual({ '.': './src/index.ts' });
  });
});
