import { describe, expect, it } from 'vitest';
import { parseRupees } from './money';
import { parseDateInput } from './trip';
import { parsePercent, parseWeight, plainRupees } from './expenseView';
import { applyDateEdit, filterNumericInput, isAcceptableNumericText, isDateTextAllowed, isUnfinishedNumber } from './inputFilter';

/** Types `text` one character at a time into a box that holds `start`, the way a keyboard does. */
const typeInto = (kind: 'money' | 'percent' | 'shares', text: string, start = '') => [...text].reduce((v, ch) => filterNumericInput(kind, v, v + ch), start);
const typeDate = (text: string, range?: { minIso: string; maxIso: string }, start = '') =>
  [...text].reduce((v, ch) => applyDateEdit(v, v + ch, range)?.text ?? v, start);

describe('money input', () => {
  it.each([
    ['323', '323'],
    ['323.4', '323.4'],
    ['323.45', '323.45'],
    ['323.456', '323.45'], // the third decimal digit is not accepted
    ['32abc', '32'], // letters never appear
    ['32@', '32'],
    ['32..45', '32.45'], // the second point is not accepted
    ['-5', '5'], // no minus sign
    ['1e5', '15'],
    ['20.', '20.'], // an unfinished amount is allowed while typing
  ])('typing %s gives %s', (typed, shown) => expect(typeInto('money', typed)).toBe(shown));

  it('refuses a paste as a whole when it would break a rule, never trimming it', () => {
    expect(filterNumericInput('money', '', '323.456')).toBe('');
    expect(filterNumericInput('money', '', '32..45')).toBe('');
    expect(filterNumericInput('money', '', '32abc')).toBe('');
    expect(filterNumericInput('money', '', '-5')).toBe('');
    expect(filterNumericInput('money', '', '1e5')).toBe('');
    expect(filterNumericInput('money', '12', '12abc')).toBe('12');
    expect(filterNumericInput('money', '', '32@')).toBe('');
  });

  it('accepts a clean paste, including grouping that parseRupees understands', () => {
    expect(filterNumericInput('money', '', '1200.50')).toBe('1200.50');
    expect(filterNumericInput('money', '', '1,23,456.50')).toBe('123456.50');
    expect(filterNumericInput('money', '', '₹1,200')).toBe('1200');
    expect(filterNumericInput('money', '', '1,2')).toBe(''); // commas in the wrong place: refused
  });

  it('never refuses a deletion that leaves an acceptable value', () => {
    expect(filterNumericInput('money', '20.45', '20.4')).toBe('20.4');
    expect(filterNumericInput('money', '20.45', '')).toBe('');
    expect(filterNumericInput('money', '20.5', '205')).toBe('205'); // the point removed: "205" is a fine amount
  });

  it('refuses inserting in the middle when the result would be impossible', () => {
    expect(filterNumericInput('money', '2.45', '2.145')).toBe('2.45');
    expect(filterNumericInput('money', '2.45', '2..45')).toBe('2.45');
    expect(filterNumericInput('money', '245', '24.5')).toBe('24.5');
  });

  it('caps the whole-rupee part at 13 digits (the parseRupees limit)', () => {
    expect(isAcceptableNumericText('money', '1'.repeat(13))).toBe(true);
    expect(isAcceptableNumericText('money', '1'.repeat(14))).toBe(false);
  });

  it('converts what the filter allows into integer paise through parseRupees, with no floating point', () => {
    expect(parseRupees('323')).toBe(32300);
    expect(parseRupees('323.4')).toBe(32340);
    expect(parseRupees('323.45')).toBe(32345);
    expect(parseRupees('0.07')).toBe(7);
    expect(parseRupees('19.99')).toBe(1999);
    expect(parseRupees('1'.repeat(13))).toBe(Number('1'.repeat(13)) * 100);
  });

  it('flags unfinished text so it can be refused at save time', () => {
    for (const t of ['', '.', '20.']) expect(isUnfinishedNumber(t)).toBe(true);
    for (const t of ['20', '20.5', '0.5']) expect(isUnfinishedNumber(t)).toBe(false);
    expect(() => parseRupees('20.')).toThrow();
    expect(() => parseRupees('.5')).toThrow();
  });
});

describe('percentage input', () => {
  it.each([
    ['33.33', '33.33'],
    ['33.333', '33.33'],
    ['100', '100'],
    ['101', '10'], // 101 is over 100%: the last digit is refused
    ['100.5', '100.'], // nothing is allowed after 100 except zeros
    ['100.00', '100.00'],
    ['12abc', '12'],
    ['-5', '5'],
    ['5..5', '5.5'],
  ])('typing %s gives %s', (typed, shown) => expect(typeInto('percent', typed)).toBe(shown));

  it('still reads through parsePercent as whole basis points', () => {
    expect(parsePercent('33.33')).toBe(3333);
    expect(parsePercent('100')).toBe(10000);
    expect(parsePercent('0.5')).toBe(50);
    expect(parsePercent('7.5')).toBe(750);
  });

  it('refuses pastes that break the rules', () => {
    expect(filterNumericInput('percent', '', '150')).toBe('');
    expect(filterNumericInput('percent', '', '12.345')).toBe('');
    expect(filterNumericInput('percent', '', '1,2')).toBe('');
    expect(filterNumericInput('percent', '', '50%')).toBe('');
  });
});

describe('shares input', () => {
  it.each([
    ['12', '12'],
    ['1.5', '15'], // no decimal point
    ['-3', '3'],
    ['3abc', '3'],
    ['1000000', '1000000'],
    ['1000001', '100000'], // over the database limit: the last digit is refused
    ['12345678', '123456'],
  ])('typing %s gives %s', (typed, shown) => expect(typeInto('shares', typed)).toBe(shown));

  it('refuses a pasted decimal, sign or letters as a whole', () => {
    expect(filterNumericInput('shares', '', '1.5')).toBe('');
    expect(filterNumericInput('shares', '', '-3')).toBe('');
    expect(filterNumericInput('shares', '', '3x')).toBe('');
    expect(filterNumericInput('shares', '', '2000000')).toBe('');
    expect(filterNumericInput('shares', '', '25')).toBe('25');
  });

  it('keeps the existing limits at save time', () => {
    expect(parseWeight('1000000')).toBe(1000000);
    expect(parseWeight('0')).toBeNull();
  });
});

describe('date input: impossible values are refused while typing', () => {
  it('refuses a day over 31, a day of 00, a month over 12 and a month of 00', () => {
    expect(typeDate('32')).toBe('3');
    expect(typeDate('00')).toBe('0');
    expect(typeDate('2713')).toBe('27/1');
    expect(typeDate('2700')).toBe('27/0');
    expect(typeDate('27122026')).toBe('27/12/2026');
  });

  it('knows the length of every month', () => {
    expect(typeDate('3104')).toBe('31/0'); // 31 April does not exist
    expect(typeDate('3004')).toBe('30/04');
    expect(typeDate('3102')).toBe('31/0');
    expect(typeDate('3006')).toBe('30/06');
    expect(typeDate('3106')).toBe('31/0');
    expect(typeDate('3107')).toBe('31/07');
  });

  it('handles leap years', () => {
    expect(typeDate('29022024')).toBe('29/02/2024'); // 2024 is a leap year
    expect(typeDate('29022028')).toBe('29/02/2028');
    expect(typeDate('29022100')).toBe('29/02/200'); // no leap day exists in 21xx up to 2100, so the 1 is refused
    expect(typeDate('29022026')).toBe('29/02/202'); // not a leap year: the last digit is refused
    expect(typeDate('29022027')).toBe('29/02/202');
    expect(typeDate('29022000')).toBe('29/02/2000'); // divisible by 400
    expect(typeDate('28022027')).toBe('28/02/2027');
  });

  it('accepts a single digit that will be padded', () => {
    expect(typeDate('5')).toBe('5');
    expect(typeDate('5/')).toBe('05');
    expect(typeDate('5/2/2027')).toBe('05/02/2027');
  });

  it('keeps years in the supported range (2000 to 2100)', () => {
    expect(typeDate('01011999')).toBe('01/01');
    expect(typeDate('01012101')).toBe('01/01/210');
    expect(typeDate('01012100')).toBe('01/01/2100');
  });

  it('refuses letters and symbols without losing the old date, even over a selection', () => {
    expect(applyDateEdit('27/12/2026', 'x')).toBeNull();
    expect(applyDateEdit('27/12/2026', '27/12/2026a')).toBeNull();
    expect(applyDateEdit('27/12/2026', '27/12/2026@')).toBeNull();
  });

  it('always lets text be removed or replaced', () => {
    expect(applyDateEdit('27/12/2026', '27/12/202')?.text).toBe('27/12/202');
    expect(applyDateEdit('27/12/2026', '')?.text).toBe('');
    expect(applyDateEdit('27/12/2026', '9')?.text).toBe('9'); // select all and type a new first digit
  });

  it('refuses a deletion in the middle that would leave an impossible date, but never one from the end', () => {
    expect(applyDateEdit('31/01/2026', '31/0/2026')).toBeNull(); // would read 31/00/2026
    expect(applyDateEdit('31/12/2026', '31/2/2026')).toBeNull(); // would read 31/02/2026
    expect(applyDateEdit('27/12/2026', '27/1/2026')?.text).toBe('27/01/2026'); // still a real date: allowed
    expect(applyDateEdit('31/01/2026', '31/01/')?.text).toBe('31/01'); // from the end: always
    expect(applyDateEdit('31/01/2026', '3')?.text).toBe('3');
    expect(applyDateEdit('31/01/2026', '')?.text).toBe('');
  });

  it('applies the same rules to a pasted date', () => {
    expect(applyDateEdit('', '32/01/2026')).toBeNull();
    expect(applyDateEdit('', '29/02/2027')).toBeNull();
    expect(applyDateEdit('', '29/02/2028')?.text).toBe('29/02/2028');
    expect(applyDateEdit('', '2028-02-29')?.text).toBe('29/02/2028');
    expect(applyDateEdit('', '13/13/2026')).toBeNull();
    expect(applyDateEdit('', '01/01/1999')).toBeNull();
    expect(applyDateEdit('', '01/01/2101')).toBeNull();
  });

  it('a date that passes the filter always passes the existing parser', () => {
    for (const t of ['29/02/2028', '31/12/2100', '01/01/2000', '30/04/2026']) {
      expect(isDateTextAllowed(t)).toBe(true);
      expect(parseDateInput(t)).not.toBeNull();
    }
    for (const t of ['29/02/2027', '31/04/2026', '32/01/2026', '01/13/2026']) {
      expect(isDateTextAllowed(t)).toBe(false);
      expect(parseDateInput(t)).toBeNull();
    }
  });

  it('real days across all supported years are accepted (every 97th day sampled)', () => {
    let day = Date.UTC(2000, 0, 1);
    const last = Date.UTC(2100, 11, 31);
    let count = 0;
    while (day <= last) {
      const d = new Date(day);
      const text = `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
      if (count % 97 === 0) expect(isDateTextAllowed(text), text).toBe(true); // a sample (the full scan per day would be quadratic)
      day += 86_400_000;
      count++;
    }
    expect(count).toBe(36890);
  });
});

describe('date input: an expense date stays inside the trip', () => {
  const trip = { minIso: '2026-12-27', maxIso: '2027-01-03' };

  it('accepts the first day, the last day and days between', () => {
    expect(typeDate('27122026', trip)).toBe('27/12/2026');
    expect(typeDate('03012027', trip)).toBe('03/01/2027');
    expect(typeDate('31122026', trip)).toBe('31/12/2026');
  });

  it('refuses the day before and the day after the trip', () => {
    expect(typeDate('26', trip)).toBe('2'); // 26 December is the day before the trip: the 6 is refused
    expect(typeDate('04', trip)).toBe('0'); // there is no 04 in the trip
    expect(applyDateEdit('', '26/12/2026', trip)).toBeNull();
    expect(applyDateEdit('', '04/01/2027', trip)).toBeNull();
    expect(isDateTextAllowed('26/12/2026', trip)).toBe(false);
    expect(isDateTextAllowed('04/01/2027', trip)).toBe(false);
    expect(isDateTextAllowed('27/12/2026', trip)).toBe(true);
    expect(isDateTextAllowed('03/01/2027', trip)).toBe(true);
  });

  it('refuses a month or year that has no day inside the trip', () => {
    expect(typeDate('2702', trip)).toBe('27'); // the trip has no February
    expect(typeDate('2712', trip)).toBe('27/12');
    expect(typeDate('27122027', trip)).toBe('27/12/202');
    expect(applyDateEdit('', '15/06/2026', trip)).toBeNull();
  });

  it('works for a one-day trip and a leap-day trip', () => {
    const one = { minIso: '2028-02-29', maxIso: '2028-02-29' };
    expect(typeDate('29022028', one)).toBe('29/02/2028');
    expect(typeDate('28022028', one)).toBe('2'); // only the 29th is inside the trip
    expect(isDateTextAllowed('01/03/2028', one)).toBe(false);
  });

  it('refuses a pasted date outside the trip as a whole', () => {
    expect(applyDateEdit('27/12/2026', '2027-02-01', trip)).toBeNull();
    expect(applyDateEdit('27/12/2026', '28/12/2026', trip)?.text).toBe('28/12/2026');
  });
});

describe('plainRupees (the text an edit form starts with)', () => {
  it('has no grouping commas, so every character of it can be edited under the money filter', () => {
    expect(plainRupees(120000)).toBe('1200');
    expect(plainRupees(120050)).toBe('1200.50');
    expect(plainRupees(7)).toBe('0.07');
    expect(plainRupees(12345678)).toBe('123456.78');
    for (const minor of [1, 99, 100, 101, 120000, 123456789]) {
      const text = plainRupees(minor);
      expect(isAcceptableNumericText('money', text)).toBe(true);
      expect(parseRupees(text)).toBe(minor); // round trip, whole-number arithmetic only
    }
  });
});
