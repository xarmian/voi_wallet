import {
  Wallet,
  AccountMetadata,
  AccountType,
  RekeyedAccountMetadata,
  StandardAccountMetadata,
  LedgerAccountMetadata,
  LedgerSigningInfo,
  LedgerTransportMedium,
  LedgerAccountError,
} from '@/types/wallet';
import VoiNetworkService, { RekeyInfo } from '@/services/network';
import { ledgerTransportService } from '@/services/ledger/transport';

export interface SigningAuthorityCheck {
  accountAddress: string;
  canSign: boolean;
  signingAccountId?: string; // ID of the account in wallet that can sign
  signingAddress?: string; // Address that can sign
  isLedger?: boolean;
  signingDeviceId?: string;
  signingDeviceName?: string;
  deviceConnected?: boolean;
  deviceAvailable?: boolean;
  transportType?: LedgerTransportMedium;
}

export interface RekeyDetectionResult {
  rekeyedAccounts: string[];
  signingAuthorities: Record<string, SigningAuthorityCheck>;
}

/**
 * Service for managing rekeyed accounts and detecting signing authorities
 */
export class RekeyManager {
  private static instance: RekeyManager;

  private constructor() {}

  static getInstance(): RekeyManager {
    if (!RekeyManager.instance) {
      RekeyManager.instance = new RekeyManager();
    }
    return RekeyManager.instance;
  }

  /**
   * Check if we have signing authority for a rekeyed account
   * Returns true if we have the private key for the auth address
   */
  async checkSigningAuthority(
    rekeyedAccountAddress: string,
    authAddress: string,
    wallet: Wallet
  ): Promise<SigningAuthorityCheck> {
    try {
      // Look for the auth address in our wallet accounts (standard accounts)
      const signingAccount = wallet.accounts.find(
        (account) =>
          account.address === authAddress &&
          account.type === AccountType.STANDARD
      );

      if (signingAccount) {
        return {
          accountAddress: rekeyedAccountAddress,
          canSign: true,
          signingAccountId: signingAccount.id,
          signingAddress: authAddress,
        };
      }

      const ledgerAccount = wallet.accounts.find(
        (account) =>
          account.address === authAddress && account.type === AccountType.LEDGER
      ) as LedgerAccountMetadata | undefined;

      if (ledgerAccount) {
        const ledgerInfo = await this.getLedgerSigningDetails(ledgerAccount);
        return {
          accountAddress: rekeyedAccountAddress,
          canSign: ledgerInfo.isDeviceConnected || ledgerInfo.isDeviceAvailable,
          signingAccountId: ledgerAccount.id,
          signingAddress: authAddress,
          isLedger: true,
          signingDeviceId: ledgerInfo.deviceId,
          signingDeviceName: ledgerInfo.deviceName,
          deviceConnected: ledgerInfo.isDeviceConnected,
          deviceAvailable: ledgerInfo.isDeviceAvailable,
          transportType: ledgerInfo.transportType,
        };
      }

      return {
        accountAddress: rekeyedAccountAddress,
        canSign: false,
      };
    } catch (error) {
      if (error instanceof LedgerAccountError) {
        throw error;
      }
      console.error('Failed to check signing authority:', error);
      return {
        accountAddress: rekeyedAccountAddress,
        canSign: false,
      };
    }
  }

  /**
   * Scan all accounts in a wallet to detect rekeyed accounts and signing authorities
   */
  async detectRekeyedAccounts(wallet: Wallet): Promise<RekeyDetectionResult> {
    try {
      const allAddresses = wallet.accounts.map((account) => account.address);

      // Get rekey info for all accounts
      const rekeyInfoMap =
        await VoiNetworkService.getMultipleAccountRekeyInfo(allAddresses);

      const rekeyedAccounts: string[] = [];
      const signingAuthorities: Record<string, SigningAuthorityCheck> = {};

      // Check each account for rekey status
      for (const address of allAddresses) {
        const rekeyInfo = rekeyInfoMap[address];

        if (rekeyInfo.isRekeyed && rekeyInfo.authAddress) {
          rekeyedAccounts.push(address);

          // Check if we can sign for this rekeyed account
          const signingCheck = await this.checkSigningAuthority(
            address,
            rekeyInfo.authAddress,
            wallet
          );

          signingAuthorities[address] = signingCheck;
        }
      }

      return {
        rekeyedAccounts,
        signingAuthorities,
      };
    } catch (error) {
      console.error('Failed to detect rekeyed accounts:', error);
      throw new Error(
        `Failed to detect rekeyed accounts: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Update account metadata with rekey information
   */
  async updateAccountWithRekeyInfo(
    account: AccountMetadata,
    rekeyInfo: RekeyInfo,
    wallet: Wallet
  ): Promise<AccountMetadata> {
    try {
      if (!rekeyInfo.isRekeyed || !rekeyInfo.authAddress) {
        // Account is not rekeyed according to network - check if we should auto-convert
        if (account.type === AccountType.REKEYED) {
          const rekeyedAccount = account as RekeyedAccountMetadata;

          // Do NOT auto-convert manually imported auth accounts that have canSign capability
          // These were explicitly imported and should be trusted regardless of network detection
          if (rekeyedAccount.canSign && !rekeyedAccount.originalOwner) {
            console.log(`[RekeyManager] Preserving manually imported auth account: ${account.address.slice(0, 8)}...`);
            return account; // Keep as rekeyed account
          }

          // Convert back to standard account if it was originally a standard account
          if (rekeyedAccount.originalOwner) {
            console.log(`[RekeyManager] Converting rekeyed account back to standard: ${account.address.slice(0, 8)}...`);
            const standardAccount: StandardAccountMetadata = {
              id: account.id,
              address: account.address,
              publicKey: account.publicKey,
              label: account.label,
              color: account.color,
              isHidden: account.isHidden,
              createdAt: account.createdAt,
              importedAt: account.importedAt,
              lastUsed: account.lastUsed,
              type: AccountType.STANDARD,
            };
            return standardAccount;
          } else {
            // Convert back to watch account if it was originally a watch account
            console.log(`[RekeyManager] Converting rekeyed account back to watch: ${account.address.slice(0, 8)}...`);
            const watchAccount = {
              id: account.id,
              address: account.address,
              publicKey: account.publicKey,
              label: account.label,
              color: account.color,
              isHidden: account.isHidden,
              createdAt: account.createdAt,
              importedAt: account.importedAt,
              lastUsed: account.lastUsed,
              type: AccountType.WATCH,
            };
            return watchAccount;
          }
        }

        // Account was never rekeyed, return as-is
        return account;
      }

      // Check if we can sign for this account
      const signingCheck = await this.checkSigningAuthority(
        account.address,
        rekeyInfo.authAddress,
        wallet
      );

      // If this is already a rekeyed account, update it
      if (account.type === AccountType.REKEYED) {
        const rekeyedAccount = account as RekeyedAccountMetadata;
        return {
          ...rekeyedAccount,
          authAddress: rekeyInfo.authAddress,
          rekeyedAt: rekeyInfo.rekeyedAt
            ? new Date(rekeyInfo.rekeyedAt).toISOString()
            : undefined,
          canSign: signingCheck.canSign,
        };
      }

      // Convert standard/watch account to rekeyed account
      const baseMetadata = {
        id: account.id,
        address: account.address,
        publicKey: account.publicKey,
        label: account.label,
        color: account.color,
        isHidden: account.isHidden,
        createdAt: account.createdAt,
        importedAt: account.importedAt,
        lastUsed: account.lastUsed,
      };

      const rekeyedAccount: RekeyedAccountMetadata = {
        ...baseMetadata,
        type: AccountType.REKEYED,
        authAddress: rekeyInfo.authAddress,
        rekeyedAt: rekeyInfo.rekeyedAt
          ? new Date(rekeyInfo.rekeyedAt).toISOString()
          : undefined,
        originalOwner: account.type === AccountType.STANDARD,
        canSign: signingCheck.canSign,
      };

      return rekeyedAccount;
    } catch (error) {
      console.error('Failed to update account with rekey info:', error);
      return account; // Return original account if update fails
    }
  }

  /**
   * Find the signing account for a rekeyed account
   */
  findSigningAccount(
    rekeyedAccount: RekeyedAccountMetadata,
    wallet: Wallet
  ): StandardAccountMetadata | LedgerAccountMetadata | null {
    if (!rekeyedAccount.canSign) {
      return null;
    }

    const signingAccount = wallet.accounts.find(
      (account) =>
        account.address === rekeyedAccount.authAddress &&
        account.type === AccountType.STANDARD
    ) as StandardAccountMetadata | undefined;

    if (signingAccount) {
      return signingAccount;
    }

    const ledgerAccount = wallet.accounts.find(
      (account) =>
        account.address === rekeyedAccount.authAddress &&
        account.type === AccountType.LEDGER
    ) as LedgerAccountMetadata | undefined;

    return ledgerAccount || null;
  }

  /**
   * Check if an account can sign transactions
   * Returns true for standard accounts and rekeyed accounts where we have the auth key
   */
  canAccountSign(account: AccountMetadata, wallet: Wallet): boolean {
    switch (account.type) {
      case AccountType.STANDARD:
        return true;
      case AccountType.REKEYED:
        return (account as RekeyedAccountMetadata).canSign;
      case AccountType.LEDGER:
        return this.isLedgerDeviceConnected(account as LedgerAccountMetadata);
      case AccountType.WATCH:
        return false;
      default:
        return false;
    }
  }

  /**
   * Get the actual signing address for an account
   * For standard accounts, returns the account address
   * For rekeyed accounts, returns the auth address if we can sign
   */
  getSigningAddress(account: AccountMetadata): string | null {
    switch (account.type) {
      case AccountType.STANDARD:
        return account.address;
      case AccountType.LEDGER:
        return account.address;
      case AccountType.REKEYED:
        const rekeyedAccount = account as RekeyedAccountMetadata;
        return rekeyedAccount.canSign ? rekeyedAccount.authAddress : null;
      case AccountType.WATCH:
        return null;
      default:
        return null;
    }
  }

  async rekeyToLedger(
    sourceAccount: AccountMetadata,
    ledgerAccount: LedgerAccountMetadata,
    wallet: Wallet
  ): Promise<RekeyedAccountMetadata> {
    if (sourceAccount.type === AccountType.LEDGER) {
      throw new LedgerAccountError(
        'Cannot rekey a Ledger account to another Ledger account',
        'LEDGER_INVALID_REKEY_SOURCE'
      );
    }

    const ledgerAccountInWallet = wallet.accounts.find(
      (account) =>
        account.id === ledgerAccount.id && account.type === AccountType.LEDGER
    ) as LedgerAccountMetadata | undefined;

    if (!ledgerAccountInWallet) {
      throw new LedgerAccountError(
        'Ledger account not found in wallet',
        'LEDGER_ACCOUNT_NOT_FOUND'
      );
    }

    const ledgerInfo = await this.getLedgerSigningDetails(
      ledgerAccountInWallet
    );

    const baseMetadata = {
      id: sourceAccount.id,
      address: sourceAccount.address,
      publicKey: sourceAccount.publicKey,
      label: sourceAccount.label,
      color: sourceAccount.color,
      isHidden: sourceAccount.isHidden,
      createdAt: sourceAccount.createdAt,
      importedAt: sourceAccount.importedAt,
      lastUsed: sourceAccount.lastUsed,
    };

    return {
      ...baseMetadata,
      type: AccountType.REKEYED,
      authAddress: ledgerAccountInWallet.address,
      originalOwner: sourceAccount.type === AccountType.STANDARD,
      canSign: ledgerInfo
        ? ledgerInfo.isDeviceConnected || ledgerInfo.isDeviceAvailable
        : false,
      rekeyedFrom:
        sourceAccount.type === AccountType.REKEYED
          ? (sourceAccount.rekeyedFrom ?? sourceAccount.address)
          : sourceAccount.address,
    };
  }

  async getLedgerSigningDetailsForAccount(
    account: RekeyedAccountMetadata,
    wallet: Wallet
  ): Promise<LedgerSigningInfo | null> {
    const ledgerAccount = wallet.accounts.find(
      (candidate) =>
        candidate.address === account.authAddress &&
        candidate.type === AccountType.LEDGER
    ) as LedgerAccountMetadata | undefined;

    if (!ledgerAccount) {
      return null;
    }

    return this.getLedgerSigningDetails(ledgerAccount);
  }

  private async getLedgerSigningDetails(
    account: LedgerAccountMetadata
  ): Promise<LedgerSigningInfo> {
    const connectedDevice = ledgerTransportService.getConnectedDevice();
    const isDeviceConnected =
      !!connectedDevice && connectedDevice.id === account.deviceId;

    const availableDevice = isDeviceConnected
      ? connectedDevice
      : ledgerTransportService
          .getDevices()
          .find((device) => device.id === account.deviceId);

    const isDeviceAvailable = Boolean(availableDevice);

    return {
      accountId: account.id,
      address: account.address,
      deviceId: account.deviceId,
      deviceName: account.deviceName,
      derivationIndex: account.derivationIndex,
      derivationPath: account.derivationPath,
      isDeviceConnected,
      isDeviceAvailable,
      requiresConnection: true,
      transportType: availableDevice?.type,
      lastDeviceConnection: account.lastDeviceConnection,
    };
  }

  private isLedgerDeviceConnected(account: LedgerAccountMetadata): boolean {
    const device = ledgerTransportService.getConnectedDevice();
    return !!device && device.id === account.deviceId;
  }
}

export default RekeyManager.getInstance();
