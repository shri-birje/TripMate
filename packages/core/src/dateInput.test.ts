import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DATE_INPUT_MAX_LENGTH, formatDateInput, rawCursorAfterEdit } from './dateInput';
import { parseDateInput } from './trip';

const fmt = (raw: string, cursor?: number) => formatDateInput(raw, cursor).text;

describe('digits without slashes (the slashes are inserted for you)', () => {
  it.each([
    ['27122026', '27/12/2026'],
    ['05012027', '05/01/2027'],
    ['01012027', '01/01/2027'],
    ['31122099', '31/12/2099'],
    ['29022028', '29/02/2028'],
  ])('%s -> %s', (raw, expected) => {
    expect(fmt(raw)).toBe(expected);
  });

  it('partial input: no slash until a third digit, then each group appears as it is typed', () => {
    const steps: [string, string][] = [
      ['', ''], ['2', '2'], ['27', '27'], ['271', '27/1'], ['2712', '27/12'], ['27122', '27/12/2'],
      ['271220', '27/12/20'], ['2712202', '27/12/202'], ['27122026', '27/12/2026'],
    ];
    for (const [raw, expected] of steps) expect(fmt(raw)).toBe(expected);
  });

  it('ignores digits beyond the eighth', () => {
    expect(fmt('2712202699')).toBe('27/12/2026');
    expect(fmt('27/12/2026999')).toBe('27/12/2026');
  });
});

describe('text that already has slashes', () => {
  it('correctly formatted dates are left alone', () => {
    for (const d of ['27/12/2026', '01/01/2027', '29/02/2028', '27/12', '27', '']) expect(fmt(d)).toBe(d);
  });

  it('a single-digit day or month followed by a slash is padded with a zero', () => {
    expect(fmt('5/1/2027')).toBe('05/01/2027');
    expect(fmt('5/')).toBe('05');
    expect(fmt('27/1/2026')).toBe('27/01/2026');
    expect(fmt('27/2/2026')).toBe('27/02/2026');
    expect(fmt('7/12/2026')).toBe('07/12/2026');
    expect(fmt('5/1/')).toBe('05/01');
  });

  it('a trailing slash is not kept (it comes back by itself when the next digit is typed)', () => {
    expect(fmt('27/')).toBe('27');
    expect(fmt('27/12/')).toBe('27/12');
  });

  it('tidies stray slashes', () => {
    expect(fmt('/27')).toBe('27');
    expect(fmt('27//12//2026')).toBe('27/12/2026');
    expect(fmt('///')).toBe('');
  });

  it('tidies stray slashes BEFORE padding, so single-digit parts still pad correctly', () => {
    expect(fmt('5//1//2027')).toBe('05/01/2027');
    expect(fmt('//5/1/2027')).toBe('05/01/2027');
    expect(fmt('5///1')).toBe('05/1');
  });
});

describe('only numbers and the automatic slashes are allowed', () => {
  it('letters are rejected', () => {
    expect(fmt('abc')).toBe('');
    expect(fmt('27a12b2026')).toBe('27/12/2026');
    expect(fmt('ab27xy12!@#2026')).toBe('27/12/2026');
    expect(fmt('twenty-seven')).toBe('');
  });

  it('spaces, symbols and punctuation typed one at a time are rejected', () => {
    for (const ch of ['-', '.', ',', ' ', '*', '#', '(', ')', '+', '\\', '_', '\t', '\n']) expect(fmt(`27${ch}`)).toBe('27');
    expect(fmt(' 27 12 2026 ')).toBe('27/12/2026');
  });

  it('digits from other scripts and look-alike characters are rejected', () => {
    expect(fmt('१२/०१/२०२६')).toBe(''); // Devanagari digits
    expect(fmt('٢٧/١٢/٢٠٢٦')).toBe(''); // Arabic-Indic digits
    expect(fmt('２７/１２/２０２６')).toBe(''); // full-width digits
    expect(fmt('²7')).toBe('7'); // superscript two is not a digit
    expect(fmt('27😀12')).toBe('27/12');
  });

  it('never lets anything but digits and "/" through (property)', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (s) => {
        expect(fmt(s)).toMatch(/^[0-9/]*$/);
      }),
      { numRuns: 1500 },
    );
  });
});

describe('pasting', () => {
  it('numeric dates, with or without slashes', () => {
    expect(fmt('27122026')).toBe('27/12/2026');
    expect(fmt('27/12/2026')).toBe('27/12/2026');
    expect(fmt('05/01/2027')).toBe('05/01/2027');
  });

  it('whole dates written with dashes or dots become DD/MM/YYYY', () => {
    expect(fmt('27-12-2026')).toBe('27/12/2026');
    expect(fmt('27.12.2026')).toBe('27/12/2026');
    expect(fmt('5-1-2027')).toBe('05/01/2027');
    expect(fmt('5.1.2027')).toBe('05/01/2027');
    expect(fmt(' 27-12-2026 ')).toBe('27/12/2026');
  });

  it('an ISO date (2026-12-27) becomes DD/MM/YYYY', () => {
    expect(fmt('2026-12-27')).toBe('27/12/2026');
    expect(fmt('2026-1-5')).toBe('05/01/2026');
    expect(fmt('2026/12/27')).toBe('27/12/2026');
    expect(fmt('2026.12.27')).toBe('27/12/2026');
  });

  it('pasted text with extra words keeps only the digits', () => {
    expect(fmt('abc27122026')).toBe('27/12/2026');
    expect(fmt('date: 27122026!')).toBe('27/12/2026');
  });

  it('after a paste the cursor goes to the end', () => {
    expect(formatDateInput('27122026').cursor).toBe(10);
    expect(formatDateInput('2026-12-27').cursor).toBe(10);
    expect(formatDateInput('27-12-2026').cursor).toBe(10);
  });
});

describe('what the text means: shaping never changes validity (no fixing, no breaking)', () => {
  const validIso = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2100;
  };

  it('valid dates stay valid and parse to the right day', () => {
    for (const [d, iso] of [['27122026', '2026-12-27'], ['29022028', '2028-02-29'], ['01012000', '2000-01-01'], ['31122100', '2100-12-31'], ['05012027', '2027-01-05']] as const) {
      expect(parseDateInput(fmt(d))).toBe(iso);
    }
  });

  it('invalid days and months are NOT corrected: they stay invalid for the validator to reject', () => {
    for (const bad of ['00012026', '32012026', '31042026', '30022026', '29022027', '29022100', '15132026', '15002026', '01011999', '01012101']) {
      const text = fmt(bad);
      expect(text).toHaveLength(10);
      expect(text).toBe(`${bad.slice(0, 2)}/${bad.slice(2, 4)}/${bad.slice(4)}`); // shaped, never altered
      expect(parseDateInput(text)).toBeNull();
    }
  });

  it('leap years: 29 February exists only in leap years', () => {
    expect(parseDateInput(fmt('29022028'))).toBe('2028-02-29');
    expect(parseDateInput(fmt('29022024'))).toBe('2024-02-29');
    expect(parseDateInput(fmt('29022000'))).toBe('2000-02-29'); // divisible by 400
    expect(parseDateInput(fmt('29022100'))).toBeNull(); // divisible by 100, not 400
    expect(parseDateInput(fmt('29022027'))).toBeNull();
    expect(parseDateInput(fmt('29022026'))).toBeNull();
  });

  it('any 8 digits: the shaped text is valid exactly when that calendar date really exists (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 99999999 }), (n) => {
        const digits = String(n).padStart(8, '0');
        const [dd, mm, yyyy] = [Number(digits.slice(0, 2)), Number(digits.slice(2, 4)), Number(digits.slice(4))];
        const parsed = parseDateInput(fmt(digits));
        expect(parsed !== null).toBe(validIso(yyyy, mm, dd));
      }),
      { numRuns: 4000 },
    );
  });

  it('every real date in 2000-2100 round-trips: typed as digits, shaped, parsed back to itself (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2000, max: 2100 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 }), (y, m, d) => {
        fc.pre(validIso(y, m, d));
        const typed = `${String(d).padStart(2, '0')}${String(m).padStart(2, '0')}${y}`;
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        expect(parseDateInput(fmt(typed))).toBe(iso);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('general properties (any text at all)', () => {
  it('the result always has the shape DD, DD/MM or DD/MM/YYYY (partial allowed), never longer than 10', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const t = fmt(s);
        expect(t.length).toBeLessThanOrEqual(DATE_INPUT_MAX_LENGTH);
        expect(t).toMatch(/^(\d{0,2}|\d{2}\/\d{1,2}|\d{2}\/\d{2}\/\d{1,4})$/);
      }),
      { numRuns: 3000 },
    );
  });

  it('is idempotent: shaping already-shaped text changes nothing (so editing a saved date never makes it "dirty")', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const once = fmt(s);
        expect(fmt(once)).toBe(once);
      }),
      { numRuns: 3000 },
    );
  });

  it('the cursor is always inside the text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: -5, max: 60 }), (s, c) => {
        const r = formatDateInput(s, c);
        expect(r.cursor).toBeGreaterThanOrEqual(0);
        expect(r.cursor).toBeLessThanOrEqual(r.text.length);
      }),
      { numRuns: 3000 },
    );
  });

  it('empty input stays empty', () => {
    expect(formatDateInput('')).toEqual({ text: '', cursor: 0 });
  });
});

describe('rawCursorAfterEdit (where the person edited)', () => {
  it('typing at the end puts the cursor at the end', () => {
    expect(rawCursorAfterEdit('27', '271')).toBe(3);
    expect(rawCursorAfterEdit('', '2')).toBe(1);
  });
  it('deleting the last character', () => {
    expect(rawCursorAfterEdit('27/12', '27/1')).toBe(4);
    expect(rawCursorAfterEdit('2', '')).toBe(0);
  });
  it('typing in the middle puts the cursor right after what was typed', () => {
    expect(rawCursorAfterEdit('27/12/2026', '275/12/2026')).toBe(3);
    expect(rawCursorAfterEdit('27/12/2026', '27/112/2026')).toBe(5);
  });
  it('backspace in the middle', () => {
    expect(rawCursorAfterEdit('27/12/2026', '27/2/2026')).toBe(3);
    expect(rawCursorAfterEdit('27/12/2026', '7/12/2026')).toBe(0);
  });
  it('paste or replace-all puts the cursor at the end', () => {
    expect(rawCursorAfterEdit('', '27122026')).toBe(8);
    expect(rawCursorAfterEdit('27/12/2026', '05012027')).toBe(8);
    expect(rawCursorAfterEdit('abc', 'xyz')).toBe(3);
  });
  it('no change keeps the cursor at the end of the shared text', () => {
    expect(rawCursorAfterEdit('27', '27')).toBe(2);
  });
  it('a repeated character gives an equivalent position (same text either way)', () => {
    expect(rawCursorAfterEdit('11', '111')).toBeGreaterThanOrEqual(1);
    expect(rawCursorAfterEdit('11', '111')).toBeLessThanOrEqual(3);
  });
  it('always inside the text, and the part after the cursor is untouched old text (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 20 }), fc.string({ maxLength: 20 }), (a, b) => {
        const c = rawCursorAfterEdit(a, b);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(b.length);
        expect(a.endsWith(b.slice(c))).toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
});

/**
 * A tiny stand-in for a text box: applies one keystroke at the cursor, then lets the formatter
 * reshape the result and place the cursor, exactly as the real field does.
 */
function box(start = '', cursor = start.length) {
  const s = { text: start, cursor };
  const apply = (raw: string, rawCursor: number) => {
    const r = formatDateInput(raw, rawCursor);
    s.text = r.text;
    s.cursor = r.cursor;
    return s;
  };
  const api = {
    state: s,
    type(chars: string) {
      for (const ch of chars) apply(s.text.slice(0, s.cursor) + ch + s.text.slice(s.cursor), s.cursor + 1);
      return api;
    },
    backspace() {
      if (s.cursor > 0) apply(s.text.slice(0, s.cursor - 1) + s.text.slice(s.cursor), s.cursor - 1);
      return api;
    },
  };
  return api;
}

describe('typing, deleting and cursor position (simulated text box)', () => {
  it('typing 27122026 one key at a time builds the date with the cursor always at the end', () => {
    const b = box();
    const seen: string[] = [];
    for (const ch of '27122026') {
      b.type(ch);
      seen.push(b.state.text);
      expect(b.state.cursor).toBe(b.state.text.length);
    }
    expect(seen).toEqual(['2', '27', '27/1', '27/12', '27/12/2', '27/12/20', '27/12/202', '27/12/2026']);
  });

  it('typing with slashes works too, including single-digit parts', () => {
    expect(box().type('27/12/2026').state.text).toBe('27/12/2026');
    expect(box().type('5/1/2027').state.text).toBe('05/01/2027');
    expect(box().type('5/1/2027').state.cursor).toBe(10);
  });

  it('letters and symbols typed in are ignored and the cursor stays put', () => {
    const b = box().type('27');
    b.type('a');
    expect(b.state).toEqual({ text: '27', cursor: 2 });
    b.type('-');
    expect(b.state).toEqual({ text: '27', cursor: 2 });
    b.type('1');
    expect(b.state.text).toBe('27/1');
  });

  it('backspace from the end removes one thing at a time, and steps over the automatic slashes smoothly', () => {
    const b = box('27/12/2026');
    const seen: string[] = [];
    while (b.state.text.length > 0) {
      b.backspace();
      seen.push(b.state.text);
    }
    expect(seen).toEqual(['27/12/202', '27/12/20', '27/12/2', '27/12', '27/1', '27', '2', '']);
  });

  it('backspace with the cursor just after an automatic slash moves over it without losing a digit', () => {
    const b = box('27/12/2026', 3); // cursor after the first slash
    b.backspace();
    expect(b.state.text).toBe('27/12/2026');
    expect(b.state.cursor).toBe(2);
  });

  it('deleting a digit in the middle keeps the date tidy and the cursor sensible', () => {
    const b = box('27/12/2026', 4); // after the "1" of the month
    b.backspace(); // 27/2/2026 -> month padded
    expect(b.state.text).toBe('27/02/2026');
    expect(b.state.cursor).toBe(3); // just after the slash, where the deleted digit was
  });

  it('deleting the first digit of the day', () => {
    const b = box('27/12/2026', 1);
    b.backspace();
    expect(b.state.text).toBe('07/12/2026');
    expect(b.state.cursor).toBe(0);
  });

  it('typing a digit in the middle shifts the later digits right, like a masked field (the last one falls off)', () => {
    const b = box('27/12/2026', 2);
    b.type('5');
    expect(b.state.text).toBe('27/51/2202');
    expect(b.state.cursor).toBe(4);
  });

  it('editing an existing date: replace the year by selecting it all and typing a new one', () => {
    const b = box('27/12/2026');
    b.backspace(); b.backspace(); b.backspace(); b.backspace(); // 27/12/
    b.type('2027');
    expect(b.state.text).toBe('27/12/2027');
  });

  it('typing past the end changes nothing', () => {
    const b = box('27/12/2026');
    b.type('9');
    expect(b.state).toEqual({ text: '27/12/2026', cursor: 10 });
  });

  it('backspace at the very start does nothing', () => {
    const b = box('27/12/2026', 0);
    b.backspace();
    expect(b.state).toEqual({ text: '27/12/2026', cursor: 0 });
  });

  it('a long random typing session never produces anything but a well-shaped date (property)', () => {
    fc.assert(
      fc.property(fc.array(fc.oneof(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '/', 'a', '-', ' ', 'BACK'), fc.constant('BACK')), { maxLength: 40 }), (keys) => {
        const b = box();
        for (const k of keys) k === 'BACK' ? b.backspace() : b.type(k);
        expect(b.state.text).toMatch(/^(\d{0,2}|\d{2}\/\d{1,2}|\d{2}\/\d{2}\/\d{1,4})$/);
        expect(b.state.cursor).toBeGreaterThanOrEqual(0);
        expect(b.state.cursor).toBeLessThanOrEqual(b.state.text.length);
      }),
      { numRuns: 1500 },
    );
  });
});
