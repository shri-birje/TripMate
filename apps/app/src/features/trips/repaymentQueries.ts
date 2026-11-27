import type { MutationOptions, QueryClient } from '@tanstack/react-query';
import type { Repayment, RepaymentEvent, RepaymentReversal } from '@tripmate/core';
import { balancesKey } from './expenseQueries';
import {
  RepaymentError,
  cancelRepayment,
  confirmRepayment,
  decideOverride,
  listRepayments,
  listReversals,
  getRepaymentEvents,
  proposeOverride,
  recordRepayment,
  rejectRepayment,
  remindAboutReversal,
  requestReversal,
  respondToReversal,
  withdrawReversal,
  type ChangedReversal,
  type DecidedRepayment,
  type RecordRepaymentVars,
  type RecordedRepayment,
  type RemindedReversal,
  type RepaymentClient,
  type RepaymentRef,
  type RequestReversalVars,
  type RequestedReversal,
  type ReversalRef,
} from './repaymentService';

/**
 * The query and mutation OPTIONS behind the repayment hooks (M7 Checkpoint 3). Free of React and of the real client so they can be tested
 * directly. Cache keys include the signed-in user, so one account never sees another's cached payments.
 *
 * After EVERY write attempt, successful or not, the trip's repayments, reversals, the affected payment's history and the BALANCES are
 * marked out of date and re-read. Balances matter most: a confirmed repayment or an applied correction moves the official balances, and
 * therefore the settlement suggestions, which are derived from the same balances query. Pending items never change balances, but they are
 * refreshed too, because they reserve capacity that the next recording depends on.
 */
export const repaymentsKey = (userId: string | null, tripId: string) => ['repayments', userId, tripId] as const;
export const reversalsKey = (userId: string | null, tripId: string) => ['repayment-reversals', userId, tripId] as const;
/** One repayment's history; the key starts with the trip so every history of the trip can be refreshed at once. */
export const repaymentEventsKey = (userId: string | null, tripId: string, repaymentId: string) => ['repayment-events', userId, tripId, repaymentId] as const;

const retryRead = (count: number, error: unknown) => error instanceof RepaymentError && error.kind === 'network' && count < 1;

export function repaymentsQueryOptions(client: RepaymentClient, userId: string | null, tripId: string) {
  return {
    queryKey: repaymentsKey(userId, tripId),
    queryFn: (): Promise<Repayment[]> => listRepayments(client, tripId),
    staleTime: 10_000,
    retry: retryRead,
  };
}

export function reversalsQueryOptions(client: RepaymentClient, userId: string | null, tripId: string) {
  return {
    queryKey: reversalsKey(userId, tripId),
    queryFn: (): Promise<RepaymentReversal[]> => listReversals(client, tripId),
    staleTime: 10_000,
    retry: retryRead,
  };
}

export function repaymentEventsQueryOptions(client: RepaymentClient, userId: string | null, tripId: string, repaymentId: string) {
  return {
    queryKey: repaymentEventsKey(userId, tripId, repaymentId),
    queryFn: (): Promise<RepaymentEvent[]> => getRepaymentEvents(client, tripId, repaymentId),
    staleTime: 10_000,
    retry: retryRead,
  };
}

export interface RepaymentMutations {
  record: MutationOptions<RecordedRepayment, RepaymentError, Omit<RecordRepaymentVars, 'tripId'>>;
  confirm: MutationOptions<DecidedRepayment, RepaymentError, Omit<RepaymentRef, 'tripId'>>;
  reject: MutationOptions<DecidedRepayment, RepaymentError, Omit<RepaymentRef, 'tripId'> & { reason?: string | null }>;
  cancel: MutationOptions<DecidedRepayment, RepaymentError, Omit<RepaymentRef, 'tripId'>>;
  requestReversal: MutationOptions<RequestedReversal, RepaymentError, Omit<RequestReversalVars, 'tripId'>>;
  respond: MutationOptions<ChangedReversal, RepaymentError, Omit<ReversalRef, 'tripId'> & { decision: 'acknowledge' | 'decline'; note?: string | null }>;
  withdraw: MutationOptions<ChangedReversal, RepaymentError, Omit<ReversalRef, 'tripId'>>;
  remind: MutationOptions<RemindedReversal, RepaymentError, { reversalId: string }>;
  propose: MutationOptions<ChangedReversal, RepaymentError, Omit<ReversalRef, 'tripId'> & { reason: string }>;
  decide: MutationOptions<ChangedReversal, RepaymentError, Omit<ReversalRef, 'tripId'> & { decision: 'approve' | 'refuse'; note?: string | null }>;
}

/** The trip is fixed by the hook (one hook can never write to another trip); the caller supplies the rest. */
export function repaymentMutations(client: RepaymentClient, queryClient: QueryClient, userId: string | null, tripId: string): RepaymentMutations {
  const refresh = (repaymentId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: repaymentsKey(userId, tripId) }),
      queryClient.invalidateQueries({ queryKey: reversalsKey(userId, tripId) }),
      queryClient.invalidateQueries({ queryKey: balancesKey(userId, tripId) }), // official balances and the settlement suggestions
      repaymentId === undefined
        ? queryClient.invalidateQueries({ queryKey: ['repayment-events', userId, tripId] }) // every history of this trip
        : queryClient.invalidateQueries({ queryKey: repaymentEventsKey(userId, tripId, repaymentId) }),
    ]);
  return {
    record: { mutationFn: (v) => recordRepayment(client, { ...v, tripId }), onSettled: () => refresh() },
    confirm: { mutationFn: (v) => confirmRepayment(client, { ...v, tripId }), onSettled: (_d, _e, v) => refresh(v?.repaymentId) },
    reject: { mutationFn: (v) => rejectRepayment(client, { ...v, tripId }), onSettled: (_d, _e, v) => refresh(v?.repaymentId) },
    cancel: { mutationFn: (v) => cancelRepayment(client, { ...v, tripId }), onSettled: (_d, _e, v) => refresh(v?.repaymentId) },
    requestReversal: { mutationFn: (v) => requestReversal(client, { ...v, tripId }), onSettled: () => refresh() },
    respond: { mutationFn: (v) => respondToReversal(client, { ...v, tripId }), onSettled: () => refresh() },
    withdraw: { mutationFn: (v) => withdrawReversal(client, { ...v, tripId }), onSettled: () => refresh() },
    remind: { mutationFn: (v) => remindAboutReversal(client, { ...v, tripId }), onSettled: () => refresh() },
    propose: { mutationFn: (v) => proposeOverride(client, { ...v, tripId }), onSettled: () => refresh() },
    decide: { mutationFn: (v) => decideOverride(client, { ...v, tripId }), onSettled: () => refresh() },
  };
}
