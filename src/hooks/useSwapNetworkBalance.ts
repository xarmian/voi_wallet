import { useCallback, useEffect, useState } from 'react';
import { NetworkService } from '@/services/network';
import { NetworkId } from '@/types/network';
import type { AccountBalance } from '@/types/wallet';
import { redactError } from '@/utils/logRedaction';

export interface SwapNetworkBalance {
  balance: AccountBalance | null;
  error: string | null;
  /** Clears the shown balance and error, then fetches again. */
  retry: () => void;
  /** Fetches again, keeping the current balance on screen until it lands. */
  refresh: () => void;
}

/**
 * Balance of `address` on the network the swap is being made on.
 *
 * Always fetched from that network's own NetworkService. The wallet store
 * balance is fetched on the app's CURRENT network, so reading it for a VOI swap
 * while Algorand is the global network offered an Algorand balance (and Max) to
 * a VOI swap. A balance belonging to a previous address or network is dropped
 * the moment either input changes, so it is never shown for the new selection.
 */
export function useSwapNetworkBalance(
  address: string | undefined,
  networkId: NetworkId | undefined
): SwapNetworkBalance {
  const [state, setState] = useState<{
    key: string;
    balance: AccountBalance | null;
    error: string | null;
  } | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const key = address && networkId ? `${networkId}:${address}` : null;

  useEffect(() => {
    if (!address || !networkId || !key) return;
    let isCancelled = false;

    const load = async () => {
      try {
        const balance =
          await NetworkService.getInstance(networkId).getAccountBalance(
            address
          );
        if (!isCancelled) setState({ key, balance, error: null });
      } catch (error) {
        if (!isCancelled) {
          console.error('Error loading network balance:', redactError(error));
          setState({
            key,
            balance: null,
            error:
              error instanceof Error ? error.message : 'Failed to load balance',
          });
        }
      }
    };

    void load();
    return () => {
      isCancelled = true;
    };
  }, [address, networkId, key, reloadToken]);

  const retry = useCallback(() => {
    setState(null);
    setReloadToken((token) => token + 1);
  }, []);

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // Only results for the current (network, address) pair are exposed.
  const current = state && state.key === key ? state : null;
  return {
    balance: current?.balance ?? null,
    error: current?.error ?? null,
    retry,
    refresh,
  };
}
