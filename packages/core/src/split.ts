import { allocateByWeights } from './allocate';
import { CoreError } from './errors';
import { assertSafeMinor, sumMinor, type Minor } from './money';

/**
 * How an expense is divided. Only the members listed here take part and are
 * ever charged (product rule 4); "selected members only" is simply the
 * participant list of an equal split.
 *
 * - equal:      everyone listed pays the same (rounded fairly)
 * - percentage: basis points (1% = 100, 33.33% = 3333); must total 10000
 * - exact:      exact paise per person; must total the expense amount
 * - shares:     relative weights, e.g. 2 : 1 : 1 (positive whole numbers)
 */
export type SplitSpec =
  | { method: 'equal'; participants: readonly string[] }
  | { method: 'percentage'; inputs: readonly { memberId: string; basisPoints: number }[] }
  | { method: 'exact'; inputs: readonly { memberId: string; amountMinor: Minor }[] }
  | { method: 'shares'; inputs: readonly { memberId: string; weight: number }[] };

export interface ShareResult {
  memberId: string;
  shareMinor: Minor;
  /** What the user entered (basis points / weight / paise), kept so the form can be reopened exactly. null for equal. */
  inputValue: number | null;
}

export const BASIS_POINTS_TOTAL = 10_000;

function assertUnique(ids: readonly string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new CoreError('DUPLICATE_MEMBER', 'A member appears more than once', { memberId: id });
    }
    seen.add(id);
  }
}

/** Computes each participant's share of `amountMinor`. Results always add up to the amount exactly. */
export function computeSplit(amountMinor: Minor, spec: SplitSpec): ShareResult[] {
  assertSafeMinor(amountMinor, 'expense amount');
  if (amountMinor <= 0) {
    throw new CoreError('INVALID_AMOUNT', 'Expense amount must be greater than zero', { amountMinor });
  }

  switch (spec.method) {
    case 'equal': {
      assertUnique(spec.participants);
      const result = allocateByWeights(
        amountMinor,
        spec.participants.map((id) => ({ id, weight: 1 })),
      );
      return result.map((r) => ({ memberId: r.id, shareMinor: r.amountMinor, inputValue: null }));
    }

    case 'percentage': {
      if (spec.inputs.length === 0) throw new CoreError('NO_PARTICIPANTS', 'At least one participant is required');
      assertUnique(spec.inputs.map((i) => i.memberId));
      for (const i of spec.inputs) {
        if (!Number.isSafeInteger(i.basisPoints) || i.basisPoints <= 0) {
          throw new CoreError('INVALID_WEIGHT', 'Each percentage must be greater than zero', {
            memberId: i.memberId,
            basisPoints: i.basisPoints,
          });
        }
      }
      const total = spec.inputs.reduce((a, i) => a + i.basisPoints, 0);
      if (total !== BASIS_POINTS_TOTAL) {
        throw new CoreError('PERCENT_SUM_INVALID', 'Percentages must add up to exactly 100%', {
          expectedBasisPoints: BASIS_POINTS_TOTAL,
          actualBasisPoints: total,
        });
      }
      const result = allocateByWeights(
        amountMinor,
        spec.inputs.map((i) => ({ id: i.memberId, weight: i.basisPoints })),
      );
      return result.map((r, idx) => ({
        memberId: r.id,
        shareMinor: r.amountMinor,
        inputValue: spec.inputs[idx]!.basisPoints,
      }));
    }

    case 'exact': {
      if (spec.inputs.length === 0) throw new CoreError('NO_PARTICIPANTS', 'At least one participant is required');
      assertUnique(spec.inputs.map((i) => i.memberId));
      for (const i of spec.inputs) {
        assertSafeMinor(i.amountMinor, 'share');
        if (i.amountMinor < 0) {
          throw new CoreError('INVALID_AMOUNT', 'A share cannot be negative', { memberId: i.memberId });
        }
      }
      const total = sumMinor(spec.inputs.map((i) => i.amountMinor));
      if (total !== amountMinor) {
        throw new CoreError('SPLIT_SUM_MISMATCH', 'Shares must add up to the expense amount', {
          expectedMinor: amountMinor,
          actualMinor: total,
        });
      }
      return spec.inputs.map((i) => ({ memberId: i.memberId, shareMinor: i.amountMinor, inputValue: i.amountMinor }));
    }

    case 'shares': {
      if (spec.inputs.length === 0) throw new CoreError('NO_PARTICIPANTS', 'At least one participant is required');
      assertUnique(spec.inputs.map((i) => i.memberId));
      const result = allocateByWeights(
        amountMinor,
        spec.inputs.map((i) => ({ id: i.memberId, weight: i.weight })),
      );
      return result.map((r, idx) => ({
        memberId: r.id,
        shareMinor: r.amountMinor,
        inputValue: spec.inputs[idx]!.weight,
      }));
    }
  }
}

export interface PayerInput {
  memberId: string;
  paidMinor: Minor;
}

export interface ExpenseInput {
  amountMinor: Minor;
  payers: readonly PayerInput[];
  split: SplitSpec;
}

export interface ComputedExpense {
  payers: PayerInput[];
  splits: ShareResult[];
}

/**
 * Validates who paid and computes who owes, for one shared expense.
 * Guarantees on success: sum(payers) = amount and sum(splits) = amount.
 */
export function computeExpense(input: ExpenseInput): ComputedExpense {
  assertSafeMinor(input.amountMinor, 'expense amount');
  if (input.amountMinor <= 0) {
    throw new CoreError('INVALID_AMOUNT', 'Expense amount must be greater than zero', {
      amountMinor: input.amountMinor,
    });
  }
  if (input.payers.length === 0) {
    throw new CoreError('NO_PAYERS', 'An expense needs at least one payer');
  }
  assertUnique(input.payers.map((p) => p.memberId));
  for (const p of input.payers) {
    assertSafeMinor(p.paidMinor, 'paid amount');
    if (p.paidMinor <= 0) {
      throw new CoreError('INVALID_AMOUNT', 'A payer must have paid more than zero', { memberId: p.memberId });
    }
  }
  const paidTotal = sumMinor(input.payers.map((p) => p.paidMinor));
  if (paidTotal !== input.amountMinor) {
    throw new CoreError('PAYERS_SUM_MISMATCH', 'Amounts paid must add up to the expense amount', {
      expectedMinor: input.amountMinor,
      actualMinor: paidTotal,
    });
  }

  const splits = computeSplit(input.amountMinor, input.split);
  return { payers: input.payers.map((p) => ({ ...p })), splits };
}
