import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';
import {
  MEMBER_MESSAGES,
  TripMemberError,
  addGuestMember,
  leaveTrip,
  removeMember,
  renameGuestMember,
  setMemberRole,
  type MemberFunction,
  type TripMemberClient,
} from './tripMemberService';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const MEMBER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

type Reply = { data: { member_id: string; changed: boolean }[] | { member_id: string; changed: boolean } | null; error: { code?: string; message?: string } | null };

function fake(reply: Reply | (() => Promise<Reply>) = { data: [{ member_id: MEMBER, changed: true }], error: null }) {
  const calls: { fn: MemberFunction; args: Record<string, unknown> }[] = [];
  const client: TripMemberClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return typeof reply === 'function' ? reply() : Promise.resolve(reply);
    },
  };
  return { client, calls };
}
const fails = (reply: Reply | (() => Promise<Reply>), act: (c: TripMemberClient) => Promise<unknown>) =>
  act(fake(reply).client).then(
    () => { throw new Error('expected a failure'); },
    (e) => e as TripMemberError,
  );
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as TripMemberError);
const err = (message: string, code?: string): Reply => ({ data: null, error: { message, ...(code ? { code } : {}) } });

describe('what is sent', () => {
  it('add: the function and exactly the trip and the trimmed name (no user id)', async () => {
    const { client, calls } = fake();
    const r = await addGuestMember(client, { tripId: TRIP, name: '  Gita ', taken: ['Asha'] });
    expect(r).toEqual({ memberId: MEMBER, changed: true });
    expect(calls).toEqual([{ fn: 'add_guest_member', args: { p_trip_id: TRIP, p_display_name: 'Gita' } }]);
  });

  it('rename, role, remove and leave send exactly the declared arguments', async () => {
    const { client, calls } = fake();
    await renameGuestMember(client, { tripId: TRIP, memberId: MEMBER, name: ' Geeta', taken: [] });
    await setMemberRole(client, { tripId: TRIP, memberId: MEMBER, role: 'admin', expectedRole: 'member' });
    await removeMember(client, { tripId: TRIP, memberId: MEMBER });
    await leaveTrip(client, { tripId: TRIP });
    expect(calls).toEqual([
      { fn: 'rename_guest_member', args: { p_trip_id: TRIP, p_member_id: MEMBER, p_display_name: 'Geeta' } },
      { fn: 'set_member_role', args: { p_trip_id: TRIP, p_member_id: MEMBER, p_role: 'admin', p_expected_role: 'member' } },
      { fn: 'remove_member', args: { p_trip_id: TRIP, p_member_id: MEMBER } },
      { fn: 'leave_trip', args: { p_trip_id: TRIP } },
    ]);
    for (const c of calls) expect(Object.keys(c.args).join()).not.toMatch(/user|uid|actor/i);
  });

  it('understands the database answering with one row or a list, and passes on "nothing changed"', async () => {
    expect(await removeMember(fake({ data: { member_id: MEMBER, changed: false }, error: null }).client, { tripId: TRIP, memberId: MEMBER })).toEqual({ memberId: MEMBER, changed: false });
    expect(await removeMember(fake({ data: [{ member_id: MEMBER, changed: true }], error: null }).client, { tripId: TRIP, memberId: MEMBER })).toEqual({ memberId: MEMBER, changed: true });
  });
});

describe('checks made before anything is sent', () => {
  it('a bad name never reaches the server: empty, invisible, too long, already taken (any case)', async () => {
    const { client, calls } = fake();
    for (const name of ['', '   ', '\t\n', 'x'.repeat(61)]) {
      const e = await rejection(addGuestMember(client, { tripId: TRIP, name, taken: [] }));
      expect(e).toBeInstanceOf(TripMemberError);
      expect(e.kind).toBe('invalid');
    }
    const taken = await rejection(addGuestMember(client, { tripId: TRIP, name: 'GITA ', taken: ['Gita'] }));
    expect(taken.kind).toBe('name_taken');
    expect(taken.message).toBe(MEMBER_MESSAGES.name_taken);
    expect(calls).toEqual([]);
  });

  it('malformed trip or person ids never reach the server', async () => {
    const { client, calls } = fake();
    const bad = ['', 'abc', "1'; drop table x;--", '../x', undefined as unknown as string, 42 as unknown as string];
    for (const id of bad) {
      expect((await rejection(addGuestMember(client, { tripId: id, name: 'A', taken: [] }))).kind).toBe('unavailable');
      expect((await rejection(leaveTrip(client, { tripId: id }))).kind).toBe('unavailable');
      expect((await rejection(removeMember(client, { tripId: TRIP, memberId: id }))).kind).toBe('not_found');
      expect((await rejection(setMemberRole(client, { tripId: TRIP, memberId: id, role: 'admin', expectedRole: 'member' }))).kind).toBe('not_found');
    }
    expect(calls).toEqual([]);
  });

  it('an unknown role word is not sent', async () => {
    const { client, calls } = fake();
    const e = await rejection(setMemberRole(client, { tripId: TRIP, memberId: MEMBER, role: 'owner' as never, expectedRole: 'member' }));
    expect(e.kind).toBe('unknown');
    expect(calls).toEqual([]);
  });
});

describe('what the database can answer, in plain words', () => {
  const cases: [string, string, string][] = [
    ['trip_not_found', 'unavailable', UNAVAILABLE_MESSAGE],
    ['not_admin', 'not_admin', MEMBER_MESSAGES.not_admin],
    ['trip_archived', 'archived', MEMBER_MESSAGES.archived],
    ['member_not_found', 'not_found', MEMBER_MESSAGES.not_found],
    ['member_changed', 'conflict', MEMBER_MESSAGES.conflict],
    ['last_admin', 'last_admin', MEMBER_MESSAGES.last_admin],
    ['guest_cannot_be_admin', 'guest_admin', MEMBER_MESSAGES.guest_admin],
    ['name_taken', 'name_taken', MEMBER_MESSAGES.name_taken],
    ['trip_full', 'full', MEMBER_MESSAGES.full],
    ['use_leave_instead', 'use_leave', MEMBER_MESSAGES.use_leave],
    ['cannot_rename', 'cannot_rename', MEMBER_MESSAGES.cannot_rename],
    ['invalid_request', 'invalid', MEMBER_MESSAGES.invalid],
  ];

  it.each(cases)('%s becomes %s', async (token, kind, message) => {
    const e = await fails(err(`error: ${token}`), (c) => removeMember(c, { tripId: TRIP, memberId: MEMBER }));
    expect(e).toBeInstanceOf(TripMemberError);
    expect(e.kind).toBe(kind);
    expect(e.message).toBe(message);
  });

  it('the same refusal reads differently when you are the one leaving', async () => {
    const e = await fails(err('last_admin'), (c) => leaveTrip(c, { tripId: TRIP }));
    expect(e.kind).toBe('last_admin');
    expect(e.message).toBe(MEMBER_MESSAGES.last_admin_leave);
    expect(e.message).toMatch(/only admin/);
  });

  it('works the same through every function', async () => {
    for (const act of [
      (c: TripMemberClient) => addGuestMember(c, { tripId: TRIP, name: 'A', taken: [] }),
      (c: TripMemberClient) => renameGuestMember(c, { tripId: TRIP, memberId: MEMBER, name: 'A', taken: [] }),
      (c: TripMemberClient) => setMemberRole(c, { tripId: TRIP, memberId: MEMBER, role: 'member', expectedRole: 'admin' }),
      (c: TripMemberClient) => leaveTrip(c, { tripId: TRIP }),
    ]) {
      expect((await fails(err('not_admin'), act)).kind).toBe('not_admin');
      expect((await fails(err('trip_not_found'), act)).kind).toBe('unavailable');
    }
  });

  it('a connection failure, a missing database update, a sign-out and anything else are told apart, and raw database text is never shown', async () => {
    const act = (c: TripMemberClient) => removeMember(c, { tripId: TRIP, memberId: MEMBER });
    expect((await fails(err('Failed to fetch'), act)).kind).toBe('network');
    expect((await fails(async () => { throw new TypeError('Failed to fetch'); }, act)).kind).toBe('network');
    expect((await fails(err('x', 'PGRST202'), act)).kind).toBe('setup');
    expect((await fails(err('x', '42883'), act)).kind).toBe('setup');
    expect((await fails(err('anything', '28000'), act)).kind).toBe('auth');
    expect((await fails(err('permission denied for function remove_member', '42501'), act)).kind).toBe('auth');
    const unknown = await fails(err('SELECT secret FROM somewhere at 10.0.0.5', 'XX000'), act);
    expect(unknown.kind).toBe('unknown');
    expect(unknown.message).toBe(MEMBER_MESSAGES.unknown);
    expect(unknown.message).not.toMatch(/SELECT|10\.0/);
  });

  it('an empty or malformed answer is an "unknown" problem, not a success', async () => {
    const act = (c: TripMemberClient) => removeMember(c, { tripId: TRIP, memberId: MEMBER });
    expect((await fails({ data: null, error: null }, act)).kind).toBe('unknown');
    expect((await fails({ data: [], error: null }, act)).kind).toBe('unknown');
    expect((await fails({ data: [{ member_id: 5 as never, changed: true }], error: null }, act)).kind).toBe('unknown');
  });

  it('no message hints at whether a trip exists', () => {
    expect(UNAVAILABLE_MESSAGE).not.toMatch(/denied|forbidden|private|permission/i);
    for (const m of Object.values(MEMBER_MESSAGES)) expect(m).not.toMatch(/permission|denied|forbidden|sql|postgres|rpc/i);
  });
});
