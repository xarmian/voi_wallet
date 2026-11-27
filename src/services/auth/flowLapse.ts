/**
 * TASK-531: lock and background for a signing flow that holds no review grant.
 *
 * The epoch moves once each time the wallet locks (a transition from unlocked)
 * and each time the app goes to the background. The signing controller captures
 * it when a watched flow starts signing and returns it with the signed result.
 * The caller that sends checks it right before the send, with no await between
 * the check and the call: a moved epoch means the flow lapsed, so nothing is
 * sent. Once the send is issued it runs to its end.
 *
 * Mirrors the wipe epoch (wipe/gate.ts) and the review grant's listeners.
 * Dependency-light so screens and services import it without a cycle.
 */
import { AppState, type NativeEventSubscription } from 'react-native';
import { AppLockSignal } from '@/services/secure/appLockState';
import { errorKind } from '@/utils/logRedaction';

export type FlowLapseReason = 'lock' | 'background';

/** The lapse texts reuse the title the review-grant lapse texts use. */
export const FLOW_LAPSE_TITLE = 'Request ended';
/** In-app flow stopped by a lock or background before every entry was signed. */
export const FLOW_STOPPED_BEFORE_SIGNED_MESSAGE =
  'Your wallet locked or the app went to the background before signing finished. Nothing was sent. Please try again.';
/** In-app flow signed, then withheld by a lock or background before the send. */
export const FLOW_WITHHELD_BEFORE_SEND_MESSAGE =
  'Your wallet locked or the app went to the background before this was sent. Nothing was sent. Please try again.';

let epoch = 0;
let wasUnlocked = AppLockSignal.isUnlocked();
let appStateSubscription: NativeEventSubscription | undefined;
const listeners = new Set<(reason: FlowLapseReason) => void>();

function lapse(reason: FlowLapseReason): void {
  epoch += 1;
  for (const listener of Array.from(listeners)) {
    try {
      listener(reason);
    } catch (error) {
      console.warn('[flowLapse] listener failed', errorKind(error));
    }
  }
}

AppLockSignal.subscribe(() => {
  const unlocked = AppLockSignal.isUnlocked();
  const locked = wasUnlocked && !unlocked;
  wasUnlocked = unlocked;
  if (locked) lapse('lock');
});

/**
 * The current epoch. Capture it when a watched flow starts signing.
 *
 * Each capture replaces the AppState subscription with a fresh one, so a
 * flow never depends on a subscription made before it started.
 */
export function lapseEpoch(): number {
  appStateSubscription?.remove();
  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'background') lapse('background');
  });
  return epoch;
}

/**
 * True when the wallet locked or the app went to the background after
 * `captured` was read. A result with no captured epoch is never lapsed here.
 */
export function flowLapsedSince(captured: number | undefined): boolean {
  return captured !== undefined && captured !== epoch;
}

/** Hear each lapse as it happens. Returns the unsubscribe function. */
export function subscribeFlowLapse(
  listener: (reason: FlowLapseReason) => void
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
