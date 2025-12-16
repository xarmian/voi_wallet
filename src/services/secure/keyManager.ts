import { AccountSecureStorage } from './AccountSecureStorage';
import { MultiAccountWalletService } from '@/services/wallet';
import {
  AccountType,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  LedgerSigningInfo,
  LedgerDeviceNotConnectedError,
  LedgerAccountError,
} from '@/types/wallet';
import RekeyManager from '@/services/wallet/rekeyManager';
import { ledgerAlgorandService } from '@/services/ledger/algorand';
import { ledgerTransportService } from '@/services/ledger/transport';
import type { LedgerDeviceInfo } from '@/services/ledger/transport';
import algosdk, { Transaction } from 'algosdk';
import { NetworkService } from '@/services/network';

/**
 * Secure Key Manager - Simplified version using AccountSecureStorage
 * Provides compatibility layer for existing code
 */

export interface SecureKeyRequest {
  address: string;
  purpose: 'transaction' | 'export' | 'verification';
  metadata?: Record<string, any>;
}

export class SecureKeyManager {
  /**
   * Get private key for specific address using biometric/PIN authentication
   * Uses our new AccountSecureStorage system
   */
  static async getPrivateKey(
    request: SecureKeyRequest,
    pin?: string
  ): Promise<Uint8Array> {
    try {
      // Find the account by address
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

      // Get private key using AccountSecureStorage (handles authentication and caching internally)
      return await AccountSecureStorage.getPrivateKey(account.id, pin);
    } catch (error) {
      throw new Error(
        `Failed to retrieve private key: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Sign transaction with secure key access
   * Handles rekeyed accounts by using the auth address's private key
   * @param networkId - Optional network ID to check network-specific rekey status
   */
  static async signTransaction(
    transaction: any,
    address: string,
    pin?: string,
    networkId?: import('@/types/network').NetworkId
  ): Promise<Uint8Array> {
    let privateKey: Uint8Array | null = null;

    try {
      // Find the account by address
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      if (!wallet) {
        throw new Error('No wallet found');
      }

      const account = wallet.accounts.find((acc) => acc.address === address);
      if (!account) {
        throw new Error('Account not found');
      }

      // Determine which address to use for signing
      let signingAddress = address;

      // Check network-specific rekey status
      // Skip timestamp lookup for performance - we only need to know IF rekeyed and the auth address
      const networkService = NetworkService.getInstance(networkId);
      const rekeyInfo = await networkService.getAccountRekeyInfo(address, true); // skipTimestamp = true

      // If account is rekeyed on this network, use the auth address for signing
      if (rekeyInfo.isRekeyed && rekeyInfo.authAddress) {
        signingAddress = rekeyInfo.authAddress;

        // Find the signing account in our wallet
        const signingAccount = wallet.accounts.find(
          (acc) =>
            acc.address.toUpperCase() === signingAddress.toUpperCase() &&
            (acc.type === AccountType.STANDARD || acc.type === AccountType.LEDGER)
        );

        if (!signingAccount) {
          throw new Error(
            `Cannot sign transactions for this rekeyed account - signing key not available`
          );
        }

        // If the signing account is a Ledger account, sign using Ledger
        if (signingAccount.type === AccountType.LEDGER) {
          const ledgerAccount = signingAccount as LedgerAccountMetadata;
          await this.ensureLedgerDeviceReady(ledgerAccount);

          if (!transaction) {
            throw new Error('Transaction is null or undefined');
          }

          const result = await ledgerAlgorandService.signTransaction({
            transaction: transaction as Transaction | Uint8Array,
            derivationIndex: ledgerAccount.derivationIndex,
            signerAddress: signingAddress,
          });
          return result.signedTransaction;
        }
        // If standard account, continue to private key flow below with signingAddress
      }

      // For watch-only accounts that aren't rekeyed, we can't sign
      if (account.type === AccountType.WATCH && !rekeyInfo.isRekeyed) {
        throw new Error('Cannot sign transactions for watch-only accounts');
      }

      // Handle Ledger accounts
      if (account.type === AccountType.LEDGER) {
        const ledgerAccount = account as LedgerAccountMetadata;

        try {
          // Attempt to ensure the device is ready; if not connected, this will try to discover and connect.
          await this.ensureLedgerDeviceReady(ledgerAccount);

          if (!transaction) {
            throw new Error('Transaction is null or undefined');
          }

          const result = await ledgerAlgorandService.signTransaction({
            transaction: transaction as Transaction | Uint8Array,
            derivationIndex: ledgerAccount.derivationIndex,
            signerAddress: address,
          });

          return result.signedTransaction;
        } catch (error) {
          console.error('Ledger Signing Error:', error);

          // Normalize to LedgerAccountError for unexpected issues; known types propagate
          if (error instanceof LedgerDeviceNotConnectedError) {
            throw error;
          }
          if (error instanceof LedgerAccountError) {
            throw error;
          }
          throw new LedgerAccountError(
            `Failed to sign transaction with Ledger device: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Get the private key for the signing address
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
      // Clear private key from memory
      if (privateKey) {
        privateKey.fill(0);
        privateKey = null as any;
      }
      // Force garbage collection in development to clear any remaining references
      if (__DEV__ && global.gc) {
        global.gc();
      }
    }
  }

  /**
   * Get signing information for an account
   * Returns the actual address that will be used for signing and whether signing is possible
   * @param address - The account address to check
   * @param networkId - Optional network ID to check network-specific rekey status
   * WARNING: For transaction signing, ALWAYS provide networkId to avoid using wrong network's rekey state
   */
  static async getSigningInfo(
    address: string,
    networkId?: import('@/types/network').NetworkId
  ): Promise<{
    canSign: boolean;
    signingAddress: string;
    signingAccountId?: string;
    isRekeyed: boolean;
    authAddress?: string;
  }> {
    try {
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      if (!wallet) {
        return {
          canSign: false,
          signingAddress: address,
          isRekeyed: false,
        };
      }

      const account = wallet.accounts.find((acc) => acc.address === address);
      if (!account) {
        return {
          canSign: false,
          signingAddress: address,
          isRekeyed: false,
        };
      }

      if (account.type === AccountType.STANDARD) {
        return {
          canSign: true,
          signingAddress: address,
          signingAccountId: account.id,
          isRekeyed: false,
        };
      }

      if (account.type === AccountType.LEDGER) {
        // User can sign with Ledger accounts regardless of current connection state.
        // Connection will be handled just-in-time during signing.
        return {
          canSign: true,
          signingAddress: address,
          signingAccountId: account.id,
          isRekeyed: false,
        };
      }

      if (account.type === AccountType.REKEYED) {
        const rekeyedAccount = account as RekeyedAccountMetadata;
        const signingAccount = RekeyManager.findSigningAccount(
          rekeyedAccount,
          wallet
        );

        return {
          canSign: rekeyedAccount.canSign,
          signingAddress: rekeyedAccount.authAddress,
          signingAccountId: signingAccount?.id,
          isRekeyed: true,
          authAddress: rekeyedAccount.authAddress,
        };
      }
      // WATCH accounts: detect if rekeyed to an account we control (standard or Ledger)
      // If rekeyed to a standard account in our wallet, report canSign true
      // If rekeyed to a Ledger account in our wallet, report canSign false but include signer identifiers
      try {
        // Use network-specific service to check rekey status
        const networkService = NetworkService.getInstance(networkId);
        const rekeyInfo = await networkService.getAccountRekeyInfo(address);
        if (rekeyInfo.isRekeyed && rekeyInfo.authAddress) {
          const signer = wallet.accounts.find(
            (acc) => acc.address === rekeyInfo.authAddress
          );

          if (signer?.type === AccountType.STANDARD) {
            return {
              canSign: true,
              signingAddress: rekeyInfo.authAddress,
              signingAccountId: signer.id,
              isRekeyed: true,
              authAddress: rekeyInfo.authAddress,
            };
          }

          if (signer?.type === AccountType.LEDGER) {
            return {
              canSign: false,
              signingAddress: rekeyInfo.authAddress,
              signingAccountId: signer.id,
              isRekeyed: true,
              authAddress: rekeyInfo.authAddress,
            };
          }

          // Rekeyed but signer not in wallet
          return {
            canSign: false,
            signingAddress: rekeyInfo.authAddress,
            isRekeyed: true,
            authAddress: rekeyInfo.authAddress,
          };
        }
      } catch {}

      // Not rekeyed or unable to detect signer for watch account
      return {
        canSign: false,
        signingAddress: address,
        isRekeyed: false,
      };
    } catch (error) {
      console.error('Failed to get signing info:', error);
      return {
        canSign: false,
        signingAddress: address,
        isRekeyed: false,
      };
    }
  }

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
    const connectedDevice = ledgerTransportService.getConnectedDevice();
    const isDeviceConnected =
      !!connectedDevice && connectedDevice.id === ledgerAccount.deviceId;

    const availableDevice = isDeviceConnected
      ? connectedDevice
      : ledgerTransportService
          .getDevices()
          .find((device) => device.id === ledgerAccount.deviceId);

    const isDeviceAvailable = !!availableDevice;

    return {
      accountId: ledgerAccount.id,
      address: ledgerAccount.address,
      deviceId: ledgerAccount.deviceId,
      deviceName: ledgerAccount.deviceName,
      derivationIndex: ledgerAccount.derivationIndex,
      derivationPath: ledgerAccount.derivationPath,
      isDeviceConnected,
      isDeviceAvailable,
      requiresConnection: true,
      transportType: availableDevice?.type,
      lastDeviceConnection: ledgerAccount.lastDeviceConnection,
    };
  }

  /**
   * Check if wallet has accounts (compatibility method)
   */
  static async hasEncryptedMnemonic(): Promise<boolean> {
    try {
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      return wallet !== null && wallet.accounts.length > 0;
    } catch {
      return false;
    }
  }

  private static async ensureLedgerDeviceReady(
    account: LedgerAccountMetadata
  ): Promise<void> {
    const connectedDevice = ledgerTransportService.getConnectedDevice();
    if (connectedDevice && connectedDevice.id === account.deviceId) {
      await MultiAccountWalletService.updateLedgerAccountDevice(
        account.id,
        connectedDevice
      );

      // Skip app verification during active signing to avoid race conditions
      // The signing process will handle any app verification errors appropriately
      try {
        await ledgerAlgorandService.verifyApp({ requireAppOpen: true });
      } catch (error) {
        // If verification fails due to race condition during signing, continue anyway
        // The signing process will handle and report the actual error
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (message.includes('race') || message.includes('pending') || message.includes('communication')) {
          console.log('⏭️ Skipping app verification due to race condition during signing');
          return;
        }
        throw error;
      }
      return;
    }

    let deviceInfo: LedgerDeviceInfo | undefined = ledgerTransportService
      .getDevices()
      .find((device) => device.id === account.deviceId);

    // Always initialize to ensure discovery is configured and persisted devices are loaded
    await ledgerTransportService.initialize();

    // If we have a persisted record but the device is not currently connected,
    // actively wait for it to be discovered (powered on and in range) before attempting connect.
    let discoveredNow = false;
    if (!deviceInfo || !deviceInfo.connected) {
      // Refresh view of devices after initialize
      deviceInfo = ledgerTransportService
        .getDevices()
        .find((device) => device.id === account.deviceId);

      if (!deviceInfo || !deviceInfo.connected) {
        // Begin active discovery and wait until it appears
        const discovered = await ledgerTransportService.waitForDevice(
          account.deviceId,
          15000
        );
        if (discovered) {
          deviceInfo = discovered;
          discoveredNow = true;
        }
      }
    }

    if (!deviceInfo) {
      throw new LedgerDeviceNotConnectedError(
        'Ledger device not found. Please power on your Ledger and open the Algorand app.'
      );
    }

    // If the device was not discovered during this attempt and is not already connected,
    // do not attempt a blind connect against only a persisted record.
    if (!deviceInfo.connected && !discoveredNow) {
      throw new LedgerDeviceNotConnectedError(
        'Ledger device is not available. Ensure it is powered on, unlocked, and the Algorand app is open.'
      );
    }

    // Attempt a connect (for newly discovered or connected devices)
    await ledgerTransportService.connect(deviceInfo.id, {
      transportType: deviceInfo.type,
    });

    const refreshedDevice = ledgerTransportService.getConnectedDevice();
    if (!refreshedDevice || refreshedDevice.id !== account.deviceId) {
      throw new LedgerDeviceNotConnectedError(
        'Unable to connect to the Ledger device. Ensure it is unlocked and the Algorand app is open.'
      );
    }

    await MultiAccountWalletService.updateLedgerAccountDevice(
      account.id,
      refreshedDevice
    );

    // Skip app verification during active signing to avoid race conditions
    try {
      await ledgerAlgorandService.verifyApp({ requireAppOpen: true });
    } catch (error) {
      // If verification fails due to race condition during signing, continue anyway
      const message = error instanceof Error ? error.message.toLowerCase() : '';
      if (message.includes('race') || message.includes('pending') || message.includes('communication')) {
        console.log('⏭️ Skipping app verification due to race condition during signing');
        return;
      }
      throw error;
    }
  }

  /**
   * Get mnemonic for specific address from account metadata (when wallet is unlocked)
   * This is much simpler than going through private key decryption
   */
  static async getMnemonic(address: string): Promise<string> {
    try {
      // Find the account by address
      const wallet = await MultiAccountWalletService.getCurrentWallet();
      if (!wallet) {
        throw new Error('No wallet found');
      }

      const account = wallet.accounts.find((acc) => acc.address === address);
      if (!account) {
        throw new Error('Account not found');
      }

      // Check if it's a standard account with mnemonic
      // TEMPORARY: Allow any account type to check if private key exists
      if (account.type !== 'standard' && account.type !== 'watch') {
        throw new Error('This account type does not have a recovery phrase');
      }

      const standardAccount =
        account as import('@/types/wallet').StandardAccountMetadata;

      const storedMnemonic = standardAccount.mnemonic?.trim();
      if (storedMnemonic) {
        return storedMnemonic;
      }

      let privateKey: Uint8Array | null = null;
      try {
        privateKey = await AccountSecureStorage.getPrivateKey(
          standardAccount.id
        );
        const derivedMnemonic = algosdk.secretKeyToMnemonic(privateKey);
        return derivedMnemonic;
      } catch (privateKeyError) {
        throw privateKeyError;
      } finally {
        if (privateKey) {
          privateKey.fill(0);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to retrieve recovery phrase: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Clear all data
   */
  static async clearAll(): Promise<void> {
    try {
      await AccountSecureStorage.clearAll();
    } catch (error) {
      console.error('Failed to clear secure storage:', error);
    }
  }
}
