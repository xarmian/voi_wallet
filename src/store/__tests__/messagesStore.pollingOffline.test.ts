/**
 * Message polling must not fan out retry ladders while offline (TASK-191).
 *
 * The interval itself keeps running: `fetchAllThreads` drains from the durable
 * committed cursor, so a skipped tick costs nothing and the first tick after
 * connectivity returns catches up.
 */

import type { ConnectivityState } from '@/platform';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockSubscribe = jest.fn();
const mockGetState = jest.fn();

jest.mock('@/platform', () => {
  const actual = jest.requireActual('@/platform');
  return {
    ...actual,
    connectivity: {
      subscribe: (listener: (state: ConnectivityState) => void) =>
        mockSubscribe(listener),
      getState: () => mockGetState(),
    },
  };
});

import {
  getOfflineCounters,
  getReachability,
  resetOfflineGate,
} from '@/services/network/offline';
import { useMessagesStore } from '@/store/messagesStore';

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

const ADDRESS = 'TESTADDRESS';

describe('messagesStore.startPolling offline gating (TASK-191)', () => {
  let emit: (state: ConnectivityState) => void;
  let fetchAllThreads: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();

    mockSubscribe.mockImplementation(
      (listener: (state: ConnectivityState) => void) => {
        emit = listener;
        return jest.fn();
      }
    );
    mockGetState.mockImplementation(() => new Promise(() => {}));
    resetOfflineGate();
    getReachability(); // prime, so `emit` exists

    fetchAllThreads = jest.fn();
    useMessagesStore.setState({ fetchAllThreads });
  });

  afterEach(() => {
    useMessagesStore.getState().stopPolling();
    jest.useRealTimers();
    resetOfflineGate();
  });

  it('skips a tick fired while offline', () => {
    emit(OFFLINE);
    useMessagesStore.getState().startPolling(ADDRESS, 1000);

    jest.advanceTimersByTime(3000);

    expect(fetchAllThreads).not.toHaveBeenCalled();
    expect(getOfflineCounters().offlineSkipsByScope['messages-poll']).toBe(3);
  });

  it('keeps polling normally while online', () => {
    emit(ONLINE);
    useMessagesStore.getState().startPolling(ADDRESS, 1000);

    jest.advanceTimersByTime(3000);

    expect(fetchAllThreads).toHaveBeenCalledTimes(3);
    expect(fetchAllThreads).toHaveBeenCalledWith(ADDRESS);
    expect(getOfflineCounters().offlineSkips).toBe(0);
  });

  it('resumes on the next tick once connectivity returns — the interval is not cancelled', () => {
    emit(OFFLINE);
    useMessagesStore.getState().startPolling(ADDRESS, 1000);

    jest.advanceTimersByTime(2000);
    expect(fetchAllThreads).not.toHaveBeenCalled();

    emit(ONLINE);
    jest.advanceTimersByTime(1000);

    expect(fetchAllThreads).toHaveBeenCalledTimes(1);
  });

  it('does not gate before connectivity is known (fail open)', () => {
    // No emit(): reachability is still `unknown`.
    useMessagesStore.getState().startPolling(ADDRESS, 1000);

    jest.advanceTimersByTime(1000);

    expect(fetchAllThreads).toHaveBeenCalledTimes(1);
  });
});
