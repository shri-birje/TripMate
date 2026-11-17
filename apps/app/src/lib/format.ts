import { formatINR } from '@tripmate/core';

/**
 * Money for display. Uses the approved M1 formatter (whole paise, Indian digit
 * grouping, no floating point). INR gets the rupee sign; other currencies show
 * their code, e.g. "USD 1,500".
 */
export function formatMoney(minor: number, currency: string): string {
  if (currency === 'INR') return formatINR(minor);
  return `${currency} ${formatINR(minor, { symbol: false })}`;
}

/** "1 person", "6 people". */
export function peopleLabel(count: number): string {
  return count === 1 ? '1 person' : `${count} people`;
}
