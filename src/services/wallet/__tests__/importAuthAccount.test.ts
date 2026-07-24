// Unit tests for TASK-244 (part 2): MultiAccountWalletService.importAuthAccount
// must PERSIST the caller-supplied `notes` field rather than silently dropping
// it. Prior to this fix `notes` was destructured from the request and never
// written into the account metadata, so caller-supplied notes vanished with no
// error and no warning.
//
// SECURITY / DR-3: every Algorand address used here is REAL, deterministically
// derived through algosdk from a throwaway fixture seed (`makeAccount`). No
// fabricated address or key material is used, and none is logged. `notes` is
// plain user-supplied metadata — not secret material.
//
// The heavy/native leaves are module-mocked (the Ledger transport pulls in
// untranspilable native ESM; the network + secure-storage modules touch native
// storage), mirroring the pattern in importFromPrivateKey.test.ts. The wallet
// mutation helpers (findAccountByAddress / addAccountToWallet) are spied so the
// test exercises the real importAuthAccount body without touching persistence.

jest.mock('@/services/ledger/transport', () => ({
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({
  ledgerAlgorandService: {},
}));
jest.mock('@/services/network', () => ({
  NetworkService: {},
}));
jest.mock('../../secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: jest.fn(() => 0),
  },
}));

import { makeAccount } from '@/__tests__/fixtures/algorand';
import {
  AccountType,
  ImportAuthAccountRequest,
  NetworkAuthAccount,
  RekeyedAccountMetadata,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { MultiAccountWalletService } from '../index';

// Real, deterministic accounts: the account being imported and the (Ledger)
// address that holds signing authority over it.
const ACCOUNT = makeAccount('import-auth-account:rekeyed');
const AUTH = makeAccount('import-auth-account:authority');

function makeNetworkAuthAccount(): NetworkAuthAccount {
  return {
    address: ACCOUNT.addr,
    authAddress: AUTH.addr,
    networkId: NetworkId.VOI_MAINNET,
    networkName: 'Voi Mainnet',
    existsInWallet: false,
  };
}

describe('MultiAccountWalletService.importAuthAccount — notes persistence (TASK-244)', () => {
  let addSpy: jest.SpyInstance;

  beforeEach(() => {
    // No existing account at either address → import proceeds as watch-only.
    jest
      .spyOn(MultiAccountWalletService, 'findAccountByAddress')
      .mockResolvedValue(null);
    // Stub the persistence write; capture what would be stored.
    addSpy = jest
      .spyOn(MultiAccountWalletService as any, 'addAccountToWallet')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('round-trips caller-supplied notes into the returned metadata', async () => {
    const notes = 'cold storage — recovered 2026-07';
    const request: ImportAuthAccountRequest = {
      authAccount: makeNetworkAuthAccount(),
      label: 'Recovered Auth Account',
      notes,
    };

    const result = await MultiAccountWalletService.importAuthAccount(request);

    expect(result.type).toBe(AccountType.REKEYED);
    expect(result.notes).toBe(notes);
  });

  it('persists notes into the metadata handed to storage (not just the return value)', async () => {
    const notes = 'imported via discovery flow';
    const request: ImportAuthAccountRequest = {
      authAccount: makeNetworkAuthAccount(),
      notes,
    };

    await MultiAccountWalletService.importAuthAccount(request);

    expect(addSpy).toHaveBeenCalledTimes(1);
    const persisted = addSpy.mock.calls[0][0] as RekeyedAccountMetadata;
    expect(persisted.notes).toBe(notes);
  });

  it('leaves notes undefined when the caller supplies none', async () => {
    const request: ImportAuthAccountRequest = {
      authAccount: makeNetworkAuthAccount(),
      label: 'No Notes',
    };

    const result = await MultiAccountWalletService.importAuthAccount(request);

    expect(result.notes).toBeUndefined();
  });
});
