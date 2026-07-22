// TASK-222 — boot reconcile (Component 3 of the cross-store reset-hardening
// design, DOC-221). These prove the FAIL-CLOSED orchestration: the pass gathers
// every strict read + secret probe first and, on ANY read/probe failure, aborts
// having mutated NOTHING. Only on a fully-known picture does it repair the three
// half-state classes — orphan secret, phantom account, stale journal entry.
//
// The coordinator's own logic is the safety surface, so we mock the two services
// it drives and assert exactly which mutations run (and, crucially, which do NOT).
//
// SECURITY NOTE: no key material anywhere — ids are opaque strings.

jest.mock('@/services/secure', () => ({
  AccountSecureStorage: {
    readAccountListStrict: jest.fn(),
    readPendingCreatesStrict: jest.fn(),
    probeSecretPresenceStrict: jest.fn(),
    deleteAccount: jest.fn(async () => {}),
    dropPendingCreateEntries: jest.fn(async () => {}),
  },
}));

jest.mock('../index', () => ({
  MultiAccountWalletService: {
    getStandardAccountIdsStrict: jest.fn(),
    pruneStandardAccounts: jest.fn(async () => {}),
  },
}));

import { AccountSecureStorage } from '@/services/secure';
import { MultiAccountWalletService } from '../index';
import { reconcileCrossStoreHalfState } from '../crossStoreReconcile';

const secure = AccountSecureStorage as unknown as {
  readAccountListStrict: jest.Mock;
  readPendingCreatesStrict: jest.Mock;
  probeSecretPresenceStrict: jest.Mock;
  deleteAccount: jest.Mock;
  dropPendingCreateEntries: jest.Mock;
};
const wallet = MultiAccountWalletService as unknown as {
  getStandardAccountIdsStrict: jest.Mock;
  pruneStandardAccounts: jest.Mock;
};

/**
 * Configure the mocked stores.
 * @param blob   STANDARD account ids in the wallet blob.
 * @param list   ids in the secure account list (voi_account_list).
 * @param journal pending-creation journal { id: token }.
 * @param secrets set of ids whose secret is PRESENT.
 */
function setup(opts: {
  blob?: string[];
  list?: string[];
  journal?: Record<string, string>;
  secrets?: string[];
}) {
  const secrets = new Set(opts.secrets ?? []);
  secure.readAccountListStrict.mockResolvedValue(opts.list ?? []);
  secure.readPendingCreatesStrict.mockResolvedValue(opts.journal ?? {});
  wallet.getStandardAccountIdsStrict.mockResolvedValue(opts.blob ?? []);
  secure.probeSecretPresenceStrict.mockImplementation(async (id: string) =>
    secrets.has(id)
  );
}

function assertNoMutation() {
  expect(secure.deleteAccount).not.toHaveBeenCalled();
  expect(secure.dropPendingCreateEntries).not.toHaveBeenCalled();
  expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reconcileCrossStoreHalfState — fail-closed abort (delete nothing)', () => {
  it('aborts and mutates nothing when the wallet-blob strict read throws', async () => {
    setup({ list: ['a'], secrets: ['a'] });
    wallet.getStandardAccountIdsStrict.mockRejectedValue(
      new Error('blob read failed')
    );

    await expect(reconcileCrossStoreHalfState()).rejects.toThrow(
      'blob read failed'
    );
    assertNoMutation();
  });

  it('aborts and mutates nothing when the account-list read throws', async () => {
    setup({ blob: ['a'], secrets: ['a'] });
    secure.readAccountListStrict.mockRejectedValue(
      new Error('list read failed')
    );

    await expect(reconcileCrossStoreHalfState()).rejects.toThrow(
      'list read failed'
    );
    assertNoMutation();
  });

  it('aborts and mutates nothing when the journal read throws', async () => {
    setup({ blob: ['a'], secrets: ['a'] });
    secure.readPendingCreatesStrict.mockRejectedValue(
      new Error('journal read failed')
    );

    await expect(reconcileCrossStoreHalfState()).rejects.toThrow(
      'journal read failed'
    );
    assertNoMutation();
  });

  // THE regression: a single probe failure must NOT be read as "secret absent"
  // and mass-delete/prune. It must abort the entire destructive pass.
  it('aborts and mass-deletes NOTHING when any secret probe throws', async () => {
    // Three blob STANDARD accounts; probing the second one fails. If the pass
    // treated the failure (or the other absences) as truth it would prune all.
    setup({ blob: ['a', 'b', 'c'], list: ['a', 'b', 'c'] });
    secure.probeSecretPresenceStrict.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('keychain wedged');
      return false; // a, c would look phantom — must NOT be pruned
    });

    await expect(reconcileCrossStoreHalfState()).rejects.toThrow(
      'keychain wedged'
    );
    assertNoMutation();
  });

  it('aborts when a probe times out (bounded, treated as read failure)', async () => {
    setup({ blob: ['a'], list: ['a'] });
    secure.probeSecretPresenceStrict.mockRejectedValue(
      new Error('secret presence probe timed out after 1500ms')
    );

    await expect(reconcileCrossStoreHalfState()).rejects.toThrow('timed out');
    assertNoMutation();
  });
});

describe('reconcileCrossStoreHalfState — repairs (clean read picture)', () => {
  it('deletes an orphan secret (present, no blob account) and drops its journal entry', async () => {
    // 'orphan' has a secret + a journal entry but no wallet-blob account.
    setup({
      blob: [],
      list: ['orphan'],
      journal: { orphan: 't1' },
      secrets: ['orphan'],
    });

    const result = await reconcileCrossStoreHalfState();

    expect(secure.deleteAccount).toHaveBeenCalledTimes(1);
    expect(secure.deleteAccount).toHaveBeenCalledWith('orphan');
    expect(secure.dropPendingCreateEntries).toHaveBeenCalledWith(['orphan']);
    expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ran: true,
      orphanSecretsDeleted: ['orphan'],
      phantomAccountsPruned: [],
      staleJournalDropped: [],
    });
  });

  it('prunes a phantom account (blob STANDARD, secret strictly absent)', async () => {
    setup({ blob: ['phantom'], list: ['phantom'], secrets: [] });

    const result = await reconcileCrossStoreHalfState();

    expect(wallet.pruneStandardAccounts).toHaveBeenCalledTimes(1);
    expect(wallet.pruneStandardAccounts).toHaveBeenCalledWith(['phantom']);
    expect(secure.deleteAccount).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ran: true,
      phantomAccountsPruned: ['phantom'],
      orphanSecretsDeleted: [],
    });
  });

  it('drops a stale journal entry (no secret, no blob account)', async () => {
    setup({ blob: [], list: [], journal: { stale: 't9' }, secrets: [] });

    const result = await reconcileCrossStoreHalfState();

    expect(secure.dropPendingCreateEntries).toHaveBeenCalledWith(['stale']);
    expect(secure.deleteAccount).not.toHaveBeenCalled();
    expect(wallet.pruneStandardAccounts).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ran: true, staleJournalDropped: ['stale'] });
  });

  it('is a no-op on a fully-consistent picture (blob ⟺ secret)', async () => {
    setup({ blob: ['a', 'b'], list: ['a', 'b'], secrets: ['a', 'b'] });

    const result = await reconcileCrossStoreHalfState();

    assertNoMutation();
    expect(result).toEqual({
      ran: true,
      orphanSecretsDeleted: [],
      phantomAccountsPruned: [],
      staleJournalDropped: [],
    });
  });

  it('does NOT touch an account-list-only ghost (no secret, no blob, no journal)', async () => {
    // An id in the account list with neither secret nor blob account nor journal
    // entry is out of this design's three repair classes — left as-is.
    setup({ blob: [], list: ['ghost'], secrets: [] });

    const result = await reconcileCrossStoreHalfState();

    assertNoMutation();
    expect(result.ran).toBe(true);
  });

  it('handles a mixed picture: orphan + phantom + stale together', async () => {
    setup({
      blob: ['phantom', 'ok'],
      list: ['orphan', 'ok'],
      journal: { orphan: 't1', stale: 't2' },
      secrets: ['orphan', 'ok'],
    });

    const result = await reconcileCrossStoreHalfState();

    // orphan: secret present, not in blob → delete + journal drop
    expect(secure.deleteAccount).toHaveBeenCalledWith('orphan');
    // phantom: blob STANDARD, secret absent → prune
    expect(wallet.pruneStandardAccounts).toHaveBeenCalledWith(['phantom']);
    // stale + orphan journal ids dropped; 'ok' untouched
    const dropped = secure.dropPendingCreateEntries.mock
      .calls[0][0] as string[];
    expect(dropped.sort()).toEqual(['orphan', 'stale']);
    expect(secure.deleteAccount).toHaveBeenCalledTimes(1); // NOT 'ok'
    expect(result).toMatchObject({
      ran: true,
      orphanSecretsDeleted: ['orphan'],
      phantomAccountsPruned: ['phantom'],
      staleJournalDropped: ['stale'],
    });
  });
});

describe('reconcileCrossStoreHalfState — Phase 2 is best-effort (partial failure)', () => {
  // Codex P2: prune runs first; if a later orphan delete throws, the outcome must
  // still report the completed prune so the caller can refresh the (now stale)
  // lock verdict — the reconcile must NOT throw away the result.
  it('preserves a completed phantom prune when a later orphan delete throws', async () => {
    setup({
      blob: ['phantom'],
      list: ['orphan'],
      journal: {},
      secrets: ['orphan'], // orphan has a secret, no blob → orphan-delete
    });
    secure.deleteAccount.mockRejectedValueOnce(
      new Error('keychain delete failed')
    );

    // Does NOT reject — Phase 2 is best-effort.
    const result = await reconcileCrossStoreHalfState();

    expect(wallet.pruneStandardAccounts).toHaveBeenCalledWith(['phantom']);
    expect(result.ran).toBe(true);
    // The prune completed and is reported so the caller refreshes the verdict...
    expect(result.phantomAccountsPruned).toEqual(['phantom']);
    // ...but the failed orphan delete is NOT reported as done.
    expect(result.orphanSecretsDeleted).toEqual([]);
    // Journal drop for the failed orphan did not run (retried next boot).
    expect(secure.dropPendingCreateEntries).not.toHaveBeenCalled();
  });

  it('reports no completed work when the phantom prune itself throws', async () => {
    setup({ blob: ['phantom'], list: [], journal: {}, secrets: [] });
    wallet.pruneStandardAccounts.mockRejectedValueOnce(
      new Error('storeWallet failed')
    );

    const result = await reconcileCrossStoreHalfState();

    expect(result.ran).toBe(true);
    // Prune threw → not recorded → caller does NOT refresh (wallet likely intact).
    expect(result.phantomAccountsPruned).toEqual([]);
  });
});
