import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { approveQuestion, askedLabel, canManagePeople, rejectQuestion, type JoinRequest, type TripDetails } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { spacing } from '../../theme/tokens';
import { useDecideJoinRequest, useJoinRequests } from './tripInviteApi';
import { TripInviteError } from './tripInviteService';

interface Props {
  details: TripDetails;
  userId: string | null;
  /** Re-reads the trip (used after a refused decision, to show what the database really holds). */
  reload: () => void;
}

type Pending = { request: JoinRequest; approve: boolean };

/**
 * The requests waiting for an administrator: who asked, when, and (for a friend's place) whose place.
 * Approve adds the person (or lets them take over the friend's place); Reject adds nobody.
 *
 * Hiding this from other people is a convenience: the database refuses to list or decide requests unless the
 * caller is an active administrator of an active trip, and re-checks everything (still waiting, room for one
 * more, the friend's place still free) at the moment of approval.
 */
export function JoinRequestsPanel({ details, userId, reload }: Props) {
  const canDecide = canManagePeople(details, userId);
  const requests = useJoinRequests(details.trip.id, canDecide);
  const decide = useDecideJoinRequest(details.trip.id);
  const submitting = useRef(false); // stops two quick taps sending two answers

  const [show, setShow] = useState(false); // collapsed by default; the count is always visible
  const [pending, setPending] = useState<Pending | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<TripInviteError | null>(null);

  if (!canDecide) return null;
  const waiting = requests.data ?? [];
  if (waiting.length === 0 && !notice && !error) return null;

  function confirm() {
    if (!pending || submitting.current) return;
    submitting.current = true;
    setDialogError(null);
    setNotice(null);
    setError(null);
    const { request, approve } = pending;
    decide.mutate(
      { tripId: details.trip.id, requestId: request.id, approve },
      {
        onSuccess: (done) => {
          submitting.current = false;
          setPending(null);
          setNotice(
            done.outcome === 'already_decided'
              ? 'Another admin already answered this request.'
              : done.outcome === 'already_member'
                ? `${request.requesterName} is already on the trip.`
                : done.outcome === 'rejected'
                  ? `${request.requesterName}'s request was rejected.`
                  : request.claimName
                    ? `${request.requesterName} took ${request.claimName}'s place.`
                    : `${request.requesterName} was added to the trip.`,
          );
        },
        onError: (e) => {
          submitting.current = false;
          // A connection problem can simply be retried from the same dialog; everything else is explained on the card.
          if (e.kind === 'network' || e.kind === 'unknown') setDialogError(e.message);
          else {
            setPending(null);
            setError(e);
          }
        },
      },
    );
  }

  const question = pending ? (pending.approve ? approveQuestion(pending.request) : rejectQuestion(pending.request)) : { title: '', message: '' };

  return (
    <View style={{ gap: spacing.xs }} testID="requests-section">
      {notice && (
        <Banner kind="success" testID="requests-notice">
          {notice}
        </Banner>
      )}
      {error && (
        <View style={{ gap: spacing.sm }}>
          <Banner kind="error" testID="requests-error">
            {error.message}
          </Banner>
          <Button
            testID="requests-reload"
            label="Reload latest"
            variant="secondary"
            onPress={() => {
              setError(null);
              void requests.refetch();
              reload();
            }}
          />
        </View>
      )}

      {waiting.length > 0 && (
        <>
          <Pressable
            testID="requests-toggle"
            onPress={() => setShow((v) => !v)}
            role="button"
            aria-expanded={show}
            aria-label={`Join requests, ${waiting.length} waiting. ${show ? 'Hide' : 'Show'}`}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <AppText variant="small" tone="brand" style={{ fontWeight: '700' }}>
              {`${show ? '▾' : '▸'} Join requests (${waiting.length})`}
            </AppText>
          </Pressable>
          {show && (
            <View style={{ gap: spacing.md }} testID="requests-list">
              <AppText variant="small" tone="secondary">
                These people opened your invitation link and asked to join. They cannot see the trip until you approve.
              </AppText>
              {waiting.map((r) => (
                <View key={r.id} testID={`request-${r.id}`} style={{ gap: spacing.xs }}>
                  <AppText testID={`request-name-${r.id}`}>{r.requesterName}</AppText>
                  {r.claimName && (
                    <AppText variant="small" tone="secondary" testID={`request-claim-${r.id}`}>
                      {`Wants to take ${r.claimName}'s place`}
                    </AppText>
                  )}
                  <AppText variant="small" tone="secondary" testID={`request-when-${r.id}`}>
                    {askedLabel(r.createdAt)}
                  </AppText>
                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <View style={{ flex: 1 }}>
                      <Button testID={`request-approve-${r.id}`} label="Approve" disabled={decide.isPending} onPress={() => { setDialogError(null); setPending({ request: r, approve: true }); }} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button testID={`request-reject-${r.id}`} label="Reject" variant="secondary" disabled={decide.isPending} onPress={() => { setDialogError(null); setPending({ request: r, approve: false }); }} />
                    </View>
                  </View>
                </View>
              ))}
            </View>
          )}
        </>
      )}

      <ConfirmDialog
        visible={pending !== null}
        title={question.title}
        message={question.message}
        confirmLabel={pending?.approve ? 'Approve' : 'Reject'}
        cancelLabel="Not yet"
        busy={decide.isPending}
        error={dialogError}
        onConfirm={confirm}
        onCancel={() => setPending(null)}
      />
    </View>
  );
}
