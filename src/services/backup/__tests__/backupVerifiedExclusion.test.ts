/**
 * TASK-45 / DR-11 — `backupVerified` must stay OUT of the backup format.
 *
 * Recovery-phrase verification is a property of the user of THIS device, not of
 * an encrypted payload that can be moved anywhere. If it travelled in the
 * backup, restoring onto a fresh device would inherit "already backed up" for a
 * user who has never seen the phrase, permanently suppressing the Home warning.
 *
 * Also pins the folded-in defect fix: `restorers.ts` read
 * `backupAccount.hasBackup || true`, which is unconditionally truthy, so every
 * restored account was marked backed up regardless of the payload.
 *
 * SECURITY NOTE: every mnemonic below is generated fresh in-process by algosdk.
 * Nothing is committed.
 */

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

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
    getAllKeys: jest.fn(async () => []),
  },
}));

const mockPersistRestoredWallet = jest.fn(async () => {});
const mockGetCurrentWallet = jest.fn();

jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    getCurrentWallet: (...args: unknown[]) => mockGetCurrentWallet(...args),
    persistRestoredWallet: (...args: unknown[]) =>
      mockPersistRestoredWallet(...(args as [])),
  },
}));

jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {
    getResetGeneration: () => 0,
    clearAll: jest.fn(),
    probeSecretPresenceStrict: jest.fn(async () => false),
    storeAccountMetadataForCreation: jest.fn(),
    storeAccountForCreation: jest.fn(async () => 'token'),
    commitPendingCreate: jest.fn(async () => {}),
    deleteAccountIfAttemptMatches: jest.fn(async () => {}),
  },
}));

jest.mock('@/services/secure/keyManager', () => ({
  SecureKeyManager: {
    getMnemonic: jest.fn(async () => mockMnemonicForCollect),
  },
}));

jest.mock('@/services/secure/pinSetupPending', () => ({
  markPinSetupPending: jest.fn(async () => {}),
}));

let mockMnemonicForCollect = '';

import algosdk from 'algosdk';
import { AccountSecureStorage } from '@/services/secure/AccountSecureStorage';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { Buffer } from 'buffer';
import {
  AccountType,
  ResetRacedError,
  StandardAccountMetadata,
} from '@/types/wallet';
import { collectAccounts } from '../collectors';
import { restoreAccounts, performFullRestore } from '../restorers';
import type { BackupAccountData } from '../types';

function freshAccount() {
  const account = algosdk.generateAccount();
  return {
    address: account.addr.toString(),
    publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
    mnemonic: algosdk.secretKeyToMnemonic(account.sk),
  };
}

beforeEach(() => {
  mockStore = {};
  jest.clearAllMocks();
});

describe('collectAccounts — backupVerified is not collected', () => {
  it('omits the field even when the account is verified', async () => {
    const fresh = freshAccount();
    mockMnemonicForCollect = fresh.mnemonic;

    const account: StandardAccountMetadata = {
      id: 'acc-1',
      address: fresh.address,
      publicKey: fresh.publicKey,
      type: AccountType.STANDARD,
      label: 'Main',
      isHidden: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsed: '2026-01-01T00:00:00.000Z',
      mnemonic: '',
      hasBackup: true,
      backupVerified: true,
    };

    mockGetCurrentWallet.mockResolvedValue({
      id: 'w',
      version: '1.0',
      createdAt: '',
      accounts: [account],
      activeAccountId: 'acc-1',
      settings: {},
    });

    const collected = await collectAccounts();

    expect(collected).toHaveLength(1);
    expect(collected[0]).not.toHaveProperty('backupVerified');
    // Legacy field still travels, unchanged.
    expect(collected[0].hasBackup).toBe(true);
    // Sanity: the payload really is the phrase-bearing record.
    expect(collected[0].mnemonic).toBe(fresh.mnemonic);
  });
});

describe('restoreAccounts — backupVerified always resets to false', () => {
  async function restoreOne(
    overrides: Partial<BackupAccountData> = {}
  ): Promise<StandardAccountMetadata> {
    const fresh = freshAccount();
    const payload: BackupAccountData = {
      id: 'acc-1',
      address: fresh.address,
      type: AccountType.STANDARD,
      publicKey: fresh.publicKey,
      createdAt: '2026-01-01T00:00:00.000Z',
      isHidden: false,
      mnemonic: fresh.mnemonic,
      ...overrides,
    };

    await restoreAccounts([payload]);

    expect(mockPersistRestoredWallet).toHaveBeenCalledTimes(1);
    const wallet = (
      mockPersistRestoredWallet.mock.calls[0] as unknown[]
    )[0] as {
      accounts: StandardAccountMetadata[];
    };
    return wallet.accounts[0];
  }

  it('restores as UNVERIFIED for a plain payload', async () => {
    const restored = await restoreOne();
    expect(restored.backupVerified).toBe(false);
  });

  it('ignores a backupVerified field smuggled into the payload', async () => {
    // A hand-edited or hostile backup must not be able to grant verified state.
    const restored = await restoreOne({
      backupVerified: true,
    } as Partial<BackupAccountData>);
    expect(restored.backupVerified).toBe(false);
  });

  it('honours hasBackup: false instead of forcing it true (|| true defect)', async () => {
    const restored = await restoreOne({ hasBackup: false });
    expect(restored.hasBackup).toBe(false);
  });

  it('honours hasBackup: true', async () => {
    const restored = await restoreOne({ hasBackup: true });
    expect(restored.hasBackup).toBe(true);
  });

  it('defaults hasBackup to false for an older payload that omits it', async () => {
    const restored = await restoreOne();
    expect(restored.hasBackup).toBe(false);
  });
});

describe('round trip against an existing (pre-TASK-45) payload shape', () => {
  it('collect -> restore preserves the legacy fields and never revives verification', async () => {
    const fresh = freshAccount();
    mockMnemonicForCollect = fresh.mnemonic;

    mockGetCurrentWallet.mockResolvedValue({
      id: 'w',
      version: '1.0',
      createdAt: '',
      accounts: [
        {
          id: 'acc-1',
          address: fresh.address,
          publicKey: fresh.publicKey,
          type: AccountType.STANDARD,
          label: 'Main',
          color: '#123456',
          isHidden: false,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsed: '2026-01-01T00:00:00.000Z',
          mnemonic: '',
          hasBackup: true,
          backupVerified: true,
        } as StandardAccountMetadata,
      ],
      activeAccountId: 'acc-1',
      settings: {},
    });

    const collected = await collectAccounts();

    // Simulate the wire hop exactly as the encrypted payload does.
    const wire: BackupAccountData[] = JSON.parse(JSON.stringify(collected));
    expect(wire[0]).not.toHaveProperty('backupVerified');

    await restoreAccounts(wire);

    const wallet = (
      mockPersistRestoredWallet.mock.calls[0] as unknown[]
    )[0] as {
      accounts: StandardAccountMetadata[];
    };
    const restored = wallet.accounts[0];

    expect(restored.address).toBe(fresh.address);
    expect(restored.label).toBe('Main');
    expect(restored.color).toBe('#123456');
    expect(restored.hasBackup).toBe(true);
    // The verified state does NOT survive the trip — by design.
    expect(restored.backupVerified).toBe(false);
    // TASK-111: the phrase is never persisted into the metadata blob.
    expect(restored.mnemonic).toBe('');
  });
});

const secure = AccountSecureStorage;
const mnemonicRead = jest.mocked(SecureKeyManager.getMnemonic);
function retained(overrides: object = {}): BackupAccountData {
  const fresh = freshAccount();
  return {
    id: 'retained',
    isHidden: false,
    type: AccountType.REKEYED,
    createdAt: '',
    ...fresh,
    originalOwner: true,
    authAddress: freshAccount().address,
    ...overrides,
  };
}
function exportWallet(record: BackupAccountData) {
  mockGetCurrentWallet.mockResolvedValue({ accounts: [record] });
  mnemonicRead.mockResolvedValue(record.mnemonic!);
}

it('round trips the original retained key, signs as its address, and wipes the write buffer', async () => {
  const record = retained();
  exportWallet(record);
  let stored: Uint8Array | undefined;
  jest
    .mocked(secure.storeAccountForCreation)
    .mockImplementationOnce(async (_meta, key) => {
      stored = new Uint8Array(key);
      return 'token';
    });
  const wire = JSON.parse(JSON.stringify(await collectAccounts()));
  expect(wire[0].mnemonic).toBe(record.mnemonic);
  expect(mnemonicRead).toHaveBeenCalledWith(record.address);
  expect(mnemonicRead).not.toHaveBeenCalledWith(record.authAddress);
  await restoreAccounts(wire);
  const restored = (
    mockPersistRestoredWallet.mock.calls[0] as unknown as [
      { accounts: object[] },
    ]
  )[0].accounts[0];
  expect(restored).toMatchObject({
    address: record.address,
    type: AccountType.REKEYED,
    originalOwner: true,
    backupVerified: false,
  });
  const message = new Uint8Array([1, 2, 3]);
  try {
    expect(
      algosdk.verifyBytes(
        message,
        algosdk.signBytes(message, stored!),
        record.address
      )
    ).toBe(true);
    expect(
      jest
        .mocked(secure.storeAccountForCreation)
        .mock.calls[0][1].every((byte) => byte === 0)
    ).toBe(true);
  } finally {
    stored?.fill(0);
  }
});

it.each([false, true])(
  'keyless/old REKEYED backup restores metadata only (owner %s)',
  async (originalOwner) => {
    const record = retained({ mnemonic: undefined, originalOwner });
    if (!originalOwner) {
      exportWallet(record);
      expect((await collectAccounts())[0].mnemonic).toBeUndefined();
      expect(mnemonicRead).not.toHaveBeenCalled();
    }
    await restoreAccounts([record]);
    expect(secure.storeAccountForCreation).not.toHaveBeenCalled();
    expect(secure.storeAccountMetadataForCreation).toHaveBeenCalledWith(
      expect.objectContaining({ backupVerified: false }),
      0
    );
  }
);

it('probe-present exports its own key even without originalOwner', async () => {
  const record = retained({ originalOwner: false });
  exportWallet(record);
  jest.mocked(secure.probeSecretPresenceStrict).mockResolvedValueOnce(true);
  expect((await collectAccounts())[0].mnemonic).toBe(record.mnemonic);
});

it('probe error aborts export instead of silently omitting the key', async () => {
  exportWallet(retained({ originalOwner: false }));
  jest
    .mocked(secure.probeSecretPresenceStrict)
    .mockRejectedValueOnce(new Error('probe failed'));
  await expect(collectAccounts()).rejects.toThrow(
    'Failed to retrieve retained key'
  );
});

it('getMnemonic error aborts export for an expected key', async () => {
  exportWallet(retained());
  mnemonicRead.mockRejectedValueOnce(new Error('read failed'));
  await expect(collectAccounts()).rejects.toThrow('read failed');
});

it.each(['address', 'publicKey'])(
  'mismatched %s rejects the whole restore before clearing',
  async (field) => {
    const other = freshAccount();
    await expect(
      performFullRestore(
        [retained({ [field]: other[field as 'address' | 'publicKey'] })],
        {} as never,
        [],
        {} as never
      )
    ).rejects.toThrow('does not match');
    expect(secure.clearAll).not.toHaveBeenCalled();
    expect(secure.storeAccountForCreation).not.toHaveBeenCalled();
  }
);

it('mid-restore failure rolls back the earlier journaled key and wipes buffers', async () => {
  // First call succeeds, the second fails.
  jest
    .mocked(secure.storeAccountForCreation)
    .mockReset()
    .mockResolvedValueOnce('owned')
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(
    restoreAccounts([retained(), retained({ id: 'second' })])
  ).rejects.toThrow('disk full');
  expect(secure.deleteAccountIfAttemptMatches).toHaveBeenCalledWith(
    'retained',
    'owned'
  );
  for (const call of jest.mocked(secure.storeAccountForCreation).mock.calls)
    expect(call[1].every((byte) => byte === 0)).toBe(true);
  jest.mocked(secure.storeAccountForCreation).mockResolvedValue('token');
});

it('never rolls back secrets the persisted wallet already references', async () => {
  // The wallet blob is written, then committing the second journal entry fails:
  // deleting either secret would leave a persisted account without its key.
  jest
    .mocked(secure.storeAccountForCreation)
    .mockReset()
    .mockResolvedValueOnce('first-token')
    .mockResolvedValueOnce('second-token');
  jest
    .mocked(secure.commitPendingCreate)
    .mockReset()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('keychain write failed'));
  jest.mocked(secure.deleteAccountIfAttemptMatches).mockClear();
  await expect(
    restoreAccounts([retained(), retained({ id: 'second' })])
  ).rejects.toThrow('keychain write failed');
  expect(mockPersistRestoredWallet).toHaveBeenCalled();
  expect(secure.deleteAccountIfAttemptMatches).not.toHaveBeenCalled();
  jest.mocked(secure.storeAccountForCreation).mockResolvedValue('token');
  jest.mocked(secure.commitPendingCreate).mockResolvedValue(undefined);
});

it('keeps secrets when the persist call fails after its blob write', async () => {
  // storeWallet writes the blob, then clears the wipe tombstone: a failure in
  // that second step rejects the persist call AFTER the wallet references the key.
  jest
    .mocked(secure.storeAccountForCreation)
    .mockReset()
    .mockResolvedValue('owned');
  mockPersistRestoredWallet.mockRejectedValueOnce(
    new Error('tombstone removal failed')
  );
  await expect(restoreAccounts([retained()])).rejects.toThrow(
    'tombstone removal failed'
  );
  expect(secure.deleteAccountIfAttemptMatches).not.toHaveBeenCalled();
  jest.mocked(secure.storeAccountForCreation).mockResolvedValue('token');
});

it('rolls back on a reset race at persist, which storeWallet throws before writing', async () => {
  jest
    .mocked(secure.storeAccountForCreation)
    .mockReset()
    .mockResolvedValue('owned');
  mockPersistRestoredWallet.mockRejectedValueOnce(new ResetRacedError());
  await expect(restoreAccounts([retained()])).rejects.toBeInstanceOf(
    ResetRacedError
  );
  expect(secure.deleteAccountIfAttemptMatches).toHaveBeenCalledWith(
    'retained',
    'owned'
  );
  jest.mocked(secure.storeAccountForCreation).mockResolvedValue('token');
});

it('rejects duplicate account ids before clearing anything', async () => {
  const keyed = retained();
  const { mnemonic: _drop, ...metadataOnly } = retained();
  await expect(
    performFullRestore(
      [keyed, { ...metadataOnly, id: keyed.id }],
      {} as never,
      [],
      {} as never
    )
  ).rejects.toThrow('duplicate account ids');
  expect(secure.clearAll).not.toHaveBeenCalled();
  expect(secure.storeAccountForCreation).not.toHaveBeenCalled();
});

it.each([null, '', 'not a recovery phrase', 42])(
  'rejects an invalid retained phrase (%p) cleanly before clearing',
  async (mnemonic) => {
    await expect(
      performFullRestore([retained({ mnemonic })], {} as never, [], {} as never)
    ).rejects.toThrow('not a valid recovery phrase');
    expect(secure.clearAll).not.toHaveBeenCalled();
  }
);
