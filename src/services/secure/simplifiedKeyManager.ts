import { AccountSecureStorage } from './AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  AccountType,
  LedgerAccountMetadata,
  LedgerSigningInfo,
  LedgerAccountError,
} from '@/types/wallet';
import { SecureKeyManager as NetworkKeyManager } from './keyManager';
import { NetworkId } from '@/types/network';
import {
  simpleLedgerSigner,
  SimpleLedgerSigningRequest,
} from '@/services/ledger/simpleLedgerSigner';
import algosdk, { Transaction } from 'algosdk';
import { redactError } from '@/utils/logRedaction';
import { assertSignableKeyreg } from '@/utils/keyregSafety';

/**
 * Simplified Key Manager
 * Replaces the complex key manager with a cleaner implementation using our new Ledger system
 */

export interface SecureKeyRequest {
  address: string;
  purpose: 'transaction' | 'export' | 'verification';
  metadata?: Record<string, any>;
}

export class SimplifiedKeyManager {
  /**
   * Get private key for specific address using biometric/PIN authentication
   */
  static async getPrivateKey(
    request: SecureKeyRequest,
    pin?: string
  ): Promise<Uint8Array> {
    try {
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      if (!wallet) {
        throw new Error('No wallet found');
      }

      const account = wallet.accounts.find(
        (acc) => acc.address === request.address
      );
      if (!account) {
        throw new Error('Account not found');
      }

      // Only return private keys for standard (non-Ledger) accounts
      if (account.type === AccountType.LEDGER) {
        throw new Error('Cannot retrieve private key for Ledger accounts');
      }

      return await AccountSecureStorage.getPrivateKey(account.id, pin);
    } catch (error) {
      throw new Error(
        `Failed to retrieve private key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Sign transaction with automatic Ledger/software key handling
   */
  static async signTransaction(
    transaction: any,
    address: string,
    pin: string | undefined,
    networkId: NetworkId
  ): Promise<Uint8Array> {
    try {
      // TASK-439: never sign a permanent non-participation keyreg.
      if (transaction) {
        assertSignableKeyreg(transaction);
      }

      const wallet = await MultiAccountWalletService.getCurrentWallet();
      if (!wallet) {
        throw new Error('No wallet found');
      }

      const account = wallet.accounts.find((acc) => acc.address === address);
      if (!account) {
        throw new Error('Account not found');
      }

      // Determine signing approach based on account type
      const signingInfo = await this.getSigningInfo(address, networkId);

      if (signingInfo.requiresLedger) {
        return await this.signWithLedger(transaction, signingInfo, address);
      } else {
        return await this.signWithSoftwareKey(
          transaction,
          signingInfo.signingAddress,
          pin
        );
      }
    } catch (error) {
      console.error('Transaction signing failed:', redactError(error));
      throw error;
    }
  }

  /**
   * Sign transaction using Ledger device
   */
  private static async signWithLedger(
    transaction: any,
    signingInfo: any,
    originalAddress: string
  ): Promise<Uint8Array> {
    const ledgerInfo = await this.getLedgerSigningInfo(
      signingInfo.signingAddress || originalAddress
    );

    const signingRequest: SimpleLedgerSigningRequest = {
      transaction: transaction as Transaction | Uint8Array,
      derivationIndex: ledgerInfo.derivationIndex,
      signerAddress:
        signingInfo.signingAddress !== originalAddress
          ? signingInfo.signingAddress
          : undefined,
    };

    const result = await simpleLedgerSigner.signTransaction(signingRequest);
    return result.signedTransaction;
  }

  /**
   * Sign transaction using software private key
   */
  private static async signWithSoftwareKey(
    transaction: any,
    signingAddress: string,
    pin?: string
  ): Promise<Uint8Array> {
    let privateKey: Uint8Array | null = null;

    try {
      privateKey = await this.getPrivateKey(
        {
          address: signingAddress,
          purpose: 'transaction',
        },
        pin
      );

      const signedTxn = algosdk.signTransaction(transaction, privateKey);
      return signedTxn.blob;
    } finally {
      if (privateKey) {
        privateKey.fill(0);
        privateKey = null;
      }
    }
  }

  /**
   * Get comprehensive signing information for an address
   */
  static async getSigningInfo(
    address: string,
    networkId: NetworkId
  ): Promise<{
    canSign: boolean;
    signingAddress: string;
    signingAccountId?: string;
    isRekeyed: boolean;
    authAddress?: string;
    requiresLedger: boolean;
  }> {
    const info = await NetworkKeyManager.getSigningInfo(address, networkId);
    const wallet = await MultiAccountWalletService.getCurrentWallet();
    return {
      ...info,
      requiresLedger:
        wallet?.accounts.some(
          (acc) =>
            acc.id === info.signingAccountId && acc.type === AccountType.LEDGER
        ) ?? false,
    };
  }

  /**
   * Get Ledger signing information for an account
   */
  static async getLedgerSigningInfo(
    identifier: string,
    options: { lookupByAddress?: boolean } = {}
  ): Promise<LedgerSigningInfo> {
    const { lookupByAddress = true } = options;

    const wallet = await MultiAccountWalletService.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    let account = wallet.accounts.find((acc) => acc.id === identifier);
    if (!account && lookupByAddress) {
      account = wallet.accounts.find((acc) => acc.address === identifier);
    }

    if (!account) {
      throw new LedgerAccountError(
        'Ledger account not found',
        'LEDGER_ACCOUNT_NOT_FOUND'
      );
    }

    if (account.type !== AccountType.LEDGER) {
      throw new LedgerAccountError(
        'Account is not Ledger-controlled',
        'LEDGER_ACCOUNT_TYPE_MISMATCH'
      );
    }

    const ledgerAccount = account as LedgerAccountMetadata;

    // Use simplified ledger manager to get device status
    const deviceInfo = simpleLedgerSigner.getDeviceInfo();

    return {
      accountId: ledgerAccount.id,
      address: ledgerAccount.address,
      deviceId: ledgerAccount.deviceId,
      deviceName: ledgerAccount.deviceName,
      derivationIndex: ledgerAccount.derivationIndex,
      derivationPath: ledgerAccount.derivationPath,
      isDeviceConnected: deviceInfo.connected,
      isDeviceAvailable: !!deviceInfo.device,
      requiresConnection: !deviceInfo.connected,
      transportType: deviceInfo.device?.type,
      lastDeviceConnection: ledgerAccount.lastDeviceConnection,
      signerAddress: ledgerAccount.address, // Add this required field
    };
  }

  /**
   * Check if an address can be signed with current wallet
   */
  static async canSignTransaction(
    address: string,
    networkId: NetworkId
  ): Promise<boolean> {
    try {
      const signingInfo = await this.getSigningInfo(address, networkId);
      return signingInfo.canSign;
    } catch {
      return false;
    }
  }

  /**
   * Get list of signing accounts (accounts that can sign transactions)
   */
  static async getSigningAccounts(networkId: NetworkId): Promise<
    {
      id: string;
      address: string;
      type: AccountType;
      canSign: boolean;
      requiresLedger: boolean;
    }[]
  > {
    try {
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      if (!wallet) {
        return [];
      }

      const signingAccounts = [];

      for (const account of wallet.accounts) {
        const info = await this.getSigningInfo(account.address, networkId);
        if (
          account.type === AccountType.STANDARD ||
          account.type === AccountType.LEDGER
        ) {
          signingAccounts.push({
            id: account.id,
            address: account.address,
            type: account.type,
            canSign: info.canSign,
            requiresLedger: info.requiresLedger,
          });
        } else if (account.type === AccountType.REKEYED) {
          signingAccounts.push({
            id: account.id,
            address: account.address,
            type: account.type,
            canSign: info.canSign,
            requiresLedger: info.requiresLedger,
          });
        }
      }

      return signingAccounts;
    } catch (error) {
      console.error('Failed to get signing accounts:', redactError(error));
      throw error;
    }
  }

  /**
   * Validate that a transaction can be signed
   */
  static async validateSigningCapability(
    addresses: string[],
    networkId: NetworkId
  ): Promise<{
    canSign: boolean;
    missingSigners: string[];
    ledgerRequired: boolean;
  }> {
    const missingSigners: string[] = [];
    let ledgerRequired = false;

    for (const address of addresses) {
      const signingInfo = await this.getSigningInfo(address, networkId);
      if (!signingInfo.canSign) {
        missingSigners.push(address);
      }
      if (signingInfo.requiresLedger) {
        ledgerRequired = true;
      }
    }

    return {
      canSign: missingSigners.length === 0,
      missingSigners,
      ledgerRequired,
    };
  }
}

// Export for compatibility
export { SimplifiedKeyManager as SecureKeyManager };
