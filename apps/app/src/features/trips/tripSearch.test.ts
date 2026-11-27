import { describe, expect, it } from 'vitest';
import type { Trip } from '@tripmate/core';
import { SCENE_KINDS, sceneFor } from '../../lib/sceneKind';
import { searchTripsByName } from './tripSearch';

const trip = (id: string, name: string, destination = 'Somewhere'): Trip => ({ id, name, destination }) as unknown as Trip;
const TRIPS = [trip('1', 'Coorg Coffee Trail', 'Coorg'), trip('2', 'Hampi Weekend', 'Hampi'), trip('3', 'Café Crawl Lisbon', 'Lisbon')];

describe('searchTripsByName', () => {
  it('matches part of the name, ignoring case', () => {
    expect(searchTripsByName(TRIPS, 'coff').map((t) => t.id)).toEqual(['1']);
    expect(searchTripsByName(TRIPS, 'WEEKEND').map((t) => t.id)).toEqual(['2']);
  });
  it('every typed word must be in the name, in any order', () => {
    expect(searchTripsByName(TRIPS, 'trail coorg').map((t) => t.id)).toEqual(['1']);
    expect(searchTripsByName(TRIPS, 'trail hampi')).toEqual([]);
  });
  it('ignores accents and surrounding spaces', () => {
    expect(searchTripsByName(TRIPS, '  cafe ').map((t) => t.id)).toEqual(['3']);
  });
  it('an empty or blank query finds nothing (the screen shows a hint instead)', () => {
    expect(searchTripsByName(TRIPS, '')).toEqual([]);
    expect(searchTripsByName(TRIPS, '   ')).toEqual([]);
  });
  it('does NOT search destinations (only names)', () => {
    expect(searchTripsByName([trip('9', 'Weekend', 'Lisbon')], 'lisbon')).toEqual([]);
  });
});

describe('sceneFor', () => {
  it('is stable for a trip and always a known scene', () => {
    for (const id of ['a', 'b', '123e4567-e89b-12d3-a456-426614174000']) {
      expect(sceneFor(id)).toBe(sceneFor(id));
      expect(SCENE_KINDS).toContain(sceneFor(id));
    }
  });
  it('picks a fitting picture from the destination words', () => {
    expect(sceneFor('x', 'Goa beach trip')).toBe('coast');
    expect(sceneFor('x', 'Spiti Valley')).toBe('mountain');
    expect(sceneFor('x', 'Dal lake')).toBe('lake');
  });
});
