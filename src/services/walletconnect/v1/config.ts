import { WalletConnectV1PeerMeta } from './types';
import { NetworkId } from '@/types/network';
import { ALGORAND_MAINNET_CHAIN_DATA } from '../config';

/**
 * PeraWallet peer metadata for v1 compatibility
 * This allows our wallet to be recognized as PeraWallet by dApps
 */
export const PERA_WALLET_PEER_META: WalletConnectV1PeerMeta = {
  name: 'Pera Wallet',
  description: 'Pera Wallet: Simply the best Algorand wallet',
  url: 'https://perawallet.app',
  icons: [
    'https://algorand-app.s3.amazonaws.com/app-icons/Pera-walletconnect-128.png',
    'https://algorand-app.s3.amazonaws.com/app-icons/Pera-walletconnect-192.png',
    'https://algorand-app.s3.amazonaws.com/app-icons/Pera-walletconnect-512.png',
  ],
};

/**
 * Voi Wallet peer metadata (alternative to PeraWallet spoofing)
 * Use this when we want to identify as Voi Wallet
 */
export const VOI_WALLET_PEER_META: WalletConnectV1PeerMeta = {
  name: 'Voi Wallet',
  description: 'Mobile wallet for Voi Network and Algorand ecosystem',
  url: 'https://getvoi.app',
  icons: [
    'https://getvoi.app/android-chrome-192x192.png',
    'https://getvoi.app/android-chrome-512x512.png',
  ],
};

/**
 * Default peer metadata to use
 * Start with PeraWallet for maximum compatibility
 */
export const DEFAULT_PEER_META = PERA_WALLET_PEER_META;

/**
 * Algorand chain IDs for WalletConnect v1
 * Unlike v2 which uses genesis hash format, v1 uses numeric IDs
 */
export const ALGORAND_CHAIN_IDS = {
  MAINNET: 416001,
  TESTNET: 416002,
  BETANET: 416003,
  // Backward compatibility - some dApps use this legacy ID
  MAINNET_LEGACY: 4160,
} as const;

/**
 * Default chain ID (Algorand mainnet).
 *
 * DR-11: this is Algorand mainnet and ONLY Algorand mainnet. The previous note
 * here claimed Voi "also uses" the same numeric id because it is
 * Algorand-compatible — that is exactly the ambiguity that makes a v1 session
 * impossible to bind securely, so it no longer holds. See `resolveV1Chain`.
 */
export const DEFAULT_CHAIN_ID = ALGORAND_CHAIN_IDS.MAINNET;

/**
 * DR-11 — resolve a WalletConnect **v1** numeric chain id to the CAIP-2 chain
 * and `NetworkId` the wallet will bind signing to.
 *
 * v1 carries a numeric chain id while every other layer of this wallet speaks
 * CAIP-2 (`getNetworkByChainId` only accepts `algorand:<hash>` strings). The
 * numeric space is also ambiguous: `416001` was historically treated as usable
 * for BOTH Algorand and Voi, so a v1 session cannot securely identify a Voi
 * chain at all.
 *
 * The mapping is therefore explicit and fail-closed: `416001` / `4160` mean
 * Algorand mainnet, and everything else — including any v1 request that is
 * really meant for Voi — resolves to `null` and must be rejected. This keeps
 * normal Pera v1 `algo_signTxn` interop working while refusing to guess.
 *
 * ACCEPTED USER-VISIBLE CONSEQUENCE: a live v1 **Voi** session breaks on
 * upgrade and must be reconnected. Silently treating it as Algorand would be
 * the alternative, and that is not an acceptable trade at a signing boundary.
 */
export function resolveV1Chain(
  chainId: number | undefined | null
): { chainId: string; networkId: NetworkId } | null {
  if (
    chainId === ALGORAND_CHAIN_IDS.MAINNET ||
    chainId === ALGORAND_CHAIN_IDS.MAINNET_LEGACY
  ) {
    return {
      chainId: ALGORAND_MAINNET_CHAIN_DATA.chainId,
      networkId: NetworkId.ALGORAND_MAINNET,
    };
  }
  return null;
}

/**
 * WalletConnect v1 protocol version
 */
export const WALLETCONNECT_V1_VERSION = '1';

/**
 * Session storage key
 */
export const WC_V1_SESSION_STORAGE_KEY = '@voiwallet:wc_v1_sessions';

/**
 * WebSocket connection timeout (ms)
 */
export const WS_CONNECTION_TIMEOUT = 10000;

/**
 * WebSocket reconnection settings
 */
export const WS_RECONNECT_DELAY = 1000;
export const WS_MAX_RECONNECT_ATTEMPTS = 5;
