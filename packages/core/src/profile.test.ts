import { describe, expect, it } from 'vitest';
import {
  ProfileDetailsSchema,
  ProfileUpdateSchema,
  profileDetailsToRow,
  SignInSchema,
  SignUpSchema,
  profileFromRow,
  profileUpdateToRow,
  type ProfileRow,
} from './profile';
import { validate } from './validation';

const goodSignUp = { displayName: 'Asha Rao', email: 'asha@example.com', password: 'Goa2026trip' };

describe('SignUpSchema', () => {
  it('accepts a good sign-up and cleans it (trim, lowercase email)', () => {
    const r = validate(SignUpSchema, { displayName: '  Asha Rao  ', email: '  Asha@Example.COM ', password: 'Goa2026trip' });
    expect(r).toEqual({ ok: true, data: { displayName: 'Asha Rao', email: 'asha@example.com', password: 'Goa2026trip' } });
  });

  it('reports one friendly message per field', () => {
    const r = validate(SignUpSchema, { displayName: '', email: 'nope', password: 'short' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual({
        displayName: 'Enter your name',
        email: 'Enter a valid email address',
        password: 'Use at least 8 characters',
      });
    }
  });

  it.each([
    ['onlyletters', 'Include at least one letter and one number'],
    ['12345678', 'Include at least one letter and one number'],
    ['a1' + 'b'.repeat(80), 'Use at most 72 characters'],
  ])('rejects password %s', (password, message) => {
    const r = validate(SignUpSchema, { ...goodSignUp, password });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.password).toBe(message);
  });

  it('rejects a password equal to the email', () => {
    const r = validate(SignUpSchema, { displayName: 'A', email: 'abc12345@x.com', password: 'abc12345@x.com' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.password).toBe('Password must be different from your email');
  });

  it('rejects names that are too long or contain control characters', () => {
    const long = validate(SignUpSchema, { ...goodSignUp, displayName: 'x'.repeat(61) });
    expect(long.ok).toBe(false);
    const ctrl = validate(SignUpSchema, { ...goodSignUp, displayName: 'Asha\nRao' });
    expect(ctrl.ok).toBe(false);
    expect(validate(SignUpSchema, { ...goodSignUp, displayName: 'x'.repeat(60) }).ok).toBe(true);
  });

  it('allows international names', () => {
    for (const name of ['அசோக்', 'José Núñez', 'आशा राव', '李雷']) {
      expect(validate(SignUpSchema, { ...goodSignUp, displayName: name }).ok).toBe(true);
    }
  });

  it('rejects missing fields and wrong types without crashing', () => {
    expect(validate(SignUpSchema, {}).ok).toBe(false);
    expect(validate(SignUpSchema, null).ok).toBe(false);
    expect(validate(SignUpSchema, { ...goodSignUp, password: 12345678 }).ok).toBe(false);
  });
});

describe('SignInSchema', () => {
  it('accepts any non-empty password (the server decides if it is right)', () => {
    expect(validate(SignInSchema, { email: 'A@b.co', password: 'x' })).toEqual({
      ok: true,
      data: { email: 'a@b.co', password: 'x' },
    });
  });
  it('rejects blanks', () => {
    const r = validate(SignInSchema, { email: '', password: '' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(['email', 'password']);
  });
});

describe('ProfileUpdateSchema', () => {
  const good = { displayName: 'Asha', upiId: 'asha@okhdfcbank', preferredCurrency: 'INR', themePreference: 'dark' };

  it('accepts a good update', () => {
    expect(validate(ProfileUpdateSchema, good)).toEqual({ ok: true, data: good });
  });

  it('treats a blank UPI ID as "none"', () => {
    for (const blank of ['', '   ']) {
      const r = validate(ProfileUpdateSchema, { ...good, upiId: blank });
      expect(r).toMatchObject({ ok: true, data: { upiId: null } });
    }
  });

  it('rejects malformed UPI IDs', () => {
    for (const bad of ['nope', '@ybl', 'a@b', 'has space@ybl']) {
      const r = validate(ProfileUpdateSchema, { ...good, upiId: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.errors.upiId).toBe('UPI ID looks like name@bank');
    }
  });

  it('rejects unknown currencies and themes', () => {
    expect(validate(ProfileUpdateSchema, { ...good, preferredCurrency: 'XYZ' }).ok).toBe(false);
    expect(validate(ProfileUpdateSchema, { ...good, preferredCurrency: 'inr' }).ok).toBe(false);
    expect(validate(ProfileUpdateSchema, { ...good, themePreference: 'neon' }).ok).toBe(false);
  });

  it('only ever produces the editable columns (cannot smuggle an id or created_at)', () => {
    const r = validate(ProfileUpdateSchema, { ...good, id: 'someone-else', created_at: '2000-01-01', deleted_at: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(profileUpdateToRow(r.data)).sort()).toEqual(['display_name', 'preferred_currency', 'theme_preference', 'upi_id']);
  });
});

describe('ProfileDetailsSchema', () => {
  it('validates the form fields and ignores the theme', () => {
    const r = validate(ProfileDetailsSchema, { displayName: ' Asha ', upiId: '', preferredCurrency: 'USD', themePreference: 'dark' });
    expect(r).toEqual({ ok: true, data: { displayName: 'Asha', upiId: null, preferredCurrency: 'USD' } });
    if (r.ok) expect(Object.keys(profileDetailsToRow(r.data)).sort()).toEqual(['display_name', 'preferred_currency', 'upi_id']);
  });
});

describe('profile mapping', () => {
  const row: ProfileRow = {
    id: 'u1',
    display_name: 'Asha',
    upi_id: null,
    avatar_path: null,
    preferred_currency: 'INR',
    theme_preference: 'system',
    created_at: '2026-11-18T00:00:00Z',
    updated_at: '2026-11-18T00:00:00Z',
  };

  it('converts a database row to an app profile', () => {
    expect(profileFromRow(row)).toEqual({
      id: 'u1',
      displayName: 'Asha',
      upiId: null,
      avatarPath: null,
      preferredCurrency: 'INR',
      themePreference: 'system',
      createdAt: '2026-11-18T00:00:00Z',
      updatedAt: '2026-11-18T00:00:00Z',
    });
  });

  it('falls back to Light if the database holds an unknown theme', () => {
    expect(profileFromRow({ ...row, theme_preference: 'neon' }).themePreference).toBe('light');
  });

  it('trims padding from the fixed-width currency column', () => {
    expect(profileFromRow({ ...row, preferred_currency: 'INR ' }).preferredCurrency).toBe('INR');
  });
});
