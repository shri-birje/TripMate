import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { UseMutationResult } from '@tanstack/react-query';
import { addState, formerMemberNote, leaveState, memberActions, myRole, validatePersonName, type MemberRole, type TripDetails, type TripMember } from '@tripmate/core';
import { AppText } from '../../components/AppText';
import { Banner } from '../../components/Banner';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { TextField } from '../../components/TextField';
import { useTheme } from '../../theme/ThemeProvider';
import { spacing } from '../../theme/tokens';
import { InvitePanel } from './InvitePanel';
import { JoinRequestsPanel } from './JoinRequestsPanel';
import { useAddGuest, useLeaveTrip, useRemoveMember, useRenameGuest, useSetMemberRole } from './tripMemberApi';
import { TripMemberError, type MemberChange } from './tripMemberService';

type Dialog = { kind: 'make_admin' | 'remove_admin' | 'remove'; member: TripMember } | { kind: 'leave' };

interface Props {
  details: TripDetails;
  userId: string | null;
  /** Re-reads the trip (used after a refused change, to show what the database really holds). */
  reload: () => void;
  /** Called after the person has left the trip: the screen goes Home. */
  onLeft: () => void;
}

/**
 * The people on a trip: who they are, what role each has, and (for administrators) the controls to
 * add a friend, rename a friend, make or unmake an admin, and remove someone; plus Leave trip for everyone.
 *
 * Hiding buttons from people who may not use them is a convenience only: the database refuses every
 * action unless the caller is allowed (see tripMemberService and the member functions in the database).
 * Nothing here ever sends a user id; the database learns who is calling from the login.
 */
export function PeopleCard({ details, userId, reload, onLeft }: Props) {
  const { colors } = useTheme();
  const { trip, members, formerMembers, creatorName } = details;
  const archived = trip.status === 'archived';
  const role = myRole(details, userId);
  const creatorIsMe = userId !== null && members.some((m) => m.userId === userId && m.userId === trip.createdBy);

  const add = useAddGuest(trip.id);
  const rename = useRenameGuest(trip.id);
  const setRole = useSetMemberRole(trip.id);
  const remove = useRemoveMember(trip.id);
  const leave = useLeaveTrip(trip.id);
  const busy = add.isPending || rename.isPending || setRole.isPending || remove.isPending || leave.isPending;
  // A ref updates at once, a render does not: it stops two quick taps sending two requests.
  const submitting = useRef(false);

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pageError, setPageError] = useState<TripMemberError | null>(null);
  const [addText, setAddText] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; text: string; error: string | null } | null>(null);
  const [showFormer, setShowFormer] = useState(false);
  const [claimFor, setClaimFor] = useState<TripMember | null>(null);

  function perform<V>(
    mutation: UseMutationResult<MemberChange, TripMemberError, V>,
    vars: V,
    done: (r: MemberChange) => void,
    fail: (e: TripMemberError) => void,
  ) {
    if (submitting.current) return;
    submitting.current = true;
    mutation.mutate(vars, {
      onSuccess: (r) => {
        submitting.current = false;
        done(r);
      },
      onError: (e) => {
        submitting.current = false;
        fail(e);
      },
    });
  }

  const clearMessages = () => {
    setNotice(null);
    setPageError(null);
    setDialogError(null);
  };
  /** A connection problem can simply be retried from the same place; everything else is explained on the card. */
  const retryable = (e: TripMemberError) => e.kind === 'network' || e.kind === 'unknown';

  // ---- add a friend
  function submitAdd() {
    clearMessages();
    setAddError(null);
    // Friendly checks first and at once: nothing is sent for a name that cannot work.
    const taken = members.map((m) => m.displayName);
    const checked = validatePersonName(addText, taken);
    if (!checked.ok) {
      setAddError(checked.message);
      return;
    }
    perform(
      add,
      { tripId: trip.id, name: checked.name, taken },
      (r) => {
        setAddText('');
        setNotice(r.changed ? 'Added to the trip.' : 'Already on the trip.');
      },
      (e) => (['invalid', 'name_taken', 'full', 'network', 'unknown'].includes(e.kind) ? setAddError(e.message) : setPageError(e)),
    );
  }

  // ---- rename a friend
  function submitRename() {
    if (!renaming) return;
    clearMessages();
    const taken = members.filter((m) => m.id !== renaming.id).map((m) => m.displayName);
    const checked = validatePersonName(renaming.text, taken);
    if (!checked.ok) {
      setRenaming({ ...renaming, error: checked.message });
      return;
    }
    perform(
      rename,
      { tripId: trip.id, memberId: renaming.id, name: checked.name, taken },
      () => {
        setRenaming(null);
        setNotice('Name changed.');
      },
      (e) => {
        if (['invalid', 'name_taken', 'network', 'unknown'].includes(e.kind)) setRenaming({ ...renaming, error: e.message });
        else {
          setRenaming(null);
          setPageError(e);
        }
      },
    );
  }

  // ---- confirmed actions (make admin, remove admin rights, remove, leave)
  function confirm() {
    if (!dialog) return;
    clearMessages();
    const closeWith = (message: string) => () => {
      setDialog(null);
      setOpenMenu(null);
      setNotice(message);
    };
    const failInDialog = (e: TripMemberError) => {
      if (retryable(e)) setDialogError(e.message);
      else {
        setDialog(null);
        setPageError(e);
      }
    };
    if (dialog.kind === 'leave') {
      perform(leave, { tripId: trip.id }, () => onLeft(), failInDialog);
    } else if (dialog.kind === 'remove') {
      perform(remove, { tripId: trip.id, memberId: dialog.member.id }, closeWith(`${dialog.member.displayName} was removed from the trip.`), failInDialog);
    } else {
      const makeAdmin = dialog.kind === 'make_admin';
      const to: MemberRole = makeAdmin ? 'admin' : 'member';
      perform(
        setRole,
        { tripId: trip.id, memberId: dialog.member.id, role: to, expectedRole: dialog.member.role },
        closeWith(makeAdmin ? `${dialog.member.displayName} is now an admin.` : `${dialog.member.displayName} is no longer an admin.`),
        failInDialog,
      );
    }
  }

  const openDialog = (d: Dialog) => {
    clearMessages();
    setDialog(d);
  };

  const meId = members.find((m) => m.userId !== null && m.userId === userId)?.id;
  const adding = addState(details, userId);
  const leaving = leaveState(details, userId);
  const isAdmin = role === 'admin';

  const dialogCopy = (() => {
    if (!dialog) return { title: '', message: '', label: '' };
    if (dialog.kind === 'leave') {
      return {
        title: 'Leave this trip?',
        message: `You will lose access to "${trip.name}" and it will leave your trips. Anything you paid or owe stays in the trip's history. To come back, an admin has to invite you again.`,
        label: 'Leave trip',
      };
    }
    const name = dialog.member.displayName;
    const me = dialog.member.id === meId;
    if (dialog.kind === 'make_admin') {
      return { title: `Make ${name} an admin?`, message: `${name} will be able to edit and archive this trip, add and remove people, and change who is an admin.`, label: 'Make admin' };
    }
    if (dialog.kind === 'remove_admin') {
      return {
        title: me ? 'Step down as admin?' : `Remove ${name} as admin?`,
        message: me
          ? 'You will become an ordinary member and will no longer be able to manage this trip or its people.'
          : `${name} will become an ordinary member and will no longer be able to manage this trip.`,
        label: 'Remove admin rights',
      };
    }
    return {
      title: `Remove ${name} from this trip?`,
      message: `${name} will lose access to the trip. Anything they paid or owe stays in the trip's history, and they will be listed under Former members.`,
      label: 'Remove from trip',
    };
  })();

  return (
    <Card>
      <AppText variant="heading">{`People (${members.length})`}</AppText>
      <AppText variant="small" tone="secondary" testID="trip-creator">
        {creatorIsMe ? 'Created by you' : creatorName ? `Created by ${creatorName}` : 'Created by a former member'}
      </AppText>
      {role && (
        <AppText variant="small" tone="secondary" testID="trip-my-role">
          {role === 'admin' ? 'You are an admin of this trip.' : 'You are a member of this trip.'}
        </AppText>
      )}

      {notice && (
        <Banner kind="success" testID="people-notice">
          {notice}
        </Banner>
      )}
      {pageError && (
        <View style={{ gap: spacing.sm }}>
          <Banner kind="error" testID="people-error">
            {pageError.message}
          </Banner>
          {['conflict', 'not_found', 'unavailable', 'not_admin', 'archived', 'last_admin', 'guest_admin', 'cannot_rename', 'use_leave'].includes(pageError.kind) && (
            <Button
              testID="people-reload"
              label="Reload latest"
              variant="secondary"
              onPress={() => {
                setPageError(null);
                reload();
              }}
            />
          )}
        </View>
      )}

      <View style={{ gap: spacing.sm }} testID="trip-people">
        {members.map((m) => {
          const actions = memberActions(details, userId, m);
          const open = openMenu === m.id;
          const editing = renaming?.id === m.id;
          return (
            <View key={m.id} style={{ gap: spacing.xs }}>
              <View testID={`member-${m.id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}>
                <AppText>{m.displayName}</AppText>
                {m.role === 'admin' && <Tag label="Admin" color={colors.primary} />}
                {m.userId !== null && m.userId === userId && <Tag label="You" color={colors.textSecondary} />}
                {m.isGuest && <Tag label="Guest" color={colors.textSecondary} />}
                {actions.any && (
                  <Pressable
                    testID={`member-manage-${m.id}`}
                    onPress={() => {
                      setOpenMenu(open ? null : m.id);
                      setRenaming(null);
                    }}
                    role="button"
                    aria-expanded={open}
                    aria-label={`Manage ${m.displayName}`}
                    style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: spacing.xs }}
                  >
                    <AppText variant="small" tone="brand" style={{ fontWeight: '600' }}>
                      {open ? 'Close' : 'Manage'}
                    </AppText>
                  </Pressable>
                )}
              </View>

              {open && actions.any && !editing && (
                <View style={{ gap: spacing.xs }} testID={`member-actions-${m.id}`}>
                  {actions.canMakeAdmin && <Button testID={`member-make-admin-${m.id}`} label="Make admin" variant="secondary" disabled={busy} onPress={() => openDialog({ kind: 'make_admin', member: m })} />}
                  {actions.canRemoveAdminRights && (
                    <Button testID={`member-remove-admin-${m.id}`} label="Remove admin rights" variant="secondary" disabled={busy} onPress={() => openDialog({ kind: 'remove_admin', member: m })} />
                  )}
                  {actions.canRename && (
                    <Button testID={`member-rename-${m.id}`} label="Rename" variant="secondary" disabled={busy} onPress={() => setRenaming({ id: m.id, text: m.displayName, error: null })} />
                  )}
                  {actions.canInviteToClaim && (
                    <Button
                      testID={`member-invite-${m.id}`}
                      label="Invite to claim this spot"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        setClaimFor(m);
                        setOpenMenu(null);
                      }}
                    />
                  )}
                  {actions.canRemove && <Button testID={`member-remove-${m.id}`} label="Remove from trip" variant="secondary" disabled={busy} onPress={() => openDialog({ kind: 'remove', member: m })} />}
                </View>
              )}

              {editing && renaming && (
                <View style={{ gap: spacing.xs }}>
                  <TextField
                    testID={`rename-input-${m.id}`}
                    label={`New name for ${m.displayName}`}
                    value={renaming.text}
                    onChangeText={(text) => setRenaming({ ...renaming, text, error: null })}
                    error={renaming.error ?? undefined}
                    maxLength={80}
                    autoCapitalize="words"
                    returnKeyType="done"
                    onSubmitEditing={submitRename}
                  />
                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <View style={{ flex: 1 }}>
                      <Button testID={`rename-save-${m.id}`} label="Save name" loading={rename.isPending} onPress={submitRename} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button testID={`rename-cancel-${m.id}`} label="Cancel" variant="secondary" disabled={rename.isPending} onPress={() => setRenaming(null)} />
                    </View>
                  </View>
                </View>
              )}
            </View>
          );
        })}
      </View>

      {adding.canAdd && (
        <View style={{ gap: spacing.xs }} testID="add-guest">
          <TextField
            testID="add-guest-name"
            label="Add a friend by name"
            helper="They don't need an account. You can rename or remove them later."
            value={addText}
            onChangeText={(t) => {
              setAddText(t);
              setAddError(null);
            }}
            error={addError ?? undefined}
            maxLength={80}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={submitAdd}
          />
          <Button testID="add-guest-submit" label="Add friend" loading={add.isPending} onPress={submitAdd} />
        </View>
      )}
      {!adding.canAdd && adding.reason === 'full' && (
        <AppText variant="small" tone="secondary" testID="add-guest-full">
          This trip has 50 people, the most it can have. Remove someone to add another.
        </AppText>
      )}
      <JoinRequestsPanel details={details} userId={userId} reload={reload} />
      <InvitePanel details={details} userId={userId} claimFor={claimFor} onClaimDone={() => setClaimFor(null)} />
      {isAdmin && archived && (
        <AppText variant="small" tone="secondary" testID="people-archived-note">
          This trip is archived, so people can&apos;t be changed. Restore it to make changes. You can still leave it.
        </AppText>
      )}

      {leaving.canLeave && <Button testID="leave-trip" label="Leave trip" variant="secondary" disabled={busy} onPress={() => openDialog({ kind: 'leave' })} />}
      {!leaving.canLeave && leaving.reason === 'sole_admin' && (
        <View style={{ gap: spacing.xs }}>
          <Button testID="leave-trip" label="Leave trip" variant="secondary" disabled onPress={() => {}} />
          <AppText variant="small" tone="secondary" testID="leave-blocked">
            You are the only admin, so you cannot leave yet. Make someone else an admin first.
          </AppText>
        </View>
      )}

      {formerMembers.length > 0 && (
        <View style={{ gap: spacing.xs }} testID="section-former">
          <Pressable
            testID="former-toggle"
            onPress={() => setShowFormer((v) => !v)}
            role="button"
            aria-expanded={showFormer}
            aria-label={`Former members, ${formerMembers.length}. ${showFormer ? 'Hide' : 'Show'}`}
            style={{ minHeight: 44, justifyContent: 'center' }}
          >
            <AppText variant="small" tone="secondary" style={{ fontWeight: '600' }}>
              {`${showFormer ? '▾' : '▸'} Former members (${formerMembers.length})`}
            </AppText>
          </Pressable>
          {showFormer && (
            <View style={{ gap: spacing.sm }} testID="former-members">
              <AppText variant="small" tone="secondary">
                They no longer have access. Anything they paid or owe stays in the trip&apos;s history.
              </AppText>
              {formerMembers.map((m) => (
                <View key={m.id} testID={`former-${m.id}`} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }}>
                  <AppText tone="secondary">{m.displayName}</AppText>
                  {m.isGuest && <Tag label="Guest" color={colors.textSecondary} />}
                  <AppText variant="small" tone="secondary" testID={`former-note-${m.id}`}>
                    {formerMemberNote(m)}
                  </AppText>
                </View>
              ))}
            </View>
          )}
        </View>
      )}

      <ConfirmDialog
        visible={dialog !== null}
        title={dialogCopy.title}
        message={dialogCopy.message}
        confirmLabel={dialogCopy.label}
        busy={busy}
        error={dialogError}
        onConfirm={confirm}
        onCancel={() => setDialog(null)}
      />
    </Card>
  );
}

function Tag({ label, color }: { label: string; color: string }) {
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 999, paddingHorizontal: spacing.sm, paddingVertical: 1 }}>
      <AppText variant="small" style={{ color, fontWeight: '600' }}>
        {label}
      </AppText>
    </View>
  );
}
