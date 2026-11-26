let mockStore: Record<string, string> = {};

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async (key: string) => mockStore[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      mockStore[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete mockStore[key];
    }),
  },
  secureStorage: {
    getItem: jest.fn(async () => null),
    deleteItem: jest.fn(async () => {}),
  },
}));
jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({ ledgerAlgorandService: {} }));
jest.mock('@/services/network', () => ({ NetworkService: {} }));
jest.mock('@/services/notifications/subscribePass', () => ({
  invalidateAccountSubscribePasses: jest.fn(),
}));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    storeAccountForCreation: jest.fn(async () => 'token'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
    deleteAccount: jest.fn(async () => {}),
  },
}));

import algosdk from 'algosdk';
import { AccountType, Wallet } from '@/types/wallet';
import { MultiAccountWalletService as Service } from '../index';

const WALLET_KEY = 'voi_wallet_metadata';
const readWallet = (): Wallet => JSON.parse(mockStore[WALLET_KEY]);
const writeWallet = (wallet: Wallet) => {
  mockStore[WALLET_KEY] = JSON.stringify(wallet);
};
const address = () => algosdk.generateAccount().addr.toString();

const addStandard = async (label: string) =>
  (await Service.createStandardAccount({ type: AccountType.STANDARD, label }))
    .id;
const addWatch = async (label: string) =>
  (
    await Service.addWatchAccount({
      type: AccountType.WATCH,
      address: address(),
      label,
    })
  ).id;

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

describe.each([
  ['a created account', addStandard],
  ['a watch account', addWatch],
])('adding %s', (_name, add) => {
  it('selects it when the wallet is empty and its active id is stale', async () => {
    // The state deleteAccount leaves after the last account goes: the wallet
    // stays, with activeAccountId still naming the deleted account.
    const gone = await addStandard('Gone');
    writeWallet({ ...readWallet(), accounts: [] });
    expect(readWallet().activeAccountId).toBe(gone);

    const added = await add('New');

    expect(readWallet().activeAccountId).toBe(added);
  });

  it('selects it when no listed account is active', async () => {
    const kept = await addStandard('Kept');
    writeWallet({ ...readWallet(), activeAccountId: 'not-listed' });

    const added = await add('New');

    const wallet = readWallet();
    expect(wallet.accounts.map((account) => account.id)).toEqual([kept, added]);
    expect(wallet.activeAccountId).toBe(added);
  });

  it('keeps the active account when one is selected', async () => {
    const first = await addStandard('First');

    await add('Second');

    expect(readWallet().activeAccountId).toBe(first);
  });
});

it('selects the next account added after the last one is deleted', async () => {
  const only = await Service.createStandardAccount({
    type: AccountType.STANDARD,
    label: 'Only',
  });
  await Service.deleteAccount(only.id, {
    address: only.address,
    type: only.type,
    keyless: false,
  });
  expect(readWallet().accounts).toEqual([]);

  const next = await addStandard('Next');

  expect(readWallet().activeAccountId).toBe(next);
});
