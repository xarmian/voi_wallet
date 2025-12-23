import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import { storage, secureStorage } from '../../platform';
import {
  WalletAccount,
  WalletInfo,
  AccountType,
  AccountMetadata,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  LedgerAccountMetadata,
  RemoteSignerAccountMetadata,
  CreateAccountRequest,
  ImportAccountRequest,
  ImportLedgerAccountRequest,
  DetectLedgerAccountsRequest,
  LedgerAccountDiscoveryResult,
  AddWatchAccountRequest,
  DetectRekeyedAccountRequest,
  ImportRemoteSignerAccountRequest,
  AccountNotFoundError,
  AccountExistsError,
  InvalidAddressError,
  InvalidMnemonicError,
  LedgerAccountError,
  LedgerDeviceNotConnectedError,
  RekeyVerificationError,
  Wallet,
  WalletSettings,
} from '@/types/wallet';
import { AccountSecureStorage } from '../secure/AccountSecureStorage';
import { ledgerTransportService } from '@/services/ledger/transport';
import type { LedgerDeviceInfo } from '@/services/ledger/transport';
import { ledgerAlgorandService } from '@/services/ledger/algorand';
import type { LedgerAccountDerivation } from '@/services/ledger/algorand';

export class MultiAccountWalletService {
  private static readonly STORAGE_PREFIX = 'voi_account_';
  private static readonly WALLET_KEY = 'voi_wallet_metadata';

  // Account Management Methods
  static async createStandardAccount(
    request: CreateAccountRequest
  ): Promise<StandardAccountMetadata> {
    try {
      const account = algosdk.generateAccount();
      const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

      const accountMetadata: StandardAccountMetadata = {
        id: this.generateAccountId(),
        address: account.addr,
        publicKey: Buffer.from(account.sk.slice(32)).toString('hex'),
        type: AccountType.STANDARD,
        label: request.label || `Account ${(await this.getAccountCount()) + 1}`,
        color: request.color || this.generateAccountColor(),
        isHidden: false,
        createdAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        mnemonic,
        hasBackup: false,
      };

      const secretKey = account.sk;
      try {
        await this.storeAccountSecurely(accountMetadata, secretKey);
        await this.addAccountToWallet(accountMetadata);
        return accountMetadata;
      } finally {
        if (secretKey) {
          secretKey.fill(0);
        }
      }
    } catch (error) {
      throw new Error(
        `Failed to create account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async importStandardAccount(
    request: ImportAccountRequest
  ): Promise<StandardAccountMetadata> {
    try {
      let account: algosdk.Account;

      if (request.mnemonic) {
        const cleanMnemonic = this.cleanMnemonic(request.mnemonic);
        if (!this.validateMnemonic(cleanMnemonic)) {
          throw new InvalidMnemonicError('Invalid mnemonic phrase');
        }
        account = algosdk.mnemonicToSecretKey(cleanMnemonic);
        // Derive public key from secret key (last 32 bytes)
        (account as any).publicKey = account.sk.slice(32);
      } else if (request.privateKey) {
        // Handle private key import
        const privateKeyBytes = this.parsePrivateKey(request.privateKey);
        const publicKey = privateKeyBytes.slice(32);
        const address = algosdk.encodeAddress(publicKey);
        account = { sk: privateKeyBytes, addr: address, publicKey };
      } else {
        throw new Error('Either mnemonic or private key must be provided');
      }

      // Check if account already exists
      const existingAccount = await this.findAccountByAddress(account.addr);
      if (existingAccount) {
        throw new AccountExistsError('Account already exists in wallet');
      }

      const mnemonic = request.mnemonic
        ? this.cleanMnemonic(request.mnemonic)
        : algosdk.secretKeyToMnemonic(account.sk);

      const accountMetadata: StandardAccountMetadata = {
        id: this.generateAccountId(),
        address: account.addr,
        publicKey: Buffer.from(
          (account as any).publicKey ?? account.sk.slice(32)
        ).toString('hex'),
        type: AccountType.STANDARD,
        label:
          request.label ||
          `Imported Account ${(await this.getAccountCount()) + 1}`,
        color: request.color || this.generateAccountColor(),
        isHidden: false,
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        mnemonic,
        hasBackup: !!request.mnemonic, // Assume imported mnemonics are backed up
      };

      const secretKey = account.sk;
      try {
        await this.storeAccountSecurely(accountMetadata, secretKey);
        await this.addAccountToWallet(accountMetadata);
        return accountMetadata;
      } finally {
        if (secretKey) {
          secretKey.fill(0);
        }
      }
    } catch (error) {
      if (
        error instanceof InvalidMnemonicError ||
        error instanceof AccountExistsError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to import account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async importLedgerAccount(
    request: ImportLedgerAccountRequest,
    derivedAccount?: LedgerAccountDerivation
  ): Promise<LedgerAccountMetadata> {
    if (!request.deviceId || request.deviceId.trim().length === 0) {
      throw new LedgerAccountError(
        'Ledger device identifier is required',
        'LEDGER_DEVICE_ID_REQUIRED'
      );
    }

    if (
      !Number.isInteger(request.derivationIndex) ||
      request.derivationIndex < 0
    ) {
      throw new LedgerAccountError(
        'Derivation index must be a non-negative integer',
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }

    const connectedDevice = ledgerTransportService.getConnectedDevice();
    if (!connectedDevice || connectedDevice.id !== request.deviceId) {
      throw new LedgerDeviceNotConnectedError(
        'Specified Ledger device is not currently connected'
      );
    }

    const wallet = await this.getCurrentWallet();

    try {
      const derived =
        derivedAccount ??
        (await ledgerAlgorandService.deriveAccount(request.derivationIndex, {
          displayOnDevice: false,
        }));

      if (
        request.derivationPath &&
        request.derivationPath !== derived.derivationPath
      ) {
        throw new LedgerAccountError(
          'Provided derivation path does not match Ledger device output',
          'LEDGER_DERIVATION_MISMATCH'
        );
      }

      // Check for duplicate accounts
      const existingAccount = await this.findAccountByAddress(derived.address);
      if (existingAccount) {
        throw new AccountExistsError('Account already exists in wallet');
      }

      const now = new Date().toISOString();
      const ledgerAccountCount = wallet
        ? wallet.accounts.filter((acc) => acc.type === AccountType.LEDGER)
            .length
        : 0;

      const accountMetadata: LedgerAccountMetadata = {
        id: this.generateAccountId(),
        address: derived.address,
        publicKey: derived.publicKey,
        type: AccountType.LEDGER,
        label:
          request.label ||
          request.deviceName ||
          `Ledger Account ${ledgerAccountCount + 1}`,
        color: request.color || this.generateAccountColor(),
        isHidden: false,
        createdAt: now,
        importedAt: now,
        lastUsed: now,
        deviceId: request.deviceId,
        deviceName: request.deviceName ?? connectedDevice.name,
        derivationIndex: request.derivationIndex,
        derivationPath: derived.derivationPath,
        lastDeviceConnection: now,
      };

      if (!wallet) {
        const newWallet: Wallet = {
          id: this.generateWalletId(),
          version: '1.0',
          createdAt: now,
          accounts: [accountMetadata],
          activeAccountId: accountMetadata.id,
          settings: this.getDefaultWalletSettings(),
        };

        await this.storeWallet(newWallet);
      } else {
        wallet.accounts.push(accountMetadata);
        await this.storeWallet(wallet);
      }

      return accountMetadata;
    } catch (error) {
      if (
        error instanceof AccountExistsError ||
        error instanceof LedgerAccountError ||
        error instanceof LedgerDeviceNotConnectedError
      ) {
        throw error;
      }

      throw new LedgerAccountError(
        `Failed to import Ledger account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async importLedgerAccountFromDevice(
    deviceInfo: LedgerDeviceInfo,
    derivationIndex: number,
    options: { label?: string; color?: string; displayOnDevice?: boolean } = {}
  ): Promise<LedgerAccountMetadata> {
    if (!deviceInfo || !deviceInfo.id) {
      throw new LedgerAccountError(
        'Ledger device information is required',
        'LEDGER_DEVICE_REQUIRED'
      );
    }

    if (!Number.isInteger(derivationIndex) || derivationIndex < 0) {
      throw new LedgerAccountError(
        'Derivation index must be a non-negative integer',
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }

    const connectedDevice = ledgerTransportService.getConnectedDevice();
    if (!connectedDevice || connectedDevice.id !== deviceInfo.id) {
      await ledgerTransportService.connect(deviceInfo.id, {
        transportType: deviceInfo.type,
      });
    }

    const derived = await ledgerAlgorandService.deriveAccount(derivationIndex, {
      displayOnDevice: options.displayOnDevice ?? false,
    });

    const request: ImportLedgerAccountRequest = {
      type: AccountType.LEDGER,
      deviceId: deviceInfo.id,
      deviceName: deviceInfo.name,
      derivationIndex,
      derivationPath: derived.derivationPath,
      label: options.label,
      color: options.color,
    };

    return this.importLedgerAccount(request, derived);
  }

  static async detectLedgerAccounts(
    deviceInfo: LedgerDeviceInfo,
    options: DetectLedgerAccountsRequest = {}
  ): Promise<LedgerAccountDiscoveryResult[]> {
    if (!deviceInfo || !deviceInfo.id) {
      throw new LedgerAccountError(
        'Ledger device information is required',
        'LEDGER_DEVICE_REQUIRED'
      );
    }

    const startIndex = options.startIndex ?? 0;
    const count = options.count ?? 5;
    const displayFirst = options.displayFirst ?? false;

    if (options.deviceId && options.deviceId !== deviceInfo.id) {
      throw new LedgerAccountError(
        'Provided device identifiers do not match',
        'LEDGER_DEVICE_MISMATCH'
      );
    }

    if (!Number.isInteger(startIndex) || startIndex < 0) {
      throw new LedgerAccountError(
        'startIndex must be a non-negative integer',
        'LEDGER_INVALID_DERIVATION_INDEX'
      );
    }

    if (!Number.isInteger(count) || count <= 0) {
      throw new LedgerAccountError(
        'count must be a positive integer',
        'LEDGER_INVALID_DERIVATION_COUNT'
      );
    }

    const connectedDevice = ledgerTransportService.getConnectedDevice();
    if (!connectedDevice || connectedDevice.id !== deviceInfo.id) {
      await ledgerTransportService.connect(deviceInfo.id, {
        transportType: deviceInfo.type,
      });
    }

    const wallet = await this.getCurrentWallet();
    const derivedAccounts = await ledgerAlgorandService.deriveAccounts(
      startIndex,
      count,
      {
        displayFirst,
      }
    );

    const results: LedgerAccountDiscoveryResult[] = [];

    for (const derived of derivedAccounts) {
      const existingAccount =
        wallet?.accounts.find(
          (account) => account.address === derived.address
        ) ?? null;

      if (
        existingAccount &&
        wallet &&
        existingAccount.type === AccountType.LEDGER
      ) {
        await this.ensureLedgerAssociation(
          wallet,
          existingAccount as LedgerAccountMetadata,
          deviceInfo
        );
      }

      results.push({
        derivationIndex: derived.derivationIndex,
        derivationPath: derived.derivationPath,
        address: derived.address,
        publicKey: derived.publicKey,
        existsInWallet: !!existingAccount,
        accountId: existingAccount?.id,
        accountLabel: existingAccount?.label,
      });
    }

    return results;
  }

  static async updateLedgerAccountDevice(
    accountId: string,
    deviceInfo: LedgerDeviceInfo
  ): Promise<LedgerAccountMetadata> {
    if (!deviceInfo || !deviceInfo.id) {
      throw new LedgerAccountError(
        'Ledger device information is required',
        'LEDGER_DEVICE_REQUIRED'
      );
    }

    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find((acc) => acc.id === accountId);
    if (!account) {
      throw new AccountNotFoundError(`Account not found: ${accountId}`);
    }

    if (account.type !== AccountType.LEDGER) {
      throw new LedgerAccountError(
        'Account is not a Ledger-controlled account',
        'LEDGER_ACCOUNT_TYPE_MISMATCH'
      );
    }

    return this.ensureLedgerAssociation(
      wallet,
      account as LedgerAccountMetadata,
      deviceInfo
    );
  }

  static async addWatchAccount(
    request: AddWatchAccountRequest
  ): Promise<WatchAccountMetadata> {
    try {
      if (!algosdk.isValidAddress(request.address)) {
        throw new InvalidAddressError('Invalid Algorand address');
      }

      // Check if account already exists
      const existingAccount = await this.findAccountByAddress(request.address);
      if (existingAccount) {
        throw new AccountExistsError('Account already exists in wallet');
      }

      const publicKey = algosdk.decodeAddress(request.address).publicKey;

      const accountMetadata: WatchAccountMetadata = {
        id: this.generateAccountId(),
        address: request.address,
        publicKey: Buffer.from(publicKey).toString('hex'),
        type: AccountType.WATCH,
        label:
          request.label ||
          `Watch Account ${(await this.getWatchAccountCount()) + 1}`,
        color: this.generateAccountColor(),
        isHidden: false,
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        source: 'manual_import',
        notes: request.notes,
      };

      await this.addAccountToWallet(accountMetadata);
      return accountMetadata;
    } catch (error) {
      if (
        error instanceof InvalidAddressError ||
        error instanceof AccountExistsError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to add watch account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async detectRekeyedAccount(
    request: DetectRekeyedAccountRequest
  ): Promise<RekeyedAccountMetadata> {
    try {
      if (
        !algosdk.isValidAddress(request.originalAddress) ||
        !algosdk.isValidAddress(request.authAddress)
      ) {
        throw new InvalidAddressError('Invalid Algorand address');
      }

      // Verify rekey relationship (this would need a network service)
      const isRekeyed = await this.verifyRekeyRelationship(
        request.originalAddress,
        request.authAddress
      );
      if (!isRekeyed) {
        throw new RekeyVerificationError('Cannot verify rekey relationship');
      }

      // Check if we control the auth address
      const authAccount = await this.findAccountByAddress(request.authAddress);
      const canSign =
        request.canSign ??
        (authAccount && authAccount.type === AccountType.STANDARD);

      const publicKey = algosdk.decodeAddress(
        request.originalAddress
      ).publicKey;

      const accountMetadata: RekeyedAccountMetadata = {
        id: this.generateAccountId(),
        address: request.originalAddress,
        publicKey: Buffer.from(publicKey).toString('hex'),
        type: AccountType.REKEYED,
        label:
          request.label ||
          `Rekeyed Account ${(await this.getRekeyedAccountCount()) + 1}`,
        color: this.generateAccountColor(),
        isHidden: false,
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        authAddress: request.authAddress,
        originalOwner: canSign,
        canSign,
        rekeyedFrom: request.rekeyedFrom,
      };

      await this.addAccountToWallet(accountMetadata);
      return accountMetadata;
    } catch (error) {
      if (
        error instanceof InvalidAddressError ||
        error instanceof RekeyVerificationError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to detect rekeyed account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async addRemoteSignerAccount(
    request: ImportRemoteSignerAccountRequest
  ): Promise<RemoteSignerAccountMetadata> {
    try {
      if (!algosdk.isValidAddress(request.address)) {
        throw new InvalidAddressError('Invalid Algorand address');
      }

      // Check if account already exists
      const existingAccount = await this.findAccountByAddress(request.address);
      if (existingAccount) {
        throw new AccountExistsError('Account already exists in wallet');
      }

      const accountMetadata: RemoteSignerAccountMetadata = {
        id: this.generateAccountId(),
        address: request.address,
        publicKey: request.publicKey,
        type: AccountType.REMOTE_SIGNER,
        label:
          request.label ||
          `Remote Signer ${(await this.getRemoteSignerAccountCount()) + 1}`,
        color: request.color || this.generateAccountColor(),
        isHidden: false,
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        signerDeviceId: request.signerDeviceId,
        signerDeviceName: request.signerDeviceName,
        pairedAt: new Date().toISOString(),
      };

      await this.addAccountToWallet(accountMetadata);
      return accountMetadata;
    } catch (error) {
      if (
        error instanceof InvalidAddressError ||
        error instanceof AccountExistsError
      ) {
        throw error;
      }
      throw new Error(
        `Failed to add remote signer account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async getRemoteSignerAccountCount(): Promise<number> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) return 0;
    return wallet.accounts.filter((a) => a.type === AccountType.REMOTE_SIGNER)
      .length;
  }

  /**
   * Convert a STANDARD account to a REMOTE_SIGNER account.
   * This removes the private key and converts the account type.
   * Used when transferring an account to an airgap device.
   *
   * @param accountId - The ID of the STANDARD account to convert
   * @param signerDeviceId - The device ID of the airgap signer
   * @param signerDeviceName - Optional friendly name for the signer device
   * @returns The new RemoteSignerAccountMetadata
   */
  static async convertStandardToRemoteSigner(
    accountId: string,
    signerDeviceId: string,
    signerDeviceName?: string
  ): Promise<RemoteSignerAccountMetadata> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    // Find the account
    const accountIndex = wallet.accounts.findIndex((acc) => acc.id === accountId);
    if (accountIndex === -1) {
      throw new AccountNotFoundError('Account not found');
    }

    const existingAccount = wallet.accounts[accountIndex];

    // Validate it's a STANDARD account
    if (existingAccount.type !== AccountType.STANDARD) {
      throw new Error(
        `Cannot convert account type ${existingAccount.type} to remote signer. Only STANDARD accounts can be converted.`
      );
    }

    // Delete the private key from secure storage
    await AccountSecureStorage.deleteAccount(accountId);

    // Create the new RemoteSignerAccountMetadata
    const remoteSignerAccount: RemoteSignerAccountMetadata = {
      id: accountId, // Keep the same ID for continuity
      address: existingAccount.address,
      publicKey: existingAccount.publicKey,
      type: AccountType.REMOTE_SIGNER,
      label: existingAccount.label,
      color: existingAccount.color,
      isHidden: existingAccount.isHidden,
      createdAt: existingAccount.createdAt,
      lastUsed: new Date().toISOString(),
      signerDeviceId,
      signerDeviceName,
      pairedAt: new Date().toISOString(),
    };

    // Replace the account in the wallet
    wallet.accounts[accountIndex] = remoteSignerAccount;

    // Store the updated wallet
    await this.storeWallet(wallet);

    return remoteSignerAccount;
  }

  // Wallet Management
  static async getCurrentWallet(): Promise<Wallet | null> {
    try {
      const walletData = await this.getStoredValue(this.WALLET_KEY);
      if (!walletData) {
        return null;
      }
      const wallet = JSON.parse(walletData) as Wallet;

      const hasSensitiveMnemonic = wallet.accounts.some(
        (acc) =>
          acc.type === AccountType.STANDARD &&
          !!(acc as StandardAccountMetadata).mnemonic
      );

      if (hasSensitiveMnemonic) {
        wallet.accounts = wallet.accounts.map((acc) => {
          if (acc.type === AccountType.STANDARD) {
            const { mnemonic: _mnemonic, ...rest } =
              acc as StandardAccountMetadata;
            return {
              ...rest,
              mnemonic: '',
            } as StandardAccountMetadata;
          }
          return acc;
        });

        await this.storeWallet(wallet);
      }

      const defaultSettings = this.getDefaultWalletSettings();
      const persistedSettings = wallet.settings ?? {};
      wallet.settings = {
        ...defaultSettings,
        ...persistedSettings,
        numberLocale:
          persistedSettings.numberLocale !== undefined
            ? persistedSettings.numberLocale
            : defaultSettings.numberLocale,
      };

      // Repair invalid or missing addresses from public keys if needed
      let modified = false;
      wallet.accounts = wallet.accounts.map((acc) => {
        if (!acc.address || !algosdk.isValidAddress(acc.address)) {
          try {
            if (acc.publicKey && /^[0-9a-fA-F]+$/.test(acc.publicKey)) {
              const pubBytes = new Uint8Array(
                acc.publicKey.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
              );
              const address = algosdk.encodeAddress(pubBytes);
              modified = true;
              return { ...acc, address } as AccountMetadata;
            }
          } catch {}
        }
        return acc;
      });

      if (modified) {
        await this.storeWallet(wallet);
      }
      return wallet;
    } catch (error) {
      console.error('Failed to get current wallet:', error);
      return null;
    }
  }

  static async createWallet(
    firstAccountMetadata: StandardAccountMetadata
  ): Promise<Wallet> {
    const wallet: Wallet = {
      id: this.generateWalletId(),
      version: '1.0',
      createdAt: new Date().toISOString(),
      accounts: [firstAccountMetadata],
      activeAccountId: firstAccountMetadata.id,
      settings: this.getDefaultWalletSettings(),
    };

    await this.storeWallet(wallet);
    return wallet;
  }

  static async getAccount(accountId: string): Promise<AccountMetadata> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find((acc) => acc.id === accountId);
    if (!account) {
      throw new AccountNotFoundError(`Account not found: ${accountId}`);
    }

    if (account.type === AccountType.LEDGER) {
      const connectedDevice = ledgerTransportService.getConnectedDevice();
      if (
        connectedDevice &&
        connectedDevice.id === (account as LedgerAccountMetadata).deviceId
      ) {
        return await this.ensureLedgerAssociation(
          wallet,
          account as LedgerAccountMetadata,
          connectedDevice
        );
      }
    }

    return account;
  }

  static async getAllAccounts(): Promise<AccountMetadata[]> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      return [];
    }
    return wallet.accounts;
  }

  static async updateAccountMetadata(
    updatedAccount: AccountMetadata
  ): Promise<void> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const accountIndex = wallet.accounts.findIndex(
      (acc) => acc.id === updatedAccount.id
    );
    if (accountIndex === -1) {
      throw new AccountNotFoundError(`Account not found: ${updatedAccount.id}`);
    }

    const accounts = wallet.accounts.map((acc) =>
      acc.id === updatedAccount.id ? updatedAccount : acc
    );

    await this.storeWallet({
      ...wallet,
      accounts,
    });
  }

  static async updateAccountLabel(
    accountId: string,
    label: string
  ): Promise<AccountMetadata> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const nextLabel = label.trim();
    const accountIndex = wallet.accounts.findIndex(
      (acc) => acc.id === accountId
    );

    if (accountIndex === -1) {
      throw new AccountNotFoundError(`Account not found: ${accountId}`);
    }

    const updatedAccount: AccountMetadata = {
      ...wallet.accounts[accountIndex],
      label: nextLabel.length > 0 ? nextLabel : undefined,
    };

    const accounts = wallet.accounts.map((acc) =>
      acc.id === accountId ? updatedAccount : acc
    );

    await this.storeWallet({
      ...wallet,
      accounts,
    });

    return updatedAccount;
  }

  static async setActiveAccount(accountId: string): Promise<void> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find((acc) => acc.id === accountId);
    if (!account) {
      throw new AccountNotFoundError(`Account not found: ${accountId}`);
    }

    wallet.activeAccountId = accountId;
    await this.storeWallet(wallet);
  }

  static async getPrivateKey(accountId: string): Promise<Uint8Array> {
    return await AccountSecureStorage.getPrivateKey(accountId);
  }

  static async deleteAccount(accountId: string): Promise<void> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    // Remove from secure storage
    await AccountSecureStorage.deleteAccount(accountId);

    // Remove from wallet
    wallet.accounts = wallet.accounts.filter((acc) => acc.id !== accountId);

    // If this was the active account, set a new one
    if (wallet.activeAccountId === accountId && wallet.accounts.length > 0) {
      wallet.activeAccountId = wallet.accounts[0].id;
    }

    await this.storeWallet(wallet);
  }

  static async clearAllWallets(): Promise<void> {
    try {
      // Delete wallet metadata
      await AsyncStorage.removeItem(this.WALLET_KEY);
      await this.clearLegacyValue(this.WALLET_KEY);

      // The secure storage will be cleared by AccountSecureStorage.clearAll()
      console.log('All wallet data cleared');
    } catch (error) {
      console.error('Failed to clear wallet data:', error);
      throw new Error(
        `Failed to clear wallet data: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  // Legacy methods for backward compatibility
  static generateWallet(): WalletInfo {
    const account = algosdk.generateAccount();
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

    // Extract public key from private key (last 32 bytes)
    const publicKey = account.sk.slice(32);

    return {
      account: {
        address: account.addr.toString(),
        publicKey,
        // privateKey removed - will be handled by SecureKeyManager
      },
      mnemonic,
    };
  }

  static importFromMnemonic(mnemonic: string): WalletAccount {
    if (!mnemonic || typeof mnemonic !== 'string') {
      throw new Error('Mnemonic must be a non-empty string');
    }

    const cleanMnemonic = mnemonic.trim().toLowerCase();
    const words = cleanMnemonic.split(/\s+/);

    if (words.length !== 25) {
      throw new Error('Invalid mnemonic: must contain exactly 25 words');
    }

    try {
      const secretKey = algosdk.mnemonicToSecretKey(cleanMnemonic);
      const publicKey = secretKey.sk.slice(32);

      return {
        address: secretKey.addr.toString(),
        publicKey,
        // privateKey removed - will be handled by SecureKeyManager
      };
    } catch (error) {
      throw new Error(
        'Invalid mnemonic phrase: ' +
          (error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  // Internal method for SecureKeyManager - includes private key
  static importFromMnemonicWithPrivateKey(mnemonic: string): {
    address: string;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
  } {
    if (!mnemonic || typeof mnemonic !== 'string') {
      throw new Error('Mnemonic must be a non-empty string');
    }

    const cleanMnemonic = mnemonic.trim().toLowerCase();
    const words = cleanMnemonic.split(/\s+/);

    if (words.length !== 25) {
      throw new Error('Invalid mnemonic: must contain exactly 25 words');
    }

    try {
      const secretKey = algosdk.mnemonicToSecretKey(cleanMnemonic);
      const publicKey = secretKey.sk.slice(32);

      return {
        address: secretKey.addr.toString(),
        privateKey: secretKey.sk,
        publicKey,
      };
    } catch (error) {
      throw new Error(
        'Invalid mnemonic phrase: ' +
          (error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  static importFromPrivateKey(privateKeyHex: string): WalletAccount {
    if (!privateKeyHex || typeof privateKeyHex !== 'string') {
      throw new Error('Private key must be a non-empty string');
    }

    const cleanHex = privateKeyHex.trim().replace(/^0x/i, '');

    if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
      throw new Error('Invalid private key: must be hexadecimal format');
    }

    if (cleanHex.length !== 128) {
      throw new Error(
        'Invalid private key: must be 64 bytes (128 hex characters)'
      );
    }

    try {
      const privateKey = new Uint8Array(
        cleanHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
      );

      const publicKey = privateKey.slice(32);
      const address = algosdk.encodeAddress(publicKey);

      return {
        address,
        publicKey,
        // privateKey removed - will be handled by SecureKeyManager
      };
    } catch (error) {
      throw new Error(
        'Failed to parse private key: ' +
          (error instanceof Error ? error.message : 'Unknown error')
      );
    }
  }

  static validateAddress(address: string): boolean {
    try {
      return algosdk.isValidAddress(address);
    } catch {
      return false;
    }
  }

  static validateMnemonic(mnemonic: string): boolean {
    try {
      algosdk.mnemonicToSecretKey(mnemonic);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Import an auth account discovered through the auth account discovery process
   */
  static async importAuthAccount(
    request: ImportAuthAccountRequest
  ): Promise<RekeyedAccountMetadata> {
    try {
      const { authAccount, label, color, notes } = request;

      // Validate addresses
      if (!algosdk.isValidAddress(authAccount.address)) {
        throw new InvalidAddressError(`Invalid account address: ${authAccount.address}`);
      }
      if (!algosdk.isValidAddress(authAccount.authAddress)) {
        throw new InvalidAddressError(`Invalid auth address: ${authAccount.authAddress}`);
      }

      // Check if account already exists
      const existing = await this.findAccountByAddress(authAccount.address);
      if (existing) {
        throw new AccountExistsError(
          `Account ${authAccount.address} already exists in wallet`
        );
      }

      // Check if we control the auth address (Ledger account)
      const authAccountInWallet = await this.findAccountByAddress(authAccount.authAddress);
      const canSign = Boolean(authAccountInWallet);

      if (!canSign) {
        console.warn(
          `Auth account ${authAccount.authAddress} not found in wallet. Import as watch-only.`
        );
      }

      const publicKey = algosdk.decodeAddress(authAccount.address).publicKey;

      const accountMetadata: RekeyedAccountMetadata = {
        id: this.generateAccountId(),
        address: authAccount.address,
        publicKey: Buffer.from(publicKey).toString('hex'),
        type: AccountType.REKEYED,
        label: label || `Auth Account (${authAccount.networkName})`,
        color: color || this.generateAccountColor(),
        isHidden: false,
        createdAt: new Date().toISOString(),
        importedAt: new Date().toISOString(),
        lastUsed: new Date().toISOString(),
        authAddress: authAccount.authAddress,
        originalOwner: false, // We didn't create this rekey relationship
        canSign,
        rekeyedAt: authAccount.firstSeen
          ? new Date(authAccount.firstSeen).toISOString()
          : undefined,
      };

      await this.addAccountToWallet(accountMetadata);

      return accountMetadata;
    } catch (error) {
      console.error('Failed to import auth account:', error);
      throw error instanceof Error
        ? error
        : new Error('Failed to import auth account');
    }
  }

  // Private utility methods for MultiAccountWalletService
  private static generateAccountId(): string {
    return `account_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private static generateWalletId(): string {
    return `wallet_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  private static generateAccountColor(): string {
    const colors = [
      '#FF6B6B',
      '#4ECDC4',
      '#45B7D1',
      '#96CEB4',
      '#FFEAA7',
      '#DDA0DD',
      '#98D8C8',
      '#F7DC6F',
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  private static cleanMnemonic(mnemonic: string): string {
    return mnemonic
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .split(' ')
      .filter((word) => word.length > 0)
      .join(' ');
  }

  private static parsePrivateKey(privateKeyHex: string): Uint8Array {
    const cleanHex = privateKeyHex.trim().replace(/^0x/i, '');

    if (!/^[0-9a-fA-F]+$/.test(cleanHex)) {
      throw new Error('Invalid private key: must be hexadecimal format');
    }

    if (cleanHex.length !== 128) {
      throw new Error(
        'Invalid private key: must be 64 bytes (128 hex characters)'
      );
    }

    return new Uint8Array(
      cleanHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );
  }

  private static async findAccountByAddress(
    address: string
  ): Promise<AccountMetadata | null> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      return null;
    }
    return wallet.accounts.find((acc) => acc.address === address) || null;
  }

  private static async getAccountCount(): Promise<number> {
    const wallet = await this.getCurrentWallet();
    return wallet ? wallet.accounts.length : 0;
  }

  private static async getWatchAccountCount(): Promise<number> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) return 0;
    return wallet.accounts.filter((acc) => acc.type === AccountType.WATCH)
      .length;
  }

  private static async getRekeyedAccountCount(): Promise<number> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) return 0;
    return wallet.accounts.filter((acc) => acc.type === AccountType.REKEYED)
      .length;
  }

  private static async verifyRekeyRelationship(
    originalAddress: string,
    authAddress: string
  ): Promise<boolean> {
    try {
      const normalizedOriginal = originalAddress.trim();
      const normalizedAuth = authAddress.trim();

      if (
        !algosdk.isValidAddress(normalizedOriginal) ||
        !algosdk.isValidAddress(normalizedAuth)
      ) {
        return false;
      }

      const networkService = NetworkService.getInstance();
      const accountInfo = await networkService.getAccountInfo(normalizedOriginal);

      if (!accountInfo) {
        return false;
      }

      const reportedAuthAddress = accountInfo['auth-addr'];
      if (!reportedAuthAddress) {
        return false;
      }

      return reportedAuthAddress.toUpperCase() === normalizedAuth.toUpperCase();
    } catch (error) {
      console.error('Failed to verify rekey relationship', error);
      return false;
    }
  }

  private static async storeAccountSecurely(
    accountMetadata: AccountMetadata,
    privateKey?: Uint8Array
  ): Promise<void> {
    await AccountSecureStorage.storeAccount(accountMetadata, privateKey);
  }

  private static async ensureLedgerAssociation(
    wallet: Wallet,
    account: LedgerAccountMetadata,
    deviceInfo: LedgerDeviceInfo
  ): Promise<LedgerAccountMetadata> {
    const accountIndex = wallet.accounts.findIndex(
      (acc) => acc.id === account.id
    );
    if (accountIndex === -1) {
      return account;
    }

    const lastConnection = account.lastDeviceConnection
      ? Date.parse(account.lastDeviceConnection)
      : NaN;
    const shouldUpdateTimestamp =
      Number.isNaN(lastConnection) || Date.now() - lastConnection > 60_000;

    const nextAccount: LedgerAccountMetadata = {
      ...account,
      deviceId: deviceInfo.id,
      deviceName: deviceInfo.name ?? account.deviceName,
      lastDeviceConnection: shouldUpdateTimestamp
        ? new Date().toISOString()
        : account.lastDeviceConnection,
    };

    if (
      account.deviceId === nextAccount.deviceId &&
      account.deviceName === nextAccount.deviceName &&
      account.lastDeviceConnection === nextAccount.lastDeviceConnection
    ) {
      return account;
    }

    const accounts = [...wallet.accounts];
    accounts[accountIndex] = nextAccount;

    await this.storeWallet({
      ...wallet,
      accounts,
    });

    return nextAccount;
  }

  private static async addAccountToWallet(
    accountMetadata: AccountMetadata
  ): Promise<void> {
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      // If no wallet exists, create one with this account
      if (accountMetadata.type === AccountType.STANDARD) {
        await this.createWallet(accountMetadata as StandardAccountMetadata);
      } else if (
        accountMetadata.type === AccountType.REMOTE_SIGNER ||
        accountMetadata.type === AccountType.WATCH_ONLY
      ) {
        // Create wallet with non-standard account (no mnemonic required)
        await this.createWalletWithAccount(accountMetadata);
      } else {
        throw new Error('Cannot create wallet with this account type');
      }
    } else {
      wallet.accounts.push(accountMetadata);
      await this.storeWallet(wallet);
    }
  }

  private static async createWalletWithAccount(
    accountMetadata: AccountMetadata
  ): Promise<Wallet> {
    const wallet: Wallet = {
      id: this.generateWalletId(),
      version: '1.0',
      createdAt: new Date().toISOString(),
      accounts: [accountMetadata],
      activeAccountId: accountMetadata.id,
      settings: this.getDefaultWalletSettings(),
    };

    await this.storeWallet(wallet);
    return wallet;
  }

  private static async storeWallet(wallet: Wallet): Promise<void> {
    const persistencePayload = this.sanitizeWalletForPersistence(wallet);
    await this.storeValue(
      this.WALLET_KEY,
      JSON.stringify(persistencePayload)
    );
  }

  private static getDefaultWalletSettings(): WalletSettings {
    return {
      theme: 'system',
      currency: 'USD',
      numberLocale: null,
      hideSmallBalances: false,
      requireBiometric: true,
      autoLock: 15,
      notifications: {
        transactionAlerts: true,
        priceAlerts: true,
        securityAlerts: true,
        pushNotifications: true,
      },
    };
  }

  // Storage methods using platform adapters
  private static async getStoredValue(key: string): Promise<string | null> {
    try {
      const value = await storage.getItem(key);
      if (value) {
        return value;
      }

      return await this.migrateLegacyValue(key);
    } catch (error) {
      console.error(`Failed to get stored value for key ${key}:`, error);
      return null;
    }
  }

  private static async storeValue(key: string, value: string): Promise<void> {
    try {
      await storage.setItem(key, value);
      await this.clearLegacyValue(key);
    } catch (error) {
      console.error(`Failed to store value for key ${key}:`, error);
      throw error;
    }
  }

  private static sanitizeWalletForPersistence(wallet: Wallet): Wallet {
    return {
      ...wallet,
      accounts: wallet.accounts.map((account) => {
        if (account.type === AccountType.STANDARD) {
          const { mnemonic: _mnemonic, ...rest } =
            account as StandardAccountMetadata;
          return {
            ...rest,
            mnemonic: '',
          } as StandardAccountMetadata;
        }
        return { ...account } as AccountMetadata;
      }),
    };
  }

  private static async migrateLegacyValue(key: string): Promise<string | null> {
    try {
      // Try to get from secure storage (legacy location)
      const legacyValue = await secureStorage.getItem(key);
      if (!legacyValue) {
        return null;
      }

      let valueToPersist = legacyValue;
      if (key === this.WALLET_KEY) {
        try {
          const legacyWallet = JSON.parse(legacyValue) as Wallet;
          valueToPersist = JSON.stringify(
            this.sanitizeWalletForPersistence(legacyWallet)
          );
        } catch (error) {
          console.warn('Failed to sanitize legacy wallet payload', error);
        }
      }

      await storage.setItem(key, valueToPersist);
      await secureStorage.deleteItem(key).catch(() => {});
      return valueToPersist;
    } catch (error) {
      console.error(`Failed to migrate legacy value for key ${key}:`, error);
      return null;
    }
  }

  private static async clearLegacyValue(key: string): Promise<void> {
    try {
      await secureStorage.deleteItem(key).catch(() => {});
    } catch {
      // Ignore errors when clearing legacy storage
    }
  }
}

// Export legacy service for backward compatibility
export class WalletService extends MultiAccountWalletService {}
