/**
 * Remote Signer Routing Utilities
 *
 * Helpers to detect REMOTE_SIGNER accounts and determine
 * whether transactions should be routed to QR-based signing.
 */

import algosdk from 'algosdk';
import { AccountMetadata, AccountType } from '@/types/wallet';
import { RemoteSignerService } from './index';
import { RemoteSignerRequest } from '@/types/remoteSigner';
import { NetworkService } from '@/services/network';

/**
 * Result of checking if an account needs remote signing
 */
export interface RemoteSigningCheck {
  /** Whether this account requires remote (QR) signing */
  needsRemoteSigning: boolean;
  /** The account if it's a remote signer account */
  remoteSignerAccount?: AccountMetadata;
  /** Error message if account can't be signed */
  error?: string;
}

/**
 * Check if an account requires remote signing via QR codes
 */
export function checkRemoteSigningRequired(
  account: AccountMetadata
): RemoteSigningCheck {
  if (account.type === AccountType.REMOTE_SIGNER) {
    return {
      needsRemoteSigning: true,
      remoteSignerAccount: account,
    };
  }

  if (account.type === AccountType.WATCH) {
    return {
      needsRemoteSigning: false,
      error: 'Watch accounts cannot sign transactions',
    };
  }

  return {
    needsRemoteSigning: false,
  };
}

/**
 * Check multiple accounts and return those that need remote signing
 */
export function filterRemoteSignerAccounts(
  accounts: AccountMetadata[]
): AccountMetadata[] {
  return accounts.filter((acc) => acc.type === AccountType.REMOTE_SIGNER);
}

/**
 * Create a signing request for a remote signer account
 */
export async function createRemoteSigningRequest(
  unsignedTxns: algosdk.Transaction[],
  signerAddresses: string[],
  options?: {
    authAddresses?: (string | undefined)[];
    dappName?: string;
    description?: string;
  }
): Promise<RemoteSignerRequest> {
  return RemoteSignerService.createSigningRequest(
    unsignedTxns,
    signerAddresses,
    options
  );
}

/**
 * Create a signing request from base64-encoded unsigned transactions
 */
export async function createRemoteSigningRequestFromBase64(
  base64Txns: string[],
  signerAddresses: string[],
  options?: {
    authAddresses?: (string | undefined)[];
    dappName?: string;
    description?: string;
  }
): Promise<RemoteSignerRequest> {
  const txns = base64Txns.map((b64) => {
    const bytes = Buffer.from(b64, 'base64');
    return algosdk.decodeUnsignedTransaction(bytes);
  });

  return createRemoteSigningRequest(txns, signerAddresses, options);
}

/**
 * Determines the signing method needed for a set of transactions
 */
export type SigningMethod = 'local' | 'ledger' | 'remote_signer' | 'cannot_sign';

export interface SigningMethodResult {
  method: SigningMethod;
  accounts: AccountMetadata[];
  /** For remote signer, the device IDs involved */
  signerDeviceIds?: string[];
  /** Error if cannot sign */
  error?: string;
}

/**
 * Determine the signing method needed for a transaction
 * based on the account types involved
 */
export function determineSigningMethod(
  accounts: AccountMetadata[]
): SigningMethodResult {
  // Check for remote signer accounts
  const remoteSignerAccounts = accounts.filter(
    (acc) => acc.type === AccountType.REMOTE_SIGNER
  );

  // Check for ledger accounts
  const ledgerAccounts = accounts.filter(
    (acc) => acc.type === AccountType.LEDGER
  );

  // Check for standard accounts
  const standardAccounts = accounts.filter(
    (acc) => acc.type === AccountType.STANDARD
  );

  // Check for watch accounts (cannot sign)
  const watchAccounts = accounts.filter(
    (acc) => acc.type === AccountType.WATCH
  );

  // If any watch accounts, cannot sign
  if (watchAccounts.length > 0) {
    return {
      method: 'cannot_sign',
      accounts,
      error: 'Watch accounts cannot sign transactions',
    };
  }

  // If any remote signer accounts, use remote signing
  // (even if mixed with other types - remote signer takes precedence)
  if (remoteSignerAccounts.length > 0) {
    const deviceIds = new Set<string>();
    remoteSignerAccounts.forEach((acc) => {
      if (acc.type === AccountType.REMOTE_SIGNER) {
        deviceIds.add((acc as any).signerDeviceId);
      }
    });

    return {
      method: 'remote_signer',
      accounts: remoteSignerAccounts,
      signerDeviceIds: Array.from(deviceIds),
    };
  }

  // If any ledger accounts, use ledger signing
  if (ledgerAccounts.length > 0) {
    return {
      method: 'ledger',
      accounts: ledgerAccounts,
    };
  }

  // Default to local signing
  if (standardAccounts.length > 0) {
    return {
      method: 'local',
      accounts: standardAccounts,
    };
  }

  // No signable accounts
  return {
    method: 'cannot_sign',
    accounts,
    error: 'No accounts available that can sign',
  };
}

/**
 * Error thrown when attempting to sign with a remote signer account
 * but not using the QR flow
 */
export class RemoteSignerRequiredError extends Error {
  constructor(
    public readonly accountAddress: string,
    public readonly signerDeviceId: string
  ) {
    super(
      `Account ${accountAddress} is a remote signer account. Use QR-based signing instead.`
    );
    this.name = 'RemoteSignerRequiredError';
  }
}

/**
 * Validate that an account can be signed directly (not via remote signer)
 * Throws RemoteSignerRequiredError if the account needs remote signing
 */
export function validateNotRemoteSigner(account: AccountMetadata): void {
  if (account.type === AccountType.REMOTE_SIGNER) {
    const rsAccount = account as any;
    throw new RemoteSignerRequiredError(
      account.address,
      rsAccount.signerDeviceId
    );
  }
}
