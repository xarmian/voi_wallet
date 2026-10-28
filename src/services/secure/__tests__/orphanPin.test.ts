import { AccountSecureStorage } from '../AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import { reconcileCrossStoreHalfState } from '@/services/wallet/crossStoreReconcile';
import { clearOrphanPin, ORPHAN_PIN_UNVERIFIABLE_MESSAGE } from '../orphanPin';

jest.mock('../AccountSecureStorage', () => ({
  AccountSecureStorage: {
    deletePin: jest.fn(),
    deleteAccount: jest.fn(),
    dropPendingCreateEntries: jest.fn(),
    readAccountListStrict: jest.fn(),
    readPendingCreatesStrict: jest.fn(),
    probeSecretPresenceStrict: jest.fn(),
    clearBiometricSecret: jest.fn(),
    setBiometricEnabled: jest.fn(),
  },
}));
jest.mock('@/services/secure', () =>
  jest.requireMock('../AccountSecureStorage')
);
jest.mock('@/services/wallet', () => ({
  MultiAccountWalletService: {
    hasKeyBearingAccountStrict: jest.fn(),
    getStandardAccountIdsStrict: jest.fn(),
  },
}));

jest.mock('@/services/wallet/crossStoreReconcile', () => ({
  reconcileCrossStoreHalfState: jest.fn(),
}));

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(reconcileCrossStoreHalfState).mockResolvedValue({
    ran: true,
    orphanSecretsDeleted: [],
    phantomAccountsPruned: [],
    staleJournalDropped: [],
  });
  jest
    .mocked(AccountSecureStorage.readAccountListStrict)
    .mockResolvedValue(['listed']);
  jest
    .mocked(AccountSecureStorage.readPendingCreatesStrict)
    .mockResolvedValue({ journaled: 'attempt', listed: 'attempt' });
  jest
    .mocked(AccountSecureStorage.probeSecretPresenceStrict)
    .mockResolvedValue(false);
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest
    .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
    .mockResolvedValue(false);
});
afterEach(() => jest.restoreAllMocks());

it('HEADLINE: a strict secret probe failure must never fail open and delete the PIN', async () => {
  jest
    .mocked(AccountSecureStorage.probeSecretPresenceStrict)
    .mockRejectedValue(new Error('keychain timeout'));
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
  expect(AccountSecureStorage.clearBiometricSecret).not.toHaveBeenCalled();
  expect(AccountSecureStorage.setBiometricEnabled).not.toHaveBeenCalled();
});

it('aborts when reconcile did not run', async () => {
  jest.mocked(reconcileCrossStoreHalfState).mockResolvedValue({
    ran: false,
    orphanSecretsDeleted: [],
    phantomAccountsPruned: [],
    staleJournalDropped: [],
  });
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.readAccountListStrict).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.probeSecretPresenceStrict).not.toHaveBeenCalled();
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
});

it('aborts when reconcile throws', async () => {
  jest
    .mocked(reconcileCrossStoreHalfState)
    .mockRejectedValue(new Error('timeout'));
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.readAccountListStrict).toHaveBeenCalledTimes(1);
  expect(AccountSecureStorage.probeSecretPresenceStrict).not.toHaveBeenCalled();
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
});

it.each(['listed', 'journaled'])(
  'aborts for residual secret in %s',
  async (presentId) => {
    jest
      .mocked(AccountSecureStorage.probeSecretPresenceStrict)
      .mockImplementation(async (id) => id === presentId);
    await expect(clearOrphanPin()).rejects.toThrow(
      ORPHAN_PIN_UNVERIFIABLE_MESSAGE
    );
    expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
    expect(AccountSecureStorage.clearBiometricSecret).not.toHaveBeenCalled();
  }
);

it.each(['readAccountListStrict', 'readPendingCreatesStrict'] as const)(
  'aborts when %s throws',
  async (method) => {
    jest
      .mocked(AccountSecureStorage[method])
      .mockRejectedValue(new Error('timeout'));
    await expect(clearOrphanPin()).rejects.toThrow(
      ORPHAN_PIN_UNVERIFIABLE_MESSAGE
    );
    expect(
      AccountSecureStorage.probeSecretPresenceStrict
    ).not.toHaveBeenCalled();
    expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
  }
);

it.each([undefined, null, 'absent', 0])(
  'rejects unexpected probe verdict %s',
  async (verdict) => {
    jest
      .mocked(AccountSecureStorage.probeSecretPresenceStrict)
      .mockResolvedValue(verdict as never);
    await expect(clearOrphanPin()).rejects.toThrow(
      ORPHAN_PIN_UNVERIFIABLE_MESSAGE
    );
    expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
  }
);

it('reconciles before the strict gate, then deletes the PIN and clears biometrics', async () => {
  await clearOrphanPin();
  const order = (fn: unknown, n = 0) =>
    jest.mocked(fn as jest.Mock).mock.invocationCallOrder[n];
  const calls = [
    order(MultiAccountWalletService.hasKeyBearingAccountStrict),
    order(AccountSecureStorage.readAccountListStrict, 0),
    order(AccountSecureStorage.readPendingCreatesStrict, 0),
    order(reconcileCrossStoreHalfState),
    order(AccountSecureStorage.readAccountListStrict, 1),
    order(AccountSecureStorage.readPendingCreatesStrict, 1),
    order(AccountSecureStorage.probeSecretPresenceStrict),
    order(AccountSecureStorage.deletePin),
    order(AccountSecureStorage.clearBiometricSecret),
    order(AccountSecureStorage.setBiometricEnabled),
  ];
  expect(calls.every((c) => typeof c === 'number')).toBe(true);
  expect(calls).toEqual([...calls].sort((a, b) => a - b));

  expect(AccountSecureStorage.probeSecretPresenceStrict).toHaveBeenCalledTimes(
    2
  );
  expect(
    AccountSecureStorage.probeSecretPresenceStrict
  ).toHaveBeenNthCalledWith(1, 'listed');
  expect(
    AccountSecureStorage.probeSecretPresenceStrict
  ).toHaveBeenNthCalledWith(2, 'journaled');
  expect(AccountSecureStorage.setBiometricEnabled).toHaveBeenCalledWith(false);
});

it('refuses a key-bearing account without deleting or clearing anything', async () => {
  jest
    .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
    .mockResolvedValue(true);
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(reconcileCrossStoreHalfState).not.toHaveBeenCalled();
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
  expect(AccountSecureStorage.clearBiometricSecret).not.toHaveBeenCalled();
  expect(AccountSecureStorage.setBiometricEnabled).not.toHaveBeenCalled();
});

it('aborts on a strict account read failure without deleting the PIN', async () => {
  jest
    .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
    .mockRejectedValue(new Error('private details'));
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
});

it('aborts on deletePin refusal without touching biometrics', async () => {
  jest
    .mocked(AccountSecureStorage.deletePin)
    .mockRejectedValue(new Error('private details'));
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.clearBiometricSecret).not.toHaveBeenCalled();
  expect(AccountSecureStorage.setBiometricEnabled).not.toHaveBeenCalled();
});

it.each(['clear', 'disable', 'both'])(
  'continues after best-effort biometric failure: %s',
  async (failure) => {
    if (failure !== 'disable')
      jest
        .mocked(AccountSecureStorage.clearBiometricSecret)
        .mockRejectedValue(new Error('private details'));
    if (failure !== 'clear')
      jest
        .mocked(AccountSecureStorage.setBiometricEnabled)
        .mockRejectedValue(new Error('private details'));
    await expect(clearOrphanPin()).resolves.toBeUndefined();
    expect(AccountSecureStorage.setBiometricEnabled).toHaveBeenCalledWith(
      false
    );
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('private details')
    );
  }
);

it('drains a journal-only failed import using the real reconcile before removing the PIN', async () => {
  const secretIds = new Set(['orphan']);
  let journal: Record<string, string> = { orphan: 'attempt' };
  jest
    .mocked(MultiAccountWalletService.getStandardAccountIdsStrict)
    .mockResolvedValue([]);
  jest.mocked(AccountSecureStorage.readAccountListStrict).mockResolvedValue([]);
  jest
    .mocked(AccountSecureStorage.readPendingCreatesStrict)
    .mockImplementation(async () => ({ ...journal }));
  jest
    .mocked(AccountSecureStorage.probeSecretPresenceStrict)
    .mockImplementation(async (id) => secretIds.has(id));
  jest
    .mocked(AccountSecureStorage.deleteAccount)
    .mockImplementation(async (id) => {
      secretIds.delete(id);
    });
  jest
    .mocked(AccountSecureStorage.dropPendingCreateEntries)
    .mockImplementation(async () => {
      journal = {};
    });
  jest
    .mocked(reconcileCrossStoreHalfState)
    .mockImplementation(
      jest.requireActual('@/services/wallet/crossStoreReconcile')
        .reconcileCrossStoreHalfState
    );
  jest.mocked(AccountSecureStorage.deletePin).mockImplementation(async () => {
    expect(secretIds.size).toBe(0);
    expect(journal).toEqual({});
  });
  await clearOrphanPin();
  expect(AccountSecureStorage.deleteAccount).toHaveBeenCalledWith('orphan');
  expect(AccountSecureStorage.dropPendingCreateEntries).toHaveBeenCalledWith([
    'orphan',
  ]);
  expect(AccountSecureStorage.deletePin).toHaveBeenCalledTimes(1);
});

it('probes ids indexed only BEFORE reconcile (pre ∪ post second layer)', async () => {
  // Keyed on reconcile having run, not on call count, so dropping the pre
  // snapshot leaves only a post read that returns [] and the test goes red.
  let reconciled = false;
  jest.mocked(reconcileCrossStoreHalfState).mockImplementation(async () => {
    reconciled = true;
    return {
      ran: true,
      orphanSecretsDeleted: [],
      phantomAccountsPruned: [],
      staleJournalDropped: [],
    };
  });
  jest
    .mocked(AccountSecureStorage.readAccountListStrict)
    .mockImplementation(async () => (reconciled ? [] : ['unindexed']));
  jest
    .mocked(AccountSecureStorage.readPendingCreatesStrict)
    .mockResolvedValue({});
  jest
    .mocked(AccountSecureStorage.probeSecretPresenceStrict)
    .mockImplementation(async (id) => id === 'unindexed');
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.probeSecretPresenceStrict).toHaveBeenCalledWith(
    'unindexed'
  );
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
});

// Mocks deleteAccount to TASK-415's contract; the real verified delete is
// covered by verifiedSecretDelete.test.ts.
it("given TASK-415's contract, a failed orphan delete stays indexed: the gate refuses and a retry succeeds", async () => {
  const secretIds = new Set(['orphan']);
  let journal: Record<string, string> = { orphan: 'attempt' };
  let failDelete = true;
  jest
    .mocked(MultiAccountWalletService.getStandardAccountIdsStrict)
    .mockResolvedValue([]);
  jest.mocked(AccountSecureStorage.readAccountListStrict).mockResolvedValue([]);
  jest
    .mocked(AccountSecureStorage.readPendingCreatesStrict)
    .mockImplementation(async () => ({ ...journal }));
  jest
    .mocked(AccountSecureStorage.probeSecretPresenceStrict)
    .mockImplementation(async (id) => secretIds.has(id));
  // TASK-415 contract: a failed secret delete throws before it unindexes.
  jest
    .mocked(AccountSecureStorage.deleteAccount)
    .mockImplementation(async (id) => {
      if (failDelete) throw new Error('keychain delete failed');
      secretIds.delete(id);
    });
  jest
    .mocked(AccountSecureStorage.dropPendingCreateEntries)
    .mockImplementation(async () => {
      journal = {};
    });
  jest
    .mocked(reconcileCrossStoreHalfState)
    .mockImplementation(
      jest.requireActual('@/services/wallet/crossStoreReconcile')
        .reconcileCrossStoreHalfState
    );
  await expect(clearOrphanPin()).rejects.toThrow(
    ORPHAN_PIN_UNVERIFIABLE_MESSAGE
  );
  expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
  expect(journal).toEqual({ orphan: 'attempt' });

  failDelete = false;
  await expect(clearOrphanPin()).resolves.toBeUndefined();
  expect(secretIds.size).toBe(0);
  expect(AccountSecureStorage.deletePin).toHaveBeenCalledTimes(1);
});

it.each(['hasKeyBearingAccountStrict', 'readAccountListStrict'] as const)(
  'fails closed when %s never settles',
  async (method) => {
    jest.useFakeTimers();
    try {
      const never = new Promise<never>(() => {});
      if (method === 'hasKeyBearingAccountStrict') {
        jest
          .mocked(MultiAccountWalletService.hasKeyBearingAccountStrict)
          .mockReturnValue(never);
      } else {
        jest
          .mocked(AccountSecureStorage.readAccountListStrict)
          .mockReturnValue(never);
      }
      const run = clearOrphanPin();
      const settled = expect(run).rejects.toThrow(
        ORPHAN_PIN_UNVERIFIABLE_MESSAGE
      );
      await jest.advanceTimersByTimeAsync(1500);
      await settled;
      expect(AccountSecureStorage.deletePin).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  }
);
