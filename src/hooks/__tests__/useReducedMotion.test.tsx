/**
 * useReducedMotion tests (TASK-42 / PLAN-12 DR-13).
 *
 * DR-13's whole point is that the preference must be *reactive*: Reanimated's
 * own `useReducedMotion()` snapshots the value at module load and never
 * updates. So the guards that matter here are (a) the initial async read is
 * honored, (b) a later `reduceMotionChanged` event re-renders consumers, and
 * (c) the native listener is a single shared subscription that is torn down
 * when the last consumer unmounts.
 */

import React from 'react';
import { AccessibilityInfo, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

import {
  __resetReducedMotionForTests,
  getReducedMotionSnapshot,
  subscribeToReducedMotion,
  useReducedMotion,
} from '../useReducedMotion';

type ChangeHandler = (enabled: boolean) => void;

const mockRemove = jest.fn();
let mockHandlers: ChangeHandler[] = [];
let mockInitial = false;
let mockAddEventListener: jest.SpyInstance;
let mockIsReduceMotionEnabled: jest.SpyInstance;

function emitChange(enabled: boolean) {
  for (const handler of [...mockHandlers]) handler(enabled);
}

// Imported statically (not via `jest.isolateModules`) so the hook shares the
// renderer's React instance; the module singleton is reset in `afterEach`.
function Probe() {
  const reduced = useReducedMotion();
  return <Text>{reduced ? 'reduced' : 'full'}</Text>;
}

beforeEach(() => {
  mockHandlers = [];
  mockRemove.mockClear();
  mockInitial = false;

  mockAddEventListener = jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation(((event: string, handler: ChangeHandler) => {
      if (event === 'reduceMotionChanged') mockHandlers.push(handler);
      return { remove: mockRemove };
    }) as never);

  mockIsReduceMotionEnabled = jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(mockInitial));
});

afterEach(() => {
  __resetReducedMotionForTests();
  jest.restoreAllMocks();
});

describe('useReducedMotion', () => {
  it('defaults to false (motion allowed) before the OS value settles', () => {
    const { getByText } = render(<Probe />);
    expect(getByText('full')).toBeTruthy();
  });

  it('adopts the initial OS value once the async read resolves', async () => {
    mockInitial = true;

    const { getByText } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockIsReduceMotionEnabled).toHaveBeenCalled();
    expect(getByText('reduced')).toBeTruthy();
  });

  it('stays reactive: a later reduceMotionChanged event re-renders consumers', async () => {
    const { getByText } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(getByText('full')).toBeTruthy();

    act(() => emitChange(true));
    expect(getByText('reduced')).toBeTruthy();

    // ...and back again, so the gate is not one-way.
    act(() => emitChange(false));
    expect(getByText('full')).toBeTruthy();
  });

  it('subscribes to the reduceMotionChanged event exactly once for many consumers', () => {
    render(
      <>
        <Probe />
        <Probe />
        <Probe />
      </>
    );

    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'reduceMotionChanged',
      expect.any(Function)
    );
  });

  it('removes the native listener only after the last consumer unmounts', () => {
    const first = render(<Probe />);
    const second = render(<Probe />);

    first.unmount();
    expect(mockRemove).not.toHaveBeenCalled();

    second.unmount();
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes after a full teardown', () => {
    render(<Probe />).unmount();
    render(<Probe />);

    expect(mockAddEventListener).toHaveBeenCalledTimes(2);
  });

  it('still subscribes only once when the platform returns no subscription handle', () => {
    // react-native-web's AccessibilityInfo returns `undefined` from
    // addEventListener when the runtime has no matchMedia; the guard must not
    // key off the returned handle or every consumer re-registers.
    mockAddEventListener.mockImplementation((() => undefined) as never);

    render(
      <>
        <Probe />
        <Probe />
      </>
    );

    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
  });

  it('keeps motion enabled when the platform cannot report the preference', async () => {
    mockAddEventListener.mockImplementation(() => {
      throw new Error('unsupported on this target');
    });
    mockIsReduceMotionEnabled.mockImplementation(() =>
      Promise.reject(new Error('unsupported on this target'))
    );

    const { getByText } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });

    // Never crash the render, and never falsely claim Reduce Motion is on.
    expect(getByText('full')).toBeTruthy();
  });

  it('exposes the settled value to non-React callers via the snapshot', async () => {
    mockInitial = true;
    const { unmount } = render(<Probe />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(getReducedMotionSnapshot()).toBe(true);
    unmount();
  });

  it('notifies imperative subscribers and stops after unsubscribe', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeToReducedMotion(listener);

    emitChange(true);
    expect(listener).toHaveBeenCalledWith(true);

    unsubscribe();
    listener.mockClear();
    emitChange(false);
    expect(listener).not.toHaveBeenCalled();
  });
});
