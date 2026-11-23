import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Share, View } from 'react-native';
import * as Linking from 'expo-linking';
import { EXPIRY_CHOICES, canManagePeople, createdLabel, currentGeneralInvite, inviteSummary, type Invite, type TripDetails, type TripMember } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { SegmentedControl } from '../../components/SegmentedControl';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';
import { useCopyGeneralLink, useCreateInvite, useRevokeInvite, useTripInvites } from './tripInviteApi';
import { TripInviteError } from './tripInviteService';

interface Props {
  details: TripDetails;
  userId: string | null;
  /** The friend a claim link is being made for (chosen from that friend's Manage menu), or null for the trip's general link. */
  claimFor: TripMember | null;
  onClaimDone: () => void;
}

/** The address people open. Until a web address is chosen for TripMate, this is the address the app is running on. */
const linkFor = (token: string) => Linking.createURL(`/join/${token}`);
const DEFAULT_HOURS = String(EXPIRY_CHOICES[1].hours);

/**
 * Administrators make, copy and revoke invitation links here.
 *
 * A trip has ONE reusable general link that anyone can use to ASK to join (nobody joins until an administrator
 * approves the request). While it is valid it cannot be replaced: Copy link returns the very same link every time
 * (the database keeps the token encrypted and gives it only to an active administrator), and Revoke link ends it.
 * A friend added by name can also get a single-use claim link, which likewise only creates a request; that link
 * is shown ONCE and never stored. The token is held in memory just long enough to copy it and is never shown,
 * logged or cached. Hiding this section from other people is a convenience: the database refuses every action
 * unless the caller is an active administrator of an active trip.
 */
export function InvitePanel({ details, userId, claimFor, onClaimDone }: Props) {
  const { colors } = useTheme();
  const { trip } = details;
  const canInvite = canManagePeople(details, userId);

  const create = useCreateInvite(trip.id);
  const revoke = useRevokeInvite(trip.id);
  const copyGeneral = useCopyGeneralLink(trip.id);
  const invites = useTripInvites(trip.id, canInvite);
  const busy = useRef(false); // stops two quick taps making two links

  const [open, setOpen] = useState(false);
  const [expiry, setExpiry] = useState(DEFAULT_HOURS);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [showActive, setShowActive] = useState(false); // the friends' links list starts collapsed; a successful create opens it
  const [cancelling, setCancelling] = useState<{ invite: Invite; label: string } | null>(null);
  const [error, setError] = useState<TripInviteError | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Choosing "Invite to claim this spot" on a friend opens the panel for that friend.
  useEffect(() => {
    if (claimFor) {
      create.reset();
      setExpiry(DEFAULT_HOURS);
      setError(null);
      setCopy('idle');
      setOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimFor?.id]);

  if (!canInvite) return null;

  const created = create.data ?? null;
  const link = created ? linkFor(created.token) : null;
  const now = Date.now();
  const all = invites.data ?? [];
  const general = currentGeneralInvite(all);
  const generalLive = general !== null && general.status === 'active';
  const claimInvites = all.filter((i) => i.status === 'active' && i.claimName !== null);

  function submit() {
    if (busy.current) return;
    setError(null);
    setCopy('idle');
    busy.current = true;
    create.mutate(
      { tripId: trip.id, options: { hours: Number(expiry), claimMemberId: claimFor?.id ?? null } },
      {
        onSuccess: () => setShowActive(true), // so the new link is easy to find
        onError: (e) => setError(e),
        onSettled: () => { busy.current = false; },
      },
    );
  }

  /** Copy link on the live general link: asks the database for the same link again, copies it, then forgets it. */
  function copyGeneralLink() {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setCopy('idle');
    copyGeneral.mutate(undefined, {
      onSuccess: async (got) => {
        try {
          if (!got) setCopy('failed');
          else {
            const text = linkFor(got.token);
            if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
            else await Share.share({ message: text });
            setCopy('copied');
          }
        } catch {
          setCopy('failed');
        } finally {
          copyGeneral.reset(); // the token is dropped from memory
          busy.current = false;
        }
      },
      onError: (e) => {
        busy.current = false;
        setError(e);
      },
    });
  }

  function finish() {
    create.reset(); // the secret link is dropped from memory
    setExpiry(DEFAULT_HOURS); // the next link starts from the default again (7 days)
    setOpen(false);
    setCopy('idle');
    setError(null);
    onClaimDone();
  }

  async function copyLink() {
    if (!link) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(link);
      else await Share.share({ message: link });
      setCopy('copied');
    } catch {
      setCopy('failed');
    }
  }

  function confirmCancel() {
    if (!cancelling || busy.current) return;
    busy.current = true;
    setDialogError(null);
    revoke.mutate(
      { tripId: trip.id, inviteId: cancelling.invite.id },
      {
        onSuccess: () => {
          busy.current = false;
          setCancelling(null);
        },
        onError: (e) => {
          busy.current = false;
          if (e.kind === 'network' || e.kind === 'unknown') setDialogError(e.message);
          else {
            setCancelling(null);
            setError(e);
          }
        },
      },
    );
  }

  const cancellingGeneral = cancelling !== null && cancelling.invite.claimName === null;

  return (
    <View style={{ gap: spacing.sm }} testID="invite-section">
      <AppText variant="heading">Invite people</AppText>
      <AppText variant="small" tone="secondary" testID="invite-approval-note">
        Anyone with the invitation link can ask to join. Nobody joins until an admin approves their request.
      </AppText>

      {general && generalLive && (
        <View style={{ gap: spacing.xs }} testID="invite-general">
          <AppText variant="small" tone="secondary" testID={`invite-created-at-${general.id}`}>
            {createdLabel(general.createdAt)}
          </AppText>
          <AppText variant="small" testID={`invite-summary-${general.id}`}>
            {inviteSummary(general, now)}
          </AppText>
          {general.copyable ? (
            <>
              <Button testID="invite-copy-link" label={Platform.OS === 'web' ? 'Copy link' : 'Share link'} loading={copyGeneral.isPending} onPress={copyGeneralLink} />
              {copy === 'copied' && !created && (
                <AppText variant="small" tone="ok" testID="invite-copied">
                  Link copied.
                </AppText>
              )}
              {copy === 'failed' && !created && (
                <AppText variant="small" tone="error" testID="invite-copy-failed">
                  Couldn&apos;t copy the link. Reload and try again.
                </AppText>
              )}
              <AppText variant="small" tone="secondary" testID="invite-copy-note">
                Copy link gives you this same link every time. Revoke link to end it; you can then make a new one.
              </AppText>
            </>
          ) : (
            <AppText variant="small" tone="secondary" testID="invite-legacy-note">
              This link was made before links could be copied again, so it can&apos;t be copied. Revoke it and create a new link to get one you can copy any time.
            </AppText>
          )}
          <Button
            testID={`invite-revoke-${general.id}`}
            label="Revoke link"
            variant="secondary"
            disabled={revoke.isPending}
            onPress={() => {
              setDialogError(null);
              setCancelling({ invite: general, label: `${createdLabel(general.createdAt)} · ${inviteSummary(general, now)}` });
            }}
          />
        </View>
      )}

      {!open && !created && !generalLive && (
        <View style={{ gap: spacing.xs }}>
          {general && general.status === 'expired' && (
            <AppText variant="small" tone="secondary" testID="invite-expired-note">
              The trip&apos;s invitation link has expired. Requests already made are still waiting for you.
            </AppText>
          )}
          <Button testID="invite-open" label="Create invitation link" variant="secondary" onPress={() => { create.reset(); setError(null); setOpen(true); }} />
        </View>
      )}

      {open && !created && (
        <View style={{ gap: spacing.sm }} testID="invite-options">
          {claimFor ? (
            <AppText testID="invite-claim-note">{`This link is for ${claimFor.displayName}. When they open it and ask to join, an admin approves, and ${claimFor.displayName}'s place on the trip becomes their own account, with everything already recorded for them.`}</AppText>
          ) : (
            <AppText tone="secondary">One link for the whole trip: you share it, people ask to join, and you approve each request.</AppText>
          )}
          <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }} testID="invite-expiry-caption">
            Link lasts
          </AppText>
          <SegmentedControl label="Link lasts" testIDPrefix="invite-expiry" options={EXPIRY_CHOICES.map((c) => ({ value: String(c.hours), label: c.label }))} value={expiry} onChange={setExpiry} />
          {claimFor && (
            <AppText variant="small" tone="secondary" testID="invite-claim-single-use">{`Single use: only ${claimFor.displayName} can use this link.`}</AppText>
          )}
          <AppText variant="small" tone="secondary" testID="invite-replace-note">
            {claimFor
              ? `If ${claimFor.displayName} already has a link, this replaces it: the old one stops working.`
              : 'You can copy this link again any time. To end it, use Revoke link; requests already made always stay.'}
          </AppText>
          <Button testID="invite-create" label="Create link" loading={create.isPending} onPress={submit} />
          <Button testID="invite-cancel-options" label="Cancel" variant="secondary" disabled={create.isPending} onPress={finish} />
        </View>
      )}

      {error && (
        <Banner kind="error" testID="invite-error">
          {error.message}
        </Banner>
      )}

      {created && link && (
        <View style={{ gap: spacing.sm, padding: spacing.md, borderRadius: 12, borderWidth: 1, borderColor: colors.primary }} testID="invite-created">
          <AppText variant="small" tone="brand" style={{ fontWeight: '600' }} testID="invite-once-warning">
            {claimFor
              ? `This link is shown only once. Copy it now and send it only to ${claimFor.displayName}.`
              : 'Copy it now and share it only with the people you want on the trip: anyone who has it can ask to join. You can copy it again any time from Invite people.'}
          </AppText>
          <AppText selectable testID="invite-link" style={{ fontSize: 13 }}>
            {link}
          </AppText>
          <Button testID="invite-copy" label={Platform.OS === 'web' ? 'Copy link' : 'Share link'} onPress={() => void copyLink()} />
          {copy === 'copied' && (
            <AppText variant="small" tone="ok" testID="invite-copied">
              Link copied.
            </AppText>
          )}
          {copy === 'failed' && (
            <AppText variant="small" tone="error" testID="invite-copy-failed">
              Couldn&apos;t copy automatically. Select the link above and copy it.
            </AppText>
          )}
          <AppText variant="small" tone="secondary" testID="invite-created-note">
            {claimFor
              ? `Single use: only ${claimFor.displayName} can use this link, and an admin still has to approve the request.`
              : 'Anyone who uses it only sends a request: an admin approves each one.'}
          </AppText>
          <Button testID="invite-done" label="Done" variant="secondary" onPress={finish} />
        </View>
      )}

      {claimInvites.length > 0 && (
        <View style={{ gap: spacing.xs }}>
          <Pressable
            testID="invite-active-toggle"
            onPress={() => setShowActive((v) => !v)}
            role="button"
            aria-expanded={showActive}
            aria-label={`Links for friends, ${claimInvites.length}. ${showActive ? 'Hide' : 'Show'}`}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
              {`${showActive ? '▾' : '▸'} Links for friends (${claimInvites.length})`}
            </AppText>
          </Pressable>
          {showActive && (
            <View style={{ gap: spacing.sm }} testID="invite-list">
              {claimInvites.map((i) => {
                const label = `${createdLabel(i.createdAt)} · ${inviteSummary(i, now)}`;
                return (
                  <View key={i.id} testID={`invite-${i.id}`} style={{ gap: 2 }}>
                    <AppText variant="small" tone="secondary" testID={`invite-created-at-${i.id}`}>
                      {createdLabel(i.createdAt)}
                    </AppText>
                    <AppText variant="small" testID={`invite-summary-${i.id}`}>
                      {inviteSummary(i, now)}
                    </AppText>
                    <Button
                      testID={`invite-revoke-${i.id}`}
                      label="Cancel this invitation"
                      variant="secondary"
                      disabled={revoke.isPending}
                      onPress={() => {
                        setDialogError(null);
                        setCancelling({ invite: i, label });
                      }}
                    />
                  </View>
                );
              })}
            </View>
          )}
        </View>
      )}

      <ConfirmDialog
        visible={cancelling !== null}
        title={cancellingGeneral ? 'Revoke the invitation link?' : 'Cancel this invitation?'}
        message={
          cancellingGeneral
            ? `${cancelling?.label ?? ''}. The link stops working for good and nobody new can ask with it. Requests already made stay in Join requests, and people already on the trip stay. You can then create a new link.`
            : `${cancelling?.label ?? ''}. Only this invitation stops working. Requests already made stay in Join requests.`
        }
        confirmLabel={cancellingGeneral ? 'Revoke link' : 'Cancel invitation'}
        cancelLabel="Keep it"
        busy={revoke.isPending}
        error={dialogError}
        onConfirm={confirmCancel}
        onCancel={() => setCancelling(null)}
      />
    </View>
  );
}
