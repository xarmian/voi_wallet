import { NetworkId } from './network';

// Account Types
export enum AccountType {
  STANDARD = 'standard', // Full control with private key
  WATCH = 'watch', // Read-only monitoring
  REKEYED = 'rekeyed', // Delegated signing authority
  LEDGER = 'ledger', // Controlled by Ledger hardware device
  REMOTE_SIGNER = 'remote_signer', // Air-gapped signing via QR codes
}

// Base Account Metadata Interface
export interface BaseAccountMetadata {
  id: string; // Unique account identifier
  address: string; // Algorand address
  publicKey: string; // Public key in hex format
  type: AccountType; // Account type
  label?: string; // User-defined label
  color?: string; // UI color identifier
  isHidden: boolean; // Whether account is hidden in UI
  createdAt: string; // Creation timestamp
  importedAt?: string; // Import timestamp (for imported accounts)
  lastUsed: string; // Last activity timestamp
  avatarUrl?: string; // Persisted avatar image URL (e.g., from Envoi)
  avatarUpdatedAt?: string; // Last time avatarUrl was refreshed
}

// Standard Account (with private key)
export interface StandardAccountMetadata extends BaseAccountMetadata {
  type: AccountType.STANDARD;
  mnemonic: string; // 25-word recovery phrase
  derivationPath?: string; // HD derivation path if applicable
  hasBackup: boolean; // Whether backup has been verified
  backupCreatedAt?: string; // Backup creation timestamp
}

// Watch Account (read-only)
export interface WatchAccountMetadata extends BaseAccountMetadata {
  type: AccountType.WATCH;
  source?: string; // Source of the watch account
  notes?: string; // User notes about this account
}

// Rekeyed Account (delegated signing)
export interface RekeyedAccountMetadata extends BaseAccountMetadata {
  type: AccountType.REKEYED;
  authAddress: string; // Address that has signing authority
  rekeyedAt?: string; // When the account was rekeyed
  originalOwner?: boolean; // Whether this wallet was the original owner
  canSign: boolean; // Whether we have the signing key for the auth address
  rekeyedFrom?: string; // Original account address if we rekeyed it
}

// Ledger Account (hardware-controlled)
export interface LedgerAccountMetadata extends BaseAccountMetadata {
  type: AccountType.LEDGER;
  deviceId: string; // Unique Ledger device identifier
  derivationIndex: number; // Account derivation index on device
  derivationPath: string; // BIP-44 derivation path
  deviceName?: string; // User-friendly device alias
  lastDeviceConnection?: string; // Last successful device connection timestamp
}

/**
 * Pairing authentication level for a remote signer account.
 *
 * - `'v2-signed'`   — the account was imported from an authenticated (v2)
 *   pairing whose set-bound Ed25519 self-signature verified.
 * - `'v1-unsigned'` — legacy / unauthenticated pairing (no verified signature).
 *   This is ALSO the conservative default for any record where the field is
 *   missing (legacy metadata) — always read it as `authLevel ?? 'v1-unsigned'`.
 */
export type RemoteSignerAuthLevel = 'v1-unsigned' | 'v2-signed';

/**
 * Resolve a possibly-missing pairing auth level to a concrete value, defaulting
 * conservatively to 'v1-unsigned'. Use this at EVERY read of a persisted
 * `authLevel` (legacy records predate the field). Centralised so the default is
 * single-sourced and unit-testable.
 */
export function withDefaultAuthLevel(
  level?: RemoteSignerAuthLevel
): RemoteSignerAuthLevel {
  return level ?? 'v1-unsigned';
}

// Remote Signer Account (air-gapped QR-based signing)
export interface RemoteSignerAccountMetadata extends BaseAccountMetadata {
  type: AccountType.REMOTE_SIGNER;
  signerDeviceId: string; // Unique identifier of the signer device
  signerDeviceName?: string; // User-friendly device name (e.g., "My Cold Storage Phone")
  pairedAt: string; // ISO timestamp when account was paired
  lastSigningActivity?: string; // Last time a transaction was signed
  /**
   * Pairing authentication level. Optional for backward compatibility with
   * records written before this field existed; treat a missing value as
   * 'v1-unsigned' at EVERY read site (`authLevel ?? 'v1-unsigned'`).
   */
  authLevel?: RemoteSignerAuthLevel;
}

// Union type for all account metadata types
export type AccountMetadata =
  | StandardAccountMetadata
  | WatchAccountMetadata
  | RekeyedAccountMetadata
  | LedgerAccountMetadata
  | RemoteSignerAccountMetadata;

// Wallet Container
export interface Wallet {
  id: string; // Wallet instance identifier
  version: string; // Architecture version
  createdAt: string; // Wallet creation timestamp
  accounts: AccountMetadata[]; // All managed accounts
  activeAccountId: string; // Currently selected account
  settings: WalletSettings; // Wallet-level settings
}

// Wallet Settings
export interface WalletSettings {
  theme: 'light' | 'dark' | 'system';
  currency: string; // Display currency (USD, EUR, etc.)
  /**
   * Optional locale override for number formatting.
   * When null/undefined, system locale is used.
   */
  numberLocale?: string | null;
  hideSmallBalances: boolean; // Hide accounts with small balances
  requireBiometric: boolean; // Require biometric for transactions
  autoLock: number; // Auto-lock timeout in minutes
  notifications: NotificationSettings;
}

export interface NotificationSettings {
  transactionAlerts: boolean;
  priceAlerts: boolean;
  securityAlerts: boolean;
  pushNotifications: boolean;
}

// Legacy interfaces for backward compatibility
export interface WalletAccount {
  address: string;
  publicKey: Uint8Array;
  // privateKey removed - now handled by SecureKeyManager
  // Optional type for detecting account type (e.g., REMOTE_SIGNER, LEDGER)
  // Present when account is passed from AccountMetadata
  type?: AccountType;
}

export interface WalletInfo {
  account: WalletAccount;
  mnemonic: string;
}

export interface AccountBalance {
  address: string;
  amount: number | bigint;
  minBalance: number | bigint;
  assets: AssetBalance[];
  voiPrice?: number; // USD price per VOI token
  algoPrice?: number; // USD price per ALGO token
  rekeyInfo?: {
    isRekeyed: boolean;
    authAddress?: string;
    rekeyedAt?: number;
  };
}

export interface AssetBalance {
  assetId: number;
  amount: number | bigint;
  decimals: number;
  name?: string;
  unitName?: string;
  symbol?: string;
  imageUrl?: string;
  usdValue?: string;
  verified?: number;
  assetType?: 'arc200' | 'asa';
  contractId?: number;
}

/**
 * Immutable on-chain parameters for an ASA, used to resolve display decimals
 * for assets that aren't in the active account's holdings (e.g. in tx history).
 */
export interface AssetParams {
  decimals: number;
  name?: string;
  unitName?: string;
}

export interface TransactionInfo {
  id: string;
  from: string;
  to: string;
  amount: number | bigint;
  fee: number | bigint;
  timestamp: number;
  type:
    | 'payment'
    | 'asset-transfer'
    | 'asset-config'
    | 'application-call'
    | 'arc200-transfer';
  assetId?: number;
  applicationId?: number; // For application-call transactions
  note?: string;
  accountId?: string; // Which account this transaction belongs to
  confirmedRound?: number | bigint; // Block round when transaction was confirmed
  contractId?: number; // For ARC-200 transfers
  isArc200?: boolean; // Flag to identify ARC-200 transactions
}

// Account Creation and Management Types
export interface CreateAccountRequest {
  type: AccountType.STANDARD;
  label?: string;
  color?: string;
}

export interface ImportAccountRequest {
  type: AccountType.STANDARD;
  mnemonic?: string;
  privateKey?: string;
  label?: string;
  color?: string;
}

export interface ImportLedgerAccountRequest {
  type: AccountType.LEDGER;
  deviceId: string;
  derivationIndex: number;
  derivationPath?: string;
  deviceName?: string;
  label?: string;
  color?: string;
}

export interface DetectLedgerAccountsRequest {
  deviceId?: string;
  startIndex?: number;
  count?: number;
  displayFirst?: boolean;
}

export interface LedgerAccountDiscoveryResult {
  derivationIndex: number;
  derivationPath: string;
  address: string;
  publicKey: string;
  existsInWallet: boolean;
  accountId?: string;
  accountLabel?: string;
}

export type LedgerTransportMedium = 'ble' | 'usb';

export interface LedgerSigningInfo {
  accountId: string;
  address: string;
  deviceId: string;
  deviceName?: string;
  derivationIndex: number;
  derivationPath: string;
  isDeviceConnected: boolean;
  isDeviceAvailable: boolean;
  requiresConnection: boolean;
  transportType?: LedgerTransportMedium;
  lastDeviceConnection?: string;
  /**
   * Address whose signature is attached to the on-device signing request. Equals
   * the Ledger account's own address; only affects the post-device `sgnr`
   * attachment used for rekeyed accounts. Optional because not every
   * `getLedgerSigningInfo` producer populates it (behavior-preserving default).
   */
  signerAddress?: string;
}

export interface AddWatchAccountRequest {
  type: AccountType.WATCH;
  address: string;
  label?: string;
  notes?: string;
}

export interface DetectRekeyedAccountRequest {
  type: AccountType.REKEYED;
  originalAddress: string;
  authAddress: string;
  label?: string;
  canSign?: boolean;
  rekeyedFrom?: string;
}

// Remote Signer Account Import Request
export interface ImportRemoteSignerAccountRequest {
  type: AccountType.REMOTE_SIGNER;
  address: string; // Account address from signer device
  publicKey: string; // Public key in hex format
  signerDeviceId: string; // Unique identifier of the signer device
  signerDeviceName?: string; // User-friendly device name
  label?: string; // User-defined label for the account
  color?: string; // UI color identifier
  /**
   * Pairing authentication level (from verifyPairing). Optional: when omitted
   * the account is persisted as the conservative 'v1-unsigned'. The import
   * screen wires this in a later task (TASK-144).
   */
  authLevel?: RemoteSignerAuthLevel;
}

// Account Error Types
export class AccountError extends Error {
  constructor(
    message: string,
    public code: string
  ) {
    super(message);
    this.name = 'AccountError';
  }
}

export class AccountNotFoundError extends AccountError {
  constructor(message: string = 'Account not found') {
    super(message, 'ACCOUNT_NOT_FOUND');
  }
}

export class AccountExistsError extends AccountError {
  constructor(message: string = 'Account already exists') {
    super(message, 'ACCOUNT_EXISTS');
  }
}

export class InvalidAddressError extends AccountError {
  constructor(message: string = 'Invalid address') {
    super(message, 'INVALID_ADDRESS');
  }
}

export class InvalidMnemonicError extends AccountError {
  constructor(message: string = 'Invalid mnemonic phrase') {
    super(message, 'INVALID_MNEMONIC');
  }
}

export class RekeyVerificationError extends AccountError {
  constructor(message: string = 'Cannot verify rekey relationship') {
    super(message, 'REKEY_VERIFICATION_FAILED');
  }
}

export class AccountStorageError extends AccountError {
  constructor(message: string = 'Account storage error') {
    super(message, 'ACCOUNT_STORAGE_ERROR');
  }
}

export class AccountRetrievalError extends AccountError {
  constructor(message: string = 'Account retrieval error') {
    super(message, 'ACCOUNT_RETRIEVAL_ERROR');
  }
}

export class AccountCreationError extends AccountError {
  constructor(message: string = 'Account creation error') {
    super(message, 'ACCOUNT_CREATION_ERROR');
  }
}

/**
 * TASK-220: a full reset/wipe raced an in-flight account creation/import/restore.
 * The reset wins (DR-2): the creation is aborted and any just-written secret is
 * rolled back so neither the secure key store nor the wallet metadata is left
 * holding a half-created account. Surfaced to the UI as "wallet was reset —
 * creation cancelled, try again."
 */
export class ResetRacedError extends AccountError {
  constructor(
    message: string = 'A wallet reset occurred while creating this account'
  ) {
    super(message, 'RESET_RACED');
    this.name = 'ResetRacedError';
  }
}

/**
 * TASK-220: a second creation/restore attempt targeted an accountId that already
 * has an uncommitted pending-creation entry (ownership collision — e.g. two
 * concurrent restores of the same backup). Rejected at the secret-write boundary
 * so an earlier attempt's rollback can never delete a later attempt's secret.
 */
export class DuplicatePendingCreateError extends AccountError {
  constructor(
    message: string = 'Another creation for this account is already in progress'
  ) {
    super(message, 'DUPLICATE_PENDING_CREATE');
    this.name = 'DuplicatePendingCreateError';
  }
}

export class AccountImportError extends AccountError {
  constructor(message: string = 'Account import error') {
    super(message, 'ACCOUNT_IMPORT_ERROR');
  }
}

export class TransactionSigningError extends AccountError {
  constructor(message: string = 'Transaction signing error') {
    super(message, 'TRANSACTION_SIGNING_ERROR');
  }
}

export class AuthenticationRequiredError extends AccountError {
  constructor(message: string = 'Authentication required') {
    super(message, 'AUTHENTICATION_REQUIRED');
  }
}

export class LedgerAccountError extends AccountError {
  constructor(
    message: string = 'Ledger account error',
    code: string = 'LEDGER_ACCOUNT_ERROR'
  ) {
    super(message, code);
    this.name = 'LedgerAccountError';
  }
}

export class LedgerDeviceNotConnectedError extends LedgerAccountError {
  constructor(message: string = 'Ledger device is not connected') {
    super(message, 'LEDGER_DEVICE_NOT_CONNECTED');
  }
}

export class LedgerAppNotOpenError extends LedgerAccountError {
  constructor(message: string = 'Required Ledger app is not open') {
    super(message, 'LEDGER_APP_NOT_OPEN');
  }
}

export class LedgerUserRejectedError extends LedgerAccountError {
  constructor(message: string = 'Ledger device rejected the request') {
    super(message, 'LEDGER_USER_REJECTED');
  }
}

export interface RemoteSignerRequiredErrorOptions {
  /** Address of the account that must be signed remotely. */
  accountAddress?: string;
  /** Device id of the paired offline signer, when known. */
  signerDeviceId?: string;
  /** Override the generated message. */
  message?: string;
}

/**
 * Thrown when a REMOTE_SIGNER account is asked to sign directly instead of
 * through the QR flow.
 *
 * TASK-41: this class used to be declared TWICE — in
 * `services/remoteSigner/signingRouter.ts` and `services/transactions/
 * unifiedSigner.ts` — with incompatible constructors. Two distinct classes
 * share one `name`, so an `instanceof` check against one of them silently
 * returned `false` for an error thrown by the other, and callers fell through
 * to a generic failure path. It now lives here (the one module both signers
 * already import) and both call sites re-export it for compatibility.
 */
export class RemoteSignerRequiredError extends AccountError {
  readonly accountAddress?: string;
  readonly signerDeviceId?: string;

  constructor(options: RemoteSignerRequiredErrorOptions = {}) {
    super(
      options.message ??
        (options.accountAddress
          ? `Account ${options.accountAddress} is a remote signer account. Use QR-based signing instead.`
          : 'This account uses remote signing via QR codes. Please use the remote signer flow instead of direct signing.'),
      'REMOTE_SIGNER_REQUIRED'
    );
    this.name = 'RemoteSignerRequiredError';
    this.accountAddress = options.accountAddress;
    this.signerDeviceId = options.signerDeviceId;
  }
}

// Transaction Signing Context
export interface TransactionSigningContext {
  transaction: any; // algosdk.Transaction type
  accountId: string;
  purpose: 'send' | 'approve' | 'opt_in' | 'application_call';
  requiresConfirmation: boolean;
}

// Account Backup Types
export interface AccountBackupData {
  accountId: string;
  address: string;
  label?: string;
  mnemonic: string;
  verificationWords: string[];
  createdAt: string;
}

export interface WalletBackupMetadata {
  walletId: string;
  createdAt: string;
  version: string;
  accountCount: number;
  totalAccounts: number;
}

// Secure Storage Types
export interface SecureAccountStorage {
  accountId: string;
  address: string;
  type: AccountType;
  encryptedPrivateKey?: string; // Only for Standard accounts
  publicData: {
    publicKey: string;
    label: string;
    color: string;
    createdAt: string;
    importedAt?: string;
    avatarUrl?: string;
    avatarUpdatedAt?: string;
  };
  authMethod: 'biometric' | 'pin';
  lastAccessed: string;
}

// Auth Account Discovery Types
export interface AuthAccountDiscoveryRequest {
  ledgerAddresses: string[]; // Addresses of imported Ledger accounts to search for
  networks?: NetworkId[]; // Which networks to search (defaults to all supported)
  includeExisting?: boolean; // Whether to include accounts already in wallet
}

export interface NetworkAuthAccount {
  address: string; // The rekeyed account address
  authAddress: string; // The Ledger address that has signing authority
  networkId: NetworkId; // Which network this account exists on
  networkName: string; // Display name of the network
  balance?: number | bigint; // Account balance if available
  minBalance?: number | bigint; // Minimum balance requirement
  assetCount?: number; // Number of assets held
  firstSeen?: number; // Timestamp when account was first seen (creation date)
  lastActivity?: number; // Timestamp of last transaction
  existsInWallet: boolean; // Whether this account is already imported
  accountId?: string; // ID if already in wallet
}

export interface AuthAccountDiscoveryResult {
  authAccounts: NetworkAuthAccount[]; // All discovered auth accounts
  ledgerAddresses: string[]; // Ledger addresses that were searched
  searchedNetworks: NetworkId[]; // Networks that were searched
  totalFound: number; // Total number of auth accounts found
  voiAccounts: NetworkAuthAccount[]; // Convenience array for Voi accounts
  algorandAccounts: NetworkAuthAccount[]; // Convenience array for Algorand accounts
  errors?: AuthAccountDiscoveryError[]; // Any errors encountered during discovery
}

export interface AuthAccountDiscoveryError {
  networkId: NetworkId;
  ledgerAddress: string;
  error: string;
  code?: string;
}

export interface ImportAuthAccountRequest {
  authAccount: NetworkAuthAccount;
  label?: string;
  color?: string;
  notes?: string;
}
