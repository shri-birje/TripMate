import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIVE_PEOPLE,
  NAME_EMPTY_MESSAGE,
  NAME_LONG_MESSAGE,
  NAME_TAKEN_MESSAGE,
  PERSON_NAME_MAX_LENGTH,
  addGuestRpcArgs,
  addState,
  canManagePeople,
  cleanPersonName,
  leaveState,
  leaveTripRpcArgs,
  memberActions,
  removeMemberRpcArgs,
  renameGuestRpcArgs,
  samePersonName,
  setMemberRoleRpcArgs,
  validatePersonName,
} from './memberManagement';
import { formerMemberFromRow, memberRowFromList, tripDetailsFromRow, type MemberListRow, type TripDetails, type TripMemberRow } from './tripDetails';

describe('names', () => {
  it('are trimmed of ALL surrounding whitespace (tabs, new lines, non-breaking spaces), like the database', () => {
    expect(cleanPersonName('  Gita  ')).toBe('Gita');
    expect(cleanPersonName('\t Gita \n')).toBe('Gita');
    expect(cleanPersonName(' Gita ')).toBe('Gita');
    expect(cleanPersonName('Gita  Rao')).toBe('Gita  Rao'); // only the ends
  });

  it('match each other ignoring case and surrounding whitespace', () => {
    expect(samePersonName('Gita', ' gita ')).toBe(true);
    expect(samePersonName('GITA', 'gita')).toBe(true);
    expect(samePersonName('Gita', 'Geeta')).toBe(false);
    expect(samePersonName('Gita Rao', 'Gita  Rao')).toBe(false);
  });

  it('are checked: empty, blank, invisible, too long and already taken are refused with friendly messages', () => {
    for (const bad of ['', '   ', '\t\n', '  ', undefined, null, 5]) expect(validatePersonName(bad, [])).toEqual({ ok: false, message: NAME_EMPTY_MESSAGE });
    expect(validatePersonName('x'.repeat(PERSON_NAME_MAX_LENGTH + 1), [])).toEqual({ ok: false, message: NAME_LONG_MESSAGE });
    expect(validatePersonName('Gita', ['Ravi', ' GITA '])).toEqual({ ok: false, message: NAME_TAKEN_MESSAGE });
  });

  it('are accepted and trimmed when fine, including exactly the longest allowed', () => {
    expect(validatePersonName('  Gita  ', ['Ravi'])).toEqual({ ok: true, name: 'Gita' });
    expect(validatePersonName('y'.repeat(PERSON_NAME_MAX_LENGTH), [])).toEqual({ ok: true, name: 'y'.repeat(PERSON_NAME_MAX_LENGTH) });
  });

  it('use the same limits as the database (60 characters, 50 people)', () => {
    expect(PERSON_NAME_MAX_LENGTH).toBe(60);
    expect(MAX_ACTIVE_PEOPLE).toBe(50);
  });
});

describe('the arguments sent to the database', () => {
  it('use exactly the names the SQL functions declare, and carry no user id', () => {
    expect(addGuestRpcArgs('t', 'Gita')).toEqual({ p_trip_id: 't', p_display_name: 'Gita' });
    expect(renameGuestRpcArgs('t', 'm', 'Geeta')).toEqual({ p_trip_id: 't', p_member_id: 'm', p_display_name: 'Geeta' });
    expect(setMemberRoleRpcArgs('t', 'm', 'admin', 'member')).toEqual({ p_trip_id: 't', p_member_id: 'm', p_role: 'admin', p_expected_role: 'member' });
    expect(removeMemberRpcArgs('t', 'm')).toEqual({ p_trip_id: 't', p_member_id: 'm' });
    expect(leaveTripRpcArgs('t')).toEqual({ p_trip_id: 't' });
    for (const a of [addGuestRpcArgs('t', 'n'), renameGuestRpcArgs('t', 'm', 'n'), setMemberRoleRpcArgs('t', 'm', 'admin', 'member'), removeMemberRpcArgs('t', 'm'), leaveTripRpcArgs('t')]) {
      expect(Object.keys(a).join(',')).not.toMatch(/user|uid|actor/i);
    }
  });
});

const row = (id: string, over: Partial<TripMemberRow> = {}): TripMemberRow => ({
  id,
  user_id: `user-${id}`,
  display_name: `Person ${id}`,
  role: 'member',
  status: 'active',
  joined_at: '2026-11-18T10:00:00+00:00',
  ...over,
});

function details(members: TripMemberRow[], status: 'active' | 'archived' = 'active'): TripDetails {
  return tripDetailsFromRow({
    id: 't1', name: 'Goa', destination: 'Goa', start_date: '2026-12-27', end_date: '2026-12-30', description: null, budget_minor: null,
    currency: 'INR', cover_image_path: null, status, created_by: 'user-1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z',
    version: 1, trip_members: members,
  });
}
const person = (d: TripDetails, id: string) => d.members.find((m) => m.id === id)!;

describe('what an administrator is offered', () => {
  const d = details([row('1', { role: 'admin' }), row('2'), row('3', { role: 'admin' }), row('g', { user_id: null }), row('x', { status: 'left', left_at: '2026-11-20T10:00:00Z' })]);

  it('on an ordinary member: make admin, remove (not remove admin rights, not rename)', () => {
    expect(memberActions(d, 'user-1', person(d, '2'))).toEqual({ canMakeAdmin: true, canRemoveAdminRights: false, canRemove: true, canRename: false, any: true });
  });

  it('on another administrator: remove admin rights, remove', () => {
    expect(memberActions(d, 'user-1', person(d, '3'))).toMatchObject({ canMakeAdmin: false, canRemoveAdminRights: true, canRemove: true });
  });

  it('on a guest: rename and remove, never make admin', () => {
    expect(memberActions(d, 'user-1', person(d, 'g'))).toMatchObject({ canMakeAdmin: false, canRename: true, canRemove: true });
  });

  it('on themselves: may step down (another admin exists) but not remove themselves', () => {
    expect(memberActions(d, 'user-1', person(d, '1'))).toMatchObject({ canRemoveAdminRights: true, canRemove: false, canMakeAdmin: false });
  });

  it('the only administrator cannot be offered "remove admin rights"', () => {
    const solo = details([row('1', { role: 'admin' }), row('2'), row('g', { user_id: null })]);
    expect(memberActions(solo, 'user-1', person(solo, '1')).canRemoveAdminRights).toBe(false);
  });

  it('nothing is offered to an ordinary member, a guest, a stranger or a signed-out visitor', () => {
    for (const who of ['user-2', 'user-9', null]) {
      for (const id of ['1', '2', '3', 'g']) expect(memberActions(d, who, person(d, id)).any, `${who}/${id}`).toBe(false);
    }
  });

  it('nothing is offered on an archived trip (read-only)', () => {
    const archived = details([row('1', { role: 'admin' }), row('2'), row('3', { role: 'admin' })], 'archived');
    for (const id of ['1', '2', '3']) expect(memberActions(archived, 'user-1', person(archived, id)).any).toBe(false);
    expect(canManagePeople(archived, 'user-1')).toBe(false);
    expect(canManagePeople(d, 'user-1')).toBe(true);
    expect(canManagePeople(d, 'user-2')).toBe(false);
  });
});

describe('adding a friend', () => {
  it('is offered to an administrator of an active trip with room', () => {
    expect(addState(details([row('1', { role: 'admin' })]), 'user-1')).toEqual({ canAdd: true });
  });
  it('says why when it cannot be done', () => {
    expect(addState(details([row('1', { role: 'admin' }), row('2')]), 'user-2')).toEqual({ canAdd: false, reason: 'not_admin' });
    expect(addState(details([row('1', { role: 'admin' })], 'archived'), 'user-1')).toEqual({ canAdd: false, reason: 'archived' });
    const full = details([row('1', { role: 'admin' }), ...Array.from({ length: MAX_ACTIVE_PEOPLE - 1 }, (_, i) => row(`p${i}`, { user_id: null }))]);
    expect(addState(full, 'user-1')).toEqual({ canAdd: false, reason: 'full' });
    const almost = details([row('1', { role: 'admin' }), ...Array.from({ length: MAX_ACTIVE_PEOPLE - 2 }, (_, i) => row(`p${i}`, { user_id: null }))]);
    expect(addState(almost, 'user-1')).toEqual({ canAdd: true });
  });
  it('does not count former members towards the limit', () => {
    const d = details([row('1', { role: 'admin' }), ...Array.from({ length: 60 }, (_, i) => row(`f${i}`, { status: 'left', left_at: '2026-11-20T10:00:00Z' }))]);
    expect(addState(d, 'user-1')).toEqual({ canAdd: true });
  });
});

describe('leaving', () => {
  it('is possible for an ordinary member, and for an administrator when another administrator exists', () => {
    const d = details([row('1', { role: 'admin' }), row('2'), row('3', { role: 'admin' })]);
    expect(leaveState(d, 'user-2')).toEqual({ canLeave: true });
    expect(leaveState(d, 'user-1')).toEqual({ canLeave: true });
  });
  it('is not possible for the only administrator, even with other people on the trip', () => {
    const d = details([row('1', { role: 'admin' }), row('2'), row('g', { user_id: null })]);
    expect(leaveState(d, 'user-1')).toEqual({ canLeave: false, reason: 'sole_admin' });
  });
  it('is not offered to people who are not on the trip', () => {
    const d = details([row('1', { role: 'admin' }), row('x', { status: 'left', left_at: '2026-11-20T10:00:00Z' })]);
    expect(leaveState(d, 'user-x')).toEqual({ canLeave: false, reason: 'not_member' });
    expect(leaveState(d, null)).toEqual({ canLeave: false, reason: 'not_member' });
  });
  it('is still possible on an archived trip (the one exception to read-only)', () => {
    const d = details([row('1', { role: 'admin' }), row('2')], 'archived');
    expect(leaveState(d, 'user-2')).toEqual({ canLeave: true });
  });
});

describe('list_trip_members rows', () => {
  const list = (over: Partial<MemberListRow> & { member_id: string }): MemberListRow => ({
    user_id: `user-${over.member_id}`, display_name: 'X', role: 'member', status: 'active', joined_at: '2026-11-18T10:00:00+00:00', left_at: null, is_guest: false, ...over,
  });

  it('become member rows; a missing role becomes an ordinary member', () => {
    expect(memberRowFromList(list({ member_id: 'a', role: 'admin' }))).toMatchObject({ id: 'a', user_id: 'user-a', role: 'admin', is_guest: false });
    expect(memberRowFromList(list({ member_id: 'a', role: null })).role).toBe('member');
  });

  it('a former member (no user id, no role sent) is still told apart from a former guest', () => {
    const account = formerMemberFromRow(memberRowFromList(list({ member_id: 'a', user_id: null, role: null, status: 'removed', left_at: '2026-11-20T10:00:00Z', is_guest: false })))!;
    const guest = formerMemberFromRow(memberRowFromList(list({ member_id: 'g', user_id: null, role: null, status: 'left', left_at: '2026-11-20T10:00:00Z', is_guest: true })))!;
    expect(account.isGuest).toBe(false);
    expect(guest.isGuest).toBe(true);
  });

  it('building the trip from such rows keeps former people apart and never invents a role for them', () => {
    const d = tripDetailsFromRow({
      id: 't1', name: 'Goa', destination: 'Goa', start_date: '2026-12-27', end_date: '2026-12-30', description: null, budget_minor: null,
      currency: 'INR', cover_image_path: null, status: 'active', created_by: 'user-1', created_at: '2026-11-18T00:00:00Z', updated_at: '2026-11-18T00:00:00Z', version: 1,
      trip_members: [
        list({ member_id: '1', role: 'admin' }),
        list({ member_id: '2' }),
        list({ member_id: '3', user_id: null, role: null, status: 'removed', left_at: '2026-11-20T10:00:00Z' }),
      ].map(memberRowFromList),
    });
    expect(d.members.map((m) => m.id)).toEqual(['1', '2']);
    expect(d.admins.map((m) => m.id)).toEqual(['1']);
    expect(d.formerMembers.map((m) => m.id)).toEqual(['3']);
    expect(JSON.stringify(d.formerMembers)).not.toMatch(/user-|admin/);
  });
});
