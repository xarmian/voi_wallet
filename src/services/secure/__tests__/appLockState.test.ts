// Unit tests for AppLockSignal listener isolation (TASK-561).
//
// A listener that throws must not escape setUnlocked(): the state is applied
// first, every other listener is still notified, and the failure is logged as a
// redacted string (never the raw Error object).

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

  it('logs the listener failure as a redacted string, never the Error object', () => {
    subscribe(() => {
      throw new Error('listener failed for wc:abc@2?symKey=deadbeef');
    });

    AppLockSignal.setUnlocked(true);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const args = warnSpy.mock.calls[0];
    args.forEach((arg: unknown) => {
      expect(typeof arg).toBe('string');
    });
    const logged = args.join(' ');
    expect(logged).toContain('listener failed');
    expect(logged).not.toContain('deadbeef');
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
