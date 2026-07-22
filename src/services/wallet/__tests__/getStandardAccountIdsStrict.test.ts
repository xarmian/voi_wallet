// TASK-222: MultiAccountWalletService.getStandardAccountIdsStrict() — the
// STRICT, boot-only read of STANDARD (key-bearing) account ids that the
// cross-store reconcile matches against secure-store secrets. It MUST fail
// CLOSED: a storage read FAILURE or a CORRUPT blob propagates (so the reconcile
// aborts rather than orphan-deleting every real secret), while a genuine ABSENCE
// resolves []. Pure read — no migration write, no cache mutation.
//
// SECURITY NOTE: no key material; blobs are minimal throwaway JSON.

let mockStore: Record<string, string> = {};

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async (k: string) =>
      Object.prototype.hasOwnProperty.call(mockStore, k) ? mockStore[k] : null
    ),
    setItem: jest.fn(async (k: string, v: string) => {
      mockStore[k] = v;
    }),
    removeItem: jest.fn(async (k: string) => {
      delete mockStore[k];
    }),
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    deleteItem: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));

import { storage, secureStorage } from '@/platform';
import { MultiAccountWalletService } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';
const mockStorageGet = storage.getItem as jest.Mock;
const mockSecureGet = secureStorage.getItem as jest.Mock;

function blob(accounts: { id: string; type: string }[]): string {
  return JSON.stringify({
    id: 'w1',
    version: '1',
    createdAt: '',
    accounts: accounts.map((a) => ({
      id: a.id,
      address: 'ADDR',
      publicKey: 'PUB',
      type: a.type,
      isHidden: false,
    })),
    activeAccountId: accounts[0]?.id ?? '',
    settings: {},
  });
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

it('returns [] for genuine absence (no blob)', async () => {
  await expect(
    MultiAccountWalletService.getStandardAccountIdsStrict()
  ).resolves.toEqual([]);
});

it('returns only STANDARD account ids, excluding other types', async () => {
  mockStore[WALLET_KEY] = blob([
    { id: 's1', type: 'standard' },
    { id: 'w1', type: 'watch' },
    { id: 'l1', type: 'ledger' },
    { id: 's2', type: 'standard' },
    { id: 'r1', type: 'remote_signer' },
  ]);

  await expect(
    MultiAccountWalletService.getStandardAccountIdsStrict()
  ).resolves.toEqual(['s1', 's2']);
});

it('returns [] for a present blob with zero accounts', async () => {
  mockStore[WALLET_KEY] = blob([]);
  await expect(
    MultiAccountWalletService.getStandardAccountIdsStrict()
  ).resolves.toEqual([]);
});

it('PROPAGATES a storage read failure (fail closed, not [])', async () => {
  mockStorageGet.mockRejectedValueOnce(new Error('keychain unavailable'));
  await expect(
    MultiAccountWalletService.getStandardAccountIdsStrict()
  ).rejects.toThrow('keychain unavailable');
});

it('THROWS on an unparseable blob (corruption is not absence)', async () => {
  mockStore[WALLET_KEY] = '{not valid json';
  await expect(
    MultiAccountWalletService.getStandardAccountIdsStrict()
  ).rejects.toThrow();
});

it('THROWS on a structurally-corrupt blob (accounts not an array)', async () => {
  mockStore[WALLET_KEY] = JSON.stringify({ accounts: {} });
  await expect(
    MultiAccountWalletService.getStandardAccountIdsStrict()
  ).rejects.toThrow('not an array');
});

it('does not write or migrate (pure read)', async () => {
  mockStore[WALLET_KEY] = blob([{ id: 's1', type: 'standard' }]);
  await MultiAccountWalletService.getStandardAccountIdsStrict();
  expect(storage.setItem).not.toHaveBeenCalled();
  // Present primary means the legacy secure-store fallback is never consulted.
  expect(mockSecureGet).not.toHaveBeenCalled();
});
