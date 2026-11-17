import { CoreError } from './errors';

/**
 * MONEY RULES
 * - Every amount is an integer number of paise ("minor units"). Rs 1 = 100.
 * - We never store or calculate with decimals like 12.5: floating-point
 *   arithmetic cannot represent most decimals exactly (0.1 + 0.2 !== 0.3),
 *   which is unacceptable for money.
 * - Rupee text typed by users is converted to paise with string handling,
 *   never with `parseFloat(x) * 100`.
 */
export type Minor = number;

/** Throws unless `n` is a safe integer (exactly representable, no rounding). */
export function assertSafeMinor(n: number, what = 'amount'): asserts n is Minor {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new CoreError('INVALID_AMOUNT', `${what} must be a safe integer number of paise`, { value: n });
  }
}

/** Adds two paise amounts and refuses to continue if the result is not exact. */
export function addMinor(a: Minor, b: Minor): Minor {
  const r = a + b;
  assertSafeMinor(r, 'sum');
  return r;
}

export function sumMinor(values: readonly Minor[]): Minor {
  let total = 0;
  for (const v of values) {
    assertSafeMinor(v);
    total = addMinor(total, v);
  }
  return total;
}

// Accepts: "1200", "1,200", "1,23,456", "1200.5", "1200.50", optional leading
// "₹" or "Rs". Rejects: negatives, more than 2 decimals, letters, blanks,
// scientific notation, ".5", "5.".
const PLAIN = /^\d+(\.\d{1,2})?$/;
const GROUPED = /^\d{1,3}(,\d{2,3})+(\.\d{1,2})?$/;
const MAX_WHOLE_DIGITS = 13; // keeps rupees*100 safely inside Number.MAX_SAFE_INTEGER

/** Converts text typed by a user (rupees) into paise. */
export function parseRupees(input: string): Minor {
  if (typeof input !== 'string') {
    throw new CoreError('INVALID_MONEY_FORMAT', 'Amount must be text', { input });
  }
  let s = input.trim().replace(/^(₹|rs\.?\s*|inr\s*)/i, '').trim();
  if (!PLAIN.test(s) && !GROUPED.test(s)) {
    throw new CoreError('INVALID_MONEY_FORMAT', 'Enter an amount like 1200 or 1,200.50', { input });
  }
  s = s.replace(/,/g, '');
  const [whole = '0', fraction = ''] = s.split('.');
  const wholeTrimmed = whole.replace(/^0+(?=\d)/, '');
  if (wholeTrimmed.length > MAX_WHOLE_DIGITS) {
    throw new CoreError('INVALID_MONEY_FORMAT', 'Amount is too large', { input });
  }
  const paise = Number(wholeTrimmed) * 100 + Number(fraction.padEnd(2, '0'));
  assertSafeMinor(paise);
  return paise;
}

export interface FormatOptions {
  /** Show the ₹ symbol (default true). */
  symbol?: boolean;
  /** 'auto' hides ".00" for whole rupees; 'always' shows paise; 'never' rounds down to rupees. */
  paise?: 'auto' | 'always';
}

/**
 * Formats paise for display with Indian digit grouping:
 * 12345678 -> "₹1,23,456.78", 150000 -> "₹1,500", -50000 -> "-₹500".
 * Display only: never parse this output back for calculation.
 */
export function formatINR(minor: Minor, options: FormatOptions = {}): string {
  assertSafeMinor(minor);
  const { symbol = true, paise = 'auto' } = options;
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const rupees = Math.floor(abs / 100);
  const fraction = abs % 100;

  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3;
  }

  const showPaise = paise === 'always' || fraction !== 0;
  const text = showPaise ? `${grouped}.${String(fraction).padStart(2, '0')}` : grouped;
  return `${negative ? '-' : ''}${symbol ? '₹' : ''}${text}`;
}
