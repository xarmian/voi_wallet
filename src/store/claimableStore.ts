/**
 * Claimable Tokens Store
 *
 * Zustand store for managing claimable ARC-200 tokens state.
 * Handles fetching approvals, validating owner balances, and persisting hidden items.
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MimirApiService, { Arc200Approval } from '@/services/mimir';
import EnvoiService from '@/services/envoi';
import { ClaimableItem, TokenApproval } from '@/types/claimable';

const HIDDEN_STORAGE_KEY_PREFIX = '@claimable/hidden/';

// Helper to get storage key for hidden items per account
const getHiddenStorageKey = (accountAddress: string) =>
  `${HIDDEN_STORAGE_KEY_PREFIX}${accountAddress}`;

/**
 * TASK-188 freshness windows.
 *
 * A fully successful fetch is trusted for SUCCESS_TTL_MS. Anything less than
 * fully successful (a failed balance leg, or a hard failure of the whole chain)
 * gets the much shorter ERROR_BACKOFF_MS instead: short enough that a transient
 * failure self-corrects on roughly the next screen visit — preserving today's
 * behavior — but long enough that a persistent outage does not turn every
 * screen focus into a fresh fan-out.
 */
const SUCCESS_TTL_MS = 60 * 1000;
const ERROR_BACKOFF_MS = 30 * 1000;

/**
 * In-flight fetches, keyed by account address. Non-forced callers join the
 * pending request instead of issuing a second fan-out; a forced caller
 * (pull-to-refresh, post-claim refresh) deliberately starts its own, mirroring
 * `NetworkService.checkNetworkHealth({ force })` — a user-initiated refresh
 * must not be answered by a response that was already in the air before the
 * gesture (or before the claim it is meant to reflect).
 */
const inFlightFetches = new Map<string, Promise<void>>();

/**
 * Generation guard, same idiom as `walletStore`'s `multiNetworkRequestSeq`.
 * `fetchApprovals` awaits four networked legs; without a re-check before every
 * commit, a fetch for account A resolving after a switch to B overwrites B's
 * claimables *and* stamps a fresh timestamp, which then suppresses the correct
 * fetch. A dedup guard without a commit guard is strictly worse than no guard.
 */
const claimableRequestSeq = new Map<string, number>();

const nextClaimableRequest = (accountAddress: string): number => {
  const next = (claimableRequestSeq.get(accountAddress) ?? 0) + 1;
  claimableRequestSeq.set(accountAddress, next);
  return next;
};

/**
 * Unlike `walletStore`, `ClaimableState` is flat — one set of items, not a
 * per-account record — so being the newest request for this address is not
 * enough. The store must still be *owned* by this address, otherwise a fetch
 * for A that is still the latest A-request would happily overwrite B's list.
 */
const isLatestClaimableRequest = (
  accountAddress: string,
  token: number,
  currentAccountAddress: string | null
): boolean =>
  claimableRequestSeq.get(accountAddress) === token &&
  currentAccountAddress === accountAddress;

interface ClaimableState {
  // State
  approvals: TokenApproval[];
  claimableItems: ClaimableItem[];
  /**
   * Account the currently held `claimableItems` belong to. Rendering is bound
   * to this so a previous account's items are never shown across a switch.
   */
  itemsAccountAddress: string | null;
  hiddenApprovals: Set<string>; // Set of hidden approval IDs (contractId_owner)
  /**
   * Account whose persisted hidden set is currently loaded. Tracked separately
   * from `currentAccountAddress` because ownership is claimed synchronously
   * while hydration is async: a forced refresh landing inside that window would
   * otherwise see "no account switch", skip hydration, and commit an empty
   * hidden set over the user's hidden tokens.
   */
  hiddenApprovalsAccount: string | null;
  showHiddenApprovals: boolean;
  isLoading: boolean;
  isValidating: boolean;
  /** Per-account timestamp of the last FULLY successful fetch (ms). */
  lastFetchedAt: Record<string, number>;
  /** Per-account timestamp of the last partial/failed fetch (ms). */
  errorBackoffAt: Record<string, number>;
  /**
   * True when the last fetch for the current account completed but at least one
   * owner-balance lookup failed, so some rows have an unknown balance.
   */
  hasPartialFailure: boolean;
  currentAccountAddress: string | null;
  lastError: string | null;

  // Computed getters
  getVisibleClaimableItems: () => ClaimableItem[];
  getHiddenClaimableItems: () => ClaimableItem[];
  getVisibleClaimableCount: () => number;
  getHiddenClaimableCount: () => number;
  getTotalClaimableCount: () => number;

  // Actions
  fetchApprovals: (
    accountAddress: string,
    options?: { force?: boolean }
  ) => Promise<void>;
  hideApproval: (approvalId: string) => Promise<void>;
  unhideApproval: (approvalId: string) => Promise<void>;
  toggleShowHidden: () => void;
  clearCache: () => Promise<void>;
  clearError: () => void;
}

export const useClaimableStore = create<ClaimableState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
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

    /**
     * Get visible (non-hidden) claimable items
     */
    getVisibleClaimableItems: () => {
      const { claimableItems, hiddenApprovals } = get();
      return claimableItems.filter((item) => !hiddenApprovals.has(item.id));
    },

    /**
     * Get hidden claimable items
     */
    getHiddenClaimableItems: () => {
      const { claimableItems, hiddenApprovals } = get();
      return claimableItems.filter((item) => hiddenApprovals.has(item.id));
    },

    /**
     * Get count of visible claimable items
     */
    getVisibleClaimableCount: () => {
      const { claimableItems, hiddenApprovals } = get();
      return claimableItems.filter((item) => !hiddenApprovals.has(item.id))
        .length;
    },

    /**
     * Get count of hidden claimable items
     */
    getHiddenClaimableCount: () => {
      const { claimableItems, hiddenApprovals } = get();
      return claimableItems.filter((item) => hiddenApprovals.has(item.id))
        .length;
    },

    /**
     * Get total count of all claimable items
     */
    getTotalClaimableCount: () => {
      return get().claimableItems.length;
    },

    /**
     * Fetch approvals from MimirAPI and validate owner balances.
     *
     * Gated by a per-account TTL and an in-flight guard. Pass
     * `{ force: true }` from user-initiated refreshes (pull-to-refresh,
     * post-claim refresh) to bypass both.
     */
    fetchApprovals: async (
      accountAddress: string,
      options?: { force?: boolean }
    ) => {
      const force = options?.force ?? false;

      if (!force) {
        // Only join a request that still OWNS the store. After B -> A -> B,
        // B's original request is still pending but can no longer commit (the
        // switch to A superseded it), so joining it would resolve into an
        // empty list and issue no refetch at all.
        const inFlight = inFlightFetches.get(accountAddress);
        if (inFlight && get().currentAccountAddress === accountAddress) {
          return inFlight;
        }

        // Freshness only counts while we still hold THIS account's data.
        // Without that condition, switching A -> B -> A inside the window
        // would suppress the refetch and leave the list empty, because the
        // switch away from A dropped A's items.
        const state = get();
        if (state.itemsAccountAddress === accountAddress) {
          const now = Date.now();
          const succeededAt = state.lastFetchedAt[accountAddress];
          if (succeededAt !== undefined && now - succeededAt < SUCCESS_TTL_MS) {
            return;
          }
          const failedAt = state.errorBackoffAt[accountAddress];
          if (failedAt !== undefined && now - failedAt < ERROR_BACKOFF_MS) {
            return;
          }
        }
      }

      const request = runFetchApprovals(accountAddress, set, get).finally(
        () => {
          // Identity check: a forced fetch may have replaced this entry while
          // we were running, and it must not be cleared by our completion.
          if (inFlightFetches.get(accountAddress) === request) {
            inFlightFetches.delete(accountAddress);
          }
        }
      );
      inFlightFetches.set(accountAddress, request);
      return request;
    },

    /**
     * Hide an approval from the claimable list
     */
    hideApproval: async (approvalId: string) => {
      const { hiddenApprovals, currentAccountAddress } = get();
      const newHidden = new Set(hiddenApprovals);
      newHidden.add(approvalId);
      set({ hiddenApprovals: newHidden });

      if (currentAccountAddress) {
        await persistHiddenApprovals(currentAccountAddress, newHidden);
      }
    },

    /**
     * Unhide an approval
     */
    unhideApproval: async (approvalId: string) => {
      const { hiddenApprovals, currentAccountAddress } = get();
      const newHidden = new Set(hiddenApprovals);
      newHidden.delete(approvalId);
      set({ hiddenApprovals: newHidden });

      if (currentAccountAddress) {
        await persistHiddenApprovals(currentAccountAddress, newHidden);
      }
    },

    /**
     * Toggle showing hidden approvals
     */
    toggleShowHidden: () => {
      set({ showHiddenApprovals: !get().showHiddenApprovals });
    },

    /**
     * Clear the error state
     */
    clearError: () => {
      set({ lastError: null });
    },

    /**
     * Clear all cached data
     */
    clearCache: async () => {
      const { currentAccountAddress } = get();
      set({
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

      // Drop the dedup entries too, so the next fetch after a cache clear
      // starts fresh instead of joining a request from the cleared session.
      // Any such request is already blocked from committing by the generation
      // guard (its owning account is now null).
      inFlightFetches.clear();

      if (currentAccountAddress) {
        await AsyncStorage.removeItem(
          getHiddenStorageKey(currentAccountAddress)
        );
      }
    },
  }))
);

type ClaimableSet = (partial: Partial<ClaimableState>) => void;
type ClaimableGet = () => ClaimableState;

/**
 * The actual fetch chain, extracted so `fetchApprovals` reads as pure gating.
 *
 * Every write is preceded by a re-check that this request still owns the store
 * (`isLatest`), not just the entry check the original had.
 */
async function runFetchApprovals(
  accountAddress: string,
  set: ClaimableSet,
  get: ClaimableGet
): Promise<void> {
  const requestToken = nextClaimableRequest(accountAddress);
  const isLatest = () =>
    isLatestClaimableRequest(
      accountAddress,
      requestToken,
      get().currentAccountAddress
    );

  const isAccountSwitch = get().currentAccountAddress !== accountAddress;

  if (isAccountSwitch) {
    // Claim ownership synchronously, before any await, and drop the previous
    // account's list in the same commit — otherwise it stays rendered until
    // this fetch lands, showing one account's claimables under another's name.
    set({
      currentAccountAddress: accountAddress,
      approvals: [],
      claimableItems: [],
      itemsAccountAddress: null,
      hiddenApprovals: new Set<string>(),
      hiddenApprovalsAccount: null,
      showHiddenApprovals: false,
      hasPartialFailure: false,
      lastError: null,
    });
  }

  // Hydrate the persisted hidden set whenever it is not already loaded for
  // this account. Keyed on `hiddenApprovalsAccount`, NOT on `isAccountSwitch`:
  // ownership is claimed synchronously above but hydration is async, so a
  // forced refresh arriving inside that window sees no switch and would
  // otherwise skip hydration, supersede the request that was loading, and
  // commit an empty hidden set over the user's hidden tokens.
  if (get().hiddenApprovalsAccount !== accountAddress) {
    const hiddenStorageKey = getHiddenStorageKey(accountAddress);
    try {
      const storedHiddenJson = await AsyncStorage.getItem(hiddenStorageKey);
      const storedHidden = storedHiddenJson
        ? new Set<string>(JSON.parse(storedHiddenJson))
        : new Set<string>();
      if (!isLatest()) return;
      set({
        hiddenApprovals: storedHidden,
        hiddenApprovalsAccount: accountAddress,
        showHiddenApprovals: false,
      });
    } catch (error) {
      console.error('Failed to load hidden approvals:', error);
      if (!isLatest()) return;
      set({
        hiddenApprovals: new Set<string>(),
        hiddenApprovalsAccount: accountAddress,
        showHiddenApprovals: false,
      });
    }
  }

  if (!isLatest()) return;
  set({ isLoading: true, lastError: null });

  try {
    // Fetch approvals where user is the spender
    const response =
      await MimirApiService.getArc200ApprovalsForSpender(accountAddress);

    // Filter out zero-amount approvals
    const nonZeroApprovals = response.approvals.filter(
      (approval) => approval.amount !== '0'
    );

    // Convert to TokenApproval type
    const tokenApprovals: TokenApproval[] = nonZeroApprovals.map(
      (approval: Arc200Approval) => ({
        owner: approval.owner,
        round: approval.round,
        amount: approval.amount,
        spender: approval.spender,
        timestamp: approval.timestamp,
        contractId: approval.contractId,
        transactionId: approval.transactionId,
      })
    );

    if (!isLatest()) return;
    set({ approvals: tokenApprovals, isValidating: true });

    // Get unique contract IDs for metadata fetch
    const contractIds = [...new Set(tokenApprovals.map((a) => a.contractId))];

    // Fetch token metadata. Metadata failures stay absorbed: they degrade
    // display (name/symbol/decimals fall back), not correctness, so they do
    // NOT count as a partial failure.
    const tokenMetadata = new Map<
      number,
      {
        name: string;
        symbol: string;
        decimals: number;
        imageUrl?: string;
        verified: boolean;
      }
    >();

    if (contractIds.length > 0) {
      try {
        const metadataResponse =
          await MimirApiService.getArc200TokensMetadata(contractIds);
        for (const token of metadataResponse.tokens) {
          tokenMetadata.set(token.contractId, {
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            imageUrl: token.imageUrl || undefined,
            verified: token.verified === 1,
          });
        }
      } catch (error) {
        console.error('Failed to fetch token metadata:', error);
      }
    }

    // Build owner/contract pairs for balance validation
    const balancePairs = tokenApprovals.map((approval) => ({
      owner: approval.owner,
      contractId: approval.contractId,
    }));

    // Batch fetch owner balances. This is the leg that decides claimability,
    // so it is the only one whose failures are surfaced.
    let ownerBalances = new Map<string, string>();
    const failedBalanceIds = new Set<string>();
    if (balancePairs.length > 0) {
      try {
        const result =
          await MimirApiService.batchGetArc200Balances(balancePairs);
        ownerBalances = result.balances;
        for (const id of result.failed) {
          failedBalanceIds.add(id);
        }
      } catch (error) {
        console.error('Failed to fetch owner balances:', error);
        // The whole leg failed: every balance is unknown, none is zero.
        for (const pair of balancePairs) {
          failedBalanceIds.add(`${pair.contractId}_${pair.owner}`);
        }
      }
    }

    // Resolve Envoi names for owner addresses (Envoi is on Voi mainnet).
    // Like metadata, name failures are display-only and stay absorbed.
    const uniqueOwners = [...new Set(tokenApprovals.map((a) => a.owner))];
    const ownerNames = new Map<string, string | null>();
    if (uniqueOwners.length > 0) {
      try {
        const envoiService = EnvoiService.getInstance();
        // Claimable tokens are always on Voi, so temporarily enable Envoi
        const wasEnabled = envoiService.isServiceEnabled();
        if (!wasEnabled) {
          envoiService.setEnabled(true);
        }
        const nameResults = await envoiService.getNames(uniqueOwners);
        // Restore previous state
        if (!wasEnabled) {
          envoiService.setEnabled(false);
        }
        for (const [address, nameInfo] of nameResults) {
          ownerNames.set(address, nameInfo?.name || null);
        }
      } catch (error) {
        console.error('Failed to fetch owner Envoi names:', error);
      }
    }

    // Build claimable items
    const claimableItems: ClaimableItem[] = tokenApprovals.map((approval) => {
      const id = `${approval.contractId}_${approval.owner}`;
      const metadata = tokenMetadata.get(approval.contractId);
      const rawBalance = ownerBalances.get(id);
      // Absent implies failed under the batch contract; the explicit `failed`
      // check keeps that from being an inference.
      const ownerBalanceUnknown =
        failedBalanceIds.has(id) || rawBalance === undefined;
      const approvalAmount = BigInt(approval.amount);
      const ownerBalance =
        ownerBalanceUnknown || rawBalance === undefined
          ? 0n
          : BigInt(rawBalance);

      return {
        id,
        contractId: approval.contractId,
        tokenName: metadata?.name || `Token ${approval.contractId}`,
        tokenSymbol: metadata?.symbol || 'TOKEN',
        tokenDecimals: metadata?.decimals || 0,
        tokenImageUrl: metadata?.imageUrl,
        tokenVerified: metadata?.verified || false,
        owner: approval.owner,
        ownerEnvoiName: ownerNames.get(approval.owner) || undefined,
        amount: approvalAmount,
        ownerBalance,
        ownerBalanceUnknown,
        // An unknown balance is not evidence of a claimable token, so the row
        // stays un-actionable — but it renders as "unknown", not "Insufficient".
        isClaimable: !ownerBalanceUnknown && ownerBalance >= approvalAmount,
        approval,
      };
    });

    const hasPartialFailure = failedBalanceIds.size > 0;

    if (!isLatest()) return;
    const now = Date.now();
    const state = get();
    set({
      claimableItems,
      itemsAccountAddress: accountAddress,
      hasPartialFailure,
      isLoading: false,
      isValidating: false,
      // Only a fully successful fetch earns the long TTL. A partial one is
      // trusted just long enough to avoid re-fanning-out on every focus.
      lastFetchedAt: hasPartialFailure
        ? omitAccount(state.lastFetchedAt, accountAddress)
        : { ...state.lastFetchedAt, [accountAddress]: now },
      errorBackoffAt: hasPartialFailure
        ? { ...state.errorBackoffAt, [accountAddress]: now }
        : omitAccount(state.errorBackoffAt, accountAddress),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to fetch approvals';
    console.error('Failed to fetch claimable tokens:', error);
    // A superseded request must not replace a newer result with an error, nor
    // clear a spinner it no longer owns.
    if (!isLatest()) return;
    const state = get();
    set({
      lastError: message,
      isLoading: false,
      isValidating: false,
      lastFetchedAt: omitAccount(state.lastFetchedAt, accountAddress),
      errorBackoffAt: { ...state.errorBackoffAt, [accountAddress]: Date.now() },
    });
  }
}

/**
 * Return a copy of `stamps` without `accountAddress`, so a stale success stamp
 * can never outlive the failure that superseded it.
 */
function omitAccount(
  stamps: Record<string, number>,
  accountAddress: string
): Record<string, number> {
  if (!(accountAddress in stamps)) return stamps;
  const next = { ...stamps };
  delete next[accountAddress];
  return next;
}

/**
 * Persist hidden approvals to AsyncStorage for a specific account
 */
async function persistHiddenApprovals(
  accountAddress: string,
  hiddenApprovals: Set<string>
): Promise<void> {
  try {
    const storageKey = getHiddenStorageKey(accountAddress);
    await AsyncStorage.setItem(
      storageKey,
      JSON.stringify([...hiddenApprovals])
    );
  } catch (error) {
    console.error('Failed to persist hidden approvals:', error);
  }
}

// ============================================================================
// Hooks for reactive state access
// ============================================================================

/**
 * Hook to get visible claimable items (reactive)
 */
export function useVisibleClaimableItems(): ClaimableItem[] {
  const claimableItems = useClaimableStore((state) => state.claimableItems);
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  return claimableItems.filter((item) => !hiddenApprovals.has(item.id));
}

/**
 * Hook to get hidden claimable items (reactive)
 */
export function useHiddenClaimableItems(): ClaimableItem[] {
  const claimableItems = useClaimableStore((state) => state.claimableItems);
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  return claimableItems.filter((item) => hiddenApprovals.has(item.id));
}

/**
 * Hook to get visible claimable count (reactive)
 */
export function useVisibleClaimableCount(): number {
  const claimableItems = useClaimableStore((state) => state.claimableItems);
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  return claimableItems.filter((item) => !hiddenApprovals.has(item.id)).length;
}

/**
 * Hook to get hidden claimable count (reactive)
 */
export function useHiddenClaimableCount(): number {
  const claimableItems = useClaimableStore((state) => state.claimableItems);
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  return claimableItems.filter((item) => hiddenApprovals.has(item.id)).length;
}

/**
 * Hook to get total claimable count (reactive)
 */
export function useTotalClaimableCount(): number {
  return useClaimableStore((state) => state.claimableItems.length);
}

/**
 * Hook to check if a specific approval is hidden (reactive)
 */
export function useIsApprovalHidden(approvalId: string): boolean {
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  return hiddenApprovals.has(approvalId);
}

/**
 * Hook to get showHiddenApprovals state (reactive)
 */
export function useShowHiddenApprovals(): boolean {
  return useClaimableStore((state) => state.showHiddenApprovals);
}

/**
 * Hook to get loading state (reactive)
 */
export function useClaimableLoading(): boolean {
  return useClaimableStore((state) => state.isLoading);
}

/**
 * Hook to get validating state (reactive)
 */
export function useClaimableValidating(): boolean {
  return useClaimableStore((state) => state.isValidating);
}

/**
 * Hook to get last error (reactive)
 */
export function useClaimableError(): string | null {
  return useClaimableStore((state) => state.lastError);
}

/**
 * Hook to get all claimable items (both visible and hidden) (reactive)
 */
export function useAllClaimableItems(): ClaimableItem[] {
  return useClaimableStore((state) => state.claimableItems);
}

// Stable identity so an account-bound miss doesn't re-render consumers.
const NO_CLAIMABLE_ITEMS: ClaimableItem[] = [];

/**
 * Hook to get all claimable items for a specific account (reactive).
 *
 * Returns an empty list unless the items currently held belong to
 * `accountAddress`. The store already clears the previous account's items on a
 * switch and guards every commit, but binding the render to account identity
 * makes "another account's claimables are on screen" unrepresentable rather
 * than merely unlikely.
 */
export function useClaimableItemsForAccount(
  accountAddress: string | null | undefined
): ClaimableItem[] {
  const claimableItems = useClaimableStore((state) => state.claimableItems);
  const itemsAccountAddress = useClaimableStore(
    (state) => state.itemsAccountAddress
  );
  if (!accountAddress || itemsAccountAddress !== accountAddress) {
    return NO_CLAIMABLE_ITEMS;
  }
  return claimableItems;
}

/**
 * Hook to get the visible (non-hidden) claimable count for a specific account
 * (reactive). Returns 0 unless the held items belong to `accountAddress`, so a
 * badge or banner never reports one account's total under another's name.
 */
export function useVisibleClaimableCountForAccount(
  accountAddress: string | null | undefined
): number {
  const claimableItems = useClaimableItemsForAccount(accountAddress);
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  return claimableItems.filter((item) => !hiddenApprovals.has(item.id)).length;
}

/**
 * Hook to check whether the last fetch for `accountAddress` completed with
 * unresolved owner balances, i.e. some of its rows are showing an unknown
 * claim status (reactive).
 *
 * Account-bound for the same reason the item hooks are: the flag is reset when
 * a switch commits, but between the active account changing and that commit
 * landing there is a render where account A's degraded banner would sit above
 * account B's (empty) list.
 */
export function useClaimablePartialFailure(
  accountAddress: string | null | undefined
): boolean {
  const hasPartialFailure = useClaimableStore(
    (state) => state.hasPartialFailure
  );
  const itemsAccountAddress = useClaimableStore(
    (state) => state.itemsAccountAddress
  );
  return (
    hasPartialFailure &&
    !!accountAddress &&
    itemsAccountAddress === accountAddress
  );
}

/**
 * Hook to get items to display based on showHiddenApprovals toggle (reactive)
 */
export function useDisplayedClaimableItems(): ClaimableItem[] {
  const claimableItems = useClaimableStore((state) => state.claimableItems);
  const hiddenApprovals = useClaimableStore((state) => state.hiddenApprovals);
  const showHidden = useClaimableStore((state) => state.showHiddenApprovals);

  if (showHidden) {
    return claimableItems;
  }
  return claimableItems.filter((item) => !hiddenApprovals.has(item.id));
}
