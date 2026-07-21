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

  it('clear removes the marker; isPending then resolves FALSE', async () => {
    await markPinSetupPending();
    await clearPinSetupPending();
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

  it('clear NEVER throws even when removeItem rejects (best-effort, self-healed later)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRemoveItem.mockRejectedValueOnce(new Error('AsyncStorage remove failed'));
    await expect(clearPinSetupPending()).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });
});
