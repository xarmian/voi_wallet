/**
 * Remote Signer Types
 *
 * This file defines the data structures used for QR-based communication
 * between the wallet (online) and signer (offline/air-gapped) devices.
 */

/**
 * Transaction item in a signing request
 */
export interface SignableTransaction {
  /** Index of transaction in the group */
  i: number;
  /** Base64 msgpack-encoded unsigned transaction */
  b: string;
  /** Address that should sign this transaction */
  s: string;
  /** Auth address (for rekeyed accounts) */
  a?: string;
}

/**
 * Unsigned Transaction Request (Wallet → Signer)
 *
 * This is what gets encoded into the QR code for the signer to scan.
 * Field names are abbreviated to minimize QR code size.
 */
export interface RemoteSignerRequest {
  /** Version number for protocol compatibility */
  v: 1;
  /** Type discriminator: 'req' for request */
  t: 'req';
  /** UUID for request tracking and replay prevention */
  id: string;
  /** Unix timestamp in milliseconds */
  ts: number;
  /** Network identifier (e.g., 'voi', 'voi-testnet', 'algorand') */
  net: string;
  /** Base64-encoded genesis hash for network validation */
  gh: string;
  /** Array of transactions to sign */
  txns: SignableTransaction[];
  /** Optional metadata about the request origin */
  meta?: {
    /** dApp name if from WalletConnect */
    app?: string;
    /** Human-readable description */
    desc?: string;
  };
}

/**
 * Signed transaction in a response
 */
export interface SignedTransaction {
  /** Index matching the request transaction */
  i: number;
  /** Base64-encoded signed transaction blob */
  b: string;
}

/**
 * Error codes for signing failures
 */
export type RemoteSignerErrorCode =
  | 'REJECTED' // User rejected the signing request
  | 'INVALID' // Request was malformed or failed validation
  | 'FAILED' // Signing operation failed
  | 'NETWORK' // Network/genesis hash mismatch
  | 'EXPIRED' // Request timestamp too old
  | 'DUPLICATE'; // Request ID already processed

/**
 * Signed Transaction Response (Signer → Wallet)
 *
 * This is what the signer displays after signing, for the wallet to scan.
 */
export interface RemoteSignerResponse {
  /** Version number for protocol compatibility */
  v: 1;
  /** Type discriminator: 'res' for response */
  t: 'res';
  /** UUID matching the request */
  id: string;
  /** Unix timestamp in milliseconds */
  ts: number;
  /** Success flag */
  ok: boolean;
  /** Signed transactions (only if ok === true) */
  sigs?: SignedTransaction[];
  /** Error information (only if ok === false) */
  err?: {
    /** Error code */
    c: RemoteSignerErrorCode;
    /** Human-readable error message */
    m: string;
  };
}

/**
 * Pairing protocol version.
 *
 * This is a SEPARATE axis from {@link REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION}
 * (which gates request/response signing and MUST stay at 1). Pairing payloads
 * are versioned independently:
 *   - `1` — legacy, UNSIGNED pairing (no per-account signatures).
 *   - `2` — authenticated pairing: every account carries a set-bound
 *     Ed25519 self-signature (proof-of-possession). See {@link PAIRING_VERSION}.
 */
export type PairingVersion = 1 | 2;

/**
 * Current authenticated pairing version (signed, set-bound).
 *
 * Kept deliberately separate from `REMOTE_SIGNER_CONSTANTS.PROTOCOL_VERSION`:
 * bumping the shared protocol version would break cross-version request/response
 * signing. Pairing versioning is an independent axis.
 */
export const PAIRING_VERSION = 2 as const;

/**
 * Hard input bounds for pairing validation (defence-in-depth against a hostile
 * QR payload — see verifyPairing). Generous but finite.
 */
export const PAIRING_LIMITS = {
  /** Maximum number of accounts in a single pairing payload */
  MAX_ACCOUNTS: 100,
  /** Maximum length of the device id string */
  MAX_DEVICE_ID_LENGTH: 128,
  /** Maximum length of the (cosmetic, unverified) device name */
  MAX_NAME_LENGTH: 128,
  /** Maximum length of a per-account (cosmetic, unverified) label */
  MAX_LABEL_LENGTH: 128,
  /** Exact byte length of an Ed25519 detached signature */
  SIGNATURE_BYTES: 64,
  /**
   * Exact base64 length of a 64-byte signature (canonical, `==`-padded).
   * Enforced BEFORE base64-decoding so a hostile QR cannot force an unbounded
   * allocation ahead of the byte-length check.
   */
  SIGNATURE_B64_LENGTH: 88,
} as const;

/**
 * Account information in pairing data
 */
export interface PairedAccount {
  /** Algorand address */
  addr: string;
  /**
   * Hex-encoded public key.
   *
   * SECURITY: kept on the wire for backward compatibility only. It is NEVER
   * trusted by the verifier — the verification public key is ALWAYS derived
   * from `addr` (checksum-validated). See DR-2/DR-3 in the design.
   */
  pk: string;
  /**
   * Base64-encoded 64-byte Ed25519 detached self-signature over the
   * domain-separated, set-binding pairing message (v2 pairings only).
   * Absent on legacy v1 (unsigned) pairings.
   */
  sig?: string;
  /** Optional label set by user on signer device */
  label?: string;
}

/**
 * Account Pairing (Signer → Wallet)
 *
 * This is displayed by the signer to export accounts to the wallet.
 */
export interface RemoteSignerPairing {
  /** Pairing protocol version (1 = legacy unsigned, 2 = authenticated/signed) */
  v: PairingVersion;
  /** Type discriminator: 'pair' for pairing */
  t: 'pair';
  /** Unique identifier of the signer device */
  dev: string;
  /** User-friendly device name */
  name?: string;
  /** Accounts to pair */
  accts: PairedAccount[];
  /** Unix timestamp in milliseconds */
  ts: number;
}

/**
 * Union type for all QR payload types
 */
export type RemoteSignerPayload =
  | RemoteSignerRequest
  | RemoteSignerResponse
  | RemoteSignerPairing;

/**
 * Type guard to check if payload is a signing request
 */
export function isRemoteSignerRequest(
  payload: RemoteSignerPayload
): payload is RemoteSignerRequest {
  return payload.t === 'req';
}

/**
 * Type guard to check if payload is a signing response
 */
export function isRemoteSignerResponse(
  payload: RemoteSignerPayload
): payload is RemoteSignerResponse {
  return payload.t === 'res';
}

/**
 * Type guard to check if payload is a pairing request
 */
export function isRemoteSignerPairing(
  payload: RemoteSignerPayload
): payload is RemoteSignerPairing {
  return payload.t === 'pair';
}

/**
 * Configuration for the signer device
 */
export interface SignerDeviceConfig {
  /** Unique device identifier (generated once on first setup) */
  deviceId: string;
  /** User-defined device name */
  deviceName: string;
  /** Whether to require PIN for each transaction in a group */
  requirePinPerTxn: boolean;
}

/**
 * Signer device information stored in wallet
 */
export interface SignerDeviceInfo {
  /** Unique device identifier */
  deviceId: string;
  /** Device name from pairing */
  deviceName?: string;
  /** Timestamp of initial pairing */
  pairedAt: number;
  /** Addresses managed by this signer */
  addresses: string[];
  /** Last successful signing activity */
  lastActivity?: number;
}

/**
 * State for tracking processed requests (replay prevention)
 */
export interface ProcessedRequestTracker {
  /** Set of processed request IDs */
  processedIds: Set<string>;
  /** Maximum age for request validity (default: 5 minutes) */
  maxAgeMs: number;
  /** Cleanup interval for old entries (default: 10 minutes) */
  cleanupAgeMs: number;
}

/**
 * Signing progress state for UI
 */
export interface SigningProgress {
  /** Current transaction being processed */
  currentIndex: number;
  /** Total number of transactions */
  totalTransactions: number;
  /** Current status */
  status: 'idle' | 'reviewing' | 'signing' | 'complete' | 'error';
  /** Error message if status is 'error' */
  error?: string;
}

/**
 * App mode - determines which features are available
 */
export type AppMode = 'wallet' | 'signer';

/**
 * Transaction type for display purposes
 */
export type TransactionDisplayType =
  | 'payment'
  | 'asset_transfer'
  | 'app_call'
  | 'asset_config'
  | 'asset_freeze'
  | 'key_registration'
  | 'state_proof'
  | 'unknown';

/**
 * Decoded transaction info for display on signer
 */
export interface DecodedTransactionInfo {
  /** Transaction type */
  type: TransactionDisplayType;
  /** Sender address */
  sender: string;
  /** Receiver address (for payments/transfers) */
  receiver?: string;
  /** Amount in microAlgos or base units */
  amount?: bigint;
  /** Transaction fee */
  fee: bigint;
  /** Asset ID (for asset transfers) */
  assetId?: number;
  /** Application ID (for app calls) */
  appId?: number;
  /** Note field (decoded as UTF-8 if possible) */
  note?: string;
  /** First valid round */
  firstValid: bigint;
  /** Last valid round */
  lastValid: bigint;
  /** Genesis ID */
  genesisId?: string;
  /** Genesis hash (base64) */
  genesisHash: string;
  /** Rekey to address */
  rekeyTo?: string;
  /** Close remainder to address */
  closeRemainderTo?: string;
  /** Raw transaction for full details */
  raw: any;
}

/**
 * Constants for remote signer protocol
 */
export const REMOTE_SIGNER_CONSTANTS = {
  /** Current protocol version */
  PROTOCOL_VERSION: 1,
  /** Maximum request age in milliseconds (5 minutes) */
  MAX_REQUEST_AGE_MS: 5 * 60 * 1000,
  /** Cleanup age for processed requests (10 minutes) */
  CLEANUP_AGE_MS: 10 * 60 * 1000,
  /** Maximum payload size for single QR (bytes) */
  SINGLE_QR_MAX_BYTES: 1000,
  /**
   * Upper bound on the base64 length of a single returned signed-transaction
   * blob. This is a DoS guard enforced during strict envelope validation
   * (before any blob is decoded); it is far larger than any legitimate signed
   * transaction. Correctness never relies on it — the content-binding check
   * requires each returned blob to byte-equal the exact transaction the wallet
   * built, so an over-sized blob is rejected on content grounds regardless.
   */
  MAX_SIGNED_TXN_B64_LENGTH: 100000,
  /** Frame size for animated QR (bytes) */
  ANIMATED_QR_FRAME_BYTES: 800,
  /** Frame rate for animated QR (fps) */
  ANIMATED_QR_FPS: 4,
} as const;
