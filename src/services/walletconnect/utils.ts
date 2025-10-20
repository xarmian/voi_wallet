import { Buffer } from 'buffer';
import { isValidAddress } from 'algosdk';
import {
  WalletTransaction,
  WalletConnectSession,
  SessionProposal,
} from './types';
import {
  AccountType,
  AccountMetadata,
  RekeyedAccountMetadata,
} from '@/types/wallet';
import { NetworkId } from '@/types/network';
import { VOI_CHAIN_DATA, ALGORAND_MAINNET_CHAIN_DATA } from './config';

const GENESIS_HASH_NETWORK_MAP: Record<
  string,
  {
    chainId: string;
    networkId: NetworkId;
  }
> = {
  af6d1f49023c8167bf90567388da2748f0972f0710987fe7c513af9e7b9e58e9: {
    chainId: VOI_CHAIN_DATA.chainId,
    networkId: NetworkId.VOI_MAINNET,
  },
  c061c4d8fc1dbdded2d7604be4568e3f6d041987ac37bde4b620b5ab39248adf: {
    chainId: ALGORAND_MAINNET_CHAIN_DATA.chainId,
    networkId: NetworkId.ALGORAND_MAINNET,
  },
};

export function parseWalletConnectUri(uri: string): {
  topic?: string;
  version?: string;
  params?: Record<string, string>;
} {
  try {
    // WalletConnect v2 URI format: wc:{topic}@{version}?{params}
    if (!uri.startsWith('wc:')) {
      throw new Error('Invalid WalletConnect URI: must start with wc:');
    }

    const withoutProtocol = uri.substring(3);
    const [topicAndVersion, paramsString] = withoutProtocol.split('?');
    const [topic, version] = topicAndVersion.split('@');

    const params: Record<string, string> = {};
    if (paramsString) {
      const searchParams = new URLSearchParams(paramsString);
      for (const [key, value] of searchParams.entries()) {
        params[key] = value;
      }
    }

    return { topic, version, params };
  } catch (error) {
    return {};
  }
}

export function isWalletConnectUri(uri: string): boolean {
  return uri.startsWith('wc:');
}

/**
 * Detect WalletConnect protocol version from URI
 * @returns 1 for v1, 2 for v2, null if invalid
 *
 * v1 format: wc:<topic>@1?bridge=https://...&key=...
 * v2 format: wc:<topic>@2?relay-protocol=irn&symKey=...
 */
export function detectWalletConnectVersion(uri: string): 1 | 2 | null {
  if (!isWalletConnectUri(uri)) return null;

  try {
    const parsed = parseWalletConnectUri(uri);
    const version = parsed.version;

    if (version === '1') return 1;
    if (version === '2') return 2;

    // Fallback: detect by params
    if (parsed.params?.bridge && parsed.params?.key) return 1;
    if (parsed.params?.['relay-protocol'] || parsed.params?.symKey) return 2;

    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Check if URI is a WalletConnect v1 URI
 */
export function isWalletConnectV1Uri(uri: string): boolean {
  return detectWalletConnectVersion(uri) === 1;
}

/**
 * Check if URI is a WalletConnect v2 URI
 */
export function isWalletConnectV2Uri(uri: string): boolean {
  return detectWalletConnectVersion(uri) === 2;
}

/**
 * Detect WalletConnect pairing URIs vs request URIs
 *
 * Pairing URI example (v2):
 *   wc:{topic}@2?relay-protocol=irn&symKey=...
 * Request URI example (v2 mobile):
 *   wc:{requestTopic}@2/wc?requestId=...&sessionTopic=...
 */
export function isWalletConnectPairingUri(uri: string): boolean {
  if (!isWalletConnectUri(uri)) return false;
  // Pairing URIs contain query with relay-protocol and no "/wc" path segment
  const hasRelay = /[?&]relay-protocol=/i.test(uri);
  const hasPath = /@\d+\/wc\?/i.test(uri);
  return hasRelay && !hasPath;
}

export function isWalletConnectRequestUri(uri: string): boolean {
  if (!isWalletConnectUri(uri)) return false;
  // Request URIs include the /wc path and requestId/sessionTopic params
  if (!/@\d+\/wc\?/i.test(uri)) return false;
  const qs = uri.split('?')[1] || '';
  const params = new URLSearchParams(qs);
  return params.has('requestId') && params.has('sessionTopic');
}

export function parseWalletConnectRequestUri(
  uri: string
): { requestId?: number; sessionTopic?: string } {
  try {
    const qs = uri.split('?')[1] || '';
    const params = new URLSearchParams(qs);
    const requestIdStr = params.get('requestId') || undefined;
    const sessionTopic = params.get('sessionTopic') || undefined;
    const requestId = requestIdStr ? Number(requestIdStr) : undefined;
    return { requestId, sessionTopic };
  } catch (e) {
    return {};
  }
}

/**
 * Parse WalletConnect v1 URI into its components
 * @param uri - WalletConnect v1 URI (e.g., wc:460d3411...@1?bridge=https://...&key=...&algorand=true)
 * @returns Parsed v1 URI components or null if invalid
 *
 * Example URI:
 * wc:460d3411-9391-4521-9eb1-e7bb370e22e2@1
 *   ?bridge=https%3A%2F%2Fwallet-connect-f.perawallet.app
 *   &key=956eaf3dd8ddf8472f81f9aa9745c2c242d4b1cb0e356014bc65b99cf9c4b475
 *   &algorand=true
 */
export interface WalletConnectV1URI {
  topic: string;
  version: string;
  bridge: string;
  key: string;
  algorand?: boolean;
}

export function parseWalletConnectV1Uri(
  uri: string
): WalletConnectV1URI | null {
  try {
    if (!isWalletConnectV1Uri(uri)) {
      return null;
    }

    const parsed = parseWalletConnectUri(uri);
    if (!parsed.topic || !parsed.version || !parsed.params) {
      return null;
    }

    const bridge = parsed.params.bridge;
    const key = parsed.params.key;

    if (!bridge || !key) {
      return null;
    }

    return {
      topic: parsed.topic,
      version: parsed.version,
      bridge: decodeURIComponent(bridge),
      key,
      algorand: parsed.params.algorand === 'true',
    };
  } catch (error) {
    console.error('Failed to parse WalletConnect v1 URI:', error);
    return null;
  }
}

export function isVoiUri(uri: string): boolean {
  return uri.startsWith('voi:');
}

export function validateAlgorandTransaction(txn: WalletTransaction): boolean {
  try {
    // Basic validation - check if transaction string is base64 encoded
    if (!txn.txn || typeof txn.txn !== 'string') {
      return false;
    }

    // Try to decode base64
    const decoded = Buffer.from(txn.txn, 'base64');
    if (decoded.length === 0) {
      return false;
    }

    // Validate signers if provided
    if (txn.signers && Array.isArray(txn.signers)) {
      for (const signer of txn.signers) {
        if (signer && !isValidAddress(signer)) {
          return false;
        }
      }
    }

    // Validate authAddr if provided
    if (txn.authAddr && !isValidAddress(txn.authAddr)) {
      return false;
    }

    return true;
  } catch (error) {
    return false;
  }
}

export function getSignableAccounts(
  accounts: AccountMetadata[]
): AccountMetadata[] {
  return accounts.filter((account) => {
    switch (account.type) {
      case AccountType.STANDARD:
        return true;
      case AccountType.LEDGER:
        return true;
      case AccountType.REKEYED:
        // Can sign if we have the signing authority
        const rekeyedAccount = account as RekeyedAccountMetadata;
        return rekeyedAccount.canSign === true;
      case AccountType.WATCH:
        return false;
      default:
        return false;
    }
  });
}

/**
 * Get signing information for a WalletConnect transaction
 * Returns the actual address that will sign and whether signing is possible
 */
export function getTransactionSigningInfo(
  transaction: WalletTransaction,
  accounts: AccountMetadata[]
): {
  canSign: boolean;
  signingAddress?: string;
  accountInfo?: AccountMetadata;
  isRekeyed: boolean;
} {
  // First, extract the sender address from the transaction
  let senderAddress: string;

  try {
    // Decode the transaction to get sender
    const txnBytes = Buffer.from(transaction.txn, 'base64');
    // This is a simplified extraction - in practice you'd use algosdk to decode
    // For now, assume the sender is provided via authAddr or signers
    senderAddress = transaction.authAddr || transaction.signers?.[0] || '';
  } catch (error) {
    return { canSign: false, isRekeyed: false };
  }

  if (!senderAddress || !isValidAddress(senderAddress)) {
    return { canSign: false, isRekeyed: false };
  }

  // Find the account
  const account = accounts.find((acc) => acc.address === senderAddress);
  if (!account) {
    return { canSign: false, isRekeyed: false };
  }

  switch (account.type) {
    case AccountType.STANDARD:
      return {
        canSign: true,
        signingAddress: account.address,
        accountInfo: account,
        isRekeyed: false,
      };

    case AccountType.REKEYED:
      const rekeyedAccount = account as RekeyedAccountMetadata;
      return {
        canSign: rekeyedAccount.canSign,
        signingAddress: rekeyedAccount.canSign
          ? rekeyedAccount.authAddress
          : undefined,
        accountInfo: account,
        isRekeyed: true,
      };

    case AccountType.WATCH:
      return {
        canSign: false,
        accountInfo: account,
        isRekeyed: false,
      };

    default:
      return { canSign: false, isRekeyed: false };
  }
}

/**
 * Validate if a WalletConnect transaction can be signed with available accounts
 */
export function canSignWalletConnectTransaction(
  transaction: WalletTransaction,
  accounts: AccountMetadata[]
): boolean {
  const signingInfo = getTransactionSigningInfo(transaction, accounts);
  return signingInfo.canSign;
}

export function formatChainId(genesisHash: string): string {
  // Algorand chain ID format: algorand:{genesisHash}
  return `algorand:${genesisHash}`;
}

export function extractGenesisHash(chainId: string): string | null {
  if (!chainId.startsWith('algorand:')) {
    return null;
  }
  return chainId.substring(9);
}

export function formatAccountAddress(chainId: string, address: string): string {
  return `${chainId}:${address}`;
}

export function parseAccountAddress(
  formattedAddress: string
): { chainId: string; address: string } | null {
  const parts = formattedAddress.split(':');
  if (parts.length !== 3) {
    return null;
  }
  return {
    chainId: `${parts[0]}:${parts[1]}`,
    address: parts[2],
  };
}

export function isSessionExpired(session: WalletConnectSession): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now > session.expiry;
}

export function formatSessionExpiry(expiry: number): string {
  const expiryDate = new Date(expiry * 1000);
  const now = new Date();
  const diffMs = expiryDate.getTime() - now.getTime();

  if (diffMs < 0) {
    return 'Expired';
  }

  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const diffHours = Math.floor(
    (diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)
  );

  if (diffDays > 0) {
    return `${diffDays}d ${diffHours}h`;
  } else if (diffHours > 0) {
    return `${diffHours}h`;
  } else {
    const diffMinutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${diffMinutes}m`;
  }
}

export function truncateAddress(address: string, chars = 4): string {
  if (!address) {
    return '';
  }

  if (address.length <= chars * 2) {
    return address;
  }
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function sanitizeMetadata(metadata: any) {
  return {
    name: metadata?.name || 'Unknown dApp',
    description: metadata?.description || 'No description provided',
    url: metadata?.url || '',
    icons: Array.isArray(metadata?.icons) ? metadata.icons : [],
  };
}

/**
 * Get network ID from WalletConnect chain ID
 */
export function getNetworkByChainId(chainId: string): NetworkId | null {
  switch (chainId) {
    case VOI_CHAIN_DATA.chainId:
      return NetworkId.VOI_MAINNET;
    case ALGORAND_MAINNET_CHAIN_DATA.chainId:
      return NetworkId.ALGORAND_MAINNET;
    default:
      return null;
  }
}

/**
 * Get chain data by chain ID
 */
export function getChainDataByChainId(chainId: string) {
  switch (chainId) {
    case VOI_CHAIN_DATA.chainId:
      return VOI_CHAIN_DATA;
    case ALGORAND_MAINNET_CHAIN_DATA.chainId:
      return ALGORAND_MAINNET_CHAIN_DATA;
    default:
      return null;
  }
}

/**
 * Get network display name from chain ID
 */
export function getNetworkNameByChainId(chainId: string): string {
  const chainData = getChainDataByChainId(chainId);
  return chainData?.name || 'Unknown Network';
}

/**
 * Get network currency from chain ID
 */
export function getNetworkCurrencyByChainId(chainId: string): string {
  const networkId = getNetworkByChainId(chainId);
  switch (networkId) {
    case NetworkId.VOI_MAINNET:
      return 'VOI';
    case NetworkId.ALGORAND_MAINNET:
      return 'ALGO';
    default:
      return 'TOKEN';
  }
}

/**
 * Extract requested chains from session proposal
 */
export function detectRequestedChains(proposal: SessionProposal): string[] {
  const chains = new Set<string>();

  // Get chains from required namespaces
  if (proposal.requiredNamespaces) {
    Object.values(proposal.requiredNamespaces).forEach((namespace) => {
      if (namespace.chains) {
        namespace.chains.forEach((chain: string) => chains.add(chain));
      }
    });
  }

  // Get chains from optional namespaces
  if (proposal.optionalNamespaces) {
    Object.values(proposal.optionalNamespaces).forEach((namespace) => {
      if (namespace.chains) {
        namespace.chains.forEach((chain: string) => chains.add(chain));
      }
    });
  }

  // Filter to only supported chains
  const supportedChains = [
    VOI_CHAIN_DATA.chainId,
    ALGORAND_MAINNET_CHAIN_DATA.chainId,
  ];
  return Array.from(chains).filter((chain) => supportedChains.includes(chain));
}

/**
 * Check if we support all required chains in a proposal
 */
export function areRequiredChainsSupported(proposal: SessionProposal): boolean {
  const supportedChains = [
    VOI_CHAIN_DATA.chainId,
    ALGORAND_MAINNET_CHAIN_DATA.chainId,
  ];

  if (proposal.requiredNamespaces) {
    for (const namespace of Object.values(proposal.requiredNamespaces)) {
      if (namespace.chains) {
        for (const chain of namespace.chains) {
          if (!supportedChains.includes(chain)) {
            return false;
          }
        }
      }
    }
  }

  return true;
}

/**
 * Resolve WalletConnect chain ID from a transaction genesis hash
 */
export function getChainIdByGenesisHash(
  genesisHash: Uint8Array | string | null | undefined
): string | null {
  const hex = decodeGenesisHashToHex(genesisHash);
  if (!hex) {
    return null;
  }

  const match = GENESIS_HASH_NETWORK_MAP[hex.toLowerCase()];
  return match?.chainId || null;
}

/**
 * Resolve network ID from a transaction genesis hash
 */
export function getNetworkByGenesisHash(
  genesisHash: Uint8Array | string | null | undefined
): NetworkId | null {
  const hex = decodeGenesisHashToHex(genesisHash);
  if (!hex) {
    return null;
  }

  const match = GENESIS_HASH_NETWORK_MAP[hex.toLowerCase()];
  return match?.networkId || null;
}

function decodeGenesisHashToHex(
  hash: string | Uint8Array | null | undefined
): string | null {
  if (!hash) {
    return null;
  }

  try {
    if (hash instanceof Uint8Array) {
      return Buffer.from(hash).toString('hex');
    }

    if (typeof hash === 'string') {
      const base64 = hash.replace(/-/g, '+').replace(/_/g, '/');
      const padded =
        base64.length % 4 === 0 ? base64 : base64 + '='.repeat(4 - (base64.length % 4));
      return Buffer.from(padded, 'base64').toString('hex');
    }

    return null;
  } catch (error) {
    console.error('Failed to decode genesis hash', error);
    return null;
  }
}
