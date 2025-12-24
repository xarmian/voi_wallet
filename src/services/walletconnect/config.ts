import Constants from 'expo-constants';
import { WalletConnectConfig, WalletConnectChainData } from './types';

const resolveWalletConnectProjectId = (): string => {
  const fromEnv =
    process.env.EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID ||
    process.env.WALLETCONNECT_PROJECT_ID;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }

  const extra =
    (Constants?.expoConfig?.extra ??
      (Constants as any)?.manifest2?.extra ??
      Constants?.manifest?.extra ??
      {}) as Record<string, unknown>;

  const fromExtra = extra['walletConnectProjectId'];
  if (typeof fromExtra === 'string' && fromExtra.trim().length > 0) {
    return fromExtra.trim();
  }

  throw new Error(
    'WalletConnect project ID is not configured. Set EXPO_PUBLIC_WALLETCONNECT_PROJECT_ID (recommended) or WALLETCONNECT_PROJECT_ID, or provide extra.walletConnectProjectId in app config.'
  );
};

export const WALLET_CONNECT_PROJECT_ID = resolveWalletConnectProjectId();

export const VOI_CHAIN_DATA: WalletConnectChainData = {
  chainId: 'algorand:r20fSQI8gWe_kFZziNonSPCXLwcQmH_n',
  name: 'Voi Network',
  logo: 'https://voi.network/voi-logo.svg',
  rgb: '0, 122, 255',
  rpc: 'https://mainnet-api.voi.nodely.dev',
  namespace: 'algorand',
};

export const ALGORAND_MAINNET_CHAIN_DATA: WalletConnectChainData = {
  chainId: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
  name: 'Algorand Mainnet',
  logo: 'https://algorand.co/hubfs/Website-2024/Typography/algorand-logo-dark.svg',
  rgb: '0, 0, 0',
  rpc: 'https://mainnet-api.4160.nodely.dev',
  namespace: 'algorand',
};

export const WALLET_METADATA = {
  name: 'Voi Wallet',
  description: 'Mobile wallet for Voi Network and Algorand ecosystem',
  url: 'https://getvoi.app',
  icons: ['https://getvoi.app/android-chrome-192x192.png', 'https://getvoi.app/android-chrome-512x512.png'],
};

export const ALGORAND_METHODS = [
  'algo_accounts',
  'algo_signTxn',
  'algo_signAndPostTxn',
  'algo_signData',
];

export const ALGORAND_EVENTS = ['accountsChanged', 'chainChanged'];

export const WALLETCONNECT_CONFIG: WalletConnectConfig = {
  projectId: WALLET_CONNECT_PROJECT_ID,
  metadata: WALLET_METADATA,
  chains: [VOI_CHAIN_DATA, ALGORAND_MAINNET_CHAIN_DATA],
};

export const DEFAULT_NAMESPACES = {
  algorand: {
    methods: ALGORAND_METHODS,
    events: ALGORAND_EVENTS,
    accounts: [],
    chains: [VOI_CHAIN_DATA.chainId, ALGORAND_MAINNET_CHAIN_DATA.chainId],
  },
};
