// Unit tests for AppLockSignal listener isolation (TASK-561).
//
// A listener that throws must not escape setUnlocked(): the state is applied
// first, every other listener is still notified, and the failure is logged by
// error kind only (never the message or the raw Error object).

import { AppLockSignal } from '../appLockState';

const unsubscribers: (() => void)[] = [];

function subscribe(listener: () => void): void {
  unsubscribers.push(AppLockSignal.subscribe(listener));
}

let warnSpy: jest.SpyInstance;

beforeEach(() => {
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  AppLockSignal.setUnlocked(false);
});

afterEach(() => {
  unsubscribers.splice(0).forEach((unsubscribe) => unsubscribe());
  AppLockSignal.setUnlocked(false);
  warnSpy.mockRestore();
});

describe('AppLockSignal.setUnlocked listener isolation', () => {
  it('does not throw when a listener throws, applies the state, and notifies later listeners', () => {
    const later = jest.fn();
    subscribe(() => {
      if (AppLockSignal.isUnlocked()) {
        throw new Error('listener boom');
      }
    });
    subscribe(later);

    expect(() => AppLockSignal.setUnlocked(true)).not.toThrow();
    expect(AppLockSignal.isUnlocked()).toBe(true);
    expect(later).toHaveBeenCalledTimes(1);
  });

  it('logs only the error kind, never the message or the Error object', () => {
    // A bare PIN is not a pattern redaction recognises, so it must not be
    // logged at all.
    subscribe(() => {
      throw new TypeError('listener failed with pin 482913');
    });

    AppLockSignal.setUnlocked(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      '[AppLockSignal] listener failed',
      'TypeError'
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('482913');
  });

  it('notifies a snapshot: a listener added during notification is not called in the same round', () => {
    const added = jest.fn();
    subscribe(() => {
      subscribe(added);
    });

    AppLockSignal.setUnlocked(true);

    expect(added).not.toHaveBeenCalled();
  });

  it('notifies a snapshot: a sibling removed during notification is still called in that round', () => {
    const sibling = jest.fn();
    let removeSibling: () => void = () => {};
    subscribe(() => {
      removeSibling();
    });
    removeSibling = AppLockSignal.subscribe(sibling);
    unsubscribers.push(removeSibling);

    AppLockSignal.setUnlocked(true);

    expect(sibling).toHaveBeenCalledTimes(1);
  });
});
