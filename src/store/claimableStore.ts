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

interface ClaimableState {
  // State
  approvals: TokenApproval[];
  claimableItems: ClaimableItem[];
  hiddenApprovals: Set<string>; // Set of hidden approval IDs (contractId_owner)
  showHiddenApprovals: boolean;
  isLoading: boolean;
  isValidating: boolean;
  lastFetchedAt: number | null;
  currentAccountAddress: string | null;
  lastError: string | null;

  // Computed getters
  getVisibleClaimableItems: () => ClaimableItem[];
  getHiddenClaimableItems: () => ClaimableItem[];
  getVisibleClaimableCount: () => number;
  getHiddenClaimableCount: () => number;
  getTotalClaimableCount: () => number;

  // Actions
  fetchApprovals: (accountAddress: string) => Promise<void>;
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
    hiddenApprovals: new Set<string>(),
    showHiddenApprovals: false,
    isLoading: false,
    isValidating: false,
    lastFetchedAt: null,
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
     * Fetch approvals from MimirAPI and validate owner balances
     */
    fetchApprovals: async (accountAddress: string) => {
      const { currentAccountAddress } = get();

      // If switching accounts, load hidden approvals from storage
      if (currentAccountAddress !== accountAddress) {
        const hiddenStorageKey = getHiddenStorageKey(accountAddress);
        try {
          const storedHiddenJson =
            await AsyncStorage.getItem(hiddenStorageKey);
          const storedHidden = storedHiddenJson
            ? new Set<string>(JSON.parse(storedHiddenJson))
            : new Set<string>();
          set({
            hiddenApprovals: storedHidden,
            showHiddenApprovals: false,
            currentAccountAddress: accountAddress,
          });
        } catch (error) {
          console.error('Failed to load hidden approvals:', error);
          set({
            hiddenApprovals: new Set<string>(),
            showHiddenApprovals: false,
            currentAccountAddress: accountAddress,
          });
        }
      }

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

        set({ approvals: tokenApprovals });

        // Now fetch token metadata and validate owner balances
        set({ isValidating: true });

        // Get unique contract IDs for metadata fetch
        const contractIds = [
          ...new Set(tokenApprovals.map((a) => a.contractId)),
        ];

        // Fetch token metadata
        let tokenMetadata: Map<
          number,
          { name: string; symbol: string; decimals: number; imageUrl?: string; verified: boolean }
        > = new Map();

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

        // Batch fetch owner balances
        let ownerBalances: Map<string, string> = new Map();
        if (balancePairs.length > 0) {
          try {
            ownerBalances =
              await MimirApiService.batchGetArc200Balances(balancePairs);
          } catch (error) {
            console.error('Failed to fetch owner balances:', error);
          }
        }

        // Resolve Envoi names for owner addresses (Envoi is on Voi mainnet)
        const uniqueOwners = [...new Set(tokenApprovals.map((a) => a.owner))];
        let ownerNames: Map<string, string | null> = new Map();
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
        const claimableItems: ClaimableItem[] = tokenApprovals.map(
          (approval) => {
            const id = `${approval.contractId}_${approval.owner}`;
            const metadata = tokenMetadata.get(approval.contractId);
            const ownerBalanceStr =
              ownerBalances.get(`${approval.contractId}_${approval.owner}`) ||
              '0';
            const approvalAmount = BigInt(approval.amount);
            const ownerBalance = BigInt(ownerBalanceStr);

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
              isClaimable: ownerBalance >= approvalAmount,
              approval,
            };
          }
        );

        set({
          claimableItems,
          isLoading: false,
          isValidating: false,
          lastFetchedAt: Date.now(),
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to fetch approvals';
        console.error('Failed to fetch claimable tokens:', error);
        set({
          lastError: message,
          isLoading: false,
          isValidating: false,
        });
      }
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
        hiddenApprovals: new Set<string>(),
        showHiddenApprovals: false,
        isLoading: false,
        isValidating: false,
        lastFetchedAt: null,
        currentAccountAddress: null,
        lastError: null,
      });

      if (currentAccountAddress) {
        await AsyncStorage.removeItem(
          getHiddenStorageKey(currentAccountAddress)
        );
      }
    },
  }))
);

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
