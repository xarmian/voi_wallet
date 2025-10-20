import { WalletConnectV1PeerMeta } from './types';

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
  url: 'https://voiapp.com',
  icons: [
    'https://voiapp.com/icon-192.png',
    'https://voiapp.com/icon-512.png',
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
 * Default chain ID (Algorand mainnet)
 * Voi Network also uses mainnet ID as it's Algorand-compatible
 */
export const DEFAULT_CHAIN_ID = ALGORAND_CHAIN_IDS.MAINNET;

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
