/**
 * TASK-425 U4 — a detected REKEYED account never claims a retained key.
 *
 * detectRekeyedAccount stores metadata only, so originalOwner (a converted
 * STANDARD account that kept its key) must be false even when this device can
 * sign through the auth address. A true flag would make every protective reader
 * expect a key that was never stored, and backup collection would then fail.
 *
 * SECURITY NOTE: no committed secret material — addresses are generated fresh.
 */

jest.mock('@/platform', () => ({
  storage: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
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
  AccountSecureStorage: { getResetGeneration: () => 0 },
}));

import algosdk from 'algosdk';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { MultiAccountWalletService } from '../index';

const ORIGINAL = algosdk.generateAccount().addr.toString();
const AUTH = algosdk.generateAccount().addr.toString();

// Private statics the detection path calls; stubbed so only the record is under test.
const service = MultiAccountWalletService as any;

afterEach(() => jest.restoreAllMocks());

it.each([
  ['a STANDARD auth account on this device', AccountType.STANDARD, true],
  ['no local auth account', undefined, false],
])(
  'writes originalOwner false with %s',
  async (_label, authType, expectedCanSign) => {
    jest.spyOn(service, 'verifyRekeyRelationship').mockResolvedValue(true);
    jest
      .spyOn(service, 'findAccountByAddress')
      .mockResolvedValue(
        authType ? ({ address: AUTH, type: authType } as AccountMetadata) : null
      );
    jest.spyOn(service, 'getRekeyedAccountCount').mockResolvedValue(0);
    const add = jest
      .spyOn(service, 'addAccountToWallet')
      .mockResolvedValue(undefined);

    const record = await MultiAccountWalletService.detectRekeyedAccount({
      type: AccountType.REKEYED,
      originalAddress: ORIGINAL,
      authAddress: AUTH,
    });

    expect(record).toMatchObject({
      type: AccountType.REKEYED,
      canSign: expectedCanSign,
      originalOwner: false,
    });
    expect(add).toHaveBeenCalledWith(record, 0);
  }
);
