import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Trip } from '@tripmate/core';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import { TripError, createTrip, listTrips, type TripsClient } from './tripService';

/**
 * React hooks over tripService. TanStack Query caches the trip list so every
 * screen sees the same data, and refreshes it after a trip is created.
 *
 * The single cast below is the only place the real Supabase client meets the
 * small `TripsClient` interface the service (and its tests) are written against.
 */
const client = supabase as unknown as TripsClient | null;

export const tripsKey = (userId: string | null) => ['trips', userId] as const;

export function useTrips() {
  const userId = useUserId();
  return useQuery<Trip[], TripError>({
    queryKey: tripsKey(userId),
    queryFn: () => listTrips(client!),
    enabled: userId !== null && client !== null,
    staleTime: 30_000,
    retry: (count, error) => error.kind === 'network' && count < 1,
  });
}

export function useCreateTrip() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<Trip, TripError, unknown>({
    mutationFn: (input) => createTrip(client!, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: tripsKey(userId) }),
  });
}
