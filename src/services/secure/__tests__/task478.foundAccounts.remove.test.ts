// TASK-478: removing a quarantined key from this device. Behind a fresh
// authentication; refused while a storage write for the slot is unresolved.

jest.mock('@/platform', () =>
  require('./fixtures/task478Platform').createTask478Platform()
);
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));
jest.mock('@/store/walletStore', () => ({
  removePersistedBalanceCaches: jest.fn(async () => {}),
}));

import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { FreshAuthError } from '@/services/secure/freshAuth';
import { UNKNOWN_WRITES_STORAGE_KEY } from '@/services/secure/boundedWrites';
import {
  readFoundAccountsSummary,
  removeFoundAccount,
  scanFoundAccounts,
} from '../foundAccounts';
import {
  LEGACY,
  SECRET,
  SEEN_KEY,
  authed,
  installPrompter,
  mockPlatform,
  pinDeviceWithTwoOrphans,
  readRegistry,
  readScanMap,
  resetAll,
} from './fixtures/task478Helpers';

let unregister: (() => void) | undefined;
beforeEach(() => {
  resetAll();
  jest.restoreAllMocks();
  (
    global as typeof globalThis & { __voiProcessSessionId?: string }
  ).__voiProcessSessionId = 'task478-process';
});
afterEach(() => {
  unregister?.();
  unregister = undefined;
});

const remove = (id: string) =>
  authed('remove_found_account', (cap) => removeFoundAccount(id, cap));

describe('TASK-478 remove a found key', () => {
  it('remove behind auth', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    const cancel = installPrompter(false);
    await expect(remove(formatA.id)).rejects.toBeInstanceOf(FreshAuthError);
    cancel.unregister();
    expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe('string');
    expect(readRegistry()).toContain(formatA.id);

    unregister = installPrompter(true).unregister;
    const summary = await readFoundAccountsSummary();
    await authed('scan_found_accounts', (cap) =>
      scanFoundAccounts(summary.unscannedIds, cap)
    );
    await AccountSecureStorage.markFoundNoticeSeen([formatA.id]);
    expect(readScanMap()).toHaveProperty(formatA.id);

    await remove(formatA.id);
    expect(mockPlatform.__secure.has(SECRET(formatA.id))).toBe(false);
    expect(mockPlatform.__secure.has(LEGACY(formatA.id))).toBe(false);
    expect(readRegistry()).not.toContain(formatA.id);
    expect(readScanMap() ?? {}).not.toHaveProperty(formatA.id);
    expect(JSON.parse(mockPlatform.__kv.get(SEEN_KEY) ?? '[]')).not.toContain(
      formatA.id
    );
    expect((await readFoundAccountsSummary()).presentCount).toBe(1);
  });

  it('remove refuses an unresolved write', async () => {
    const { formatA } = await pinDeviceWithTwoOrphans();
    mockPlatform.__kv.set(
      UNKNOWN_WRITES_STORAGE_KEY,
      JSON.stringify({
        [SECRET(formatA.id)]: {
          key: SECRET(formatA.id),
          op: 'set',
          verifier: 'nonce',
          attempt: 'a1',
          sessionId: 'an-earlier-process',
          at: 1,
        },
      })
    );
    unregister = installPrompter(true).unregister;
    await expect(remove(formatA.id)).rejects.toThrow(/unresolved/);
    expect(typeof mockPlatform.__secure.get(SECRET(formatA.id))).toBe('string');
    expect(readRegistry()).toContain(formatA.id);
  });

  it('an id that is not in the found list is refused', async () => {
    await pinDeviceWithTwoOrphans();
    unregister = installPrompter(true).unregister;
    await expect(remove('not-quarantined')).rejects.toThrow(
      /no longer in the found list/
    );
  });
});
