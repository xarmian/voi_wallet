import { useEffect } from 'react';

/**
 * Test double for `useFocusEffect` from `@react-navigation/native`.
 *
 * Runs the callback on mount (as a focused screen would), runs its cleanup on
 * unmount, and lets a test simulate the screen regaining focus with
 * `refocus()` (call it inside `act`). Tracks every mounted instance so several
 * hooks in one render tree each refocus.
 */
type FocusCallback = () => void | (() => void);

type FocusInstance = {
  callback: FocusCallback;
  cleanup: (() => void) | undefined;
};

const instances = new Set<FocusInstance>();

export function createNavigationFocusMock() {
  return {
    useFocusEffect(callback: FocusCallback) {
      useEffect(() => {
        const instance: FocusInstance = {
          callback,
          cleanup: callback() || undefined,
        };
        instances.add(instance);
        return () => {
          instance.cleanup?.();
          instances.delete(instance);
        };
      }, [callback]);
    },
  };
}

export function refocus() {
  for (const instance of instances) {
    instance.cleanup?.();
    instance.cleanup = instance.callback() || undefined;
  }
}
