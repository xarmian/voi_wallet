// TASK-213 restore-before-PIN: performFullRestore must SET the pin_setup_pending
// breadcrumb AFTER wiping old data and BEFORE persisting any key-bearing (STANDARD)
// account — so a cold-kill in the restore window (accounts on disk, no PIN yet)
// boots to SecuritySetup(resume), not the recovery screen whose Reset would wipe
// the just-restored wallet. This asserts that ordering invariant.
//
// SECURITY NOTE: no real key material — algosdk + secure storage are mocked sinks;
// the breadcrumb holds only the marker 'true', never a secret.

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
    storeAccount: jest.fn(async () => {
      order.push('storeAccount');
    }),
    setBiometricEnabled: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    persistRestoredWallet: jest.fn(async () => {
      order.push('persistList');
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

describe('performFullRestore — pin_setup_pending breadcrumb ordering (TASK-213)', () => {
  it('sets the breadcrumb AFTER clearAllData and BEFORE the STANDARD account is persisted', async () => {
    const standardAccount = {
      id: 'restored-standard-1',
      type: AccountType.STANDARD,
      address: 'RESTORED_ADDR',
      // Non-empty so the STANDARD branch does not skip; algosdk is mocked so the
      // content is irrelevant (never a real phrase).
      mnemonic: 'placeholder mnemonic not a real phrase',
      label: 'Restored',
      createdAt: new Date().toISOString(),
    } as unknown as BackupAccountData;

    // Minimal settings/experimental: the later restorers may reject on these, but
    // the mark/clearAll/storeAccount ordering is already committed by then. Guard
    // so a later rejection can't fail this ordering assertion.
    try {
      await performFullRestore(
        [standardAccount],
        {} as unknown as BackupSettings,
        [],
        {} as unknown as Parameters<typeof performFullRestore>[3]
      );
    } catch {
      // ignore — ordering already captured above
    }

    expect(mockMark).toHaveBeenCalledTimes(1);
    // Breadcrumb set after the wipe...
    expect(order.indexOf('clearAll')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('clearAll')).toBeLessThan(order.indexOf('mark'));
    // ...and BEFORE any key-bearing account is written to disk.
    expect(order.indexOf('storeAccount')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('storeAccount'));
  });
});
