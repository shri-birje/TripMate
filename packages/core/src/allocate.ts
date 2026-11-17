import { CoreError } from './errors';
import { assertSafeMinor, type Minor } from './money';

export interface WeightedEntry {
  id: string;
  /** Positive safe integer. Equal split = all weights 1. */
  weight: number;
}

export interface Allocation {
  id: string;
  amountMinor: Minor;
}

/**
 * Splits `totalMinor` among entries in proportion to their weights, using the
 * LARGEST REMAINDER method.
 *
 * Why this exists: Rs 10.00 split three ways is 3.333... each. Rounding each
 * share independently gives 3.33 x 3 = 9.99, so a paisa disappears. Instead:
 *   1. Give everyone the rounded-DOWN share.
 *   2. Hand the leftover paise, one each, to those whose exact share had the
 *      biggest fractional part.
 * Result: integers that ALWAYS add up to the total, and nobody is off by more
 * than one paisa from their exact share.
 *
 * Ties (equal remainders) go to the lowest id (plain string comparison), so
 * the answer never depends on the order the entries were given in.
 *
 * Internals use BigInt so total * weight can never overflow.
 */
export function allocateByWeights(totalMinor: Minor, entries: readonly WeightedEntry[]): Allocation[] {
  assertSafeMinor(totalMinor, 'total');
  if (totalMinor < 0) {
    throw new CoreError('INVALID_AMOUNT', 'total must not be negative', { totalMinor });
  }
  if (entries.length === 0) {
    throw new CoreError('NO_PARTICIPANTS', 'At least one participant is required');
  }

  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.id)) {
      throw new CoreError('DUPLICATE_MEMBER', 'A member appears more than once', { id: e.id });
    }
    seen.add(e.id);
    if (!Number.isSafeInteger(e.weight) || e.weight <= 0) {
      throw new CoreError('INVALID_WEIGHT', 'Weights must be positive whole numbers', {
        id: e.id,
        weight: e.weight,
      });
    }
  }

  const total = BigInt(totalMinor);
  const weightSum = entries.reduce((acc, e) => acc + BigInt(e.weight), 0n);

  const rows = entries.map((e, index) => {
    const numerator = total * BigInt(e.weight);
    return { index, id: e.id, base: numerator / weightSum, remainder: numerator % weightSum };
  });

  const allocatedBase = rows.reduce((acc, r) => acc + r.base, 0n);
  const leftover = Number(total - allocatedBase); // always 0 <= leftover < entries.length

  const byRemainder = [...rows].sort((a, b) => {
    if (a.remainder !== b.remainder) return a.remainder > b.remainder ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const bonus = new Set(byRemainder.slice(0, leftover).map((r) => r.index));

  return rows.map((r) => ({
    id: r.id,
    amountMinor: Number(r.base) + (bonus.has(r.index) ? 1 : 0),
  }));
}
