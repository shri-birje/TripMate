import type { Trip } from '@tripmate/core';

/**
 * Search over the trips ALREADY LOADED on the device, by trip NAME only (case-insensitive, ignores accents and
 * surrounding spaces; every word typed must appear in the name). It never calls the backend, and it does not search
 * destinations, travellers, dates or expenses (those are not supported and are not offered).
 */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function searchTripsByName(trips: readonly Trip[], query: string): Trip[] {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return trips.filter((t) => {
    const name = fold(t.name);
    return words.every((w) => name.includes(w));
  });
}
