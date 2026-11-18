import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { Trip } from '@tripmate/core';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import { tripDetailsKey } from './tripDetailsApi';
import { tripsKey } from './tripApi';
import { TripEditError, setTripArchived, updateTrip, type SetArchivedVars, type TripEditClient, type UpdateTripVars } from './tripEditService';

/**
 * React hooks over tripEditService.
 *
 * After EVERY attempt (success or failure) the trip list and the trip's details are
 * re-fetched, so the screens always show what the database really holds: after a success
 * the new data, after a refused attempt (someone else changed or archived the trip, or
 * your rights changed) the current truth.
 *
 * The single cast is the only place the real Supabase client meets the small
 * `TripEditClient` interface the service (and its tests) are written against.
 */
const client = supabase as unknown as TripEditClient | null;

function useRefreshAfter(tripId: string) {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: tripsKey(userId) }),
      queryClient.invalidateQueries({ queryKey: tripDetailsKey(userId, tripId) }),
    ]);
}

export function useUpdateTrip(tripId: string) {
  const refresh = useRefreshAfter(tripId);
  return useMutation<Trip, TripEditError, UpdateTripVars>({
    mutationFn: (vars) => updateTrip(client!, vars),
    onSettled: refresh,
  });
}

export function useSetTripArchived(tripId: string) {
  const refresh = useRefreshAfter(tripId);
  return useMutation<Trip, TripEditError, SetArchivedVars>({
    mutationFn: (vars) => setTripArchived(client!, vars),
    onSettled: refresh,
  });
}
