import { afterEach, describe, expect, it } from 'vitest';
import { tripPhase } from '@tripmate/core';
import { todayIso } from './today';

/**
 * "Today" is the calendar day on the PERSON'S OWN clock, not in UTC. Trip dates are plain calendar
 * days, so a trip must count as "ongoing" on the day the person's own calendar says so, wherever
 * they are, with no off-by-one near midnight and across daylight-saving changes.
 */
describe('todayIso in different time zones', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  const at = (zone: string, utcIso: string) => {
    process.env.TZ = zone;
    return todayIso(new Date(utcIso));
  };

  it('the same instant is a different calendar day in different places (20:00 UTC on 27 Dec)', () => {
    expect(at('Pacific/Kiritimati', '2026-12-27T20:00:00Z')).toBe('2026-12-28'); // UTC+14: already the 28th
    expect(at('Asia/Kolkata', '2026-12-27T20:00:00Z')).toBe('2026-12-28'); // UTC+5:30: 01:30 on the 28th
    expect(at('Europe/London', '2026-12-27T20:00:00Z')).toBe('2026-12-27');
    expect(at('UTC', '2026-12-27T20:00:00Z')).toBe('2026-12-27');
    expect(at('America/Los_Angeles', '2026-12-27T20:00:00Z')).toBe('2026-12-27'); // 12:00 noon
    expect(at('Pacific/Pago_Pago', '2026-12-27T20:00:00Z')).toBe('2026-12-27'); // UTC-11: 09:00
  });

  it('the day changes at LOCAL midnight (India: 23:59:59 vs 00:00:00)', () => {
    expect(at('Asia/Kolkata', '2026-12-27T18:29:59Z')).toBe('2026-12-27'); // 23:59:59 local
    expect(at('Asia/Kolkata', '2026-12-27T18:30:00Z')).toBe('2026-12-28'); // 00:00:00 local
  });

  it('is correct around daylight-saving changes', () => {
    expect(at('Europe/London', '2026-03-28T23:59:59Z')).toBe('2026-03-28');
    expect(at('Europe/London', '2026-03-29T00:30:00Z')).toBe('2026-03-29'); // the clocks jump at 01:00
    expect(at('America/New_York', '2026-11-01T05:30:00Z')).toBe('2026-11-01'); // clocks fall back that morning
  });

  it('always has the form YYYY-MM-DD with zero padding', () => {
    expect(at('UTC', '2026-01-05T00:00:00Z')).toBe('2026-01-05');
    expect(at('UTC', '2026-12-31T23:59:59Z')).toBe('2026-12-31');
  });

  it('a trip starting or ending "today" is ongoing for the person, in every zone', () => {
    // A trip 28-30 Dec. At 20:00 UTC on 27 Dec it is already the 28th in India (ongoing) but still the 27th in London (upcoming).
    const phaseAt = (zone: string, utcIso: string) => tripPhase('2026-12-28', '2026-12-30', at(zone, utcIso));
    expect(phaseAt('Asia/Kolkata', '2026-12-27T20:00:00Z')).toBe('ongoing'); // starts today for them
    expect(phaseAt('Europe/London', '2026-12-27T20:00:00Z')).toBe('upcoming');
    // Ends 30 Dec: still ongoing at 23:59:59 local on the 30th, completed one second later.
    expect(phaseAt('Asia/Kolkata', '2026-12-30T18:29:59Z')).toBe('ongoing'); // ends today for them
    expect(phaseAt('Asia/Kolkata', '2026-12-30T18:30:00Z')).toBe('completed');
  });
});
