/**
 * TASK-469: wipeAllLocalData removes every general-storage key that is not on
 * the allow-list, reads storage back and reports any key still present (names
 * only), deletes leftover secure items, and resets in-memory stores before the
 * first delete so a late store write cannot bring a removed key back.
 *
 * AsyncStorage and the platform storage share one in-memory map here, as they
 * share one native store on mobile.
 */
const mockPlain = new Map<string, string>();
const mockSecure = new Map<string, string>();
const mockEvents: string[] = [];
let mockStickyKeys = new Set<string>();
let mockListFailure = false;
let mockSecureDeleteFailures = new Set<string>();
// Like the mobile adapter: the presence marker goes even when the delete fails.
let mockDropMarkerOnDelete = false;
let mockListFailuresLeft = 0;
// General-storage keys whose read or write rejects.
let mockFailingReads = new Set<string>();
let mockFailingWrites = new Set<string>();
let mockNonce = 0;

jest.mock('@/platform', () => ({
  crypto: {
    getRandomBytes: async (n: number) =>
      Uint8Array.from({ length: n }, () => ++mockNonce % 256),
    sha256: async () => 'test',
    randomUUID: () => 'test-id',
  },
  secureStorage: {
    getItem: jest.fn(async (key: string) => mockSecure.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockSecure.set(key, value);
    }),
    deleteItem: jest.fn(async (key: string) => {
      try {
        if (mockSecureDeleteFailures.has(key))
          throw new Error('secure delete failed');
        mockEvents.push(`secure-delete:${key}`);
        mockSecure.delete(key);
      } finally {
        if (mockDropMarkerOnDelete)
          mockPlain.delete(`__voi_ss_present__${key}`);
      }
    }),
  },
  storage: {
    getItem: jest.fn(async (key: string) => {
      if (mockFailingReads.has(key)) throw new Error('read failed');
      return mockPlain.get(key) ?? null;
    }),
    setItem: jest.fn(async (key: string, value: string) => {
      if (mockFailingWrites.has(key)) throw new Error('write failed');
      mockPlain.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      mockEvents.push(`remove:${key}`);
      mockPlain.delete(key);
    }),
    multiRemove: jest.fn(async (keys: string[]) => {
      mockEvents.push('multi-remove');
      keys.forEach((key) => {
        if (!mockStickyKeys.has(key)) mockPlain.delete(key);
      });
    }),
    getAllKeys: jest.fn(async () => {
      if (mockListFailure) throw new Error('list failed');
      if (mockListFailuresLeft > 0) {
        mockListFailuresLeft -= 1;
        throw new Error('list failed');
      }
      return [...mockPlain.keys()];
    }),
  },
  biometrics: {},
  deviceId: {},
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (key: string) => mockPlain.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      mockPlain.set(key, value);
    },
    removeItem: async (key: string) => {
      mockPlain.delete(key);
    },
  },
}));
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    clearAllWallets: jest.fn(async () => {
      mockPlain.delete('voi_wallet_metadata');
    }),
    hasWalletWithAccountsStrict: jest.fn(async () => false),
  },
}));
// The notifications service is loaded only by its own tests below.
const mockDismissAll = jest.fn(async (): Promise<void> => {});
const mockSetBadgeCount = jest.fn(
  async (_count: number): Promise<boolean> => true
);
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  clearLastNotificationResponse: jest.fn(),
  dismissAllNotificationsAsync: () => mockDismissAll(),
  setBadgeCountAsync: (count: number) => mockSetBadgeCount(count),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
}));
jest.mock('expo-device', () => ({ isDevice: true }));
jest.mock('react-native-toast-message', () => ({
  __esModule: true,
  default: { show: jest.fn(), hide: jest.fn() },
}));
jest.mock('@/services/wallet/ownKeyCustody', () => ({
  probeOwnKey: jest.fn(),
}));
jest.mock('@/services/supabase', () => ({
  getSupabaseClient: () => null,
  isSupabaseConfigured: () => false,
  setDeviceId: jest.fn(),
}));
const mockEnvoiLookup: {
  resolve?: (value: unknown) => void;
} = {};
jest.mock('@/services/envoi', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      isServiceEnabled: () => true,
      setEnabled: () => {},
      getAddress: () =>
        new Promise((resolve) => {
          mockEnvoiLookup.resolve = resolve;
        }),
    }),
  },
}));

// The app cache as an in-memory file tree, with the expo-file-system 58 calls
// the wipe makes: Directory exists, list and parentDirectory, and a delete that
// throws when the path is absent and removes a directory with everything in it.
const MOCK_CACHE = 'file:///cache';
const mockDirs = new Set<string>();
const mockFiles = new Set<string>();
// Directory or file URIs whose delete throws, never settles, or returns
// without removing anything.
let mockDeleteFailures = new Set<string>();
let mockDeleteHangs = new Set<string>();
let mockDeleteIgnored = new Set<string>();

jest.mock('expo-file-system', () => {
  const join = (...parts: (string | { uri: string })[]) =>
    parts
      .map((p) => (typeof p === 'string' ? p : p.uri))
      .map((p) => p.replace(/\/+$/, ''))
      .join('/');
  const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf('/'));
  const remove = (uri: string, exists: boolean) => {
    if (mockDeleteFailures.has(uri)) throw new Error('delete failed');
    if (mockDeleteHangs.has(uri)) return new Promise<void>(() => {});
    if (!exists) throw new Error('path does not exist');
    if (mockDeleteIgnored.has(uri)) return undefined;
    mockFiles.delete(uri);
    mockDirs.delete(uri);
    for (const f of [...mockFiles])
      if (f.startsWith(`${uri}/`)) mockFiles.delete(f);
    for (const d of [...mockDirs])
      if (d.startsWith(`${uri}/`)) mockDirs.delete(d);
    return undefined;
  };
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return mockFiles.has(this.uri);
    }
    delete() {
      return remove(this.uri, this.exists);
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = join(...parts);
    }
    get exists() {
      return mockDirs.has(this.uri);
    }
    get parentDirectory() {
      return new Directory(parentOf(this.uri));
    }
    delete() {
      return remove(this.uri, this.exists);
    }
    list() {
      return [
        ...[...mockDirs]
          .filter((d) => parentOf(d) === this.uri)
          .map((d) => new Directory(d)),
        ...[...mockFiles]
          .filter((f) => parentOf(f) === this.uri)
          .map((f) => new File(f)),
      ];
    }
  }
  return {
    File,
    Directory,
    Paths: {
      get cache() {
        return new Directory(MOCK_CACHE);
      },
    },
  };
});

import { wipeAllLocalData } from '../index';
import { registerWipeReset } from '../gate';
import { useFriendsStore } from '@/store/friendsStore';
import { WipeIncompleteError } from '@/types/wallet';

// Kept by the allow-list (one of each kind) and the wipe's own bookkeeping.
const KEPT = {
  '@voi_wallet_theme_mode': 'dark',
  '@voi_wallet_nft_theme_enabled': 'true',
  voi_selected_network: 'voi-mainnet',
  '@wallet-asset-sort-by': 'value',
  '@wallet-asset-network-filter': 'all',
  '@voi_wallet_slippage_tolerance': '1',
  '@voi_wallet_token_mappings': '[]',
  '@voi_wallet_token_mappings_timestamp': '1',
  '@update/dismissedUpdateId': 'u1',
  'experimental-features': '{}',
  voi_rate_limits: '{}',
  voi_device_installation_id: 'device',
  __voi_encryption_key__: 'k',
  __voi_ss_present__voi_device_installation_id: '1',
} as const;
const ADDRESS = 'A'.repeat(58);
// Wiped by default: the previous wallet's data, plus a key nothing knows about.
const WIPED = {
  '@friends/list': '[{"envoiName":"bob"}]',
  [`@messages/${ADDRESS}`]: '{}',
  [`@claimable/hidden/${ADDRESS}`]: '[]',
  '@voi_wallet_nft_theme': '{"nftData":{"contractId":1}}',
  '@voi_wallet_nft_theme_colors': '{}',
  '@voi_wallet_balance_cache_v2': '{}',
  'wc@2:core:0.3//keychain': '{}',
  '@voiwallet:wc_v1_sessions:topic': '{}',
  pin_setup_pending: '1',
  voi_reconcile_recovery_required: '1',
  some_unknown_key: 'x',
} as const;

const seed = (entries: Record<string, string>) => {
  for (const [key, value] of Object.entries(entries)) mockPlain.set(key, value);
};
const remainingKeys = () => [...mockPlain.keys()].sort();

beforeEach(() => {
  mockPlain.clear();
  mockSecure.clear();
  mockEvents.length = 0;
  mockStickyKeys = new Set();
  mockListFailure = false;
  mockSecureDeleteFailures = new Set();
  mockDropMarkerOnDelete = false;
  mockListFailuresLeft = 0;
  mockFailingReads = new Set();
  mockFailingWrites = new Set();
  mockNonce = 0;
  mockEnvoiLookup.resolve = undefined;
  useFriendsStore.setState({ friends: [], isInitialized: false });
  mockDirs.clear();
  mockDirs.add(MOCK_CACHE);
  mockFiles.clear();
  mockDeleteFailures = new Set();
  mockDeleteHangs = new Set();
  mockDeleteIgnored = new Set();
});

// A delete still refused when a test ends leaves its name in the wipe's
// in-process set of unconfirmed deletes; a clean wipe lets it go, so it does
// not reach the next test.
afterEach(async () => {
  if (mockSecureDeleteFailures.size === 0) return;
  mockSecureDeleteFailures = new Set();
  mockFailingReads = new Set();
  mockFailingWrites = new Set();
  await wipeAllLocalData().catch(() => undefined);
});

describe('wipe by default', () => {
  test('only allow-listed keys and the wipe bookkeeping remain', async () => {
    seed(KEPT);
    seed(WIPED);
    await wipeAllLocalData();
    expect(remainingKeys()).toEqual(
      [...Object.keys(KEPT), 'voi_secure_wiped'].sort()
    );
    expect(mockPlain.get('@voi_wallet_theme_mode')).toBe('dark');
  });

  test('a key still present after the sweep and its retry is reported by name, and the request stays', async () => {
    seed(WIPED);
    mockStickyKeys = new Set([`@messages/${ADDRESS}`, 'some_unknown_key']);
    const error = await wipeAllLocalData().then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(WipeIncompleteError);
    const keys = (error as WipeIncompleteError).keys;
    expect(keys).toContain('some_unknown_key');
    // Per-address names keep their prefix; the address itself is redacted.
    expect(keys).toContain('@messages/AAAAAA…[redacted]');
    expect(keys.join(' ')).not.toContain(ADDRESS);
    expect(mockPlain.get('voi_wipe_intent')).toBe('1');
  });

  test('a storage listing that fails is incomplete, never "nothing left"', async () => {
    seed(WIPED);
    mockListFailure = true;
    await expect(wipeAllLocalData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining(['storage_keys']),
    });
    expect(mockPlain.get('voi_wipe_intent')).toBe('1');
  });
});

describe('secure leftovers', () => {
  test('known leftover secure items and items behind a leftover presence marker are deleted', async () => {
    mockSecure.set('voi_wc_v1_session_key', 'k');
    mockSecure.set('voi_transaction_cache', '[]');
    mockSecure.set('voi_orphan_item', 'v');
    mockSecure.set('voi_device_installation_id', 'device');
    seed({
      __voi_ss_present__voi_orphan_item: '1',
      __voi_ss_present__voi_device_installation_id: '1',
    });
    await wipeAllLocalData();
    expect(mockSecure.has('voi_wc_v1_session_key')).toBe(false);
    expect(mockSecure.has('voi_transaction_cache')).toBe(false);
    expect(mockSecure.has('voi_orphan_item')).toBe(false);
    expect(mockPlain.has('__voi_ss_present__voi_orphan_item')).toBe(false);
    // The device id and its presence marker are kept.
    expect(mockSecure.get('voi_device_installation_id')).toBe('device');
    expect(mockPlain.get('__voi_ss_present__voi_device_installation_id')).toBe(
      '1'
    );
  });

  test('a leftover secure item that cannot be deleted is unresolved, and its presence marker stays', async () => {
    mockSecure.set('voi_orphan_item', 'v');
    seed({ __voi_ss_present__voi_orphan_item: '1' });
    mockSecureDeleteFailures = new Set(['voi_orphan_item']);
    await expect(wipeAllLocalData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining(['voi_orphan_item']),
    });
    expect(mockPlain.get('__voi_ss_present__voi_orphan_item')).toBe('1');
  });

  test('a failed first listing keeps the marker of an item it never reached, and the retry deletes that item', async () => {
    mockSecure.set('voi_orphan_item', 'v');
    seed({ __voi_ss_present__voi_orphan_item: '1' });
    mockListFailuresLeft = 1;
    await expect(wipeAllLocalData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining(['storage_keys']),
    });
    expect(mockSecure.has('voi_orphan_item')).toBe(true);
    expect(mockPlain.get('__voi_ss_present__voi_orphan_item')).toBe('1');

    await wipeAllLocalData();
    expect(mockSecure.has('voi_orphan_item')).toBe(false);
    expect(mockPlain.has('__voi_ss_present__voi_orphan_item')).toBe(false);
  });

  test('a leftover whose delete fails is recorded by name, and the retry deletes it although its marker is gone', async () => {
    mockDropMarkerOnDelete = true;
    mockSecure.set('voi_orphan_item', 'secret-value');
    seed({ __voi_ss_present__voi_orphan_item: '1' });
    mockSecureDeleteFailures = new Set(['voi_orphan_item']);
    await expect(wipeAllLocalData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining(['voi_orphan_item']),
    });
    // The adapter dropped the marker; the record still names the item.
    expect(mockPlain.has('__voi_ss_present__voi_orphan_item')).toBe(false);
    const record = mockPlain.get('voi_wipe_secure_leftovers') ?? '';
    expect(JSON.parse(record)).toEqual(['voi_orphan_item']);
    expect(record).not.toContain('secret-value');

    mockSecureDeleteFailures = new Set();
    await wipeAllLocalData();
    expect(mockSecure.has('voi_orphan_item')).toBe(false);
    // Cleared only now that the wipe is complete.
    expect(mockPlain.has('voi_wipe_secure_leftovers')).toBe(false);
    expect(mockPlain.has('voi_wipe_intent')).toBe(false);
  });
});

describe('a failed leftover delete the record could not keep', () => {
  // The adapter drops the marker and the record holds nothing for the item:
  // only this process still knows the name, and its retry deletes the item.
  const firstWipeFailsWith = async (failing: 'read' | 'write') => {
    mockDropMarkerOnDelete = true;
    mockSecure.set('voi_orphan_item', 'v');
    seed({ __voi_ss_present__voi_orphan_item: '1' });
    mockSecureDeleteFailures = new Set(['voi_orphan_item']);
    if (failing === 'read')
      mockFailingReads = new Set(['voi_wipe_secure_leftovers']);
    else mockFailingWrites = new Set(['voi_wipe_secure_leftovers']);
    await expect(wipeAllLocalData()).rejects.toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining([
        'voi_orphan_item',
        'voi_wipe_secure_leftovers',
      ]),
    });
    expect(mockPlain.has('__voi_ss_present__voi_orphan_item')).toBe(false);
    expect(mockPlain.has('voi_wipe_secure_leftovers')).toBe(false);
    mockSecureDeleteFailures = new Set();
    mockFailingReads = new Set();
    mockFailingWrites = new Set();
  };

  test('an unreadable record: a retry in the same process still deletes the item', async () => {
    await firstWipeFailsWith('read');
    await wipeAllLocalData();
    expect(mockSecure.has('voi_orphan_item')).toBe(false);
    expect(mockPlain.has('voi_wipe_intent')).toBe(false);

    // Confirmed deleted, so the name is let go: the next wipe does not ask.
    mockEvents.length = 0;
    await wipeAllLocalData();
    expect(mockEvents).not.toContain('secure-delete:voi_orphan_item');
  });

  test('a record write that fails: a retry in the same process still deletes the item', async () => {
    await firstWipeFailsWith('write');
    await wipeAllLocalData();
    expect(mockSecure.has('voi_orphan_item')).toBe(false);
    expect(mockPlain.has('voi_wipe_intent')).toBe(false);
  });
});

describe('in-memory state', () => {
  test('registered resets run after the request is recorded and before the first delete', async () => {
    seed(WIPED);
    const unregister = registerWipeReset('probe', () => {
      mockEvents.push('reset');
    });
    try {
      await wipeAllLocalData();
    } finally {
      unregister();
    }
    const firstDelete = mockEvents.findIndex(
      (e) =>
        e === 'multi-remove' ||
        e.startsWith('secure-delete:') ||
        e.startsWith('remove:')
    );
    expect(mockEvents.indexOf('reset')).toBeGreaterThanOrEqual(0);
    expect(mockEvents.indexOf('reset')).toBeLessThan(firstDelete);
  });

  test('the friends store is back at its initial state', async () => {
    useFriendsStore.setState({
      friends: [{ envoiName: 'bob' } as never],
      isInitialized: true,
    });
    seed(WIPED);
    await wipeAllLocalData();
    expect(useFriendsStore.getState().friends).toEqual([]);
    expect(useFriendsStore.getState().isInitialized).toBe(false);
  });

  test('a friends save in flight when the wipe starts does not bring its key back', async () => {
    seed(WIPED);
    const adding = useFriendsStore
      .getState()
      .addFriend('carol')
      .catch(() => undefined);
    await Promise.resolve();
    await wipeAllLocalData();
    mockEnvoiLookup.resolve?.({ name: 'carol', address: ADDRESS });
    await adding;
    expect(mockPlain.has('@friends/list')).toBe(false);
    expect(useFriendsStore.getState().friends).toEqual([]);
  });

  test('a friends load that starts during the wipe installs nothing, and a write begun after the wipe persists', async () => {
    seed(WIPED);
    let release: (() => void) | undefined;
    const unregister = registerWipeReset(
      'probe-hold',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    let wiping: Promise<void> | undefined;
    try {
      wiping = wipeAllLocalData();
      for (let i = 0; i < 1000 && !release; i++) await Promise.resolve();
      expect(release).toBeDefined();
      // The resets ran; the sweep has not, so the old list is still stored.
      expect(mockPlain.has('@friends/list')).toBe(true);
      await useFriendsStore.getState().initialize();
      expect(useFriendsStore.getState().friends).toEqual([]);
      expect(useFriendsStore.getState().isLoading).toBe(false);
      release?.();
      await wiping;
    } finally {
      release?.();
      await wiping?.catch(() => undefined);
      unregister();
    }
    expect(mockPlain.has('@friends/list')).toBe(false);

    const adding = useFriendsStore.getState().addFriend('carol');
    await Promise.resolve();
    mockEnvoiLookup.resolve?.({ name: 'carol', address: ADDRESS });
    await adding;
    expect(mockPlain.get('@friends/list')).toContain('carol');
    expect(useFriendsStore.getState().friends).toHaveLength(1);
  });

  test('a local purge that fails is unresolved, by name', async () => {
    const unregister = registerWipeReset('probe-purge', () =>
      Promise.reject(new Error('purge failed'))
    );
    try {
      await expect(wipeAllLocalData()).rejects.toMatchObject({
        name: 'WipeIncompleteError',
        keys: expect.arrayContaining(['memory:probe-purge']),
      });
    } finally {
      unregister();
    }
  });

  test('a local purge that never settles is bounded and unresolved', async () => {
    jest.useFakeTimers();
    const unregister = registerWipeReset(
      'probe-hang',
      () => new Promise<void>(() => {})
    );
    try {
      const outcome = wipeAllLocalData().then(
        () => undefined,
        (e: unknown) => e
      );
      await jest.advanceTimersByTimeAsync(6000);
      expect(await outcome).toMatchObject({
        name: 'WipeIncompleteError',
        keys: expect.arrayContaining(['memory:probe-hang']),
      });
    } finally {
      unregister();
      jest.useRealTimers();
    }
  });
});

describe('the notifications reset', () => {
  // The real notifications service and a wipe from one module registry, so
  // its reset is registered on the gate this wipe runs.
  const loadWipeWithNotifications = () => {
    let loaded:
      | { wipe: typeof import('../index'); gate: typeof import('../gate') }
      | undefined;
    jest.isolateModules(() => {
      require('@/services/notifications');
      loaded = { wipe: require('../index'), gate: require('../gate') };
    });
    return loaded!;
  };

  beforeEach(() => {
    mockDismissAll.mockReset();
    mockDismissAll.mockImplementation(async () => {});
    mockSetBadgeCount.mockReset();
    mockSetBadgeCount.mockImplementation(async () => true);
  });

  test('a wipe dismisses the delivered notifications and clears the badge', async () => {
    seed(WIPED);
    const { wipe } = loadWipeWithNotifications();
    await wipe.wipeAllLocalData();
    expect(mockDismissAll).toHaveBeenCalledTimes(1);
    expect(mockSetBadgeCount).toHaveBeenCalledWith(0);
    expect(remainingKeys().filter((key) => key in WIPED)).toEqual([]);
    expect(mockPlain.has('voi_wipe_intent')).toBe(false);
  });

  test.each([
    ['dismissing the delivered notifications', () => mockDismissAll],
    ['clearing the badge', () => mockSetBadgeCount],
  ] as const)(
    'a failure %s is reported as memory:notifications, and the other resets and steps still run',
    async (_what, failing) => {
      seed(WIPED);
      (failing() as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('native call failed');
      });
      const { wipe, gate } = loadWipeWithNotifications();
      const probe = jest.fn();
      gate.registerWipeReset('probe', probe);
      await expect(wipe.wipeAllLocalData()).rejects.toMatchObject({
        name: 'WipeIncompleteError',
        keys: ['memory:notifications'],
      });
      expect(probe).toHaveBeenCalledTimes(1);
      expect(mockDismissAll).toHaveBeenCalledTimes(1);
      expect(mockSetBadgeCount).toHaveBeenCalledWith(0);
      // The rest of the wipe ran; the request stays for the retry.
      expect(remainingKeys().filter((key) => key in WIPED)).toEqual([]);
      expect(mockPlain.get('voi_wipe_intent')).toBe('1');
    }
  );

  test('a dismiss that never settles is bounded and reported as memory:notifications', async () => {
    jest.useFakeTimers();
    try {
      mockDismissAll.mockImplementationOnce(() => new Promise<void>(() => {}));
      const { wipe } = loadWipeWithNotifications();
      const outcome = wipe.wipeAllLocalData().then(
        () => undefined,
        (e: unknown) => e
      );
      await jest.advanceTimersByTimeAsync(6000);
      expect(await outcome).toMatchObject({
        name: 'WipeIncompleteError',
        keys: ['memory:notifications'],
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('backup files in the app cache', () => {
  const BACKUPS = `${MOCK_CACHE}/backups`;
  const PICKER = `${MOCK_CACHE}/DocumentPicker`;
  const seedBackupFiles = () => {
    mockDirs.add(BACKUPS);
    mockDirs.add(PICKER);
    mockFiles.add(`${BACKUPS}/voi-wallet-backup-2026-11-27.voibackup`);
    mockFiles.add(`${PICKER}/0f8e7d6c.voibackup`);
  };
  const failure = async () =>
    wipeAllLocalData().then(
      () => undefined,
      (e: unknown) => e
    );

  test('a written backup and a picked copy are deleted, and other cache files stay', async () => {
    seedBackupFiles();
    mockFiles.add(`${MOCK_CACHE}/stray.voibackup`);
    mockFiles.add(`${MOCK_CACHE}/image.png`);
    await wipeAllLocalData();
    expect(mockDirs.has(BACKUPS)).toBe(false);
    expect(mockDirs.has(PICKER)).toBe(false);
    expect([...mockFiles]).toEqual([`${MOCK_CACHE}/image.png`]);
  });

  test('missing backup directories are fine: the wipe completes', async () => {
    seed(WIPED);
    await expect(wipeAllLocalData()).resolves.toBeUndefined();
    expect(mockPlain.has('voi_wipe_intent')).toBe(false);
  });

  test('a directory delete that throws makes the wipe incomplete, named by step only', async () => {
    seedBackupFiles();
    mockDeleteFailures = new Set([BACKUPS]);
    const error = await failure();
    expect(error).toBeInstanceOf(WipeIncompleteError);
    const keys = (error as WipeIncompleteError).keys;
    expect(keys).toContain('file:backups');
    expect(keys).not.toContain('file:picker-cache');
    const text = `${keys.join(' ')} ${(error as Error).message}`;
    expect(text).not.toContain('voibackup');
    expect(text).not.toContain('file:///');
    expect(mockPlain.get('voi_wipe_intent')).toBe('1');
    // The other directory is still deleted.
    expect(mockDirs.has(PICKER)).toBe(false);
  });

  test('a directory delete that never settles is bounded and unresolved', async () => {
    seedBackupFiles();
    mockDeleteHangs = new Set([PICKER]);
    jest.useFakeTimers();
    try {
      const outcome = failure();
      await jest.advanceTimersByTimeAsync(6000);
      expect(await outcome).toMatchObject({
        name: 'WipeIncompleteError',
        keys: expect.arrayContaining(['file:picker-cache']),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  test('a directory still present after its delete is unresolved', async () => {
    seedBackupFiles();
    mockDeleteIgnored = new Set([BACKUPS]);
    expect(await failure()).toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining(['file:backups']),
    });
  });

  test('a backup file left in the cache itself that cannot be deleted is unresolved', async () => {
    const stray = `${MOCK_CACHE}/stray.voibackup`;
    mockFiles.add(stray);
    mockDeleteFailures = new Set([stray]);
    const error = await failure();
    expect(error).toMatchObject({
      name: 'WipeIncompleteError',
      keys: expect.arrayContaining(['file:cache-backups']),
    });
    expect((error as WipeIncompleteError).keys.join(' ')).not.toContain(
      'stray'
    );
  });
});
