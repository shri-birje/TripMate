import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Invite, InvitePreview, JoinRequest } from '@tripmate/core';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import { tripDetailsKey } from './tripDetailsApi';
import { tripsKey } from './tripApi';
import {
  TripInviteError,
  createInvite,
  decideJoinRequest,
  getGeneralInviteLink,
  listInvites,
  listJoinRequests,
  previewInvite,
  requestToJoin,
  revokeInvite,
  type CreateInviteVars,
  type CreatedInvite,
  type Decided,
  type GeneralLink,
  type DecideVars,
  type RequestResult,
  type RevokeVars,
  type TripInviteClient,
} from './tripInviteService';

/**
 * React hooks over tripInviteService.
 *
 * SECRECY: an invitation token is a secret. It is held in memory only: never in a query key for the
 * administrator's lists (they have no tokens at all), and the preview's cache entry is dropped the moment the
 * screen closes (gcTime 0). The token returned by creating a link lives only in that mutation's result, which
 * the screen clears (`reset`) as soon as the administrator is done with it.
 *
 * Asking to join never changes what the asker can see (they are not a member), so nothing about the trip is
 * refreshed for them; only an administrator's APPROVAL changes the trip, so that is what refreshes the people,
 * the trip list and the request list.
 *
 * The single cast is the only place the real Supabase client meets the small `TripInviteClient` interface the
 * service (and its tests) are written against.
 */
const client = supabase as unknown as TripInviteClient | null;

export const invitesKey = (userId: string | null, tripId: string) => ['trip-invites', userId, tripId] as const;
export const joinRequestsKey = (userId: string | null, tripId: string) => ['join-requests', userId, tripId] as const;

/** The administrator's list of links for a trip (never any token or hash). */
export function useTripInvites(tripId: string, enabled: boolean) {
  const userId = useUserId();
  return useQuery<Invite[], TripInviteError>({
    queryKey: invitesKey(userId, tripId),
    queryFn: () => listInvites(client!, tripId),
    enabled: enabled && userId !== null && client !== null,
    staleTime: 10_000,
    retry: (count, error) => error.kind === 'network' && count < 1,
  });
}

export function useCreateInvite(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<CreatedInvite, TripInviteError, CreateInviteVars>({
    mutationFn: (vars) => createInvite(client!, vars),
    gcTime: 0, // the secret token is not kept around once nothing is looking at it
    onSettled: () => queryClient.invalidateQueries({ queryKey: invitesKey(userId, tripId) }),
  });
}

/** Copy link: fetches the live general link's token on demand. Nothing is cached: the token lives only in the result. */
export function useCopyGeneralLink(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<GeneralLink | null, TripInviteError, void>({
    mutationFn: () => getGeneralInviteLink(client!, tripId),
    gcTime: 0,
    // a "nothing to copy" answer means the list on screen is stale
    onSuccess: (link) => (link ? undefined : queryClient.invalidateQueries({ queryKey: invitesKey(userId, tripId) })),
  });
}

export function useRevokeInvite(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<{ inviteId: string; changed: boolean }, TripInviteError, RevokeVars>({
    mutationFn: (vars) => revokeInvite(client!, vars),
    onSettled: () => queryClient.invalidateQueries({ queryKey: invitesKey(userId, tripId) }),
  });
}

/** What a link is for. Works signed out. The cache entry is dropped as soon as the screen closes. */
export function usePreviewInvite(token: string) {
  return useQuery<InvitePreview, TripInviteError>({
    queryKey: ['invite-preview', token],
    queryFn: () => previewInvite(client!, token),
    enabled: client !== null,
    staleTime: 0,
    gcTime: 0,
    // Retrying a "not valid" link or a setup problem would not help; a dropped connection gets one more try.
    retry: (count, error) => error.kind === 'network' && count < 1,
  });
}

/** Asks to join the trip (or to take a friend's place). The asker does not become a member and sees nothing more. */
export function useRequestToJoin() {
  return useMutation<RequestResult, TripInviteError, string>({
    mutationFn: (token) => requestToJoin(client!, token),
    gcTime: 0,
  });
}

/** The requests waiting for an administrator (names and times only). */
export function useJoinRequests(tripId: string, enabled: boolean) {
  const userId = useUserId();
  return useQuery<JoinRequest[], TripInviteError>({
    queryKey: joinRequestsKey(userId, tripId),
    queryFn: () => listJoinRequests(client!, tripId),
    enabled: enabled && userId !== null && client !== null,
    staleTime: 10_000,
    retry: (count, error) => error.kind === 'network' && count < 1,
  });
}

/** An administrator approves or rejects a request. Afterwards the requests, the people and the trip list are re-read. */
export function useDecideJoinRequest(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<Decided, TripInviteError, DecideVars>({
    mutationFn: (vars) => decideJoinRequest(client!, vars),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: joinRequestsKey(userId, tripId) }),
        queryClient.invalidateQueries({ queryKey: invitesKey(userId, tripId) }),
        queryClient.invalidateQueries({ queryKey: tripDetailsKey(userId, tripId) }),
        queryClient.invalidateQueries({ queryKey: tripsKey(userId) }),
      ]),
  });
}
