/**
 * OfflineBanner tests (TASK-40 / R-03).
 *
 * The banner is the app's only passive connectivity signal, so the two things
 * that matter are: it appears when — and only when — the adapter reports
 * offline, and it reacts to transitions without a remount.
 */

import React from 'react';
import { act, render } from '@testing-library/react-native';

import OfflineBanner from '../OfflineBanner';
import type { ConnectivityState } from '@/platform';

const ONLINE: ConnectivityState = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
};
const OFFLINE: ConnectivityState = {
  isConnected: false,
  isInternetReachable: false,
  type: 'none',
};

let mockCurrent: ConnectivityState = ONLINE;
let mockEmit: ((state: ConnectivityState) => void) | null = null;

jest.mock('@/platform', () => ({
  connectivity: {
    getState: () => Promise.resolve(mockCurrent),
    subscribe: (listener: (state: ConnectivityState) => void) => {
      mockEmit = listener;
      listener(mockCurrent);
      return () => {
        mockEmit = null;
      };
    },
  },
  isOffline: (state: ConnectivityState) =>
    state.isInternetReachable !== null
      ? !state.isInternetReachable
      : !state.isConnected,
}));

jest.mock('@/contexts/ThemeContext', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  useTheme: () => ({ theme: require('@/constants/themes').lightTheme }),
}));

jest.mock(
  '@expo/vector-icons',
  () => ({
    Ionicons: () => null,
  }),
  { virtual: true }
);

jest.mock('react-native-safe-area-context', () => ({
  initialWindowMetrics: {
    frame: { x: 0, y: 0, width: 390, height: 844 },
    insets: { top: 47, left: 0, right: 0, bottom: 34 },
  },
}));

beforeEach(() => {
  mockCurrent = ONLINE;
  mockEmit = null;
});

// The hook also primes itself with an async `getState()`; settle it so the
// assertions run against a quiesced tree.
const settle = () => act(async () => {});

describe('OfflineBanner', () => {
  it('renders nothing while online', async () => {
    const { queryByTestId } = render(<OfflineBanner />);
    await settle();
    expect(queryByTestId('offline-banner')).toBeNull();
  });

  it('renders while offline', async () => {
    mockCurrent = OFFLINE;
    const { getByTestId } = render(<OfflineBanner />);
    await settle();
    expect(getByTestId('offline-banner')).toBeTruthy();
  });

  it('appears and disappears as connectivity changes', async () => {
    const { queryByTestId } = render(<OfflineBanner />);
    await settle();
    expect(queryByTestId('offline-banner')).toBeNull();

    act(() => {
      mockEmit?.(OFFLINE);
    });
    expect(queryByTestId('offline-banner')).toBeTruthy();

    act(() => {
      mockEmit?.(ONLINE);
    });
    expect(queryByTestId('offline-banner')).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    const { unmount } = render(<OfflineBanner />);
    await settle();
    expect(mockEmit).not.toBeNull();

    unmount();
    expect(mockEmit).toBeNull();
  });
});
