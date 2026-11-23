import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { formatDateRange, isInviteToken } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Screen } from '../../components/Screen';
import { useAuth } from '../../features/auth/AuthProvider';
import { usePreviewInvite, useRequestToJoin } from '../../features/trips/tripInviteApi';
import { TripInviteError } from '../../features/trips/tripInviteService';
import { pendingInvite } from '../../lib/pendingInvite';
import { spacing } from '../../theme/tokens';

/**
 * An invitation link: /join/<token>.
 *
 * Open to signed-out visitors (they see what they are invited to, then sign in or create an account, and are
 * brought back here) and to signed-in people (who press Request to join). Asking is always an explicit press, and
 * it NEVER adds anyone to the trip: it sends a request that an administrator approves or rejects. Until then the
 * person can see nothing about the trip (they are not a member), which the database enforces.
 *
 * SECRECY: the token is a secret in the address. It is never shown on this screen, never written to messages, and
 * the "not valid" page is the same for a link that was never real, has expired, was replaced or cancelled, or
 * belongs to an archived trip. Who may be added, and everything else, is decided by the database.
 */
export default function JoinScreen() {
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const raw = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = isInviteToken(raw) ? raw : null;
  const router = useRouter();
  const { state } = useAuth();
  const signedIn = state.status === 'signedIn';

  const preview = usePreviewInvite(token ?? '');
  const ask = useRequestToJoin();
  const submitting = useRef(false); // a ref updates at once: stops two quick taps sending two requests
  const [askError, setAskError] = useState<TripInviteError | null>(null);
  const [sent, setSent] = useState<'requested' | 'already_requested' | null>(null);

  const notValid = token === null || preview.error?.kind === 'invalid_link' || askError?.kind === 'invalid_link';

  // A link that cannot be used must not be remembered for after sign-in.
  useEffect(() => {
    if (notValid) pendingInvite.clear();
  }, [notValid]);

  function requestToJoin() {
    if (!token || submitting.current) return;
    submitting.current = true;
    setAskError(null);
    ask.mutate(token, {
      onSuccess: (done) => {
        submitting.current = false;
        pendingInvite.clear();
        if (done.outcome === 'already_member') router.replace(`/trips/${done.tripId}`);
        else setSent(done.outcome);
      },
      onError: (e) => {
        submitting.current = false;
        setAskError(e);
      },
    });
  }

  /** Signed-out: keep the link for after sign-in, then go and sign in or create an account. */
  function goToAuth(path: '/sign-in' | '/sign-up') {
    pendingInvite.remember(token);
    router.push(path);
  }

  if (notValid) {
    return (
      <Screen>
        <Card>
          <AppText variant="heading" testID="join-invalid-title">
            This invite link isn&apos;t valid
          </AppText>
          <AppText testID="join-invalid">
            It may have expired, been replaced, or been cancelled. Ask the person who invited you for the current link.
          </AppText>
          {signedIn ? (
            <Button testID="join-home" label="Back to Home" onPress={() => router.replace('/')} />
          ) : (
            <Button testID="join-signin-plain" label="Sign in" onPress={() => router.replace('/sign-in')} />
          )}
        </Card>
      </Screen>
    );
  }

  if (preview.isPending) {
    return (
      <Screen>
        <AppText tone="secondary" testID="join-loading">
          Opening your invitation…
        </AppText>
      </Screen>
    );
  }

  if (preview.error || !preview.data) {
    return (
      <Screen>
        <Card>
          <Banner kind="error" testID="join-load-error">
            {preview.error?.message ?? 'Something went wrong. Please try again.'}
          </Banner>
          <Button testID="join-retry" label="Try again" variant="secondary" onPress={() => void preview.refetch()} loading={preview.isFetching} />
        </Card>
      </Screen>
    );
  }

  const p = preview.data;

  if (sent) {
    return (
      <Screen>
        <Card>
          <AppText variant="small" tone="brand" style={{ fontWeight: '600' }}>
            {sent === 'requested' ? 'Request sent' : 'Already requested'}
          </AppText>
          <AppText variant="title" testID="join-requested-title">
            {p.tripName}
          </AppText>
          <AppText testID="join-requested">
            {`${sent === 'requested' ? 'Your request has been sent.' : 'You have already asked to join.'} An admin needs to approve it. The trip will appear on your Home screen when they do.`}
          </AppText>
          <AppText variant="small" tone="secondary" testID="join-requested-privacy">
            Until then you cannot see anything about the trip.
          </AppText>
          <Button testID="join-requested-home" label="Back to Home" onPress={() => router.replace('/')} />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen>
      <Card>
        <AppText variant="small" tone="brand" style={{ fontWeight: '600' }}>
          You&apos;re invited
        </AppText>
        <AppText variant="title" testID="join-trip-name">
          {p.tripName}
        </AppText>
        <View style={{ gap: spacing.xs }}>
          <AppText tone="secondary" testID="join-destination">
            {p.destination}
          </AppText>
          <AppText tone="secondary" testID="join-dates">
            {formatDateRange(p.startDate, p.endDate)}
          </AppText>
          <AppText variant="small" tone="secondary" testID="join-inviter">
            {`Invited by ${p.inviterName}`}
          </AppText>
          <AppText variant="small" tone="secondary" testID="join-count">
            {`${p.memberCount} ${p.memberCount === 1 ? 'person is' : 'people are'} on this trip`}
          </AppText>
        </View>
        {p.claimName && (
          <Banner kind="info" testID="join-claim-note">
            {`This invitation is for ${p.claimName}. If an admin approves your request, you take over ${p.claimName}'s place on the trip, with everything already recorded for them.`}
          </Banner>
        )}
        <AppText variant="small" tone="secondary" testID="join-approval-note">
          You can ask to join. An admin has to approve your request before you can see the trip.
        </AppText>

        {askError && (
          <Banner kind="error" testID="join-error">
            {askError.message}
          </Banner>
        )}

        {signedIn ? (
          <Button testID="join-request" label={p.claimName ? `Ask to take ${p.claimName}'s place` : 'Request to join'} loading={ask.isPending} onPress={requestToJoin} />
        ) : (
          <View style={{ gap: spacing.sm }}>
            <AppText variant="small" tone="secondary" testID="join-needs-account">
              You need a TripMate account to ask. You will come straight back here afterwards.
            </AppText>
            <Button testID="join-signin" label="Sign in to ask to join" onPress={() => goToAuth('/sign-in')} />
            <Button testID="join-signup" label="Create an account" variant="secondary" onPress={() => goToAuth('/sign-up')} />
          </View>
        )}
      </Card>
    </Screen>
  );
}
