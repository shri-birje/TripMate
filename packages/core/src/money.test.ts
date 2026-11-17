import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMinor, assertSafeMinor, formatINR, parseRupees, sumMinor } from './money';
import { expectCoreError } from './testkit';

describe('parseRupees', () => {
  it.each([
    ['1200', 120000],
    ['1,200', 120000],
    ['1,23,456.5', 12345650],
    ['₹1,200.50', 120050],
    ['Rs. 99', 9900],
    ['rs99', 9900],
    ['0', 0],
    ['0.05', 5],
    ['007', 700],
    ['12.30', 1230],
    ['  450  ', 45000],
  ])('parses %s as %d paise', (text, paise) => {
    expect(parseRupees(text)).toBe(paise);
  });

  it.each(['', ' ', '-5', '1.234', '1e5', 'abc', '.5', '5.', '1,2', '12,3456', '₹', '1 000', '१२३'])(
    'rejects %j',
    (text) => {
      expectCoreError(() => parseRupees(text), 'INVALID_MONEY_FORMAT');
    },
  );

  it('rejects amounts too large to handle exactly', () => {
    expectCoreError(() => parseRupees('12345678901234'), 'INVALID_MONEY_FORMAT');
  });

  it('is exact where floating point is not (0.1 + 0.2 style traps)', () => {
    expect(parseRupees('0.30')).toBe(30);
    expect(parseRupees('1.15')).toBe(115); // 1.15 * 100 === 114.99999999999999 in floating point
    expect(parseRupees('4.35')).toBe(435); // 4.35 * 100 === 434.99999999999994
  });

  it('rejects non-text input', () => {
    expectCoreError(() => parseRupees(120 as unknown as string), 'INVALID_MONEY_FORMAT');
  });
});

describe('formatINR', () => {
  it.each([
    [12345678, '₹1,23,456.78'],
    [150000, '₹1,500'],
    [0, '₹0'],
    [5, '₹0.05'],
    [99, '₹0.99'],
    [100, '₹1'],
    [-50000, '-₹500'],
    [-1, '-₹0.01'],
    [100000000, '₹10,00,000'],
    [999999900, '₹99,99,999'],
    [123456789012, '₹1,23,45,67,890.12'],
  ])('formats %d paise as %s', (paise, text) => {
    expect(formatINR(paise)).toBe(text);
  });

  it('can always show paise', () => {
    expect(formatINR(150000, { paise: 'always' })).toBe('₹1,500.00');
  });

  it('can hide the symbol', () => {
    expect(formatINR(150050, { symbol: false })).toBe('1,500.50');
  });

  it('refuses unsafe numbers', () => {
    expectCoreError(() => formatINR(1.5), 'INVALID_AMOUNT');
  });

  it('parse(format(x)) returns x for any amount (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (paise) => {
        const text = formatINR(paise, { symbol: false, paise: 'always' });
        expect(parseRupees(text)).toBe(paise);
      }),
      { numRuns: 2000 },
    );
  });
});

describe('safe integer helpers', () => {
  it.each([1.5, NaN, Infinity, 2 ** 53, -(2 ** 53)])('assertSafeMinor rejects %s', (n) => {
    expectCoreError(() => assertSafeMinor(n), 'INVALID_AMOUNT');
  });

  it('accepts ordinary and negative integers', () => {
    expect(() => assertSafeMinor(0)).not.toThrow();
    expect(() => assertSafeMinor(-250)).not.toThrow();
  });

  it('sumMinor adds exactly', () => {
    expect(sumMinor([1, 2, 3])).toBe(6);
    expect(sumMinor([])).toBe(0);
  });

  it('refuses to continue when a sum would not be exact', () => {
    expectCoreError(() => addMinor(Number.MAX_SAFE_INTEGER, 1), 'INVALID_AMOUNT');
    expectCoreError(() => sumMinor([Number.MAX_SAFE_INTEGER, 1]), 'INVALID_AMOUNT');
  });
});
