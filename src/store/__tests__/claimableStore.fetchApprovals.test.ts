// TASK-188: per-account TTL + in-flight guard + commit-time account re-check
// for claimableStore.fetchApprovals.
//
// Mirrors loadAccountBalance.dedup.test.ts, including its `finally`-cleanup
// cases: a failed or superseded fetch must not wedge the in-flight slot.
//
// The two properties that matter together:
//   1. a dedup/TTL guard WITHOUT a commit guard is strictly worse than no
//      guard, because a stale write also refreshes the freshness stamp and
//      thereby suppresses the correct fetch; and
//   2. a partial failure must not be recorded as a success, or a transient
//      error gets pinned for the whole success window.

const mockGetApprovals = jest.fn();
const mockGetMetadata = jest.fn();
const mockBatchBalances = jest.fn();
const mockGetNames = jest.fn();

jest.mock('@/services/mimir', () => ({
  __esModule: true,
  default: {
    getArc200ApprovalsForSpender: (...args: unknown[]) =>
      mockGetApprovals(...args),
    getArc200TokensMetadata: (...args: unknown[]) => mockGetMetadata(...args),
    batchGetArc200Balances: (...args: unknown[]) => mockBatchBalances(...args),
  },
}));

jest.mock('@/services/envoi', () => ({
  __esModule: true,
  default: {
    getInstance: () => ({
      isServiceEnabled: () => true,
      setEnabled: jest.fn(),
      getNames: (...args: unknown[]) => mockGetNames(...args),
    }),
  },
}));

const mockStorageGetItem = jest.fn<Promise<string | null>, [string]>(
  async () => null
);

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (key: string) => mockStorageGetItem(key),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
  },
}));

import { useClaimableStore } from '../claimableStore';

const ACCOUNT_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const ACCOUNT_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER = 'OWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROW';

const SUCCESS_TTL_MS = 60 * 1000;
const ERROR_BACKOFF_MS = 30 * 1000;

const approval = (contractId: number, amount = '100') => ({
  owner: OWNER,
  round: 1,
  amount,
  spender: 'SPENDER',
  timestamp: 1,
  contractId,
  transactionId: 'TX',
});

const approvalsFor = (contractId: number) => ({
  approvals: [approval(contractId)],
  'current-round': 1,
});

// Drain microtasks so an awaited leg advances to its next (still-pending) call.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const okBalances = (contractId: number, balance = '1000') => ({
  balances: new Map([[`${contractId}_${OWNER}`, balance]]),
  failed: new Set<string>(),
});

const failedBalances = (contractId: number) => ({
  balances: new Map<string, string>(),
  failed: new Set([`${contractId}_${OWNER}`]),
});

const resetStore = () => {
  useClaimableStore.setState({
    approvals: [],
    claimableItems: [],
    itemsAccountAddress: null,
    hiddenApprovals: new Set<string>(),
    hiddenApprovalsAccount: null,
    showHiddenApprovals: false,
    isLoading: false,
    isValidating: false,
    lastFetchedAt: {},
    errorBackoffAt: {},
    hasPartialFailure: false,
    currentAccountAddress: null,
    lastError: null,
  });
};

describe('claimableStore.fetchApprovals guards (TASK-188)', () => {
  beforeEach(async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    mockGetApprovals.mockReset();
    mockGetMetadata.mockReset();
    mockBatchBalances.mockReset();
    mockGetNames.mockReset();
    mockStorageGetItem.mockReset();
    mockStorageGetItem.mockResolvedValue(null);

    mockGetMetadata.mockResolvedValue({ tokens: [] });
    mockGetNames.mockResolvedValue(new Map());
    mockBatchBalances.mockResolvedValue(okBalances(1));
    mockGetApprovals.mockResolvedValue(approvalsFor(1));

    // clearCache also drops module-level in-flight entries, so each test
    // starts from a clean dedup slate.
    await useClaimableStore.getState().clearCache();
    resetStore();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('account-switch race', () => {
    it("a fetch for A resolving after a switch to B leaves B's items and stamps untouched", async () => {
      let resolveA!: (value: unknown) => void;
      mockGetApprovals.mockImplementation(async (address: string) => {
        if (address === ACCOUNT_A) {
          return new Promise((resolve) => {
            resolveA = resolve as (value: unknown) => void;
          });
        }
        return approvalsFor(2);
      });
      mockBatchBalances.mockImplementation(
        async (pairs: { contractId: number }[]) =>
          okBalances(pairs[0].contractId)
      );

      const pA = useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await flush();

      // User switches to B while A's approvals request is still in the air.
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_B);

      const afterB = useClaimableStore.getState();
      expect(afterB.itemsAccountAddress).toBe(ACCOUNT_B);
      expect(afterB.claimableItems.map((i) => i.contractId)).toEqual([2]);
      const bStamp = afterB.lastFetchedAt[ACCOUNT_B];
      expect(bStamp).toBeDefined();

      // A now resolves. It must not overwrite B's list…
      resolveA(approvalsFor(1));
      await pA;

      const afterA = useClaimableStore.getState();
      expect(afterA.itemsAccountAddress).toBe(ACCOUNT_B);
      expect(afterA.claimableItems.map((i) => i.contractId)).toEqual([2]);
      // …nor re-stamp B's freshness (which would suppress B's next real fetch)…
      expect(afterA.lastFetchedAt[ACCOUNT_B]).toBe(bStamp);
      // …nor stamp its own, since it never committed.
      expect(afterA.lastFetchedAt[ACCOUNT_A]).toBeUndefined();
    });

    it("clears the previous account's items at the moment of the switch", async () => {
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(useClaimableStore.getState().claimableItems).toHaveLength(1);

      let resolveB!: (value: unknown) => void;
      mockGetApprovals.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveB = resolve as (value: unknown) => void;
          })
      );

      const pB = useClaimableStore.getState().fetchApprovals(ACCOUNT_B);
      await flush();

      // B's fetch has not landed yet — A's claimables must already be gone
      // rather than sitting on screen under B's name.
      expect(useClaimableStore.getState().claimableItems).toEqual([]);
      expect(useClaimableStore.getState().itemsAccountAddress).toBeNull();

      resolveB(approvalsFor(2));
      await pB;
    });

    it('a stale request does not clear the spinner owned by a newer one', async () => {
      let resolveA!: (value: unknown) => void;
      mockGetApprovals.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve as (value: unknown) => void;
          })
      );

      const pA = useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await flush();

      let resolveB!: (value: unknown) => void;
      mockGetApprovals.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve as (value: unknown) => void;
          })
      );
      const pB = useClaimableStore.getState().fetchApprovals(ACCOUNT_B);
      await flush();

      expect(useClaimableStore.getState().isLoading).toBe(true);

      resolveA(approvalsFor(1));
      await pA;

      // B is still loading; A's late arrival must not turn the spinner off.
      expect(useClaimableStore.getState().isLoading).toBe(true);

      resolveB(approvalsFor(2));
      await pB;
      expect(useClaimableStore.getState().isLoading).toBe(false);
    });
  });

  describe('success TTL', () => {
    it('stamps the success TTL and suppresses a second call inside the window', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);
      expect(useClaimableStore.getState().lastFetchedAt[ACCOUNT_A]).toBe(now);
      expect(
        useClaimableStore.getState().errorBackoffAt[ACCOUNT_A]
      ).toBeUndefined();

      (Date.now as jest.Mock).mockReturnValue(now + SUCCESS_TTL_MS - 1);
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);

      (Date.now as jest.Mock).mockReturnValue(now + SUCCESS_TTL_MS + 1);
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    });

    it('force bypasses a live success TTL', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);

      await useClaimableStore
        .getState()
        .fetchApprovals(ACCOUNT_A, { force: true });
      expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    });

    it('is keyed per account: A being fresh never suppresses B', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_B);

      expect(mockGetApprovals).toHaveBeenCalledTimes(2);
      expect(mockGetApprovals).toHaveBeenNthCalledWith(1, ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenNthCalledWith(2, ACCOUNT_B);
    });

    it('refetches when switching back to a still-fresh account, because its items were dropped', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_B);
      // Back to A inside A's TTL: the stamp is fresh, but A's list was cleared
      // by the switch, so honoring the TTL here would render an empty screen.
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);

      expect(mockGetApprovals).toHaveBeenCalledTimes(3);
      expect(useClaimableStore.getState().itemsAccountAddress).toBe(ACCOUNT_A);
      expect(useClaimableStore.getState().claimableItems).toHaveLength(1);
    });
  });

  describe('partial balance failure', () => {
    it('stamps the 30s error-backoff rather than the 60s success TTL', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      mockBatchBalances.mockResolvedValue(failedBalances(1));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);

      const state = useClaimableStore.getState();
      expect(state.lastFetchedAt[ACCOUNT_A]).toBeUndefined();
      expect(state.errorBackoffAt[ACCOUNT_A]).toBe(now);
      expect(state.hasPartialFailure).toBe(true);
    });

    it('a focus inside the backoff does not refetch; the first focus after it does', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      mockBatchBalances.mockResolvedValue(failedBalances(1));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);

      (Date.now as jest.Mock).mockReturnValue(now + ERROR_BACKOFF_MS - 1);
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);

      (Date.now as jest.Mock).mockReturnValue(now + ERROR_BACKOFF_MS + 1);
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(2);

      // …and well inside what would have been the success TTL, proving the
      // partial result was never trusted for 60s.
      expect(now + ERROR_BACKOFF_MS + 1).toBeLessThan(now + SUCCESS_TTL_MS);
    });

    it('renders a failed balance as unknown, not as a zero balance', async () => {
      mockBatchBalances.mockResolvedValue(failedBalances(1));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);

      const [item] = useClaimableStore.getState().claimableItems;
      expect(item.ownerBalanceUnknown).toBe(true);
      expect(item.isClaimable).toBe(false);
    });

    it('a whole-leg balance failure marks every row unknown', async () => {
      mockBatchBalances.mockRejectedValue(new Error('mimir down'));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);

      const state = useClaimableStore.getState();
      expect(state.claimableItems[0].ownerBalanceUnknown).toBe(true);
      expect(state.hasPartialFailure).toBe(true);
      expect(state.lastFetchedAt[ACCOUNT_A]).toBeUndefined();
    });

    it('a real zero balance is still "insufficient", not unknown', async () => {
      mockBatchBalances.mockResolvedValue(okBalances(1, '0'));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);

      const [item] = useClaimableStore.getState().claimableItems;
      expect(item.ownerBalanceUnknown).toBe(false);
      expect(item.isClaimable).toBe(false);
      expect(useClaimableStore.getState().hasPartialFailure).toBe(false);
    });

    it('a later fully successful fetch clears the backoff and the degraded flag', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      mockBatchBalances.mockResolvedValueOnce(failedBalances(1));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(useClaimableStore.getState().hasPartialFailure).toBe(true);

      mockBatchBalances.mockResolvedValue(okBalances(1));
      await useClaimableStore
        .getState()
        .fetchApprovals(ACCOUNT_A, { force: true });

      const state = useClaimableStore.getState();
      expect(state.hasPartialFailure).toBe(false);
      expect(state.lastFetchedAt[ACCOUNT_A]).toBe(now);
      expect(state.errorBackoffAt[ACCOUNT_A]).toBeUndefined();
    });

    it('metadata and Envoi-name failures stay absorbed and do NOT count as partial', async () => {
      mockGetMetadata.mockRejectedValue(new Error('metadata down'));
      mockGetNames.mockRejectedValue(new Error('envoi down'));
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);

      const state = useClaimableStore.getState();
      expect(state.hasPartialFailure).toBe(false);
      expect(state.lastFetchedAt[ACCOUNT_A]).toBe(now);
      expect(state.claimableItems[0].isClaimable).toBe(true);
    });
  });

  describe('in-flight guard', () => {
    it('concurrent non-forced callers share one fetch chain', async () => {
      let resolveApprovals!: (value: unknown) => void;
      mockGetApprovals.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveApprovals = resolve as (value: unknown) => void;
          })
      );

      const p1 = useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      const p2 = useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await flush();

      expect(mockGetApprovals).toHaveBeenCalledTimes(1);

      resolveApprovals(approvalsFor(1));
      await Promise.all([p1, p2]);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);
    });

    it('does NOT join an in-flight request that lost ownership (B -> A -> B)', async () => {
      const resolvers: ((value: unknown) => void)[] = [];
      mockGetApprovals.mockImplementation(
        (address: string) =>
          new Promise((resolve) => {
            resolvers.push(() =>
              (resolve as (v: unknown) => void)(
                approvalsFor(address === ACCOUNT_B ? 2 : 1)
              )
            );
          })
      );

      const pB1 = useClaimableStore.getState().fetchApprovals(ACCOUNT_B);
      await flush();

      const pA = useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await flush();

      // Back to B while B's original request is still pending. It can no
      // longer commit (A superseded it), so joining it would resolve into an
      // empty list and refetch nothing — B must start a fresh request.
      const pB2 = useClaimableStore.getState().fetchApprovals(ACCOUNT_B);
      await flush();

      expect(mockGetApprovals).toHaveBeenCalledTimes(3);

      resolvers.forEach((resolve) => resolve(undefined));
      await Promise.all([pB1, pA, pB2]);

      const state = useClaimableStore.getState();
      expect(state.itemsAccountAddress).toBe(ACCOUNT_B);
      expect(state.claimableItems.map((i) => i.contractId)).toEqual([2]);
    });

    it('a forced refresh during hidden-set hydration does not wipe the hidden set', async () => {
      // Ownership is claimed synchronously but hydration is async. A forced
      // refresh landing inside that window sees no account switch; if it keyed
      // hydration off the switch it would skip loading, supersede the request
      // that was loading, and commit an empty hidden set over the user's
      // hidden tokens.
      const storageResolvers: ((value: string | null) => void)[] = [];
      mockStorageGetItem.mockImplementation(
        () =>
          new Promise((resolve) => {
            storageResolvers.push(resolve as (v: string | null) => void);
          })
      );

      const p1 = useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      await flush();

      const p2 = useClaimableStore
        .getState()
        .fetchApprovals(ACCOUNT_A, { force: true });
      await flush();

      // Both requests read storage: the forced one must NOT have skipped
      // hydration just because ownership was already claimed.
      expect(storageResolvers).toHaveLength(2);

      storageResolvers.forEach((resolve) =>
        resolve(JSON.stringify(['1_HIDDEN']))
      );
      await Promise.all([p1, p2]);

      const state = useClaimableStore.getState();
      expect(state.hiddenApprovalsAccount).toBe(ACCOUNT_A);
      expect([...state.hiddenApprovals]).toEqual(['1_HIDDEN']);
    });

    it('clears the in-flight entry so a later fetch runs again (finally cleanup)', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(1);

      // The entry was removed in `finally`, so a forced refresh is free to
      // start a fresh fetch rather than being wedged on a settled promise.
      await useClaimableStore
        .getState()
        .fetchApprovals(ACCOUNT_A, { force: true });
      expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight entry even when the fetch throws (no wedged future fetches)', async () => {
      mockGetApprovals.mockRejectedValueOnce(new Error('mimir down'));

      // Errors are handled to state, never rejected to callers.
      await expect(
        useClaimableStore.getState().fetchApprovals(ACCOUNT_A)
      ).resolves.toBeUndefined();
      expect(useClaimableStore.getState().lastError).toBe('mimir down');
      expect(useClaimableStore.getState().isLoading).toBe(false);

      mockGetApprovals.mockResolvedValueOnce(approvalsFor(1));
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    });

    it('a hard failure with no data on screen still self-corrects on the next focus', async () => {
      const now = 1_000_000;
      jest.spyOn(Date, 'now').mockReturnValue(now);
      mockGetApprovals.mockRejectedValue(new Error('mimir down'));

      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      // No items were ever committed, so the backoff has nothing to protect
      // and must not suppress the retry — today's behavior, preserved.
      await useClaimableStore.getState().fetchApprovals(ACCOUNT_A);
      expect(mockGetApprovals).toHaveBeenCalledTimes(2);
    });
  });
});
