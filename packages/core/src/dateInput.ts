/**
 * Live formatting for the date text boxes (Start date / End date).
 *
 * People type dates as DD/MM/YYYY. This module turns whatever is in the box after each
 * keystroke or paste into that shape, and says where the cursor should go:
 *
 *   27122026   ->  27/12/2026     (slashes are inserted for you)
 *   27/12/2026 ->  27/12/2026     (already formatted: unchanged)
 *   5/1/2027   ->  05/01/2027     (a single-digit day or month followed by "/" is padded)
 *   27         ->  27             (no slash until a third digit arrives)
 *
 * Only digits and the automatic "/" are ever kept: letters, spaces, symbols and non-ASCII
 * digits are rejected. A whole pasted date written 2026-12-27, 27-12-2026 or 27.12.2026
 * is converted to DD/MM/YYYY.
 *
 * IMPORTANT: this only SHAPES the text. It never judges or "fixes" a date: 31/02/2026 stays
 * 31/02/2026, and the existing validation (parseDateInput) still rejects it. It cannot turn
 * an invalid date into a valid one.
 */
export const DATE_INPUT_MAX_LENGTH = 10; // DD/MM/YYYY
const MAX_DIGITS = 8;

export interface FormattedDateInput {
  text: string;
  /** Where the cursor belongs in `text` (0 to text.length). */
  cursor: number;
}

const ISO_PASTE = /^\s*(\d{4})[-./](\d{1,2})[-./](\d{1,2})\s*$/;
const DMY_OTHER_SEPARATORS = /^\s*(\d{1,2})[-.](\d{1,2})[-.](\d{4})\s*$/;

const isDigit = (ch: string) => ch >= '0' && ch <= '9'; // ASCII digits only (no Arabic-Indic, Devanagari, full-width...)

/**
 * Where the cursor is after an edit, worked out from the old and new text alone: everything
 * the two share at the start and at the end is unchanged, so the edit sits in between and
 * the cursor is at its end. Typing at the end, in the middle, backspace, selecting and
 * replacing, and paste all come out right, and it does not depend on selection events
 * (which can lag behind fast typing).
 */
export function rawCursorAfterEdit(previous: string, next: string): number {
  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  return next.length - suffix;
}

/** Shapes the text of a date box. `rawCursor` is where the cursor is in `raw` (defaults to the end). */
export function formatDateInput(raw: string, rawCursor: number = raw.length): FormattedDateInput {
  let text = raw;
  let cursor = Math.max(0, Math.min(raw.length, rawCursor));

  // 1. A whole pasted date written with other separators becomes DD/MM/YYYY (cursor to the end).
  const iso = ISO_PASTE.exec(text);
  const dmy = iso ? null : DMY_OTHER_SEPARATORS.exec(text);
  if (iso) {
    text = `${iso[3]}/${iso[2]}/${iso[1]}`;
    cursor = text.length;
  } else if (dmy) {
    text = `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
    cursor = text.length;
  }

  // 2. Keep only digits and single slashes (no leading slash, no doubled slashes), tracking the cursor.
  let cleaned = '';
  let cleanedCursor = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const keep = isDigit(ch) || (ch === '/' && cleaned.length > 0 && cleaned[cleaned.length - 1] !== '/');
    if (keep) {
      cleaned += ch;
      if (i < cursor) cleanedCursor++;
    }
  }

  // 3. A single-digit day or month that is followed by a "/" is padded: "5/" -> "05", "27/2/2026" -> "27/02/2026".
  const parts = cleaned.split('/');
  let padsBeforeCursor = 0;
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (i < 2 && parts.length > i + 1 && part.length === 1) {
      parts[i] = `0${part}`;
      if (cleanedCursor > offset) padsBeforeCursor++; // the cursor is after the padded digit's start
    }
    offset += part.length + 1; // the part and its slash, in the CLEANED text
  }

  // 4. Regroup the digits: DD, then MM, then YYYY (at most 8 digits).
  const digits = parts.join('').replace(/\//g, '').slice(0, MAX_DIGITS);
  let formatted = digits.slice(0, 2);
  if (digits.length > 2) formatted += `/${digits.slice(2, 4)}`;
  if (digits.length > 4) formatted += `/${digits.slice(4, MAX_DIGITS)}`;

  // 5. Put the cursor after the same number of digits it was after before.
  let digitsBefore = 0;
  for (let i = 0; i < cleanedCursor; i++) if (isDigit(cleaned[i]!)) digitsBefore++;
  digitsBefore = Math.min(digitsBefore + padsBeforeCursor, digits.length);

  let newCursor: number;
  if (digitsBefore <= 0) {
    newCursor = 0;
  } else if (digitsBefore >= digits.length) {
    newCursor = formatted.length;
  } else {
    let seen = 0;
    let idx = 0;
    while (idx < formatted.length && seen < digitsBefore) {
      if (isDigit(formatted[idx]!)) seen++;
      idx++;
    }
    // If the cursor was right after a "/" and there is a "/" here, stay after it (so deleting a digit feels natural).
    if (cleanedCursor > 0 && cleaned[cleanedCursor - 1] === '/' && formatted[idx] === '/') idx++;
    newCursor = idx;
  }
  return { text: formatted, cursor: newCursor };
}
