// Regression tests for TASK-213 (Codex round-4 P1): the MOBILE secure-storage
// adapter must fail CLOSED on Android, where expo-secure-store SWALLOWS a
// decrypt/keystore read FAILURE to `null` — indistinguishable from genuine
// ABSENCE — for the keystore-desync classes this guards (missing KeyStore key
// after reinstall/restore, KeyPermanentlyInvalidatedException, BadPadding / AEAD
// tag mismatch). Two of those native paths ALSO delete the item, which without a
// guard makes the fail-OPEN permanent (Retry sees genuine absence and the app
// offers to set a NEW PIN — a lock-takeover vector).
//
// The adapter keeps a PLAINTEXT presence sentinel (key NAMES only) in AsyncStorage
// so a value that was written and not deleted, yet now reads back `null`, is
// surfaced as a THROW (a read FAILURE) rather than absence. iOS throws natively,
// so this reconstruction is Android-only and iOS behavior is pass-through.
//
// SECURITY NOTE: no real secret material — opaque marker strings only.
//
// The shared control/state below is `mock`-prefixed so the jest.mock factories
// (hoisted above imports) may legally reference it.

// In-memory backing for the two stores the adapter touches.
const mockSecureBacking = new Map<string, string>();
const mockAsyncBacking = new Map<string, string>();

// Models the Android native read: healthy -> returns the stored value; broken ->
// swallows to null (like KeyPermanentlyInvalidated) and, when
// `mockDeleteOnDecryptFailure` is set, ALSO deletes the item (like the BadPadding
// / missing-KeyStore-key paths that call deleteItemImpl).
const mockCtl = {
  keystoreHealthy: true,
  deleteOnDecryptFailure: true,
  // For the iOS pass-through test: make the native read THROW (iOS raises a
  // KeyChainException on any status other than errSecItemNotFound).
  iosNativeThrows: false,
  // Make the AsyncStorage sentinel read THROW (models AsyncStorage genuinely
  // unavailable). Driven through the shared control object rather than a
  // per-instance mockRejectedValueOnce because the adapter is loaded under
  // jest.isolateModules and thus holds its OWN jest.fn instance.
  asyncGetThrows: false,
  // Make the native delete THROW (a broken keystore can make deletion fail).
  nativeDeleteThrows: false,
};

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
  getItemAsync: jest.fn(async (key: string) => {
    if (mockCtl.iosNativeThrows) {
      throw new Error('KeyChainException: keychain unreadable');
    }
    if (!mockSecureBacking.has(key)) {
      return null; // genuine absence
    }
    if (mockCtl.keystoreHealthy) {
      return mockSecureBacking.get(key)!;
    }
    if (mockCtl.deleteOnDecryptFailure) {
      mockSecureBacking.delete(key); // mimic deleteItemImpl on BadPadding/missing-key
    }
    return null; // Android swallow-to-null
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecureBacking.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    if (mockCtl.nativeDeleteThrows) {
      throw new Error('native delete failed (broken keystore)');
    }
    mockSecureBacking.delete(key);
  }),
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => {
      if (mockCtl.asyncGetThrows) {
        throw new Error('AsyncStorage unavailable');
      }
      return mockAsyncBacking.has(k) ? mockAsyncBacking.get(k)! : null;
    }),
    setItem: jest.fn(async (k: string, v: string) => {
      mockAsyncBacking.set(k, v);
    }),
    removeItem: jest.fn(async (k: string) => {
      mockAsyncBacking.delete(k);
    }),
  },
}));

const PIN_KEY = 'voi_wallet_pin';
const SENTINEL = '__voi_ss_present__' + PIN_KEY;

// Load a FRESH adapter instance bound to a chosen Platform.OS. The adapter reads
// Platform.OS at module-eval time, so the platform mock must be installed before
// the module is required — hence isolateModules + doMock per load.
function loadAdapter(os: 'android' | 'ios') {
  let AdapterClass: typeof import('../secureStorage').MobileSecureStorageAdapter;
  jest.isolateModules(() => {
    jest.doMock('react-native', () => ({ Platform: { OS: os } }));
    AdapterClass = require('../secureStorage').MobileSecureStorageAdapter;
  });
  // @ts-expect-error assigned inside isolateModules
  return new AdapterClass();
}

beforeEach(() => {
  mockSecureBacking.clear();
  mockAsyncBacking.clear();
  mockCtl.keystoreHealthy = true;
  mockCtl.deleteOnDecryptFailure = true;
  mockCtl.iosNativeThrows = false;
  mockCtl.asyncGetThrows = false;
  mockCtl.nativeDeleteThrows = false;
  jest.clearAllMocks();
});

describe('MobileSecureStorageAdapter — Android fail-closed (TASK-213)', () => {
  it('resolves NULL for genuine absence (no stored item, no sentinel)', async () => {
    const adapter = loadAdapter('android');
    await expect(adapter.getItem(PIN_KEY)).resolves.toBeNull();
  });

  it('resolves the value AND self-heals the presence sentinel on a healthy read', async () => {
    // Pre-existing item written by an older build (no sentinel yet).
    mockSecureBacking.set(PIN_KEY, 'opaque-credential');
    const adapter = loadAdapter('android');

    await expect(adapter.getItem(PIN_KEY)).resolves.toBe('opaque-credential');
    // The sentinel was written so the NEXT boot is protected.
    expect(mockAsyncBacking.get(SENTINEL)).toBe('1');
  });

  it('THROWS (fails closed) when a written item later reads back null — the Android swallow-to-null', async () => {
    const adapter = loadAdapter('android');
    // A value is written (sentinel recorded)...
    await adapter.setItem(PIN_KEY, 'opaque-credential');
    expect(mockAsyncBacking.get(SENTINEL)).toBe('1');

    // ...then the keystore desyncs: native returns null (and deletes the item).
    mockCtl.keystoreHealthy = false;

    await expect(adapter.getItem(PIN_KEY)).rejects.toThrow(
      /secure storage read failed/i
    );
  });

  it('STAYS failed closed on the NEXT read after the native path deleted the item (no permanent fail-open)', async () => {
    const adapter = loadAdapter('android');
    await adapter.setItem(PIN_KEY, 'opaque-credential');

    // First failing read: native swallows to null AND deletes the encrypted item.
    mockCtl.keystoreHealthy = false;
    await expect(adapter.getItem(PIN_KEY)).rejects.toThrow();
    expect(mockSecureBacking.has(PIN_KEY)).toBe(false); // native deleted it

    // Second read: the item is genuinely gone from secure store, but the sentinel
    // persists — so the adapter STILL throws rather than reporting a fake absence
    // (which is what let a NEW PIN be set — the lock-takeover the guard closes).
    await expect(adapter.getItem(PIN_KEY)).rejects.toThrow(
      /secure storage read failed/i
    );
  });

  it('an EXPLICIT delete clears the sentinel so the next read is genuine ABSENCE (reset escape hatch)', async () => {
    const adapter = loadAdapter('android');
    await adapter.setItem(PIN_KEY, 'opaque-credential');

    // Break the keystore, then delete (models clearAll() during a reset).
    mockCtl.keystoreHealthy = false;
    await adapter.deleteItem(PIN_KEY);
    expect(mockAsyncBacking.has(SENTINEL)).toBe(false);

    // After the intentional wipe the read must resolve null (absence), NOT throw —
    // this is what routes the recovery-screen reset back into Onboarding.
    await expect(adapter.getItem(PIN_KEY)).resolves.toBeNull();
  });

  it('clears the sentinel EVEN WHEN the native delete throws (Codex round-4 P2 — reset never stranded)', async () => {
    const adapter = loadAdapter('android');
    await adapter.setItem(PIN_KEY, 'opaque-credential');

    // Broken keystore: native delete throws AND the item still reads back null.
    mockCtl.keystoreHealthy = false;
    mockCtl.nativeDeleteThrows = true;

    // clearAll() swallows the deleteItem rejection, so we mirror that here: the
    // native error propagates, but the sentinel MUST already be cleared.
    await expect(adapter.deleteItem(PIN_KEY)).rejects.toThrow(
      'native delete failed'
    );
    expect(mockAsyncBacking.has(SENTINEL)).toBe(false);

    // With the sentinel gone, the next strict read resolves genuine ABSENCE (not a
    // fail-closed throw), so recovery's reset can reach Onboarding.
    await expect(adapter.getItem(PIN_KEY)).resolves.toBeNull();
  });

  it('a self-healed item is protected on the FOLLOWING boot even if it was written by an older build', async () => {
    // Older build wrote the value with no sentinel.
    mockSecureBacking.set(PIN_KEY, 'opaque-credential');
    const adapter = loadAdapter('android');

    // First successful boot self-heals the sentinel.
    await expect(adapter.getItem(PIN_KEY)).resolves.toBe('opaque-credential');

    // Now the keystore breaks — the (now-recorded) sentinel makes it fail closed.
    mockCtl.keystoreHealthy = false;
    await expect(adapter.getItem(PIN_KEY)).rejects.toThrow(
      /secure storage read failed/i
    );
  });

  it('propagates an AsyncStorage sentinel-read failure (fail closed, never coerced to absence)', async () => {
    const adapter = loadAdapter('android');
    await adapter.setItem(PIN_KEY, 'opaque-credential');
    mockCtl.keystoreHealthy = false;
    // Native read yields null; the sentinel read then fails — the failure must
    // PROPAGATE (fail closed), never be coerced to absence.
    mockCtl.asyncGetThrows = true;

    await expect(adapter.getItem(PIN_KEY)).rejects.toThrow(
      'AsyncStorage unavailable'
    );
  });
});

describe('MobileSecureStorageAdapter — iOS is pass-through (unchanged)', () => {
  it('propagates a native THROW (iOS raises on keychain failure) — no sentinel involved', async () => {
    mockSecureBacking.set(PIN_KEY, 'opaque-credential');
    mockCtl.iosNativeThrows = true;
    const adapter = loadAdapter('ios');

    await expect(adapter.getItem(PIN_KEY)).rejects.toThrow('KeyChainException');
  });

  it('resolves null for absence and does NOT write a sentinel on iOS', async () => {
    const adapter = loadAdapter('ios');

    await expect(adapter.getItem(PIN_KEY)).resolves.toBeNull();
    await adapter.setItem(PIN_KEY, 'opaque-credential');
    // No Android sentinel bookkeeping on iOS.
    expect(mockAsyncBacking.size).toBe(0);
    await expect(adapter.getItem(PIN_KEY)).resolves.toBe('opaque-credential');
  });
});
