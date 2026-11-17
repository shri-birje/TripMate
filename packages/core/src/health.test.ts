import { describe, expect, it } from 'vitest';
import { HealthResponseSchema } from './health';

const valid = {
  status: 'ok',
  service: 'tripmate-api',
  version: '0.1.0',
  environment: 'development',
  time: '2026-11-17T10:00:00.000Z',
  checks: { database: 'not_configured' },
};

describe('HealthResponseSchema', () => {
  it('accepts a valid response', () => {
    expect(HealthResponseSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an unknown status', () => {
    expect(() => HealthResponseSchema.parse({ ...valid, status: 'great' })).toThrow();
  });

  it('rejects a non-ISO timestamp', () => {
    expect(() => HealthResponseSchema.parse({ ...valid, time: 'yesterday' })).toThrow();
  });

  it('rejects a response from a different service', () => {
    expect(() => HealthResponseSchema.parse({ ...valid, service: 'other' })).toThrow();
  });
});
