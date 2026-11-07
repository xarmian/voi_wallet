import {
  Wallet,
  AccountMetadata,
  AccountType,
  BackupMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
  LedgerSigningInfo,
  LedgerAccountError,
} from '@/types/wallet';
import { ledgerTransportService } from '@/services/ledger/transport';

// Conversions preserve only the source account's own backup history.
function sourceBackupMetadata(account: AccountMetadata): BackupMetadata {
  if (
    account.type !== AccountType.STANDARD &&
    account.type !== AccountType.REKEYED
  ) {
    return {};
  }
  return {
    hasBackup: account.hasBackup,
    backupVerified: account.backupVerified,
    backupCreatedAt: account.backupCreatedAt,
  };
}

/**
 * Service for explicit rekey-to-Ledger and rekey-to-airgap metadata (balance
 * loads no longer detect or convert rekeyed accounts, TASK-425 U5)
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
      ...sourceBackupMetadata(sourceAccount),
      type: AccountType.REKEYED,
      authAddress: ledgerAccountInWallet.address,
      // TASK-419: preserve ownership through repeated rekeys; the original key
      // is still retained, and hasKeyBearingAccountStrict relies on this flag.
      originalOwner:
        sourceAccount.type === AccountType.STANDARD ||
        (sourceAccount.type === AccountType.REKEYED &&
          (sourceAccount as RekeyedAccountMetadata).originalOwner === true),
      canSign: ledgerInfo
        ? ledgerInfo.isDeviceConnected || ledgerInfo.isDeviceAvailable
        : false,
      rekeyedFrom:
        sourceAccount.type === AccountType.REKEYED
          ? (sourceAccount.rekeyedFrom ?? sourceAccount.address)
          : sourceAccount.address,
    };
  }

  /**
   * Create rekeyed account metadata for an account being rekeyed to an airgap signer
   * This is called AFTER the rekey transaction has been successfully submitted
   *
   * @param sourceAccount - The account being rekeyed
   * @param airgapAccount - The airgap signer account that will have signing authority
   * @param wallet - The current wallet
   */
  async rekeyToAirgap(
    sourceAccount: AccountMetadata,
    airgapAccount: RemoteSignerAccountMetadata,
    wallet: Wallet
  ): Promise<RekeyedAccountMetadata> {
    if (sourceAccount.type === AccountType.REMOTE_SIGNER) {
      throw new Error(
        'Cannot rekey a remote signer account to another remote signer'
      );
    }

    // Verify the airgap account exists in wallet
    const airgapAccountInWallet = wallet.accounts.find(
      (account) =>
        account.id === airgapAccount.id &&
        account.type === AccountType.REMOTE_SIGNER
    ) as RemoteSignerAccountMetadata | undefined;

    if (!airgapAccountInWallet) {
      throw new Error('Airgap signer account not found in wallet');
    }

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
      ...sourceBackupMetadata(sourceAccount),
      type: AccountType.REKEYED,
      authAddress: airgapAccountInWallet.address,
      // TASK-419: preserve ownership through repeated rekeys; the original key
      // is still retained, and hasKeyBearingAccountStrict relies on this flag.
      originalOwner:
        sourceAccount.type === AccountType.STANDARD ||
        (sourceAccount.type === AccountType.REKEYED &&
          (sourceAccount as RekeyedAccountMetadata).originalOwner === true),
      canSign: true, // Airgap accounts can always sign via QR flow
      rekeyedFrom:
        sourceAccount.type === AccountType.REKEYED
          ? ((sourceAccount as RekeyedAccountMetadata).rekeyedFrom ??
            sourceAccount.address)
          : sourceAccount.address,
    };
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
}

export default RekeyManager.getInstance();
