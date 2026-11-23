import { describe, expect, it } from 'vitest';
import { UNAVAILABLE_MESSAGE } from './tripDetailsService';
import {
  INVITE_MESSAGES,
  TripInviteError,
  createInvite,
  decideJoinRequest,
  getGeneralInviteLink,
  listInvites,
  listJoinRequests,
  previewInvite,
  requestToJoin,
  revokeInvite,
  type InviteFunction,
  type TripInviteClient,
} from './tripInviteService';

const TRIP = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
const MEMBER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INVITE = '0b8a9b1e-2c64-4c2f-9d1c-5a7f6a6f3b11';
const REQUEST = '5d1d1a3c-6f5b-4d0e-8b5e-2f3c8a9e7b10';
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

type Reply = { data: unknown; error: { code?: string; message?: string } | null };

function fake(reply: Reply | (() => Promise<Reply>) = { data: [], error: null }) {
  const calls: { fn: InviteFunction; args: Record<string, unknown> }[] = [];
  const client: TripInviteClient = {
    rpc: (fn, args) => {
      calls.push({ fn, args });
      return typeof reply === 'function' ? reply() : Promise.resolve(reply);
    },
  };
  return { client, calls };
}
const rejection = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure'); }, (e) => e as TripInviteError);
const err = (message: string, code?: string): Reply => ({ data: null, error: { message, ...(code ? { code } : {}) } });
const options = { hours: 168, claimMemberId: null };

describe('Copy link (getting the live general link again)', () => {
  it('sends only the trip, and returns the token and expiry', async () => {
    const { client, calls } = fake({ data: [{ token: TOKEN, expires_at: '2026-11-25T10:00:00Z' }], error: null });
    expect(await getGeneralInviteLink(client, TRIP)).toEqual({ token: TOKEN, expiresAt: '2026-11-25T10:00:00Z' });
    expect(calls).toEqual([{ fn: 'get_general_invite_link', args: { p_trip_id: TRIP } }]);
  });

  it('an empty answer means "nothing to copy", and a bad id is refused before sending', async () => {
    expect(await getGeneralInviteLink(fake({ data: [], error: null }).client, TRIP)).toBeNull();
    expect(await getGeneralInviteLink(fake({ data: null, error: null }).client, TRIP)).toBeNull();
    const { client, calls } = fake();
    expect((await rejection(getGeneralInviteLink(client, 'nope'))).kind).toBe('unavailable');
    expect(calls).toEqual([]);
  });

  it('refuses an answer that is not a real token, and never puts a token in an error', async () => {
    for (const data of [[{ token: 'short', expires_at: 'x' }], [{ token: TOKEN }]]) {
      expect((await rejection(getGeneralInviteLink(fake({ data, error: null }).client, TRIP))).kind).toBe('unknown');
    }
    for (const reply of [err(`not_admin ${TOKEN}`), err(`trip_not_found ${TOKEN}`), err(`boom ${TOKEN}`)]) {
      const e = await rejection(getGeneralInviteLink(fake(reply).client, TRIP));
      expect(e.message).not.toContain(TOKEN);
      expect(JSON.stringify(e)).not.toContain(TOKEN);
    }
  });

  it('"a valid link already exists" is a clear message when creating another', async () => {
    const e = await rejection(createInvite(fake(err('invite_exists')).client, { tripId: TRIP, options }));
    expect(e.kind).toBe('invite_exists');
    expect(e.message).toBe(INVITE_MESSAGES.invite_exists);
    expect(e.message).toMatch(/Copy link/);
  });
});

describe('making the trip\'s link', () => {
  const created = { data: [{ invite_id: INVITE, token: TOKEN, expires_at: '2026-11-25T10:00:00Z' }], error: null };

  it('sends exactly the trip and how long it lasts (no usage limit, no user id) and returns the token for the one time it is shown', async () => {
    const { client, calls } = fake(created);
    const r = await createInvite(client, { tripId: TRIP, options: { hours: 24, claimMemberId: MEMBER } });
    expect(r).toEqual({ inviteId: INVITE, token: TOKEN, expiresAt: '2026-11-25T10:00:00Z' });
    expect(calls).toEqual([{ fn: 'create_invite', args: { p_trip_id: TRIP, p_claim_member_id: MEMBER, p_expires_in_hours: 24 } }]);
    expect(Object.keys(calls[0]!.args).join()).not.toMatch(/user|uid|actor|uses/i);
  });

  it('refuses bad options and bad ids before anything is sent', async () => {
    const { client, calls } = fake(created);
    for (const hours of [0, 721, 1.5, Number.NaN]) expect((await rejection(createInvite(client, { tripId: TRIP, options: { hours, claimMemberId: null } }))).kind, String(hours)).toBe('invalid');
    expect((await rejection(createInvite(client, { tripId: 'nope', options }))).kind).toBe('unavailable');
    expect((await rejection(createInvite(client, { tripId: TRIP, options: { ...options, claimMemberId: 'nope' } }))).kind).toBe('not_found');
    expect(calls).toEqual([]);
  });

  it('refuses an answer that is not a real token (it would be shown to an administrator as a link)', async () => {
    for (const data of [null, [], [{ invite_id: INVITE, token: 'short', expires_at: 'x' }], [{ invite_id: INVITE, token: TOKEN.toUpperCase(), expires_at: 'x' }], [{ token: TOKEN }]]) {
      expect((await rejection(createInvite(fake({ data, error: null }).client, { tripId: TRIP, options }))).kind, JSON.stringify(data)).toBe('unknown');
    }
  });
});

describe('listing and cancelling links', () => {
  it('lists links without any token or hash', async () => {
    const row = { invite_id: INVITE, claim_member_id: null, claim_name: null, created_by_name: 'Asha', expires_at: '2026-11-25T10:00:00Z', use_count: 2, revoked_at: null, created_at: '2026-11-18T10:00:00Z', status: 'active' };
    const { client, calls } = fake({ data: [row], error: null });
    const list = await listInvites(client, TRIP);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: INVITE, status: 'active', requestCount: 2, createdAt: '2026-11-18T10:00:00Z' });
    expect(JSON.stringify(list)).not.toMatch(/token|hash/i);
    expect(calls).toEqual([{ fn: 'list_trip_invites', args: { p_trip_id: TRIP } }]);
    expect(await listInvites(fake({ data: null, error: null }).client, TRIP)).toEqual([]);
  });

  it('cancels a link, passing on "nothing changed" for a repeat', async () => {
    const { client, calls } = fake({ data: [{ invite_id: INVITE, changed: false }], error: null });
    expect(await revokeInvite(client, { tripId: TRIP, inviteId: INVITE })).toEqual({ inviteId: INVITE, changed: false });
    expect(calls).toEqual([{ fn: 'revoke_invite', args: { p_trip_id: TRIP, p_invite_id: INVITE } }]);
  });

  it('refuses malformed ids before anything is sent', async () => {
    const { client, calls } = fake();
    expect((await rejection(listInvites(client, 'x'))).kind).toBe('unavailable');
    expect((await rejection(revokeInvite(client, { tripId: 'x', inviteId: INVITE }))).kind).toBe('unavailable');
    expect((await rejection(revokeInvite(client, { tripId: TRIP, inviteId: 'x' }))).kind).toBe('not_found');
    expect(calls).toEqual([]);
  });
});

describe('previewing a link', () => {
  const row = { trip_name: 'Goa', destination: 'Goa, India', start_date: '2026-12-27', end_date: '2026-12-30', inviter_name: 'Asha', member_count: 3, is_claim: false, claim_name: null };

  it('sends only the token and returns the public facts', async () => {
    const { client, calls } = fake({ data: [row], error: null });
    expect(await previewInvite(client, TOKEN)).toMatchObject({ tripName: 'Goa', inviterName: 'Asha', memberCount: 3, claimName: null });
    expect(calls).toEqual([{ fn: 'preview_invite', args: { p_token: TOKEN } }]);
  });

  it('an empty answer (unknown, expired, replaced, cancelled, archived trip) is the one "not valid" error', async () => {
    for (const data of [[], null]) {
      const e = await rejection(previewInvite(fake({ data, error: null }).client, TOKEN));
      expect(e.kind).toBe('invalid_link');
      expect(e.message).toBe(INVITE_MESSAGES.invalid_link);
    }
  });

  it('a malformed token never reaches the server and gets the same error', async () => {
    const { client, calls } = fake({ data: [row], error: null });
    for (const bad of ['', 'abc', TOKEN.toUpperCase(), `${TOKEN}0`, "' or 1=1 --", null, undefined, 5, {}]) {
      const e = await rejection(previewInvite(client, bad));
      expect(e.kind, String(bad)).toBe('invalid_link');
      expect(e.message).toBe(INVITE_MESSAGES.invalid_link);
    }
    expect(calls).toEqual([]);
  });
});

describe('asking to join', () => {
  it('sends only the token and says what happened: a request, never a membership', async () => {
    const { client, calls } = fake({ data: [{ trip_id: TRIP, request_id: REQUEST, outcome: 'requested' }], error: null });
    expect(await requestToJoin(client, TOKEN)).toEqual({ tripId: TRIP, requestId: REQUEST, outcome: 'requested' });
    expect(calls).toEqual([{ fn: 'request_to_join', args: { p_token: TOKEN } }]);
    expect((await requestToJoin(fake({ data: [{ trip_id: TRIP, request_id: REQUEST, outcome: 'already_requested' }], error: null }).client, TOKEN)).outcome).toBe('already_requested');
    expect(await requestToJoin(fake({ data: [{ trip_id: TRIP, request_id: null, outcome: 'already_member' }], error: null }).client, TOKEN)).toEqual({ tripId: TRIP, requestId: null, outcome: 'already_member' });
  });

  it('never has an outcome that means "you are in": there is no way to become a member from here', () => {
    // the only outcomes the service understands are about a REQUEST (or about already being a member)
    return expect(requestToJoin(fake({ data: [{ trip_id: TRIP, request_id: REQUEST, outcome: 'joined' }], error: null }).client, TOKEN)).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('a malformed token never reaches the server', async () => {
    const { client, calls } = fake();
    for (const bad of ['', 'abc', TOKEN.toUpperCase(), null, undefined]) expect((await rejection(requestToJoin(client, bad))).kind).toBe('invalid_link');
    expect(calls).toEqual([]);
  });

  it('an answer that is not recognised is an "unknown" problem, never a success', async () => {
    for (const data of [null, [], [{ trip_id: TRIP, request_id: REQUEST, outcome: 'weird' }], [{ trip_id: 5, request_id: REQUEST, outcome: 'requested' }], [{ trip_id: TRIP, request_id: null, outcome: 'requested' }]]) {
      expect((await rejection(requestToJoin(fake({ data, error: null }).client, TOKEN))).kind, JSON.stringify(data)).toBe('unknown');
    }
  });
});

describe('the administrator\'s requests', () => {
  it('lists waiting requests as a name, a time and (for a claim) the friend\'s place: never a user id', async () => {
    const rows = [
      { request_id: REQUEST, requester_name: 'Nina Shah', claim_member_id: null, claim_name: null, created_at: '2026-11-23T04:45:00Z' },
      { request_id: INVITE, requester_name: 'Ravi', claim_member_id: MEMBER, claim_name: 'Gita', created_at: '2026-11-23T05:00:00Z' },
    ];
    const { client, calls } = fake({ data: rows, error: null });
    const list = await listJoinRequests(client, TRIP);
    expect(list.map((r) => [r.requesterName, r.claimName])).toEqual([['Nina Shah', null], ['Ravi', 'Gita']]);
    expect(JSON.stringify(list)).not.toMatch(/user/i);
    expect(calls).toEqual([{ fn: 'list_join_requests', args: { p_trip_id: TRIP } }]);
    expect(await listJoinRequests(fake({ data: null, error: null }).client, TRIP)).toEqual([]);
  });

  it('approves or rejects with exactly the trip, the request and the answer', async () => {
    const { client, calls } = fake({ data: [{ request_id: REQUEST, outcome: 'approved', member_id: MEMBER }], error: null });
    expect(await decideJoinRequest(client, { tripId: TRIP, requestId: REQUEST, approve: true })).toEqual({ requestId: REQUEST, outcome: 'approved', memberId: MEMBER });
    expect(await decideJoinRequest(fake({ data: [{ request_id: REQUEST, outcome: 'rejected', member_id: null }], error: null }).client, { tripId: TRIP, requestId: REQUEST, approve: false })).toEqual({ requestId: REQUEST, outcome: 'rejected', memberId: null });
    expect(calls).toEqual([{ fn: 'decide_join_request', args: { p_trip_id: TRIP, p_request_id: REQUEST, p_approve: true } }]);
    expect(Object.keys(calls[0]!.args).join()).not.toMatch(/user|uid|actor/i);
    for (const outcome of ['already_decided', 'already_member']) {
      expect((await decideJoinRequest(fake({ data: [{ request_id: REQUEST, outcome, member_id: null }], error: null }).client, { tripId: TRIP, requestId: REQUEST, approve: true })).outcome).toBe(outcome);
    }
  });

  it('refuses malformed ids and a missing answer before anything is sent, and unrecognised answers after', async () => {
    const { client, calls } = fake();
    expect((await rejection(listJoinRequests(client, 'x'))).kind).toBe('unavailable');
    expect((await rejection(decideJoinRequest(client, { tripId: 'x', requestId: REQUEST, approve: true }))).kind).toBe('unavailable');
    expect((await rejection(decideJoinRequest(client, { tripId: TRIP, requestId: 'x', approve: true }))).kind).toBe('not_found');
    expect((await rejection(decideJoinRequest(client, { tripId: TRIP, requestId: REQUEST, approve: undefined as unknown as boolean }))).kind).toBe('unknown');
    expect(calls).toEqual([]);
    for (const data of [null, [], [{ request_id: REQUEST, outcome: 'joined', member_id: MEMBER }]]) {
      expect((await rejection(decideJoinRequest(fake({ data, error: null }).client, { tripId: TRIP, requestId: REQUEST, approve: true }))).kind, JSON.stringify(data)).toBe('unknown');
    }
  });
});

describe('what the database can answer, in plain words', () => {
  const cases: [string, string, string][] = [
    ['invite_invalid', 'invalid_link', INVITE_MESSAGES.invalid_link],
    ['trip_not_found', 'unavailable', UNAVAILABLE_MESSAGE],
    ['not_admin', 'not_admin', INVITE_MESSAGES.not_admin],
    ['trip_archived', 'archived', INVITE_MESSAGES.archived],
    ['request_used', 'request_used', INVITE_MESSAGES.request_used],
    ['claim_pending', 'claim_pending', INVITE_MESSAGES.claim_pending],
    ['claim_conflict', 'claim_conflict', INVITE_MESSAGES.claim_conflict],
    ['claim_unavailable', 'claim_unavailable', INVITE_MESSAGES.claim_unavailable],
    ['too_many_requests', 'too_many', INVITE_MESSAGES.too_many],
    ['trip_full', 'full', INVITE_MESSAGES.full],
    ['requester_unavailable', 'requester_unavailable', INVITE_MESSAGES.requester_unavailable],
    ['profile_missing', 'profile', INVITE_MESSAGES.profile],
    ['not_a_guest', 'not_a_guest', INVITE_MESSAGES.not_a_guest],
    ['member_not_found', 'not_found', INVITE_MESSAGES.not_found],
    ['invite_not_found', 'not_found', INVITE_MESSAGES.not_found],
    ['request_not_found', 'not_found', INVITE_MESSAGES.not_found],
    ['invalid_request', 'invalid', INVITE_MESSAGES.invalid],
  ];

  it.each(cases)('%s becomes %s', async (token, kind, message) => {
    const e = await rejection(requestToJoin(fake(err(`error: ${token}`)).client, TOKEN));
    expect(e).toBeInstanceOf(TripInviteError);
    expect(e.kind).toBe(kind);
    expect(e.message).toBe(message);
  });

  it('a claim conflict reads differently for the administrator who is deciding than for the person asking', async () => {
    const asked = await rejection(requestToJoin(fake(err('claim_conflict')).client, TOKEN));
    const decided = await rejection(decideJoinRequest(fake(err('claim_conflict')).client, { tripId: TRIP, requestId: REQUEST, approve: true }));
    expect(asked.message).toBe(INVITE_MESSAGES.claim_conflict);
    expect(decided.message).toBe(INVITE_MESSAGES.claim_conflict_admin);
    expect(decided.message).toMatch(/Reject the request/);
  });

  it('the same words are understood through every function', async () => {
    for (const act of [
      (c: TripInviteClient) => createInvite(c, { tripId: TRIP, options }),
      (c: TripInviteClient) => listInvites(c, TRIP),
      (c: TripInviteClient) => revokeInvite(c, { tripId: TRIP, inviteId: INVITE }),
      (c: TripInviteClient) => previewInvite(c, TOKEN),
      (c: TripInviteClient) => requestToJoin(c, TOKEN),
      (c: TripInviteClient) => listJoinRequests(c, TRIP),
      (c: TripInviteClient) => decideJoinRequest(c, { tripId: TRIP, requestId: REQUEST, approve: true }),
    ]) {
      expect((await rejection(act(fake(err('not_admin')).client))).kind).toBe('not_admin');
      expect((await rejection(act(fake(err('trip_not_found')).client))).kind).toBe('unavailable');
    }
  });

  it('a connection failure, a missing database update, a sign-out and anything else are told apart; raw text is never shown', async () => {
    const act = (c: TripInviteClient) => requestToJoin(c, TOKEN);
    expect((await rejection(act(fake(err('Failed to fetch')).client))).kind).toBe('network');
    expect((await rejection(act(fake(async () => { throw new TypeError('Failed to fetch'); }).client))).kind).toBe('network');
    expect((await rejection(act(fake(err('x', 'PGRST202')).client))).kind).toBe('setup');
    expect((await rejection(act(fake(err('x', '42883')).client))).kind).toBe('setup');
    expect((await rejection(act(fake(err('x', '28000')).client))).kind).toBe('auth');
    expect((await rejection(act(fake(err('permission denied for function request_to_join', '42501')).client))).kind).toBe('auth');
    const unknown = await rejection(act(fake(err('SELECT secret FROM somewhere at 10.0.0.5', 'XX000')).client));
    expect(unknown.kind).toBe('unknown');
    expect(unknown.message).toBe(INVITE_MESSAGES.unknown);
  });

  it('NO error or message ever contains the token, even when the database error text does', async () => {
    const poisoned = [`invite_invalid ${TOKEN}`, `invalid input syntax: "${TOKEN}"`, `request_used for ${TOKEN}`, `Failed to fetch ${TOKEN}`, `weird ${TOKEN}`];
    for (const text of poisoned) {
      for (const run of [(c: TripInviteClient) => requestToJoin(c, TOKEN), (c: TripInviteClient) => previewInvite(c, TOKEN)]) {
        const e = await rejection(run(fake(err(text)).client));
        expect(e.message).not.toContain(TOKEN);
        expect(JSON.stringify({ ...e, message: e.message, stack: undefined })).not.toContain(TOKEN);
      }
    }
    for (const m of Object.values(INVITE_MESSAGES)) expect(m).not.toMatch(/[0-9a-f]{32}|token|hash|sql|rpc|permission denied/i);
  });
});
