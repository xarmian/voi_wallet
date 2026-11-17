// TASK-213 restore-before-PIN: with no PIN, performFullRestore must SET the
// pin_setup_pending breadcrumb BEFORE persisting any key-bearing (STANDARD)
// account, so a cold-kill in the restore window (accounts on disk, no PIN yet)
// boots to SecuritySetup(resume), not the recovery screen whose Reset would wipe
// the just-restored wallet. TASK-504: restore is add-only, so it never clears
// anything, from either entry point.
//
// SECURITY NOTE: no real key material. algosdk + secure storage are mocked
// sinks; the breadcrumb holds only the marker 'true', never a secret.

const order: string[] = [];

jest.mock('@/services/secure/pinSetupPending', () => ({
  markPinSetupPending: jest.fn(async () => {
    order.push('mark');
  }),
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    clearAll: jest.fn(async () => {
      order.push('clearAll');
    }),
    getResetGeneration: jest.fn(() => 0),
    hasPinStrict: jest.fn(async () => false),
    storeAccountForRestore: jest.fn(async (account: { id: string }) => {
      order.push('storeAccount');
      return {
        kind: 'written' as const,
        id: account.id,
        token: 'token-1',
        reassigned: false,
      };
    }),
    storeAccountForCreation: jest.fn(async () => 'token-1'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
    removeAccountMetadataOnly: jest.fn(async () => {}),
    setBiometricEnabled: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    clearAllWallets: jest.fn(async () => {
      order.push('clearWallet');
    }),
    readWalletStrict: jest.fn(async () => null),
    isDeviceFreshStrict: jest.fn(async () => true),
    mergeRestoredAccounts: jest.fn(async (accounts: { id: string }[]) => {
      order.push('persistList');
      return {
        added: accounts.map((a) => a.id),
        skipped: [],
        hadAccounts: false,
      };
    }),
  },
}));

jest.mock('@/platform', () => ({
  storage: {
    removeItem: jest.fn(async () => {}),
    setItem: jest.fn(async () => {}),
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getAllKeys: jest.fn(async () => []),
    multiRemove: jest.fn(async () => {}),
    multiSet: jest.fn(async () => {}),
    setItem: jest.fn(async () => {}),
  },
}));

jest.mock('algosdk', () => ({
  __esModule: true,
  default: {
    mnemonicToSecretKey: jest.fn(() => ({
      addr: { toString: () => 'RESTORED_ADDR' },
      sk: new Uint8Array(64),
    })),
  },
}));

import { performFullRestore } from '../restorers';
import { markPinSetupPending } from '@/services/secure/pinSetupPending';
import { AccountType } from '@/types/wallet';
import type { BackupAccountData, BackupSettings } from '../types';

const mockMark = markPinSetupPending as jest.Mock;

beforeEach(() => {
  order.length = 0;
  jest.clearAllMocks();
});

const standardRecord = () =>
  ({
    id: 'restored-standard-1',
    type: AccountType.STANDARD,
    address: 'RESTORED_ADDR',
    // Non-empty so the STANDARD branch does not skip; algosdk is mocked so the
    // content is irrelevant (never a real phrase).
    mnemonic: 'placeholder mnemonic not a real phrase',
    label: 'Restored',
    createdAt: new Date().toISOString(),
  }) as unknown as BackupAccountData;

async function restoreOnce() {
  return performFullRestore(
    [standardRecord()],
    {} as unknown as BackupSettings,
    [],
    {} as unknown as Parameters<typeof performFullRestore>[3]
  );
}

describe('performFullRestore — pin_setup_pending breadcrumb ordering (TASK-213)', () => {
  it('sets the breadcrumb BEFORE the STANDARD account is persisted when there is no PIN', async () => {
    try {
      await restoreOnce();
    } catch {
      // later restorers may reject on the minimal fixtures; the ordering is
      // already committed by then
    }

    expect(mockMark).toHaveBeenCalledTimes(1);
    expect(order.indexOf('storeAccount')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('storeAccount'));
  });

  it('does not set the breadcrumb when a PIN exists', async () => {
    const {
      AccountSecureStorage,
    } = require('@/services/secure/AccountSecureStorage');
    AccountSecureStorage.hasPinStrict.mockResolvedValueOnce(true);
    try {
      await restoreOnce();
    } catch {
      // minimal fixtures
    }
    expect(mockMark).not.toHaveBeenCalled();
  });
});

describe('performFullRestore — add-only (TASK-504)', () => {
  it.each([false, true])(
    'never clears secrets or the wallet blob (PIN present: %s)',
    async (hasPin) => {
      const {
        AccountSecureStorage,
      } = require('@/services/secure/AccountSecureStorage');
      const { MultiAccountWalletService } = require('@/services/wallet');
      AccountSecureStorage.hasPinStrict.mockResolvedValue(hasPin);
      try {
        await restoreOnce();
      } catch {
        // minimal fixtures
      }
      expect(AccountSecureStorage.clearAll).not.toHaveBeenCalled();
      expect(MultiAccountWalletService.clearAllWallets).not.toHaveBeenCalled();
    }
  );

  it('a failed device read stops the restore before anything is written', async () => {
    const { MultiAccountWalletService } = require('@/services/wallet');
    MultiAccountWalletService.isDeviceFreshStrict.mockRejectedValueOnce(
      new Error('disk I/O failure')
    );
    await expect(restoreOnce()).rejects.toThrow('disk I/O failure');
    expect(mockMark).not.toHaveBeenCalled();
    expect(order).not.toContain('storeAccount');
  });
});

it.each([undefined, '', 'invalid phrase'])(
  'rejects a missing or invalid standard phrase before any destructive work (#4): %s',
  async (mnemonic) => {
    const algosdk = jest.requireMock('algosdk').default;
    const { AccountSecureStorage } = jest.requireMock(
      '@/services/secure/AccountSecureStorage'
    );
    const { MultiAccountWalletService } = jest.requireMock('@/services/wallet');
    algosdk.mnemonicToSecretKey.mockImplementation((phrase: string) => {
      if (phrase !== 'valid test phrase') throw new Error('Invalid mnemonic');
      return {
        addr: { toString: () => 'RESTORED_ADDR' },
        sk: new Uint8Array(64),
      };
    });
    const records = ['valid test phrase', mnemonic].map(
      (phrase, index) =>
        ({
          id: `standard-${index}`,
          type: AccountType.STANDARD,
          address: 'RESTORED_ADDR',
          mnemonic: phrase,
        }) as BackupAccountData
    );
    await expect(
      performFullRestore(
        records,
        {} as BackupSettings,
        [],
        {} as Parameters<typeof performFullRestore>[3]
      )
    ).rejects.toThrow();
    expect(AccountSecureStorage.clearAll).not.toHaveBeenCalled();
    expect(MultiAccountWalletService.clearAllWallets).not.toHaveBeenCalled();
    expect(AccountSecureStorage.storeAccountForCreation).not.toHaveBeenCalled();
    expect(mockMark).not.toHaveBeenCalled();
  }
);
