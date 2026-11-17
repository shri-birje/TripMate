import { describe, expect, it } from 'vitest';
import { formatMoney, peopleLabel } from './format';
import { todayIso } from './today';

describe('formatMoney', () => {
  it('formats rupees with Indian grouping', () => {
    expect(formatMoney(6_000_000, 'INR')).toBe('₹60,000');
    expect(formatMoney(12_345_050, 'INR')).toBe('₹1,23,450.50');
  });
  it('shows other currencies by code', () => {
    expect(formatMoney(150_000, 'USD')).toBe('USD 1,500');
    expect(formatMoney(5, 'EUR')).toBe('EUR 0.05');
  });
});

describe('peopleLabel', () => {
  it('uses the right singular and plural', () => {
    expect(peopleLabel(1)).toBe('1 person');
    expect(peopleLabel(6)).toBe('6 people');
    expect(peopleLabel(0)).toBe('0 people');
  });
});

describe('todayIso', () => {
  it('uses the local calendar day with zero padding', () => {
    expect(todayIso(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(todayIso(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
});
