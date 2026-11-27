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
      if (mockSecureDeleteFailures.has(key))
        throw new Error('secure delete failed');
      mockEvents.push(`secure-delete:${key}`);
      mockSecure.delete(key);
    }),
  },
  storage: {
    getItem: jest.fn(async (key: string) => mockPlain.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
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
  mockNonce = 0;
  mockEnvoiLookup.resolve = undefined;
  useFriendsStore.setState({ friends: [], isInitialized: false });
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
