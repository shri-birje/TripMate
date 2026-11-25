import { formatDateInput, rawCursorAfterEdit } from './dateInput';
import { partsOfIso } from './calendar';
import { SHARES_WEIGHT_MAX } from './expense';

/**
 * Input filtering: what a text box accepts WHILE the person types or pastes (M5 input validation refinement).
 *
 * One rule for every way text arrives (a key press, a paste, a drop, autofill): the box is given its previous text and the text it
 * would become, and these functions return the text it should hold. A change that would make an impossible value is REFUSED as a whole
 * (the previous text stays); it is never trimmed, rounded or "fixed" into something the person did not type. Removing text is always
 * allowed, so nobody gets stuck correcting a value. These helpers only decide what may be TYPED: the existing parsers (parseRupees,
 * parsePercent, parseWeight, parseDateInput) and the database still validate everything again at save time.
 *
 * Money is text until the very end: no number is ever calculated from these strings here (floating point never touches an amount).
 */

const isDigit = (ch: string) => ch >= '0' && ch <= '9'; // ASCII digits only

/** The characters that were added by an edit (everything the old and new text do not share at their start and end). */
function diffOf(previous: string, next: string): { prefix: number; added: string } {
  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  return { prefix, added: next.slice(prefix, next.length - suffix) };
}
const insertedText = (previous: string, next: string) => diffOf(previous, next).added;

export type NumericKind = 'money' | 'percent' | 'shares';

/** The largest whole-rupee part of an amount (keeps rupees x 100 inside the safe integer range; same limit as parseRupees). */
export const MONEY_MAX_WHOLE_DIGITS = 13;

/** Whether `text` is a value the box may hold at any moment while typing (it can still be unfinished, like "20." or ""). */
export function isAcceptableNumericText(kind: NumericKind, text: string): boolean {
  if (text === '') return true;
  if (kind === 'shares') return /^\d{1,7}$/.test(text) && Number(text) <= SHARES_WEIGHT_MAX;
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(text);
  if (!m) return false;
  const whole = m[1] ?? '';
  if (kind === 'money') return whole.length <= MONEY_MAX_WHOLE_DIGITS;
  // percent: 0 to 100 with at most two decimals ("100" or "100.00" at most)
  if (whole.length > 3) return false;
  if (whole === '' ) return text.startsWith('.');
  const n = Number(whole);
  if (n > 100) return false;
  if (n === 100 && /[1-9]/.test(m[2] ?? '')) return false;
  return true;
}

/**
 * The text a number box should hold after an edit. Letters, signs, spaces and other symbols never appear. A third decimal digit,
 * a second decimal point, too many digits, or (shares) any decimal point makes the whole change refused. A pasted "1,200.50" loses its
 * grouping commas and spaces (nothing else about the number changes).
 */
export function filterNumericInput(kind: NumericKind, previous: string, next: string): string {
  if (next === previous) return previous;
  const { added } = diffOf(previous, next);
  if (added === '') return isAcceptableNumericText(kind, next) ? next : previous; // only removal: fine if the result is fine
  let body = next;
  if (kind === 'money') {
    // A pasted amount may carry the rupee sign and Indian/Western grouping ("₹1,23,456.50"): that is all that is dropped. It is judged on
    // the whole new text (a paste over a selection can share characters with the old text, so the edit alone cannot be trusted).
    body = next.trim().replace(/^₹\s*/, '');
    if (body.includes(',')) {
      if (!/^\d{1,3}(,\d{2,3})+(\.\d{1,2})?$/.test(body)) return previous; // commas in the wrong places: refuse, never guess
      body = body.replace(/,/g, '');
    }
  }
  // Anything else that is not a digit or a decimal point (letters, signs, symbols, spaces) refuses the whole change.
  if (!/^[\d.]*$/.test(body)) return previous;
  return isAcceptableNumericText(kind, body) ? body : previous;
}

/** True when a box holds text that is still unfinished ("", ".", "20."): fine while typing, not fine to submit. */
export const isUnfinishedNumber = (text: string): boolean => text === '' || text === '.' || text.endsWith('.');

// ---------------------------------------------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------------------------------------------

/** The years a typed date may be in. The same limits as parseDateInput and the calendar. */
export const DATE_INPUT_MIN_ISO = '2000-01-01';
export const DATE_INPUT_MAX_ISO = '2100-12-31';

export interface DateRange {
  minIso: string;
  maxIso: string;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function dmyOf(year: number, month: number, day: number): string {
  return `${pad2(day)}/${pad2(month)}/${year}`;
}

function nextDay(y: number, m: number, d: number): [number, number, number] {
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate(); // days in month m (1-based) via day 0 of the next month
  if (d < dim) return [y, m, d + 1];
  if (m < 12) return [y, m + 1, 1];
  return [y + 1, 1, 1];
}

/**
 * Whether the text could still become a real date inside the range: it must be the start of the DD/MM/YYYY text of at least one
 * real calendar day between the two limits. That one rule rejects a day of 00 or 32, a month of 00 or 13, 31 in a 30-day month,
 * 29 February in a year that is not a leap year (once the year is complete) and, for an expense, any day outside the trip.
 * A single digit that can only be the second digit of a day or month ("5", "27/2") is allowed: it is padded when the "/" arrives.
 */
export function isDateTextAllowed(text: string, range: DateRange = { minIso: DATE_INPUT_MIN_ISO, maxIso: DATE_INPUT_MAX_ISO }): boolean {
  if (text === '') return true;
  if (!/^[\d/]+$/.test(text) || text.length > 10) return false;
  const lo = partsOfIso(range.minIso);
  const hi = partsOfIso(range.maxIso);
  if (!lo || !hi) return false;
  // "5" is a day starting with 0, "27/2" a month starting with 0: test the padded spelling as well.
  const candidates = [text];
  const segs = text.split('/');
  if (segs.length <= 2 && segs[segs.length - 1]!.length === 1 && segs.length <= 2) {
    const padded = [...segs];
    padded[padded.length - 1] = `0${padded[padded.length - 1]}`;
    candidates.push(padded.join('/'));
  }
  let [y, m, d] = [lo.year, lo.month, lo.day];
  const end = hi.year * 10000 + hi.month * 100 + hi.day;
  // Walk the days of the range; stop at the first match. (At most about 37,000 short comparisons, only on a rejected key press.)
  while (y * 10000 + m * 100 + d <= end) {
    const dmy = dmyOf(y, m, d);
    for (const c of candidates) if (dmy.startsWith(c)) return true;
    [y, m, d] = nextDay(y, m, d);
  }
  return false;
}

export interface DateEditResult {
  text: string;
  cursor: number;
}

/**
 * What a date box should hold after an edit (typing, paste, delete, replace), or null when the edit is refused and the box should keep
 * its text. The text is shaped as DD/MM/YYYY first (digits only, slashes inserted), then checked with `isDateTextAllowed`.
 * Removing text from the end is always allowed (so a wrong date can always be corrected); removing from the middle is refused only when it
 * would leave an impossible date. Edits that add nothing a date can contain (letters, symbols)
 * are refused, even when they replace a selection, so the old date is never lost to a stray key.
 */
export function applyDateEdit(previous: string, next: string, range?: DateRange): DateEditResult | null {
  if (next === previous) return { text: previous, cursor: previous.length };
  const added = insertedText(previous, next);
  const cursor = rawCursorAfterEdit(previous, next);
  const shaped = formatDateInput(next, cursor);
  if (added === '') {
    // Only removal. Taking text off the END always works (what is left is the start of the same date, so it is never impossible), which is
    // the way out of any mistake. Taking a digit out of the MIDDLE is allowed when what is left is still a possible date; otherwise it is
    // refused (31/01 with the 1 of the month removed would read 31/00), and the person can delete from the end or retype instead.
    return previous.startsWith(next) || isDateTextAllowed(shaped.text, range) ? shaped : null;
  }
  if (![...added].some((ch) => isDigit(ch) || ch === '/' || ch === '-' || ch === '.')) return null; // nothing but letters/symbols
  return isDateTextAllowed(shaped.text, range) ? shaped : null;
}
