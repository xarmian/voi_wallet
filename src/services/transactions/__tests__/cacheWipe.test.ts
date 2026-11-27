/**
 * TASK-469: the prepared-transaction cache holds unsigned transactions and the
 * previous wallet's addresses for minutes. A wipe empties it, and a
 * preparation that started before or during the wipe does not put its result
 * back. Only the network boundary is mocked; no key material is involved.
 */
import { makeAddress, SUGGESTED_PARAMS } from '@/__tests__/fixtures/algorand';

const mockGetSuggestedParams = jest.fn();
jest.mock('@/services/network', () => {
  const svc = {
    getSuggestedParams: (...args: unknown[]) => mockGetSuggestedParams(...args),
    estimateTransactionFee: async () => 1000,
  };
  return {
    __esModule: true,
    networkService: svc,
    NetworkService: { getInstance: () => svc },
  };
});
jest.mock('@/services/mimir', () => ({ __esModule: true, default: {} }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/store/walletStore', () => ({
  __esModule: true,
  useWalletStore: { getState: () => ({}) },
}));
jest.mock('@/services/ledger/transport', () => ({
  __esModule: true,
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({
  __esModule: true,
  ledgerAlgorandService: {},
}));
jest.mock('@/services/secure/keyManager', () => ({
  __esModule: true,
  SecureKeyManager: {
    getSigningInfo: jest.fn(),
    getLedgerSigningInfo: jest.fn(),
  },
}));
jest.mock('@/services/security/transactionTracker', () => ({
  __esModule: true,
  TransactionTracker: { validateNewTransaction: async () => [] },
}));
const mockAccounts = () => [
  { id: 'sender', address: SENDER, type: 'standard' },
  { id: 'recipient', address: RECIPIENT, type: 'standard' },
];
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getAllAccounts: async () => mockAccounts(),
    getCurrentWallet: async () => ({ accounts: mockAccounts() }),
  },
}));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    probeSecretPresenceStrict: async () => false,
    getPrivateKey: async () => {
      throw new Error('no key');
    },
  },
}));
jest.mock('@/services/remoteSigner/signingRouter', () => ({
  checkRemoteSigningRequired: () => ({ needsRemoteSigning: false }),
}));

import { TransactionService } from '@/services/transactions';
import {
  closeWipeWindow,
  openWipeWindow,
  runWipeResets,
} from '@/services/wipe/gate';

const SENDER = makeAddress('tx-cache-wipe:sender');
const RECIPIENT = makeAddress('tx-cache-wipe:recipient');
const PAYMENT = {
  from: SENDER,
  to: RECIPIENT,
  amount: 1_000_000,
  assetType: 'voi' as const,
};
const REKEY = { fromAddress: SENDER, rekeyToAddress: RECIPIENT };

const params = async () => ({ ...SUGGESTED_PARAMS });
/** The next suggested-params read waits until `release` is called. */
const holdNextParams = () => {
  let release: () => void = () => {};
  mockGetSuggestedParams.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ ...SUGGESTED_PARAMS });
      })
  );
  return () => release();
};
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const wipe = () => {
  openWipeWindow();
  runWipeResets();
  closeWipeWindow();
};

beforeEach(() => {
  mockGetSuggestedParams.mockReset();
  mockGetSuggestedParams.mockImplementation(params);
  wipe();
});
afterEach(() => closeWipeWindow());

test('a wipe empties the cache of prepared transactions', async () => {
  const built = await TransactionService.buildTransaction(PAYMENT);
  expect(TransactionService.getCachedUnsignedTransaction(PAYMENT)).toBe(built);

  wipe();
  expect(TransactionService.getCachedUnsignedTransaction(PAYMENT)).toBeNull();
});

test('a preparation under way when the wipe starts does not fill the cache after it', async () => {
  const release = holdNextParams();
  const building = TransactionService.buildTransaction(PAYMENT);
  await flush();
  wipe();
  release();
  await building;
  expect(TransactionService.getCachedUnsignedTransaction(PAYMENT)).toBeNull();
});

test('a preparation that starts while the wipe runs does not fill the cache, even once it ends', async () => {
  openWipeWindow();
  runWipeResets();
  const release = holdNextParams();
  const building = TransactionService.buildTransaction(PAYMENT);
  await flush();
  closeWipeWindow();
  release();
  await building;
  expect(TransactionService.getCachedUnsignedTransaction(PAYMENT)).toBeNull();
});

test('a rekey preparation under way when the wipe starts is not reused after it', async () => {
  const release = holdNextParams();
  const building = TransactionService.buildRekeyTransaction(REKEY);
  await flush();
  wipe();
  release();
  await building;
  expect(mockGetSuggestedParams).toHaveBeenCalledTimes(1);

  // Not served from the cache: it is built again.
  await TransactionService.buildRekeyTransaction(REKEY);
  expect(mockGetSuggestedParams).toHaveBeenCalledTimes(2);
});

test('without a wipe a prepared transaction is still reused', async () => {
  const first = await TransactionService.buildTransaction(PAYMENT);
  const second = await TransactionService.buildTransaction(PAYMENT);
  expect(second).toBe(first);
  await TransactionService.buildRekeyTransaction(REKEY);
  await TransactionService.buildRekeyTransaction(REKEY);
  expect(mockGetSuggestedParams).toHaveBeenCalledTimes(2);
});
