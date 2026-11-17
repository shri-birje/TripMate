/**
 * Today's date as "YYYY-MM-DD" in the phone's own calendar (not UTC), so a trip
 * counts as "ongoing" on the right day wherever the person is.
 * `now` can be passed in for testing.
 */
export function todayIso(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
