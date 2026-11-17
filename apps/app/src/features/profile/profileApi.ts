import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Profile, ThemePreference } from '@tripmate/core';
import { supabase } from '../../lib/supabase';
import { useUserId } from '../auth/AuthProvider';
import {
  ProfileError,
  fetchProfile,
  updateProfileDetails,
  updateThemePreference,
  type ProfilesClient,
} from './profileService';

/**
 * React hooks over profileService. TanStack Query keeps the profile cached so
 * every screen sees the same data, and refetches it when needed.
 *
 * The single cast below is the only place the real Supabase client meets the
 * small `ProfilesClient` interface the service (and its tests) are written
 * against; the shapes match at runtime.
 */
const client = supabase as unknown as ProfilesClient | null;

export const profileKey = (userId: string | null) => ['profile', userId] as const;

export function useProfile() {
  const userId = useUserId();
  return useQuery<Profile, ProfileError>({
    queryKey: profileKey(userId),
    queryFn: () => fetchProfile(client!, userId!),
    enabled: userId !== null && client !== null,
    staleTime: 60_000,
    // Retry once for connection hiccups only; retrying "not found" or "forbidden" would not help.
    retry: (count, error) => error.kind === 'network' && count < 1,
  });
}

export function useUpdateProfileDetails() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<Profile, ProfileError, unknown>({
    mutationFn: (input) => updateProfileDetails(client!, userId!, input),
    onSuccess: (profile) => queryClient.setQueryData(profileKey(userId), profile),
  });
}

export function useUpdateTheme() {
  const userId = useUserId();
  const queryClient = useQueryClient();
  return useMutation<Profile, ProfileError, ThemePreference>({
    mutationFn: (theme) => updateThemePreference(client!, userId!, theme),
    onSuccess: (profile) => queryClient.setQueryData(profileKey(userId), profile),
  });
}
