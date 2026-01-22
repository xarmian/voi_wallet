import algosdk from 'algosdk';
import { NetworkId } from '@/types/network';

// =============================================================================
// Types
// =============================================================================

export type Arc0090Scheme = 'algorand' | 'voi' | 'perawallet';

export interface NetworkAuthority {
  type: 'genesis-hash' | 'network-alias' | 'none';
  value?: string; // base64url genesis hash or alias name
}

interface Arc0090BaseUri {
  scheme: Arc0090Scheme;
  network: NetworkAuthority;
  fragment?: string; // #arc26+27 compliance markers
}

// Payment URI (address in path)
export interface Arc0090PaymentUri extends Arc0090BaseUri {
  type: 'payment';
  address: string;
  params: {
    amount?: string; // microunits (bigint string)
    asset?: string; // asset ID
    label?: string;
    note?: string;
    xnote?: string;
    fee?: string; // transaction fee in microunits
  };
}

// Key Registration URI
export interface Arc0090KeyregUri extends Arc0090BaseUri {
  type: 'keyreg';
  address: string;
  params: {
    votekey?: string; // base64url
    selkey?: string; // base64url
    sprfkey?: string; // base64url
    votefst?: string; // first valid round
    votelst?: string; // last valid round
    votekd?: string; // key dilution
    fee?: string;
    note?: string;
    xnote?: string;
  };
  isOnline: boolean; // true if participation keys present
}

// Application Call URI
export interface Arc0090ApplUri extends Arc0090BaseUri {
  type: 'appl';
  address: string; // sender address (or zero address for template)
  params: {
    app: string[]; // app IDs (first is primary, rest are foreign)
    method?: string; // ABI method signature
    arg?: string[]; // method arguments (base64url for binary)
    box?: string[]; // box references (base64url)
    asset?: string[]; // foreign asset references
    account?: string[]; // foreign account references
    fee?: string;
    note?: string;
    xnote?: string;
    payment?: string; // payment amount in atomic units to prepend to app call
  };
}

// Application Query URI
export interface Arc0090AppQueryUri extends Arc0090BaseUri {
  type: 'app-query';
  appId: string;
  params: {
    box?: string; // base64url box key
    global?: string; // base64url global state key
    local?: string; // base64url local state key
    algorandaddress?: string; // account for local state
    tealcode?: boolean; // request approval program
  };
}

// Asset Query URI
export interface Arc0090AssetQueryUri extends Arc0090BaseUri {
  type: 'asset-query';
  assetId: string;
  params: {
    total?: boolean;
    decimals?: boolean;
    frozen?: boolean;
    unitname?: boolean;
    assetname?: boolean;
    url?: boolean;
    metadatahash?: boolean;
    manager?: boolean;
    reserve?: boolean;
    freeze?: boolean;
    clawback?: boolean;
  };
}

export type Arc0090Uri =
  | Arc0090PaymentUri
  | Arc0090KeyregUri
  | Arc0090ApplUri
  | Arc0090AppQueryUri
  | Arc0090AssetQueryUri;

export type Arc0090UriType =
  | 'payment'
  | 'keyreg'
  | 'appl'
  | 'app-query'
  | 'asset-query';

// =============================================================================
// Constants
// =============================================================================

// Genesis hash to NetworkId mapping (base64url encoded, without padding)
const GENESIS_HASH_MAP: Record<string, NetworkId> = {
  'r20fSQI8gWe_kFZziNonSPCXLwcQmH_n': NetworkId.VOI_MAINNET, // Voi Mainnet
  'wGHE2Pwdvd7S12BL5FaOP20EGYesN73k': NetworkId.ALGORAND_MAINNET, // Algorand Mainnet
};

// Network alias to NetworkId mapping
const NETWORK_ALIAS_MAP: Record<string, NetworkId> = {
  mainnet: NetworkId.VOI_MAINNET, // Default mainnet for voi:// scheme
  'voi-mainnet': NetworkId.VOI_MAINNET,
  'voimain-v1.0': NetworkId.VOI_MAINNET, // Official Voi network alias
  voi: NetworkId.VOI_MAINNET,
  'algorand-mainnet': NetworkId.ALGORAND_MAINNET,
  algorand: NetworkId.ALGORAND_MAINNET,
};

// NetworkId to genesis hash mapping (for generating URIs)
const NETWORK_ID_TO_GENESIS: Record<NetworkId, string> = {
  [NetworkId.VOI_MAINNET]: 'r20fSQI8gWe_kFZziNonSPCXLwcQmH_n',
  [NetworkId.ALGORAND_MAINNET]: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73k',
};

// Algorand zero address (used as template placeholder)
const ZERO_ADDRESS =
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ';

// Supported URI schemes
const SUPPORTED_SCHEMES = ['algorand', 'voi', 'perawallet'];

// =============================================================================
// Detection Functions
// =============================================================================

/**
 * Checks if a URI follows the ARC-0090 format
 * Supports algorand://, voi://, and perawallet:// schemes
 */
export function isArc0090Uri(uri: string): boolean {
  const normalizedUri = uri.toLowerCase();
  return SUPPORTED_SCHEMES.some((scheme) =>
    normalizedUri.startsWith(`${scheme}://`)
  );
}

/**
 * Determines the type of ARC-0090 URI
 */
export function getArc0090UriType(uri: string): Arc0090UriType | null {
  if (!isArc0090Uri(uri)) {
    return null;
  }

  try {
    // Parse to determine structure
    const { remainder } = parseSchemeAndAuthority(uri);

    // Check for query paths (app/ID or asset/ID)
    if (remainder.startsWith('app/')) {
      return 'app-query';
    }
    if (remainder.startsWith('asset/')) {
      return 'asset-query';
    }

    // Check query params for transaction types
    const [, queryString] = remainder.split('?');
    if (queryString) {
      const params = new URLSearchParams(queryString);
      const type = params.get('type');

      if (type === 'keyreg') {
        return 'keyreg';
      }
      if (type === 'appl') {
        return 'appl';
      }
    }

    // Default to payment if address-like path
    return 'payment';
  } catch {
    return null;
  }
}

// =============================================================================
// Parsing Functions
// =============================================================================

/**
 * Main parser for ARC-0090 URIs
 */
export function parseArc0090Uri(uri: string): Arc0090Uri | null {
  try {
    if (!isArc0090Uri(uri)) {
      return null;
    }

    const uriType = getArc0090UriType(uri);
    if (!uriType) {
      return null;
    }

    switch (uriType) {
      case 'payment':
        return parsePaymentUri(uri);
      case 'keyreg':
        return parseKeyregUri(uri);
      case 'appl':
        return parseApplUri(uri);
      case 'app-query':
        return parseAppQueryUri(uri);
      case 'asset-query':
        return parseAssetQueryUri(uri);
      default:
        return null;
    }
  } catch (error) {
    console.error('Failed to parse ARC-0090 URI:', error);
    return null;
  }
}

/**
 * Parses the scheme and optional network authority from a URI
 */
function parseSchemeAndAuthority(uri: string): {
  scheme: Arc0090Scheme;
  network: NetworkAuthority;
  remainder: string;
  fragment?: string;
} {
  // Extract fragment if present
  const [uriWithoutFragment, fragment] = uri.split('#');

  // Match scheme
  const schemeMatch = uriWithoutFragment.match(/^([^:]+):\/\//);
  if (!schemeMatch) {
    throw new Error('Invalid URI format: no scheme found');
  }

  const scheme = schemeMatch[1].toLowerCase() as Arc0090Scheme;
  if (!SUPPORTED_SCHEMES.includes(scheme)) {
    throw new Error(`Unsupported scheme: ${scheme}`);
  }

  // Remove scheme://
  let remainder = uriWithoutFragment.slice(schemeMatch[0].length);

  // Check for network authority (gh: or net: prefix before first /)
  let network: NetworkAuthority = { type: 'none' };

  // Authority must come before first / or ? and contain gh: or net:
  const firstSlashIdx = remainder.indexOf('/');
  const firstQueryIdx = remainder.indexOf('?');

  // Determine where authority ends
  let authorityEnd = remainder.length;
  if (firstSlashIdx !== -1 && firstSlashIdx < authorityEnd) {
    authorityEnd = firstSlashIdx;
  }
  if (firstQueryIdx !== -1 && firstQueryIdx < authorityEnd) {
    authorityEnd = firstQueryIdx;
  }

  const potentialAuthority = remainder.slice(0, authorityEnd);

  if (potentialAuthority.startsWith('gh:')) {
    // Genesis hash authority
    network = {
      type: 'genesis-hash',
      value: potentialAuthority.slice(3),
    };
    remainder = remainder.slice(authorityEnd);
    if (remainder.startsWith('/')) {
      remainder = remainder.slice(1);
    }
  } else if (potentialAuthority.startsWith('net:')) {
    // Network alias authority
    network = {
      type: 'network-alias',
      value: potentialAuthority.slice(4),
    };
    remainder = remainder.slice(authorityEnd);
    if (remainder.startsWith('/')) {
      remainder = remainder.slice(1);
    }
  }
  // If no authority prefix, the whole thing is the path

  return {
    scheme,
    network,
    remainder,
    fragment: fragment || undefined,
  };
}

/**
 * Parses a payment URI
 * Format: scheme://[authority/]address?amount=...&asset=...
 */
function parsePaymentUri(uri: string): Arc0090PaymentUri | null {
  const { scheme, network, remainder, fragment } = parseSchemeAndAuthority(uri);

  // Split address and query params
  const [addressPart, queryString] = remainder.split('?');

  // Address is the path (may be empty for opt-in)
  const address = addressPart || '';

  // Parse query parameters
  const params: Arc0090PaymentUri['params'] = {};

  if (queryString) {
    const searchParams = new URLSearchParams(queryString);

    // Extract supported parameters
    if (searchParams.has('amount')) {
      const amount = searchParams.get('amount')!;
      // Validate amount is a non-negative integer
      if (/^\d+$/.test(amount)) {
        params.amount = amount;
      }
    }

    if (searchParams.has('asset')) {
      const asset = searchParams.get('asset')!;
      // Validate asset ID is a non-negative integer
      if (/^\d+$/.test(asset)) {
        params.asset = asset;
      }
    }

    if (searchParams.has('label')) {
      params.label = decodeURIComponent(searchParams.get('label')!);
    }

    if (searchParams.has('note')) {
      params.note = decodeURIComponent(searchParams.get('note')!);
    }

    if (searchParams.has('xnote')) {
      params.xnote = decodeURIComponent(searchParams.get('xnote')!);
    }

    if (searchParams.has('fee')) {
      const fee = searchParams.get('fee')!;
      if (/^\d+$/.test(fee)) {
        params.fee = fee;
      }
    }
  }

  // Validate address if provided
  let isValidAddress = true;
  if (address) {
    try {
      isValidAddress = algosdk.isValidAddress(address);
    } catch {
      isValidAddress = false;
    }
  }

  if (!isValidAddress && address) {
    console.warn('Invalid address in payment URI:', address);
    return null;
  }

  return {
    type: 'payment',
    scheme,
    network,
    address,
    params,
    fragment,
  };
}

/**
 * Parses a key registration URI
 * Format: scheme://[authority/]address?type=keyreg&votekey=...
 */
function parseKeyregUri(uri: string): Arc0090KeyregUri | null {
  const { scheme, network, remainder, fragment } = parseSchemeAndAuthority(uri);

  // Split address and query params
  const [addressPart, queryString] = remainder.split('?');

  const address = addressPart || '';

  // Validate address
  if (!address || !algosdk.isValidAddress(address)) {
    console.warn('Invalid or missing address in keyreg URI');
    return null;
  }

  const params: Arc0090KeyregUri['params'] = {};

  if (queryString) {
    const searchParams = new URLSearchParams(queryString);

    // Extract keyreg parameters
    if (searchParams.has('votekey')) {
      params.votekey = searchParams.get('votekey')!;
    }

    if (searchParams.has('selkey')) {
      params.selkey = searchParams.get('selkey')!;
    }

    if (searchParams.has('sprfkey')) {
      params.sprfkey = searchParams.get('sprfkey')!;
    }

    if (searchParams.has('votefst')) {
      const votefst = searchParams.get('votefst')!;
      if (/^\d+$/.test(votefst)) {
        params.votefst = votefst;
      }
    }

    if (searchParams.has('votelst')) {
      const votelst = searchParams.get('votelst')!;
      if (/^\d+$/.test(votelst)) {
        params.votelst = votelst;
      }
    }

    if (searchParams.has('votekd')) {
      const votekd = searchParams.get('votekd')!;
      if (/^\d+$/.test(votekd)) {
        params.votekd = votekd;
      }
    }

    if (searchParams.has('fee')) {
      const fee = searchParams.get('fee')!;
      if (/^\d+$/.test(fee)) {
        params.fee = fee;
      }
    }

    if (searchParams.has('note')) {
      params.note = decodeURIComponent(searchParams.get('note')!);
    }

    if (searchParams.has('xnote')) {
      params.xnote = decodeURIComponent(searchParams.get('xnote')!);
    }
  }

  // Determine if this is an online (participation) or offline keyreg
  const isOnline = !!(params.votekey && params.selkey);

  return {
    type: 'keyreg',
    scheme,
    network,
    address,
    params,
    isOnline,
    fragment,
  };
}

/**
 * Parses an application call URI
 * Format: scheme://[authority/]address?type=appl&app=ID&method=...
 */
function parseApplUri(uri: string): Arc0090ApplUri | null {
  const { scheme, network, remainder, fragment } = parseSchemeAndAuthority(uri);

  // Split address and query params
  const [addressPart, queryString] = remainder.split('?');

  const address = addressPart || '';

  // Validate address (can be zero address for templates)
  if (address && !algosdk.isValidAddress(address)) {
    console.warn('Invalid address in appl URI');
    return null;
  }

  const params: Arc0090ApplUri['params'] = {
    app: [],
    arg: [],
    box: [],
    asset: [],
    account: [],
  };

  if (queryString) {
    const searchParams = new URLSearchParams(queryString);

    // App IDs (can have multiple - first is primary, rest are foreign)
    const appParams = searchParams.getAll('app');
    params.app = appParams.filter((id) => /^\d+$/.test(id));

    if (params.app.length === 0) {
      console.warn('No valid app ID in appl URI');
      return null;
    }

    // Method signature
    if (searchParams.has('method')) {
      params.method = searchParams.get('method')!;
    }

    // Arguments (can have multiple)
    params.arg = searchParams.getAll('arg');

    // Box references (can have multiple, base64url encoded)
    params.box = searchParams.getAll('box');

    // Foreign assets (can have multiple)
    params.asset = searchParams.getAll('asset').filter((id) => /^\d+$/.test(id));

    // Foreign accounts (can have multiple)
    params.account = searchParams
      .getAll('account')
      .filter((addr) => algosdk.isValidAddress(addr));

    // Fee
    if (searchParams.has('fee')) {
      const fee = searchParams.get('fee')!;
      if (/^\d+$/.test(fee)) {
        params.fee = fee;
      }
    }

    // Notes
    if (searchParams.has('note')) {
      params.note = decodeURIComponent(searchParams.get('note')!);
    }

    if (searchParams.has('xnote')) {
      params.xnote = decodeURIComponent(searchParams.get('xnote')!);
    }

    // Payment amount (atomic units to prepend as payment to app escrow)
    if (searchParams.has('payment')) {
      const payment = searchParams.get('payment')!;
      if (/^\d+$/.test(payment)) {
        params.payment = payment;
      }
    }
  }

  return {
    type: 'appl',
    scheme,
    network,
    address: address || ZERO_ADDRESS,
    params,
    fragment,
  };
}

/**
 * Parses an application query URI
 * Format: scheme://[authority/]app/appId?box=...&global=...
 */
function parseAppQueryUri(uri: string): Arc0090AppQueryUri | null {
  const { scheme, network, remainder, fragment } = parseSchemeAndAuthority(uri);

  // Remove 'app/' prefix
  if (!remainder.startsWith('app/')) {
    return null;
  }

  const pathAfterApp = remainder.slice(4);
  const [appIdStr, queryString] = pathAfterApp.split('?');

  // Validate app ID
  if (!/^\d+$/.test(appIdStr)) {
    console.warn('Invalid app ID in query URI');
    return null;
  }

  const params: Arc0090AppQueryUri['params'] = {};

  if (queryString) {
    const searchParams = new URLSearchParams(queryString);

    if (searchParams.has('box')) {
      params.box = searchParams.get('box')!;
    }

    if (searchParams.has('global')) {
      params.global = searchParams.get('global')!;
    }

    if (searchParams.has('local')) {
      params.local = searchParams.get('local')!;
    }

    if (searchParams.has('algorandaddress')) {
      const addr = searchParams.get('algorandaddress')!;
      if (algosdk.isValidAddress(addr)) {
        params.algorandaddress = addr;
      }
    }

    // Flag parameter (presence = true)
    if (searchParams.has('tealcode')) {
      params.tealcode = true;
    }
  }

  return {
    type: 'app-query',
    scheme,
    network,
    appId: appIdStr,
    params,
    fragment,
  };
}

/**
 * Parses an asset query URI
 * Format: scheme://[authority/]asset/assetId?total&decimals&...
 */
function parseAssetQueryUri(uri: string): Arc0090AssetQueryUri | null {
  const { scheme, network, remainder, fragment } = parseSchemeAndAuthority(uri);

  // Remove 'asset/' prefix
  if (!remainder.startsWith('asset/')) {
    return null;
  }

  const pathAfterAsset = remainder.slice(6);
  const [assetIdStr, queryString] = pathAfterAsset.split('?');

  // Validate asset ID
  if (!/^\d+$/.test(assetIdStr)) {
    console.warn('Invalid asset ID in query URI');
    return null;
  }

  const params: Arc0090AssetQueryUri['params'] = {};

  if (queryString) {
    const searchParams = new URLSearchParams(queryString);

    // All asset query params are flags (presence = true)
    const flagParams = [
      'total',
      'decimals',
      'frozen',
      'unitname',
      'assetname',
      'url',
      'metadatahash',
      'manager',
      'reserve',
      'freeze',
      'clawback',
    ] as const;

    for (const flag of flagParams) {
      if (searchParams.has(flag)) {
        params[flag] = true;
      }
    }
  }

  return {
    type: 'asset-query',
    scheme,
    network,
    assetId: assetIdStr,
    params,
    fragment,
  };
}

// =============================================================================
// Network Resolution
// =============================================================================

/**
 * Resolves network authority to a NetworkId
 * Returns null if network cannot be determined or is unsupported
 */
export function resolveNetworkFromAuthority(
  authority: NetworkAuthority,
  defaultForScheme?: Arc0090Scheme
): NetworkId | null {
  if (authority.type === 'genesis-hash' && authority.value) {
    return GENESIS_HASH_MAP[authority.value] || null;
  }

  if (authority.type === 'network-alias' && authority.value) {
    return NETWORK_ALIAS_MAP[authority.value.toLowerCase()] || null;
  }

  // No authority - use default based on scheme
  if (authority.type === 'none') {
    if (defaultForScheme === 'algorand') {
      return NetworkId.ALGORAND_MAINNET;
    }
    // Default to Voi for voi:// and perawallet:// in this wallet
    return NetworkId.VOI_MAINNET;
  }

  return null;
}

/**
 * Gets the genesis hash for a NetworkId
 */
export function getGenesisHashForNetwork(networkId: NetworkId): string | null {
  return NETWORK_ID_TO_GENESIS[networkId] || null;
}

/**
 * Checks if a genesis hash is supported
 */
export function isSupportedGenesisHash(genesisHash: string): boolean {
  return genesisHash in GENESIS_HASH_MAP;
}

// =============================================================================
// Validation Functions
// =============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validates a payment URI
 */
export function validatePaymentUri(uri: Arc0090PaymentUri): ValidationResult {
  const errors: string[] = [];

  // Address is required for sending (unless opt-in only)
  if (!uri.address && !uri.params.asset) {
    errors.push('Address is required for payment');
  }

  // Amount must be reasonable if provided
  if (uri.params.amount) {
    try {
      const amount = BigInt(uri.params.amount);
      if (amount < 0n) {
        errors.push('Amount cannot be negative');
      }
      // Max 10 trillion units (reasonable upper bound)
      if (amount > BigInt('10000000000000000')) {
        errors.push('Amount exceeds maximum allowed');
      }
    } catch {
      errors.push('Invalid amount format');
    }
  }

  // Asset ID must be valid
  if (uri.params.asset) {
    const assetId = parseInt(uri.params.asset);
    if (isNaN(assetId) || assetId < 0) {
      errors.push('Invalid asset ID');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates a keyreg URI
 */
export function validateKeyregUri(uri: Arc0090KeyregUri): ValidationResult {
  const errors: string[] = [];

  if (!uri.address) {
    errors.push('Address is required for key registration');
  }

  // Online keyreg requires all participation keys
  if (uri.isOnline) {
    if (!uri.params.votekey) errors.push('Vote key is required for online keyreg');
    if (!uri.params.selkey)
      errors.push('Selection key is required for online keyreg');
    if (!uri.params.votefst)
      errors.push('First valid round is required for online keyreg');
    if (!uri.params.votelst)
      errors.push('Last valid round is required for online keyreg');
    if (!uri.params.votekd)
      errors.push('Key dilution is required for online keyreg');

    // Validate round numbers
    if (uri.params.votefst && uri.params.votelst) {
      const first = parseInt(uri.params.votefst);
      const last = parseInt(uri.params.votelst);
      if (first >= last) {
        errors.push('First valid round must be less than last valid round');
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validates an appl URI
 */
export function validateApplUri(uri: Arc0090ApplUri): ValidationResult {
  const errors: string[] = [];

  // Must have at least one app ID
  if (uri.params.app.length === 0) {
    errors.push('At least one app ID is required');
  }

  // Validate app IDs
  for (const appId of uri.params.app) {
    const id = parseInt(appId);
    if (isNaN(id) || id < 0) {
      errors.push(`Invalid app ID: ${appId}`);
    }
  }

  // If method is provided, validate format
  if (uri.params.method) {
    // Basic ABI method signature validation: name(types)returntype
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*\([^)]*\)/.test(uri.params.method)) {
      errors.push('Invalid method signature format');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Decodes a base64url encoded string to Uint8Array
 */
export function decodeBase64Url(input: string): Uint8Array {
  // Convert base64url to base64
  let base64 = input.replace(/-/g, '+').replace(/_/g, '/');

  // Add padding if necessary
  const paddingNeeded = (4 - (base64.length % 4)) % 4;
  base64 += '='.repeat(paddingNeeded);

  // Decode
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes Uint8Array to base64url string
 */
export function encodeBase64Url(input: Uint8Array): string {
  let base64 = btoa(String.fromCharCode(...input));
  // Convert base64 to base64url (remove padding, replace chars)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Parses the multi-ARC compliance fragment
 * Format: #arc26+27 or #arc3+16
 */
export function parseMultiArcFragment(fragment: string): number[] {
  if (!fragment || !fragment.startsWith('arc')) {
    return [];
  }

  const arcNumbers: number[] = [];
  const parts = fragment.slice(3).split('+'); // Remove 'arc' prefix

  for (const part of parts) {
    const num = parseInt(part);
    if (!isNaN(num) && num > 0) {
      arcNumbers.push(num);
    }
  }

  return arcNumbers;
}

/**
 * Converts amount from smallest units to display format
 */
export function convertAmountToDisplay(
  amount: string,
  decimals: number = 6
): string {
  try {
    const amountBigInt = BigInt(amount);
    const divisor = BigInt(10) ** BigInt(decimals);

    const wholePart = amountBigInt / divisor;
    const fractionalPart = amountBigInt % divisor;

    if (fractionalPart === BigInt(0)) {
      return wholePart.toString();
    }

    const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
    const trimmedFractional = fractionalStr.replace(/0+$/, '');

    return `${wholePart}.${trimmedFractional}`;
  } catch {
    return '0';
  }
}

/**
 * Creates a human-readable summary of a payment request
 */
export function createPaymentSummary(parsed: Arc0090PaymentUri): string {
  const parts: string[] = [];

  if (parsed.params.label) {
    parts.push(`to ${parsed.params.label}`);
  } else if (parsed.address) {
    parts.push(
      `to ${parsed.address.slice(0, 8)}...${parsed.address.slice(-8)}`
    );
  }

  if (parsed.params.amount) {
    const assetId = parsed.params.asset ? parseInt(parsed.params.asset) : 0;
    const isNativeToken = assetId === 0;
    const decimals = isNativeToken ? 6 : 0;
    const displayAmount = convertAmountToDisplay(parsed.params.amount, decimals);

    if (isNativeToken) {
      const tokenName = parsed.scheme === 'algorand' ? 'Algos' : 'VOI';
      parts.push(`${displayAmount} ${tokenName}`);
    } else {
      parts.push(`${displayAmount} units of asset ${parsed.params.asset}`);
    }
  }

  if (parsed.params.note || parsed.params.xnote) {
    const note = parsed.params.xnote || parsed.params.note;
    parts.push(`with note: "${note}"`);
  }

  return parts.length > 0
    ? `Send ${parts.join(' ')}`
    : 'Process payment request';
}

// =============================================================================
// Legacy Compatibility
// =============================================================================

/**
 * Checks if this is a legacy voi://action?params format
 * Legacy format: voi://send?to=address&amount=...
 * New format: voi://ADDRESS?amount=...
 */
export function isLegacyVoiUri(uri: string): boolean {
  if (!uri.toLowerCase().startsWith('voi://')) {
    return false;
  }

  const withoutScheme = uri.slice(6);
  const [pathPart] = withoutScheme.split('?');

  // Legacy URIs use action words as path (send, receive, connect)
  const legacyActions = ['send', 'receive', 'connect'];
  return legacyActions.includes(pathPart.toLowerCase());
}

// =============================================================================
// Backward-compatible exports (for existing code)
// =============================================================================

// Re-export old function names for compatibility
export const isAlgorandPaymentUri = isArc0090Uri;
export const parseAlgorandUri = (uri: string) => {
  const parsed = parseArc0090Uri(uri);
  if (!parsed || parsed.type !== 'payment') {
    return null;
  }

  // Convert to old format for backward compatibility
  return {
    address: parsed.address,
    params: {
      address: parsed.address,
      amount: parsed.params.amount,
      asset: parsed.params.asset,
      label: parsed.params.label,
      note: parsed.params.note,
      xnote: parsed.params.xnote,
    },
    isValid: true,
    scheme: parsed.scheme,
  };
};

// Legacy types for backward compatibility
export interface AlgorandUriParams {
  address?: string;
  amount?: string;
  asset?: string;
  label?: string;
  note?: string;
  xnote?: string;
}

export interface ParsedAlgorandUri {
  address: string;
  params: AlgorandUriParams;
  isValid: boolean;
  scheme: 'algorand' | 'voi' | 'perawallet';
}
