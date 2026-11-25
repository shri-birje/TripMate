import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import { tripDetailsKey } from './tripDetailsApi';
import { tripsKey } from './tripApi';
import { memberChangeExpenseKeys } from './memberChangeKeys';
import {
  TripMemberError,
  addGuestMember,
  leaveTrip,
  removeMember,
  renameGuestMember,
  setMemberRole,
  type AddGuestVars,
  type MemberChange,
  type RemoveVars,
  type RenameGuestVars,
  type SetRoleVars,
  type TripMemberClient,
} from './tripMemberService';

/**
 * React hooks over tripMemberService.
 *
 * After EVERY attempt (success or failure) the trip's details (its people) and the trip list are
 * re-fetched, so the screens always show what the database really holds: after a success the new
 * people, after a refused attempt (someone else changed things, your rights changed) the current truth.
 * The exception is leaving: once you have left, the trip is no longer yours to read, so only the trip
 * list is refreshed and the trip's details are just marked out of date (the screen goes Home).
 *
 * The single cast is the only place the real Supabase client meets the small `TripMemberClient`
 * interface the service (and its tests) are written against.
 */
const client = supabase as unknown as TripMemberClient | null;

function useRefresh(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  const all = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: tripsKey(userId) }),
      queryClient.invalidateQueries({ queryKey: tripDetailsKey(userId, tripId) }),
      ...memberChangeExpenseKeys(userId, tripId).map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    ]);
  const afterLeaving = () => {
    void queryClient.invalidateQueries({ queryKey: tripsKey(userId) });
    void queryClient.invalidateQueries({ queryKey: tripDetailsKey(userId, tripId), refetchType: 'none' });
  };
  return { all, afterLeaving };
}

export function useAddGuest(tripId: string) {
  const { all } = useRefresh(tripId);
  return useMutation<MemberChange, TripMemberError, AddGuestVars>({ mutationFn: (v) => addGuestMember(client!, v), onSettled: all });
}

export function useRenameGuest(tripId: string) {
  const { all } = useRefresh(tripId);
  return useMutation<MemberChange, TripMemberError, RenameGuestVars>({ mutationFn: (v) => renameGuestMember(client!, v), onSettled: all });
}

export function useSetMemberRole(tripId: string) {
  const { all } = useRefresh(tripId);
  return useMutation<MemberChange, TripMemberError, SetRoleVars>({ mutationFn: (v) => setMemberRole(client!, v), onSettled: all });
}

export function useRemoveMember(tripId: string) {
  const { all } = useRefresh(tripId);
  return useMutation<MemberChange, TripMemberError, RemoveVars>({ mutationFn: (v) => removeMember(client!, v), onSettled: all });
}

export function useLeaveTrip(tripId: string) {
  const { all, afterLeaving } = useRefresh(tripId);
  return useMutation<MemberChange, TripMemberError, { tripId: string }>({
    mutationFn: (v) => leaveTrip(client!, v),
    onSuccess: afterLeaving,
    onError: () => void all(),
  });
}
