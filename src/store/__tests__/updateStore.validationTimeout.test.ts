jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));
jest.mock('expo-updates', () => ({}));
jest.mock('react-native-toast-message', () => ({ show: jest.fn() }));

import { useUpdateStore } from '../updateStore';

const TIMEOUT_MS = 15000;

// TASK-448: the allowlist fetch had no deadline, so a server that accepted the
// connection and stalled left the update stuck in "validating" forever. At the
// deadline it must read as "couldn't validate", which blocks the update.
describe('updateStore allowlist fetch is bounded (TASK-448)', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    global.fetch = jest.fn(() => new Promise<never>(() => {})) as any;
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a stalled allowlist fetch blocks the update at the deadline', async () => {
    const pending = useUpdateStore.getState().setUpdateAvailable('update-1');

    await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
    expect(useUpdateStore.getState().isValidating).toBe(true);

    await jest.advanceTimersByTimeAsync(1);
    await pending;
    const state = useUpdateStore.getState();
    expect(state.isValidating).toBe(false);
    expect(state.validationStatus).toBe('unknown');
    expect(state.isUpdateAvailable).toBe(false);
  });
});
