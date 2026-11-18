import { useQuery } from '@tanstack/react-query';
import type { TripDetails } from '@tripmate/core';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import { TripDetailsError, getTripDetails, type TripDetailsClient } from './tripDetailsService';

/**
 * React hook over getTripDetails. The cache key includes the signed-in user, so one
 * person's trip can never be served from the cache to another account on the same device.
 *
 * The single cast is the only place the real Supabase client meets the small
 * `TripDetailsClient` interface the service (and its tests) are written against.
 */
const client = supabase as unknown as TripDetailsClient | null;

export const tripDetailsKey = (userId: string | null, tripId: string) => ['trip-details', userId, tripId] as const;

export function useTripDetails(tripId: string) {
  const userId = useUserId();
  return useQuery<TripDetails, TripDetailsError>({
    queryKey: tripDetailsKey(userId, tripId),
    queryFn: () => getTripDetails(client!, tripId),
    enabled: userId !== null && client !== null,
    staleTime: 15_000,
    // Retry once for a connection hiccup only. Retrying "not available" or a setup problem would not help.
    retry: (count, error) => error.kind === 'network' && count < 1,
  });
}
