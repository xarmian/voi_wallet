// Unit tests for TASK-30 (Codex P2-1): BackupService.createBackup must enforce
// the passphrase policy at the service boundary, so a direct caller that skips
// the UI modal cannot create a backup (which protects every account's mnemonic)
// under a weak password. The restore/import path must NOT be gated by this
// policy — that is covered by encryption.test.ts round-trips.
//
// SECURITY NOTE: no real secret material — accounts collector is mocked to [].

// Platform CSPRNG for the real scrypt/AES path used by encryptBackup.
jest.mock('@/platform', () => {
  const nodeCrypto = require('crypto');
  return {
    crypto: {
      getRandomBytes: async (byteCount: number): Promise<Uint8Array> =>
        Uint8Array.from(nodeCrypto.randomBytes(byteCount)),
    },
  };
});

// Mock the file-system + expo surface so createBackup can complete in Node.
jest.mock('expo-file-system', () => {
  class Directory {
    get exists() {
      return true;
    }
    async create() {}
  }
  class File {
    uri = 'file:///mock/voi-wallet.voibackup';
    async write() {}
  }
  return { Directory, File, Paths: { cache: 'file:///mock/cache' } };
});
jest.mock('expo-sharing', () => ({
  isAvailableAsync: async () => false,
  shareAsync: async () => {},
}));
jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { version: '9.9.9' } },
}));

// Mock the heavy collectors/restorers so their native dependency graph never
// loads. createBackup calls collectAccounts FIRST (after the policy gate).
jest.mock('../collectors', () => ({
  collectAccounts: jest.fn(async () => []),
  collectSettings: jest.fn(async () => ({
    theme: {
      mode: 'system',
      nftTheme: null,
      nftThemeEnabled: false,
      selectedPaletteIndex: 0,
      backgroundImageEnabled: false,
      overlayIntensity: 0,
    },
    security: { pinTimeout: 5, biometricEnabled: false },
    network: null,
    assetFilters: {
      sortBy: 'name',
      sortOrder: 'asc',
      balanceThreshold: 0,
      valueThreshold: 0,
      nativeTokensFirst: false,
    },
  })),
  collectFriends: jest.fn(async () => []),
  collectExperimental: jest.fn(async () => ({
    swapEnabled: false,
    messagingEnabled: false,
  })),
}));
jest.mock('../restorers', () => ({ performFullRestore: jest.fn() }));

import { BackupService } from '../index';
import * as collectors from '../collectors';

describe('BackupService.createBackup passphrase policy (TASK-30 P2-1)', () => {
  it('rejects a short password before collecting any account data', async () => {
    await expect(BackupService.createBackup('short')).rejects.toMatchObject({
      code: 'WEAK_PASSWORD',
    });
    // Gate runs first: no mnemonic collection happened.
    expect(collectors.collectAccounts).not.toHaveBeenCalled();
  });

  it('rejects a common/predictable password of sufficient length', async () => {
    await expect(
      BackupService.createBackup('password1234')
    ).rejects.toMatchObject({ code: 'WEAK_PASSWORD' });
    expect(collectors.collectAccounts).not.toHaveBeenCalled();
  });

  it('proceeds past the gate and produces a backup for a strong passphrase', async () => {
    const result = await BackupService.createBackup(
      'correct horse battery staple'
    );
    expect(collectors.collectAccounts).toHaveBeenCalled();
    expect(result.filename).toMatch(/\.voibackup$/);
    expect(result.accountCount).toBe(0);
  });
});
