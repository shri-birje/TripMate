/**
 * Every rule violation in the money engine throws a CoreError with a stable
 * machine-readable `code`. The API maps these codes to HTTP errors and the
 * app maps them to friendly messages. Messages are for developers and logs.
 *
 * The engine never "fixes up" bad input silently: wrong data must fail
 * loudly, because a quietly wrong balance is worse than an error.
 */
export type CoreErrorCode =
  | 'INVALID_MONEY_FORMAT'
  | 'INVALID_AMOUNT'
  | 'INVALID_WEIGHT'
  | 'NO_PARTICIPANTS'
  | 'NO_PAYERS'
  | 'DUPLICATE_MEMBER'
  | 'UNKNOWN_MEMBER'
  | 'PERCENT_SUM_INVALID'
  | 'SPLIT_SUM_MISMATCH'
  | 'PAYERS_SUM_MISMATCH'
  | 'INCONSISTENT_EXPENSE'
  | 'BALANCES_NOT_ZERO_SUM';

export class CoreError extends Error {
  constructor(
    public readonly code: CoreErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'CoreError';
  }
}
