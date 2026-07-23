/**
 * useReducedMotion — reactive OS "Reduce Motion" preference (TASK-42 / PLAN-12 DR-13).
 *
 * Why not `react-native-reanimated`'s `useReducedMotion()`? Because it snapshots
 * the system value once at module-load time and explicitly documents that
 * "changing the reduced motion system setting doesn't cause your components to
 * rerender". DR-13 requires the preference to be honored *reactively*, so this
 * hook reads `AccessibilityInfo.isReduceMotionEnabled()` on first subscribe and
 * then stays subscribed to the `reduceMotionChanged` event.
 *
 * Reanimated's own animation primitives already default to
 * `ReduceMotion.System`, which disables *finite* animations when the OS
 * preference is on. What it does NOT do is prevent an infinite `withRepeat`
 * loop from being scheduled at all — it merely lets the first repetition
 * settle. Components that drive continuous/looping motion therefore need to
 * read this hook and skip starting the loop entirely (DR-13 item 3).
 *
 * Implementation note: the subscription is a refcounted module-level singleton
 * so that the ~90 components that consume it share a single native listener
 * rather than each registering their own.
 */

import { useSyncExternalStore } from 'react';
import { AccessibilityInfo } from 'react-native';

type Listener = (enabled: boolean) => void;

/**
 * Assume motion is allowed until the OS says otherwise. The first read is
 * async; defaulting to `false` means the app looks normal for users who have
 * the setting off (the overwhelming majority) and settles within a frame or two
 * for users who have it on.
 */
let currentValue = false;
let subscribers: Listener[] = [];
let nativeSubscription: { remove: () => void } | null = null;
/**
 * Tracked separately from `nativeSubscription` because react-native-web's
 * `AccessibilityInfo.addEventListener` returns `undefined` when the runtime has
 * no `matchMedia`. Keying the guard off the returned handle alone would then
 * re-register a listener for every additional consumer.
 */
let nativeSubscriptionStarted = false;

function publish(next: boolean): void {
  if (next === currentValue) return;
  currentValue = next;
  // Copy first: a listener may unsubscribe during notification.
  for (const listener of [...subscribers]) listener(next);
}

function startNativeSubscription(): void {
  if (nativeSubscriptionStarted) return;
  nativeSubscriptionStarted = true;

  try {
    nativeSubscription =
      AccessibilityInfo.addEventListener(
        'reduceMotionChanged',
        (enabled: boolean) => publish(!!enabled)
      ) ?? null;
  } catch {
    // Targets without the event (older web/extension runtimes) simply never
    // update after the initial read below.
    nativeSubscription = null;
  }

  try {
    const pending = AccessibilityInfo.isReduceMotionEnabled?.();
    if (pending && typeof pending.then === 'function') {
      pending
        .then((enabled) => publish(!!enabled))
        .catch(() => {
          // Unable to determine the preference — keep animations enabled
          // rather than degrading the UI on a query failure.
        });
    }
  } catch {
    // Same rationale: a throwing/absent API must not break rendering.
  }
}

function stopNativeSubscription(): void {
  nativeSubscription?.remove();
  nativeSubscription = null;
  nativeSubscriptionStarted = false;
}

/**
 * Subscribe to the reduced-motion preference outside of React.
 * Returns an unsubscribe function.
 */
export function subscribeToReducedMotion(listener: Listener): () => void {
  subscribers.push(listener);
  startNativeSubscription();

  let active = true;
  return () => {
    if (!active) return;
    active = false;
    subscribers = subscribers.filter((entry) => entry !== listener);
    if (subscribers.length === 0) stopNativeSubscription();
  };
}

/** Last known value of the preference, without subscribing. */
export function getReducedMotionSnapshot(): boolean {
  return currentValue;
}

/**
 * Reactive OS "Reduce Motion" preference.
 *
 * Components driving looping or decorative motion should skip starting the
 * animation when this is `true`; one-shot transitions can rely on Reanimated's
 * built-in `ReduceMotion.System` handling.
 */
export function useReducedMotion(): boolean {
  // `useSyncExternalStore` is the right primitive here: it subscribes without a
  // setState-in-effect, and it re-reads the snapshot after subscribing, so a
  // value that settles between render and commit cannot be missed.
  return useSyncExternalStore(
    subscribeToReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionSnapshot
  );
}

/** Test-only: drop all state so each case starts from a clean singleton. */
export function __resetReducedMotionForTests(): void {
  stopNativeSubscription();
  subscribers = [];
  currentValue = false;
}

export default useReducedMotion;
