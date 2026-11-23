import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPIRY_HOURS,
  EXPIRY_CHOICES,
  MAX_EXPIRY_HOURS,
  approveQuestion,
  askedLabel,
  createInviteRpcArgs,
  copyableGeneralInvite,
  createdLabel,
  getGeneralInviteLinkRpcArgs,
  currentGeneralInvite,
  decideJoinRequestRpcArgs,
  expiresInLabel,
  inviteFromRow,
  inviteLink,
  inviteSummary,
  isInviteToken,
  joinRequestFromRow,
  listInvitesRpcArgs,
  listJoinRequestsRpcArgs,
  previewFromRow,
  previewInviteRpcArgs,
  rejectQuestion,
  requestToJoinRpcArgs,
  revokeInviteRpcArgs,
  tokenFromInput,
  validateInviteOptions,
  type Invite,
  type InviteRow,
} from './invite';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('tokens', () => {
  it('are exactly 64 lower-case hex characters', () => {
    expect(isInviteToken(TOKEN)).toBe(true);
    expect(isInviteToken('0'.repeat(64))).toBe(true);
    for (const bad of ['', 'abc', TOKEN.slice(1), `${TOKEN}0`, TOKEN.toUpperCase(), `${TOKEN.slice(1)}g`, ` ${TOKEN}`, `${TOKEN}\n`, null, undefined, 5, {}, [TOKEN]]) {
      expect(isInviteToken(bad), String(bad)).toBe(false);
    }
  });

  it('are found in a pasted link or a bare code, and nowhere else', () => {
    expect(tokenFromInput(TOKEN)).toBe(TOKEN);
    expect(tokenFromInput(`  ${TOKEN}  `)).toBe(TOKEN);
    expect(tokenFromInput(`https://tripmate.example/join/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromInput(`http://localhost:8081/join/${TOKEN}/`)).toBe(TOKEN);
    expect(tokenFromInput(`https://x.example/join/${TOKEN}?utm=1#top`)).toBe(TOKEN);
    expect(tokenFromInput(`tripmate:///join/${TOKEN}`)).toBe(TOKEN);
    for (const bad of ['', 'join', 'https://x.example/join/', 'https://x.example/join/short', `https://x.example/other/${TOKEN}`, `https://x.example/join/${TOKEN}extra`, `https://x.example/join/${TOKEN.toUpperCase()}`, null, undefined, 42, {}]) {
      expect(tokenFromInput(bad), String(bad)).toBeNull();
    }
  });

  it('make links of the form <origin>/join/<token>, tolerating a trailing slash on the origin', () => {
    expect(inviteLink('https://tripmate.example', TOKEN)).toBe(`https://tripmate.example/join/${TOKEN}`);
    expect(inviteLink('https://tripmate.example/', TOKEN)).toBe(`https://tripmate.example/join/${TOKEN}`);
    expect(tokenFromInput(inviteLink('http://localhost:8081', TOKEN))).toBe(TOKEN);
  });
});

describe('the options an administrator may choose', () => {
  it('are only how long the link lasts: 1, 7 or 30 days, 7 by default (no usage limit)', () => {
    expect(DEFAULT_EXPIRY_HOURS).toBe(168);
    expect(MAX_EXPIRY_HOURS).toBe(720);
    expect(EXPIRY_CHOICES.map((c) => c.hours)).toEqual([24, 168, 720]);
    expect(EXPIRY_CHOICES.some((c) => c.hours === DEFAULT_EXPIRY_HOURS)).toBe(true);
    expect(Object.keys(EXPIRY_CHOICES[0])).toEqual(['label', 'hours']);
  });

  it('are accepted inside the limits and refused outside them', () => {
    for (const hours of [1, 24, 168, 720]) expect(validateInviteOptions({ hours, claimMemberId: null }).ok, String(hours)).toBe(true);
    for (const hours of [0, 721, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(validateInviteOptions({ hours, claimMemberId: null }).ok, String(hours)).toBe(false);
    expect(validateInviteOptions({ hours: 168, claimMemberId: 'g' }).ok).toBe(true);
  });
});

describe('the arguments sent to the database', () => {
  it('use exactly the names the SQL declares, have no usage limit, and never carry a user id', () => {
    expect(createInviteRpcArgs('t', { hours: 24, claimMemberId: 'g' })).toEqual({ p_trip_id: 't', p_claim_member_id: 'g', p_expires_in_hours: 24 });
    expect(createInviteRpcArgs('t', { hours: 168, claimMemberId: null }).p_claim_member_id).toBeNull();
    expect(listInvitesRpcArgs('t')).toEqual({ p_trip_id: 't' });
    expect(revokeInviteRpcArgs('t', 'i')).toEqual({ p_trip_id: 't', p_invite_id: 'i' });
    expect(previewInviteRpcArgs(TOKEN)).toEqual({ p_token: TOKEN });
    expect(requestToJoinRpcArgs(TOKEN)).toEqual({ p_token: TOKEN });
    expect(listJoinRequestsRpcArgs('t')).toEqual({ p_trip_id: 't' });
    expect(decideJoinRequestRpcArgs('t', 'r', true)).toEqual({ p_trip_id: 't', p_request_id: 'r', p_approve: true });
    expect(decideJoinRequestRpcArgs('t', 'r', false).p_approve).toBe(false);
    for (const a of [
      createInviteRpcArgs('t', { hours: 1, claimMemberId: null }), listInvitesRpcArgs('t'), revokeInviteRpcArgs('t', 'i'), previewInviteRpcArgs(TOKEN),
      requestToJoinRpcArgs(TOKEN), listJoinRequestsRpcArgs('t'), decideJoinRequestRpcArgs('t', 'r', true),
    ]) {
      expect(Object.keys(a).join()).not.toMatch(/user|uid|actor|max_uses|uses/i);
    }
  });
});

describe('links, as the database sends them back', () => {
  const row = (over: Partial<InviteRow> = {}): InviteRow => ({
    invite_id: 'i1', claim_member_id: null, claim_name: null, created_by_name: 'Asha', expires_at: '2026-11-25T10:00:00Z', use_count: 0, revoked_at: null,
    created_at: '2026-11-18T10:00:00Z', status: 'active', ...over,
  });

  it('keep only what the screen shows, and treat an unknown state as unusable', () => {
    const inv = inviteFromRow(row({ use_count: 3 }));
    expect(inv).toEqual({ id: 'i1', claimName: null, createdByName: 'Asha', expiresAt: '2026-11-25T10:00:00Z', createdAt: '2026-11-18T10:00:00Z', requestCount: 3, status: 'active', copyable: false });
    expect(inviteFromRow(row({ status: 'weird' })).status).toBe('expired');
    expect(JSON.stringify(inv)).not.toMatch(/token|hash/i);
  });

  it('only the live general link with a kept secret is copyable; friend links, expired, revoked and older links are not', () => {
    expect(inviteFromRow(row({ copyable: true })).copyable).toBe(true);
    expect(inviteFromRow(row({ copyable: true, claim_member_id: 'm1', claim_name: 'Gita' })).copyable).toBe(false);
    expect(inviteFromRow(row({ copyable: true, status: 'expired' })).copyable).toBe(false);
    expect(inviteFromRow(row({ copyable: true, status: 'revoked' })).copyable).toBe(false);
    expect(inviteFromRow(row()).copyable).toBe(false);
    const mk = (id: string, copyable: boolean): Invite => ({ id, claimName: null, createdByName: 'A', expiresAt: '', createdAt: '', requestCount: 0, status: 'active', copyable });
    expect(copyableGeneralInvite([mk('a', false)])).toBeNull();
    expect(copyableGeneralInvite([mk('a', false), mk('b', true)])?.id).toBe('b');
    expect(getGeneralInviteLinkRpcArgs('t1')).toEqual({ p_trip_id: 't1' });
  });

  it("the trip's general link is the live one that is not for a friend (active or expired, never cancelled)", () => {
    const mk = (id: string, status: Invite['status'], claimName: string | null = null): Invite => ({ id, claimName, createdByName: 'A', expiresAt: '', createdAt: '', requestCount: 0, status, copyable: false });
    expect(currentGeneralInvite([])).toBeNull();
    expect(currentGeneralInvite([mk('c', 'active', 'Gita'), mk('old', 'revoked')])).toBeNull();
    expect(currentGeneralInvite([mk('c', 'active', 'Gita'), mk('g', 'active')])!.id).toBe('g');
    expect(currentGeneralInvite([mk('g', 'expired'), mk('old', 'revoked')])!.id).toBe('g');
  });

  it("a preview keeps the public facts; the friend's name is shown only for a link made for one", () => {
    const base = { trip_name: 'Goa', destination: 'Goa, India', start_date: '2026-12-27', end_date: '2026-12-30', inviter_name: 'Asha', member_count: 3 };
    expect(previewFromRow({ ...base, is_claim: false, claim_name: null })).toEqual({ tripName: 'Goa', destination: 'Goa, India', startDate: '2026-12-27', endDate: '2026-12-30', inviterName: 'Asha', memberCount: 3, claimName: null });
    expect(previewFromRow({ ...base, is_claim: true, claim_name: 'Gita' }).claimName).toBe('Gita');
    expect(previewFromRow({ ...base, is_claim: false, claim_name: 'Leaked' }).claimName).toBeNull();
  });
});

describe('join requests', () => {
  it("keep a name, a time and (for a claim) the friend's place: never a user id", () => {
    const r = joinRequestFromRow({ request_id: 'r1', requester_name: 'Nina Shah', claim_member_id: null, claim_name: null, created_at: '2026-11-23T04:45:00Z' });
    expect(r).toEqual({ id: 'r1', requesterName: 'Nina Shah', claimName: null, createdAt: '2026-11-23T04:45:00Z' });
    expect(joinRequestFromRow({ request_id: 'r2', requester_name: 'Nina', claim_member_id: 'g', claim_name: 'Gita', created_at: 'x' }).claimName).toBe('Gita');
    expect(joinRequestFromRow({ request_id: 'r3', requester_name: 'Nina', claim_member_id: null, claim_name: 'Leaked', created_at: 'x' }).claimName).toBeNull();
    expect(Object.keys(r).join()).not.toMatch(/user/i);
  });

  it('are put to the administrator in plain words, differently for a claim', () => {
    const plain = { id: 'r', requesterName: 'Nina Shah', claimName: null, createdAt: '' };
    const claim = { ...plain, claimName: 'Gita' };
    expect(approveQuestion(plain).title).toBe('Add Nina Shah to this trip?');
    expect(approveQuestion(plain).message).toMatch(/will become a member/);
    expect(approveQuestion(claim).title).toBe("Let Nina Shah take Gita's place?");
    expect(approveQuestion(claim).message).toMatch(/with everything already recorded for Gita\. Nobody else is added/);
    expect(rejectQuestion(plain).title).toBe("Reject Nina Shah's request?");
    expect(rejectQuestion(plain).message).toMatch(/will not be added/);
    expect(rejectQuestion(plain).message).toMatch(/cannot ask again with the current link/);
    expect(rejectQuestion(claim).message).toMatch(/Gita's place stays as it is/);
  });
});

describe('wording', () => {
  const NOW = Date.parse('2026-11-18T10:00:00Z');
  const at = (ms: number) => new Date(NOW + ms).toISOString();

  it('says how long a link has left', () => {
    expect(expiresInLabel(at(7 * 86_400_000), NOW)).toBe('Expires in 7 days');
    expect(expiresInLabel(at(7 * 86_400_000 - 60_000), NOW)).toBe('Expires in 7 days'); // a link made a minute ago
    expect(expiresInLabel(at(30 * 86_400_000 - 5000), NOW)).toBe('Expires in 30 days');
    expect(expiresInLabel(at(2 * 86_400_000 + 4 * 3_600_000), NOW)).toBe('Expires in 2 days');
    expect(expiresInLabel(at(86_400_000 + 5), NOW)).toBe('Expires in 1 day');
    expect(expiresInLabel(at(23 * 3_600_000 + 1), NOW)).toBe('Expires in 23 hours');
    expect(expiresInLabel(at(3_600_000 + 1), NOW)).toBe('Expires in 1 hour');
    expect(expiresInLabel(at(59 * 60_000), NOW)).toBe('Expires in less than an hour');
    expect(expiresInLabel(at(0), NOW)).toBe('Expired');
    expect(expiresInLabel(at(-1000), NOW)).toBe('Expired');
    expect(expiresInLabel('not a date', NOW)).toBe('Expired');
  });

  it("describes a link in one line, for the general link and for a friend's link", () => {
    const base = { id: 'i', claimName: null, createdByName: 'Asha', expiresAt: at(2 * 86_400_000 + 5), createdAt: at(-1000), requestCount: 0, status: 'active', copyable: false } as const;
    expect(inviteSummary(base, NOW)).toBe('Invitation link · No requests yet · Expires in 2 days');
    expect(inviteSummary({ ...base, requestCount: 1 }, NOW)).toBe('Invitation link · 1 request so far · Expires in 2 days');
    expect(inviteSummary({ ...base, requestCount: 3 }, NOW)).toBe('Invitation link · 3 requests so far · Expires in 2 days');
    expect(inviteSummary({ ...base, claimName: 'Gita' }, NOW)).toBe('For Gita · No request yet · Expires in 2 days');
    expect(inviteSummary({ ...base, claimName: 'Gita', requestCount: 1, status: 'used' }, NOW)).toBe('For Gita · A request was made · Used');
    expect(inviteSummary({ ...base, status: 'revoked' }, NOW)).toMatch(/Cancelled$/);
    expect(inviteSummary({ ...base, status: 'expired' }, NOW)).toMatch(/Expired$/);
    expect(inviteSummary({ ...base, requestCount: 2, status: 'revoked' }, NOW)).toMatch(/2 requests so far/); // requests already made are still counted
  });
});

describe('when a link was made and when someone asked', () => {
  const original = process.env.TZ;
  afterEach(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });

  // The same moment reads differently in different places: 04:45 UTC on 23 November is 10:15 am in India.
  it.each([
    ['Asia/Kolkata', '23 Nov 2026, 10:15 am'],
    ['UTC', '23 Nov 2026, 4:45 am'],
    ['America/Los_Angeles', '22 Nov 2026, 8:45 pm'],
    ['Pacific/Kiritimati', '23 Nov 2026, 6:45 pm'],
    ['Pacific/Pago_Pago', '22 Nov 2026, 5:45 pm'],
  ])("are shown in the viewer's own time zone (%s)", (zone, expected) => {
    process.env.TZ = zone;
    expect(createdLabel('2026-11-23T04:45:00Z')).toBe(`Created ${expected}`);
    expect(askedLabel('2026-11-23T04:45:00Z')).toBe(`Asked ${expected}`);
  });

  it('handle midnight, noon and single-digit minutes (12-hour clock)', () => {
    process.env.TZ = 'UTC';
    expect(createdLabel('2026-01-05T00:05:00Z')).toBe('Created 5 Jan 2026, 12:05 am');
    expect(createdLabel('2026-01-05T12:00:00Z')).toBe('Created 5 Jan 2026, 12:00 pm');
    expect(createdLabel('2026-12-31T23:59:00Z')).toBe('Created 31 Dec 2026, 11:59 pm');
    expect(askedLabel('2026-06-01T13:07:00Z')).toBe('Asked 1 Jun 2026, 1:07 pm');
  });

  it('say so, rather than failing, when the moment is unreadable', () => {
    for (const bad of ['', 'garbage', 'not a date']) {
      expect(createdLabel(bad)).toBe('Created at an unknown time');
      expect(askedLabel(bad)).toBe('Asked at an unknown time');
    }
  });
});
