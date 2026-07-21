// Unit tests for the pin_setup_pending breadcrumb (TASK-213 restore-before-PIN).
//
// The breadcrumb distinguishes restore-before-PIN (a healthy wallet mid-restore)
// from a genuine keystore break in AuthContext's key-bearing guard. Its READ must
// FAIL CLOSED (an unreadable breadcrumb ⇒ treated ABSENT ⇒ recovery, never the
// SecuritySetup resume) and its CLEAR must never throw (so a clear failure can
// never fail an otherwise-successful PIN setup). Backed by PLAINTEXT AsyncStorage
// so it stays readable when the KEYSTORE is broken; it holds NO secret material.

const store = new Map<string, string>();
const mockGetItem = jest.fn(async (k: string) =>
  store.has(k) ? store.get(k)! : null
);
const mockSetItem = jest.fn(async (k: string, v: string) => {
  store.set(k, v);
});
const mockRemoveItem = jest.fn(async (k: string) => {
  store.delete(k);
});

jest.mock('@/platform', () => ({
  storage: {
    getItem: (k: string) => mockGetItem(k),
    setItem: (k: string, v: string) => mockSetItem(k, v),
    removeItem: (k: string) => mockRemoveItem(k),
  },
}));

import {
  PIN_SETUP_PENDING_KEY,
  markPinSetupPending,
  clearPinSetupPending,
  isPinSetupPending,
} from '../pinSetupPending';

beforeEach(() => {
  store.clear();
  jest.clearAllMocks();
});

describe('pinSetupPending breadcrumb (TASK-213)', () => {
  it('mark writes the durable marker; isPending then resolves TRUE', async () => {
    await markPinSetupPending();
    expect(store.get(PIN_SETUP_PENDING_KEY)).toBe('true');
    await expect(isPinSetupPending()).resolves.toBe(true);
  });

  it('isPending resolves FALSE for genuine absence', async () => {
    await expect(isPinSetupPending()).resolves.toBe(false);
  });

  it('mark PROPAGATES a write failure (bounded) so restore fails fast, not hangs', async () => {
    mockSetItem.mockRejectedValueOnce(new Error('AsyncStorage write failed'));
    await expect(markPinSetupPending()).rejects.toThrow();
  });

  it('clear removes the marker and returns TRUE (confirmed); isPending then FALSE', async () => {
    await markPinSetupPending();
    await expect(clearPinSetupPending()).resolves.toBe(true);
    expect(store.has(PIN_SETUP_PENDING_KEY)).toBe(false);
    await expect(isPinSetupPending()).resolves.toBe(false);
  });

  it('isPending FAILS CLOSED (resolves FALSE, never throws) on a read error', async () => {
    // A breadcrumb that cannot be read must be treated as ABSENT so the
    // key-bearing guard routes to RECOVERY, never the SecuritySetup resume.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetItem.mockRejectedValueOnce(new Error('AsyncStorage read failed'));
    await expect(isPinSetupPending()).resolves.toBe(false);
    warnSpy.mockRestore();
  });

  it('isPending resolves FALSE for any value that is not the exact marker', async () => {
    store.set(PIN_SETUP_PENDING_KEY, 'TRUE'); // wrong case / stray value
    await expect(isPinSetupPending()).resolves.toBe(false);
  });

  it('clear RETRIES a transient removeItem failure, VERIFIES removal, returns TRUE', async () => {
    await markPinSetupPending();
    // First removal attempt throws; the retry succeeds and removal is confirmed.
    mockRemoveItem.mockRejectedValueOnce(
      new Error('transient AsyncStorage remove failure')
    );
    await expect(clearPinSetupPending()).resolves.toBe(true);
    expect(store.has(PIN_SETUP_PENDING_KEY)).toBe(false);
    // Retried the removal (more than one attempt).
    expect(mockRemoveItem.mock.calls.length).toBeGreaterThan(1);
  });

  it('clear returns FALSE (never throws) when removal can NEVER be confirmed — the abort signal setupPin keys off', async () => {
    // A marker that cannot be verifiably removed makes clear return FALSE so
    // setupPin ABORTS rather than committing a PIN into an ambiguous state. It is
    // still safe if a caller ignores the result: a marker that cannot be removed
    // also cannot be READ (isPending fails closed), so it can never fail open.
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRemoveItem.mockRejectedValue(new Error('AsyncStorage remove failed'));
    await expect(clearPinSetupPending()).resolves.toBe(false);
    warnSpy.mockRestore();
  });
});
