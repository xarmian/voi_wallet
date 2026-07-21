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
  ImportAuthAccountRequest,
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
  ResetRacedError,
  Wallet,
  WalletSettings,
  withDefaultAuthLevel,
} from '@/types/wallet';
import { AccountSecureStorage } from '../secure/AccountSecureStorage';
import { ledgerTransportService } from '@/services/ledger/transport';
import type { LedgerDeviceInfo } from '@/services/ledger/transport';
import { ledgerAlgorandService } from '@/services/ledger/algorand';
import { NetworkService } from '@/services/network';
import type { LedgerAccountDerivation } from '@/services/ledger/algorand';

/**
 * F-22 (TASK-179) — getCurrentWallet() memoization.
 *
 * getCurrentWallet() sits on the cold-boot path AND every signing/key-retrieval
 * and WalletConnect flow (43 call sites). Each call re-parsed the whole wallet
 * blob, scanned every account for a legacy mnemonic, ran algosdk.isValidAddress
 * (base32 decode + SHA-512/256 checksum) on every account, and merged settings —
 * identical work on an unchanged blob (~40-50 checksum hashes per cold boot).
 *
 * This memo caches ONLY the parsed/healed/validated Wallet, keyed on the exact
 * raw stored string. Because this feeds signing (a stale wallet after a
 * restore/reset/rekey must NEVER be signed), it holds to these invariants:
 *   1. The current stored raw string is read on EVERY call (never cached), so
 *      external wipes/rewrites that bypass this service — restore clearAllData()
 *      removes voi_wallet_metadata directly (backup/restorers.ts), and
 *      migrateLegacyValue rewrites it — are always observed. A null read busts
 *      the memo and returns null (no stale wallet survives a reset).
 *   2. Cache HIT only when the raw string is byte-identical to the cached key;
 *      any change (including removal) re-parses.
 *   3. Every return is a DEEP CLONE — callers mutate the returned wallet in place
 *      before persisting, so a shared reference would corrupt the cache.
 *   4. The legacy/unsanitized read (a blob still carrying a per-account mnemonic)
 *      is NEVER memoized: its raw string would become the cache key and retain a
 *      secret. Only the sanitized path is cached (persisted blobs are
 *      mnemonic-stripped at write time), so the memo holds no key material.
 *   5. Concurrent cold-boot loads of the same raw string collapse into one parse
 *      via in-flight promise dedup (mirrors walletStore's balanceLoadsInFlight).
 */
let cachedWalletRawString: string | null = null;
let cachedWallet: Wallet | null = null;
const getCurrentWalletParsesInFlight = new Map<
  string,
  Promise<Wallet | null>
>();

/**
 * Account fields that carry key material and must NEVER be retained in the module
 * memo or become a cache/in-flight key. `mnemonic` is the persisted schema's only
 * secret (StandardAccountMetadata); `privateKey` is checked as defense-in-depth
 * against a corrupt/legacy/tampered blob that carries key material on a mistyped
 * or malformed account object — a type-gated check would miss it, so detection is
 * type-AGNOSTIC and fails closed on ANY account.
 */
const SECRET_ACCOUNT_FIELDS = ['mnemonic', 'privateKey'] as const;

/**
 * TASK-212 — write-vs-wipe serialization for the wallet-metadata blob.
 *
 * getCurrentWallet() performs read-repair WRITES (legacy-mnemonic strip,
 * heal-on-read address repair) while processing a just-read blob. A concurrent
 * reset/restore can wipe voi_wallet_metadata BETWEEN that read and the pending
 * write; the in-flight write would then re-persist (resurrect) the stale
 * metadata after the wipe. Two coordinated mechanisms close the race:
 *
 *   1. A reset EPOCH bumped synchronously by every wipe funneled through the
 *      service (clearAllWallets — restore now routes through it too). A
 *      read-repair write captures the epoch at read time and is SKIPPED if a
 *      wipe bumped it in the meantime. It never applies to intentional writes
 *      (createWallet / addAccount / persistRestoredWallet), which must persist.
 *   2. A single write CHAIN that serializes every WALLET_KEY mutation (writes
 *      AND wipes) so a write and a wipe can never interleave at the storage
 *      layer — regardless of the storage adapter's ordering guarantees. If a
 *      read-repair write did slip past the epoch check, the wipe enqueued after
 *      it still runs last and wins.
 */
let walletResetEpoch = 0;
let walletWriteChain: Promise<unknown> = Promise.resolve();

export class MultiAccountWalletService {
  private static readonly STORAGE_PREFIX = 'voi_account_';
  private static readonly WALLET_KEY = 'voi_wallet_metadata';
  // TASK-212: durable "wallet was intentionally wiped" tombstone. Persisted in
  // general storage (survives app restart, unlike the in-memory reset epoch) and
  // set by clearAllWallets in the same chain task that removes the primary blob.
  // migrateLegacyValue refuses to resurrect a wallet from a surviving legacy
  // secure-store copy while this is set (it BAILS when set, so it never itself
  // clears it); a storeWallet primary write (createWallet / restore / any
  // intentional write) clears it, marking the wiped state over. Closes the
  // wipe→migration resurrection gap (incl. across a restart) without keeping the
  // legacy delete on the write chain.
  private static readonly WIPE_TOMBSTONE_KEY = 'voi_wallet_wiped';

  // Account Management Methods
  static async createStandardAccount(
    request: CreateAccountRequest
  ): Promise<StandardAccountMetadata> {
    try {
      const account = algosdk.generateAccount();
      const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

      const accountMetadata: StandardAccountMetadata = {
        id: this.generateAccountId(),
        // algosdk 3 returns an `Address` object; persist the 58-char base32
        // string so the stored value stays Pera/Algorand-wallet compatible.
        address: account.addr.toString(),
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
      // TASK-220: capture the secure reset generation BEFORE the key write so
      // the cross-store creation is atomic against a concurrent full reset.
      const creationGen = AccountSecureStorage.getResetGeneration();
      let token: string | undefined;
      try {
        token = await AccountSecureStorage.storeAccountForCreation(
          accountMetadata,
          secretKey,
          creationGen
        );
        await this.addAccountToWallet(accountMetadata, creationGen);
        await AccountSecureStorage.commitPendingCreate(
          accountMetadata.id,
          token,
          creationGen
        );
        return accountMetadata;
      } catch (error) {
        // DR-2 (reset wins): a reset raced this creation → roll back the just-
        // written secret (ownership-checked; a no-op if the reset already
        // deleted it) so neither store keeps a half-created account.
        if (error instanceof ResetRacedError && token !== undefined) {
          await AccountSecureStorage.deleteAccountIfAttemptMatches(
            accountMetadata.id,
            token
          );
        }
        throw error;
      } finally {
        if (secretKey) {
          secretKey.fill(0);
        }
      }
    } catch (error) {
      // Preserve ResetRacedError so the UI can show "wallet was reset — creation
      // cancelled" instead of a generic failure.
      if (error instanceof ResetRacedError) {
        throw error;
      }
      throw new Error(
        `Failed to create account: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  static async importStandardAccount(
    request: ImportAccountRequest
  ): Promise<StandardAccountMetadata> {
    try {
      // The mnemonic path yields an algosdk 3 `Account` (addr is an `Address`
      // object); the private-key path builds an object whose addr is already a
      // base32 string. Allow both so `account.addr.toString()` normalizes them.
      let account: {
        sk: Uint8Array;
        addr: algosdk.Address | string;
        publicKey?: Uint8Array;
      };

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
      const existingAccount = await this.findAccountByAddress(
        account.addr.toString()
      );
      if (existingAccount) {
        throw new AccountExistsError('Account already exists in wallet');
      }

      const mnemonic = request.mnemonic
        ? this.cleanMnemonic(request.mnemonic)
        : algosdk.secretKeyToMnemonic(account.sk);

      const accountMetadata: StandardAccountMetadata = {
        id: this.generateAccountId(),
        // Persist the 58-char base32 string, never the algosdk `Address` object.
        address: account.addr.toString(),
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
      // TASK-220: guard the cross-store creation against a concurrent full reset.
      const creationGen = AccountSecureStorage.getResetGeneration();
      let token: string | undefined;
      try {
        token = await AccountSecureStorage.storeAccountForCreation(
          accountMetadata,
          secretKey,
          creationGen
        );
        await this.addAccountToWallet(accountMetadata, creationGen);
        await AccountSecureStorage.commitPendingCreate(
          accountMetadata.id,
          token,
          creationGen
        );
        return accountMetadata;
      } catch (error) {
        if (error instanceof ResetRacedError && token !== undefined) {
          await AccountSecureStorage.deleteAccountIfAttemptMatches(
            accountMetadata.id,
            token
          );
        }
        throw error;
      } finally {
        if (secretKey) {
          secretKey.fill(0);
        }
      }
    } catch (error) {
      if (
        error instanceof InvalidMnemonicError ||
        error instanceof AccountExistsError ||
        error instanceof ResetRacedError
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

    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
    // TASK-220: guard the no-wallet CREATION write (below) against a concurrent
    // full reset. Ledger accounts hold no secret, so there is nothing to roll
    // back — the guard just stops a reset being defeated by a resurrected wallet.
    const creationGen = AccountSecureStorage.getResetGeneration();
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

        // Creation write (no prior wallet existed) — guarded on the creation
        // generation (TASK-220) so a concurrent reset aborts it instead of
        // resurrecting a wallet; nothing to resurrect otherwise.
        await this.storeWallet(newWallet, undefined, creationGen);
      } else {
        wallet.accounts.push(accountMetadata);
        await this.storeWallet(wallet, readEpoch);
      }

      return accountMetadata;
    } catch (error) {
      if (
        error instanceof AccountExistsError ||
        error instanceof LedgerAccountError ||
        error instanceof LedgerDeviceNotConnectedError ||
        error instanceof ResetRacedError
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

    // TASK-212: guard the ledger-association write against a reset racing this read.
    const readEpoch = walletResetEpoch;
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
          deviceInfo,
          readEpoch
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

    // TASK-212: guard the ledger-association write against a reset racing this read.
    const readEpoch = walletResetEpoch;
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
      deviceInfo,
      readEpoch
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

      // TASK-220: guard the (possibly wallet-creating) metadata write against a
      // concurrent full reset. Watch accounts hold no secret, so there is nothing
      // to roll back — the guard just prevents a reset being defeated by a
      // resurrected/recreated wallet.
      const creationGen = AccountSecureStorage.getResetGeneration();
      await this.addAccountToWallet(accountMetadata, creationGen);
      return accountMetadata;
    } catch (error) {
      if (
        error instanceof InvalidAddressError ||
        error instanceof AccountExistsError ||
        error instanceof ResetRacedError
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
        (!!authAccount && authAccount.type === AccountType.STANDARD);

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

      // TASK-220: guard the metadata write against a concurrent full reset.
      const creationGen = AccountSecureStorage.getResetGeneration();
      await this.addAccountToWallet(accountMetadata, creationGen);
      return accountMetadata;
    } catch (error) {
      if (
        error instanceof InvalidAddressError ||
        error instanceof RekeyVerificationError ||
        error instanceof ResetRacedError
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
        // Persist the pairing authentication level. Defaults conservatively to
        // 'v1-unsigned' until the import screen supplies a verified level
        // (TASK-144).
        authLevel: withDefaultAuthLevel(request.authLevel),
      };

      // TASK-220: guard the metadata write against a concurrent full reset.
      const creationGen = AccountSecureStorage.getResetGeneration();
      await this.addAccountToWallet(accountMetadata, creationGen);
      return accountMetadata;
    } catch (error) {
      if (
        error instanceof InvalidAddressError ||
        error instanceof AccountExistsError ||
        error instanceof ResetRacedError
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
    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    // Find the account
    const accountIndex = wallet.accounts.findIndex(
      (acc) => acc.id === accountId
    );
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
      // Local conversion is not an authenticated (v2) pairing, so record the
      // conservative default. Keeps the field present on all new records.
      authLevel: 'v1-unsigned',
    };

    // Replace the account in the wallet
    wallet.accounts[accountIndex] = remoteSignerAccount;

    // Store the updated wallet
    await this.storeWallet(wallet, readEpoch);

    return remoteSignerAccount;
  }

  /**
   * TASK-212: true if a wipe/reset advanced the reset epoch since `readEpoch` was
   * captured. getCurrentWallet() returns null (fail-closed) rather than hand back
   * a stale pre-wipe wallet — it feeds signing / key retrieval, so a read that a
   * concurrent reset/restore raced must not be served (the caller re-reads to see
   * the current state).
   */
  private static resetRacedRead(readEpoch: number): boolean {
    return readEpoch !== walletResetEpoch;
  }

  // Wallet Management
  static async getCurrentWallet(): Promise<Wallet | null> {
    try {
      // TASK-212: capture the reset epoch BEFORE the read. Any read-repair write
      // this call performs (legacy strip / heal-on-read) is guarded on it and
      // skipped if a wipe/reset bumps the epoch before the write lands, so a
      // concurrent restore/reset can't be undone by an in-flight repair.
      const readEpoch = walletResetEpoch;

      // (1) ALWAYS read the current stored raw string. This read is intentionally
      // NOT memoized: external wipes/rewrites that bypass this service (restore
      // clearAllData() removing voi_wallet_metadata directly, migrateLegacyValue
      // rewriting it) must be observed on every call so signing never sees a
      // stale wallet.
      const walletData = await this.getStoredValue(this.WALLET_KEY);

      if (!walletData) {
        // Removed key busts the memo and returns null — no stale wallet survives
        // a restore/reset.
        cachedWalletRawString = null;
        cachedWallet = null;
        return null;
      }

      // (2) Cache hit: byte-identical raw string. Skip the JSON.parse +
      // legacy-mnemonic scan + per-account algosdk.isValidAddress checksum
      // hashing + settings merge; hand back a deep clone so the caller can mutate
      // its copy freely.
      if (walletData === cachedWalletRawString && cachedWallet) {
        if (this.resetRacedRead(readEpoch)) return null;
        return this.deepCloneWallet(cachedWallet);
      }

      // Parse once to classify the blob. JSON.parse is synchronous (it never
      // yields), so a concurrent caller cannot interleave between here and the
      // memo write below: the first caller to finish a sanitized load populates
      // the memo, and overlapping callers then take the fast path (2) or join the
      // in-flight load (4). Secret detection is type-AGNOSTIC (see
      // SECRET_ACCOUNT_FIELDS): a mnemonic/privateKey on ANY account object —
      // even one with a wrong or malformed `type` — is caught so its raw string
      // can never become a cache/in-flight key.
      const parsed = JSON.parse(walletData) as Wallet;
      const hasSecretMaterial = parsed.accounts.some((acc) =>
        this.accountHasSecretMaterial(acc)
      );

      // (3) Legacy/unsanitized path: the raw string still carries plaintext key
      // material. It is handled ENTIRELY inline and is NEVER placed in the module
      // cache OR the in-flight map — its raw string is a secret and must never
      // become a module-level key (invariant #4). This is a one-time legacy
      // migration; concurrent double-execution is idempotent (both strip to the
      // same sanitized blob), so it needs no dedup.
      if (hasSecretMaterial) {
        parsed.accounts = parsed.accounts.map((acc) =>
          this.stripAccountSecrets(acc)
        );

        // Read-repair write: skipped if a wipe/reset raced this read (TASK-212).
        await this.storeWallet(parsed, readEpoch);

        const sanitized = await this.mergeSettingsAndHeal(parsed, readEpoch);
        if (this.resetRacedRead(readEpoch)) return null;
        return this.deepCloneWallet(sanitized);
      }

      // (4) Sanitized path: the raw string carries no secret, so it is safe to
      // use as both the in-flight dedup key and the cache key. Collapse
      // concurrent cold-boot loads of the same raw string into one heal/validate
      // pass; every caller still receives its own deep clone.
      const inFlight = getCurrentWalletParsesInFlight.get(walletData);
      if (inFlight) {
        const shared = await inFlight;
        if (this.resetRacedRead(readEpoch)) return null;
        return shared ? this.deepCloneWallet(shared) : null;
      }

      const loadPromise = (async () => {
        const wallet = await this.mergeSettingsAndHeal(parsed, readEpoch);
        // Fail-closed: only memoize a wallet whose accounts hold NO secret
        // material, keyed on a secret-free raw string. hasSecretMaterial already
        // guaranteed this above; re-checking the healed result keeps the
        // invariant local to the write so a future refactor cannot silently cache
        // key material. (If heal-on-read re-stored a repaired address the stored
        // string also changed, so this entry is simply superseded on the next
        // read — never served stale, since every read compares the live string.)
        //
        // TASK-212: also require the reset epoch to be unchanged. A wipe/reset
        // that raced this in-flight load synchronously busts the memo; without
        // this guard, resuming here would re-populate cachedWallet with the
        // now-wiped blob (transient stale state until the next read).
        if (
          readEpoch === walletResetEpoch &&
          !wallet.accounts.some((acc) => this.accountHasSecretMaterial(acc))
        ) {
          cachedWalletRawString = walletData;
          cachedWallet = wallet;
        }
        return wallet;
      })();
      getCurrentWalletParsesInFlight.set(walletData, loadPromise);
      try {
        const wallet = await loadPromise;
        if (this.resetRacedRead(readEpoch)) return null;
        return this.deepCloneWallet(wallet);
      } finally {
        getCurrentWalletParsesInFlight.delete(walletData);
      }
    } catch (error) {
      console.error('Failed to get current wallet:', error);
      return null;
    }
  }

  /**
   * Applies the default-settings merge and heal-on-read address repair to an
   * already-parsed, mnemonic-free wallet, persisting only when a repair actually
   * ran. Shared by both getCurrentWallet() load paths and free of any caching
   * side effect — the caller decides whether the result is memoized, so a
   * mnemonic-bearing blob (handled inline in getCurrentWallet before it is
   * stripped) can never be routed through the memo.
   */
  private static async mergeSettingsAndHeal(
    wallet: Wallet,
    readEpoch: number
  ): Promise<Wallet> {
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

    // Heal-on-read: repair invalid, missing, or non-base32 (e.g. a persisted
    // algosdk `Address` object serialized to `{"publicKey":{...}}`) addresses
    // by re-deriving them from the stored hex public key. This only ever
    // rewrites to a freshly derived, checksum-valid base32 address obtained
    // from an exactly-32-byte public key; it never weakens validation.
    let modified = false;
    wallet.accounts = wallet.accounts.map((acc) => {
      const rawAddress = acc.address as unknown;
      const currentAddress = typeof rawAddress === 'string' ? rawAddress : '';
      if (!currentAddress || !algosdk.isValidAddress(currentAddress)) {
        try {
          const rawPublicKey = acc.publicKey as unknown;
          const hexPublicKey =
            typeof rawPublicKey === 'string' ? rawPublicKey : '';
          if (hexPublicKey && /^[0-9a-fA-F]+$/.test(hexPublicKey)) {
            const pubBytes = new Uint8Array(
              hexPublicKey.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
            );
            if (pubBytes.length === 32) {
              const derived = algosdk.encodeAddress(pubBytes);
              if (algosdk.isValidAddress(derived)) {
                modified = true;
                return { ...acc, address: derived } as AccountMetadata;
              }
            }
          }
        } catch {}
      }
      return acc;
    });

    if (modified) {
      // Read-repair write: skipped if a wipe/reset raced this read (TASK-212).
      await this.storeWallet(wallet, readEpoch);
    }

    return wallet;
  }

  /**
   * Deep clone via JSON round-trip. The Wallet is fully JSON-serializable (it is
   * parsed from and persisted as JSON), so this produces a fully independent copy
   * with no shared nested references. Required because getCurrentWallet()'s
   * consumers mutate the returned object in place (e.g. wallet.accounts[i] = ...
   * then storeWallet); handing out the cached reference would corrupt the memo.
   */
  private static deepCloneWallet(wallet: Wallet): Wallet {
    return JSON.parse(JSON.stringify(wallet)) as Wallet;
  }

  /**
   * Type-agnostic secret detector. Returns true if an account object carries key
   * material in any SECRET_ACCOUNT_FIELDS entry, regardless of its declared
   * `type`. Empty strings and absent fields are NOT secrets; any non-empty string
   * (a mnemonic phrase / private key hex) or any unexpected non-string presence
   * in a secret field fails closed as a secret. Used to keep the module memo free
   * of key material even for corrupt/mistyped legacy blobs.
   */
  private static accountHasSecretMaterial(acc: unknown): boolean {
    if (!acc || typeof acc !== 'object') {
      return false;
    }
    const record = acc as Record<string, unknown>;
    return SECRET_ACCOUNT_FIELDS.some((field) => {
      const value = record[field];
      if (value == null) {
        return false;
      }
      return typeof value === 'string' ? value.length > 0 : true;
    });
  }

  /**
   * Removes every SECRET_ACCOUNT_FIELDS entry from an account object (any type),
   * then restores the persisted-schema shape: a STANDARD account always carries
   * an explicit empty `mnemonic` (matching sanitizeWalletForPersistence). Used on
   * the inline legacy path so a mnemonic-bearing blob is fully scrubbed before it
   * is re-stored or returned — and never memoized.
   */
  private static stripAccountSecrets(acc: AccountMetadata): AccountMetadata {
    const record: Record<string, unknown> = {
      ...(acc as unknown as Record<string, unknown>),
    };
    for (const field of SECRET_ACCOUNT_FIELDS) {
      delete record[field];
    }
    if (record.type === AccountType.STANDARD) {
      record.mnemonic = '';
    }
    return record as unknown as AccountMetadata;
  }

  static async createWallet(
    firstAccountMetadata: StandardAccountMetadata,
    // TASK-220: secure reset generation captured before the first account's key
    // write, so a concurrent full reset aborts this creation (ResetRacedError)
    // instead of resurrecting a wallet whose secret the reset just deleted.
    creationGen?: number
  ): Promise<Wallet> {
    const wallet: Wallet = {
      id: this.generateWalletId(),
      version: '1.0',
      createdAt: new Date().toISOString(),
      accounts: [firstAccountMetadata],
      activeAccountId: firstAccountMetadata.id,
      settings: this.getDefaultWalletSettings(),
    };

    await this.storeWallet(wallet, undefined, creationGen);
    return wallet;
  }

  static async getAccount(accountId: string): Promise<AccountMetadata> {
    // TASK-212: guard the ledger-association write against a reset racing this read.
    const readEpoch = walletResetEpoch;
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
          connectedDevice,
          readEpoch
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
    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
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

    await this.storeWallet(
      {
        ...wallet,
        accounts,
      },
      readEpoch
    );
  }

  static async updateAccountLabel(
    accountId: string,
    label: string
  ): Promise<AccountMetadata> {
    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
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

    await this.storeWallet(
      {
        ...wallet,
        accounts,
      },
      readEpoch
    );

    return updatedAccount;
  }

  static async setActiveAccount(accountId: string): Promise<void> {
    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      throw new Error('No wallet found');
    }

    const account = wallet.accounts.find((acc) => acc.id === accountId);
    if (!account) {
      throw new AccountNotFoundError(`Account not found: ${accountId}`);
    }

    wallet.activeAccountId = accountId;
    await this.storeWallet(wallet, readEpoch);
  }

  static async getPrivateKey(accountId: string): Promise<Uint8Array> {
    return await AccountSecureStorage.getPrivateKey(accountId);
  }

  static async deleteAccount(accountId: string): Promise<void> {
    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
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

    await this.storeWallet(wallet, readEpoch);
  }

  static async clearAllWallets(): Promise<void> {
    // TASK-212: this is the canonical wallet-metadata wipe — restore
    // (backup/restorers.ts clearAllData) and LockScreen.performReset() both
    // funnel through it. Bump the reset epoch and bust the memo SYNCHRONOUSLY,
    // before any await, so an in-flight read-repair write that captured an older
    // epoch is skipped and no cached clone survives the reset.
    walletResetEpoch++;
    const bumpedEpoch = walletResetEpoch;
    cachedWalletRawString = null;
    cachedWallet = null;
    try {
      // Clears wallet METADATA only (the account list / active-account record).
      // Private keys in secure storage are NOT touched here; callers that need a
      // full reset must also call AccountSecureStorage.clearAll() — as
      // LockScreen.performReset() does immediately before invoking this method.
      //
      // Serialize ONLY the primary removeItem + tombstone-set on the chain, so a
      // hanging legacy secure-store deletion can never block it (or a subsequent
      // write/wipe). The durable tombstone (survives restart) is what guarantees a
      // surviving legacy copy can't be re-migrated to resurrect this wallet — so
      // the legacy delete itself is best-effort below.
      //
      // Set the tombstone FIRST, then remove the primary: if the app dies or the
      // removeItem fails in between, we are left tombstone-set (migration blocked)
      // + primary-present (still readable) — never primary-gone-without-tombstone,
      // which would let a surviving legacy copy resurrect on next launch. A stale
      // tombstone with the primary present is harmless (migration only fires when
      // the primary is absent) and the next primary write clears it.
      await this.enqueueWalletWrite(async () => {
        await storage.setItem(this.WIPE_TOMBSTONE_KEY, '1');
        await storage.removeItem(this.WALLET_KEY);
      });
      // Best-effort legacy secure-store cleanup, OUTSIDE the chain and
      // fire-and-forget (the tombstone, not this delete, prevents resurrection),
      // so a stalled/failing keychain op can neither block the chain nor fail the
      // reset. For migrated installs the legacy key is already absent (no-op).
      void this.clearLegacyValue(this.WALLET_KEY);

      console.log('All wallet metadata cleared');
    } catch (error) {
      // The primary removal failed — the wallet was NOT wiped. Revert the
      // optimistic epoch bump (unless another wipe has since advanced it) so
      // future intentional writes aren't wrongly skipped as if a reset landed.
      // (Best-effort: the revert can't un-skip a guarded task that already ran in
      // the failure window, and if setItem(tombstone) succeeded before removeItem
      // threw, the tombstone lingers beside the still-present primary — both are
      // self-healing: readers prefer a present primary, and the next successful
      // primary write clears the stale tombstone. Not a resurrection.)
      if (walletResetEpoch === bumpedEpoch) {
        walletResetEpoch = bumpedEpoch - 1;
      }
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
    // TASK-124: Share the same validate-and-parse helper as the real import
    // path (parsePrivateKey) so the QR preview address and the account that is
    // actually imported stay in sync, and a pubkey-mismatched key is rejected
    // identically in both places.
    const privateKey = this.validateAndParseSecretKey(privateKeyHex);
    const publicKey = privateKey.slice(32);
    const address = algosdk.encodeAddress(publicKey);

    return {
      address,
      publicKey,
      // privateKey removed - will be handled by SecureKeyManager
    };
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
        throw new InvalidAddressError(
          `Invalid account address: ${authAccount.address}`
        );
      }
      if (!algosdk.isValidAddress(authAccount.authAddress)) {
        throw new InvalidAddressError(
          `Invalid auth address: ${authAccount.authAddress}`
        );
      }

      // Check if account already exists
      const existing = await this.findAccountByAddress(authAccount.address);
      if (existing) {
        throw new AccountExistsError(
          `Account ${authAccount.address} already exists in wallet`
        );
      }

      // Check if we control the auth address (Ledger account)
      const authAccountInWallet = await this.findAccountByAddress(
        authAccount.authAddress
      );
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

      // TASK-220: guard the metadata write against a concurrent full reset.
      const creationGen = AccountSecureStorage.getResetGeneration();
      await this.addAccountToWallet(accountMetadata, creationGen);

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

  /**
   * TASK-124: Parse a hex-encoded 64-byte Algorand secret key and verify that
   * its appended public key actually matches the seed.
   *
   * An Algorand `sk` is `seed(32) || publicKey(32)`. A corrupted or hand-edited
   * key whose trailing 32 bytes no longer correspond to the seed would be
   * imported at one address (derived from the appended pubkey) yet sign for a
   * different address (derived from the seed), silently producing an
   * unrecoverable account. We reject on mismatch instead.
   *
   * The check uses the algosdk round-trip `sk -> mnemonic -> sk`, which rebuilds
   * the sk from the seed alone, then compares the seed-derived address to the
   * address encoded from the appended pubkey. Public keys are not secret, so a
   * plain string comparison is fine (no constant-time compare needed). Every
   * legitimately generated key (algosdk / Pera / mnemonic export) round-trips
   * unchanged; only mismatched keys are rejected.
   */
  private static validateAndParseSecretKey(privateKeyHex: string): Uint8Array {
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

    const sk = new Uint8Array(
      cleanHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    // Reject keys whose appended public key does not match the seed.
    const seedAddr = algosdk
      .mnemonicToSecretKey(algosdk.secretKeyToMnemonic(sk))
      .addr.toString();
    const appendedAddr = algosdk.encodeAddress(sk.slice(32));
    if (seedAddr !== appendedAddr) {
      throw new Error(
        'Invalid private key: public key does not match the seed'
      );
    }

    return sk;
  }

  private static parsePrivateKey(privateKeyHex: string): Uint8Array {
    return this.validateAndParseSecretKey(privateKeyHex);
  }

  // Public so auth-account-discovery can reuse the same lookup/dedup logic.
  static async findAccountByAddress(
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
      const accountInfo =
        await networkService.getAccountInfo(normalizedOriginal);

      if (!accountInfo) {
        return false;
      }

      // algosdk v3 exposes the auth address as `authAddr` (an Address object
      // with publicKey bytes), not the legacy kebab-case 'auth-addr' (which is
      // always undefined in v3 — reading it made rekey verification always fail).
      const authAddr = (accountInfo as any).authAddr;
      const reportedAuthAddress =
        typeof authAddr === 'string'
          ? authAddr
          : authAddr?.publicKey
            ? algosdk.encodeAddress(new Uint8Array(authAddr.publicKey))
            : undefined;
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
    deviceInfo: LedgerDeviceInfo,
    // TASK-212: epoch captured by the caller before it read `wallet`, so this
    // metadata-timestamp write is skipped if a reset raced that read.
    readEpoch: number
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

    await this.storeWallet(
      {
        ...wallet,
        accounts,
      },
      readEpoch
    );

    return nextAccount;
  }

  private static async addAccountToWallet(
    accountMetadata: AccountMetadata,
    // TASK-220: the secure reset generation captured by the caller BEFORE it
    // wrote any secret. Threaded into every metadata creation/add write so a
    // full reset racing this account-add aborts the write (ResetRacedError)
    // rather than resurrecting a wiped wallet or orphaning the new key.
    creationGen: number
  ): Promise<void> {
    // TASK-212: guard the write against a reset racing this read.
    const readEpoch = walletResetEpoch;
    const wallet = await this.getCurrentWallet();
    if (!wallet) {
      // If no wallet exists, create one with this account
      if (accountMetadata.type === AccountType.STANDARD) {
        await this.createWallet(
          accountMetadata as StandardAccountMetadata,
          creationGen
        );
      } else if (
        accountMetadata.type === AccountType.REMOTE_SIGNER ||
        accountMetadata.type === AccountType.WATCH
      ) {
        // Create wallet with non-standard account (no mnemonic required)
        await this.createWalletWithAccount(accountMetadata, creationGen);
      } else {
        throw new Error('Cannot create wallet with this account type');
      }
    } else {
      wallet.accounts.push(accountMetadata);
      // Pass BOTH the read epoch (don't resurrect a concurrently-wiped wallet)
      // and the creation generation (abort + let the caller roll back a raced
      // STANDARD key). For a STANDARD add either guard tripping throws
      // ResetRacedError; for a non-secret add the wallet simply isn't resurrected.
      await this.storeWallet(wallet, readEpoch, creationGen);
    }
  }

  private static async createWalletWithAccount(
    accountMetadata: AccountMetadata,
    creationGen?: number
  ): Promise<Wallet> {
    const wallet: Wallet = {
      id: this.generateWalletId(),
      version: '1.0',
      createdAt: new Date().toISOString(),
      accounts: [accountMetadata],
      activeAccountId: accountMetadata.id,
      settings: this.getDefaultWalletSettings(),
    };

    await this.storeWallet(wallet, undefined, creationGen);
    return wallet;
  }

  /**
   * TASK-212 — serialize a WALLET_KEY mutation on the shared write chain so
   * writes and wipes never interleave at the storage layer. Each task runs after
   * the previous settles (success OR failure); a task's rejection is isolated so
   * it can't poison later writes, but is still surfaced to THIS caller.
   */
  private static enqueueWalletWrite<T>(task: () => Promise<T>): Promise<T> {
    const run = walletWriteChain.then(task, task);
    walletWriteChain = run.catch(() => {});
    return run;
  }

  /**
   * Persist the wallet metadata, serialized on the write chain.
   *
   * TASK-212 — pass `readEpoch` for any write DERIVED FROM A PRIOR getCurrentWallet
   * READ (the read-repair writes AND every intentional read-modify-write mutation:
   * addAccount, deleteAccount, setActiveAccount, label/metadata updates, ledger
   * association, standard→remote-signer conversion, …). The write is then SKIPPED
   * if a wipe/reset advanced the reset epoch since that read, so a concurrent
   * restore/reset can't be undone by re-persisting the pre-reset blob (which would
   * recreate account records whose secure keys were already wiped). The epoch is
   * re-checked INSIDE the serialized task (after any earlier-enqueued wipe), and
   * the write chain still guarantees a wipe enqueued afterward wins even if the
   * check narrowly passes. CREATION writes (createWallet / createWalletWithAccount
   * / persistRestoredWallet) pass no epoch and always persist.
   */
  private static async storeWallet(
    wallet: Wallet,
    readEpoch?: number,
    // TASK-220: pass for a CREATION/ADD write that follows a fresh key/account
    // creation (createWallet, createWalletWithAccount, ledger/restore creation,
    // and the STANDARD existing-wallet add). Captured before the secret write;
    // if the SECURE reset generation advanced since, a full reset raced this
    // creation, so the write is ABORTED with ResetRacedError (not silently
    // skipped) — the caller then rolls back the just-written secret and the
    // reset wins (DR-2). This is the guard that fires in the clearAll()→
    // clearAllWallets() window, where walletResetEpoch has not yet bumped.
    creationGen?: number
  ): Promise<void> {
    // Sanitize + serialize a SNAPSHOT now (synchronously), before enqueuing, so a
    // later in-place mutation of `wallet` by the caller can't alter what is
    // persisted once this task reaches the front of the chain.
    const serialized = JSON.stringify(
      this.sanitizeWalletForPersistence(wallet)
    );
    const wrote = await this.enqueueWalletWrite(async () => {
      // TASK-220 creation/add guard: abort if a reset advanced the SECURE
      // generation since this creation captured it. Throwing (not skipping) lets
      // the caller roll back the secret it already wrote so neither store keeps a
      // half-created account.
      if (
        creationGen !== undefined &&
        AccountSecureStorage.getResetGeneration() !== creationGen
      ) {
        throw new ResetRacedError();
      }
      if (readEpoch !== undefined) {
        // Guarded write (read-repair OR intentional read-modify-write): skip if a
        // wipe advanced the epoch since the read this write derives from...
        if (readEpoch !== walletResetEpoch) {
          // A creation/add write must ABORT (so its secret is rolled back), not
          // silently skip like a pure read-modify-write mutation.
          if (creationGen !== undefined) throw new ResetRacedError();
          return false;
        }
        // ...OR if a wipe has COMPLETED (tombstone set AND primary now absent)
        // since. A reset started in the epoch-bump→removeItem gap leaves the epoch
        // matching but the wipe task's tombstone set before this write runs, so
        // the tombstone is the backstop against a stale mutation resurrecting the
        // just-wiped wallet. Require the primary to actually be ABSENT: a stuck
        // tombstone left beside a still-present primary (a failed removeItem/
        // tombstone-clear, or a crash mid-write) must NOT silently disable
        // mutations — such a write is not a resurrection and proceeds below,
        // clearing the stale marker. (Creation writes pass no epoch.)
        const wiped = await storage.getItem(this.WIPE_TOMBSTONE_KEY);
        if (wiped != null) {
          const current = await storage.getItem(this.WALLET_KEY);
          if (current == null) {
            if (creationGen !== undefined) throw new ResetRacedError();
            return false;
          }
        }
      }
      // TASK-212: only the PRIMARY (AsyncStorage) write is serialized on the
      // chain, so a hanging legacy secure-store op can never block a subsequent
      // write or wipe.
      await storage.setItem(this.WALLET_KEY, serialized);
      // A primary blob now exists — the wiped state (if any) is over. Clear the
      // durable tombstone atomically with the write so migrateLegacyValue is
      // re-enabled and no stale "wiped" marker lingers past a create/restore.
      await storage.removeItem(this.WIPE_TOMBSTONE_KEY);
      return true;
    });
    // Best-effort legacy secure-store cleanup, OUTSIDE the chain and
    // fire-and-forget so a stalled keychain op can't hold up this write (or the
    // chain). Harmless if it lingers: the primary copy is authoritative and
    // getStoredValue prefers it (migrateLegacyValue only runs when primary is
    // absent).
    if (wrote) {
      void this.clearLegacyValue(this.WALLET_KEY);
    }
  }

  /**
   * TASK-111: Public wrapper used by the backup/restore flow to persist a
   * restored wallet through the same sanitizing path as every other write.
   * Delegates to the private storeWallet(), which strips per-account mnemonics
   * via sanitizeWalletForPersistence() and clears any legacy secure-store copy.
   * Restore code MUST use this instead of a raw storage.setItem so a restored
   * wallet can never leak a mnemonic into general storage.
   *
   * TASK-220: pass the secure reset generation captured at the start of the
   * restore so this commit is ABORTED (ResetRacedError) if a full reset raced
   * the restore — the restore then rolls back the secrets it wrote (DR-2).
   */
  static async persistRestoredWallet(
    wallet: Wallet,
    creationGen?: number
  ): Promise<void> {
    await this.storeWallet(wallet, undefined, creationGen);
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
      // TASK-220 (DR-3): serialize ONLY the primary read on the write chain so it
      // observes a wipe's removeItem that was enqueued before it. Closes the
      // stale-read window where getCurrentWallet, having captured walletResetEpoch
      // AFTER a reset already bumped it, still reads the pre-wipe blob because the
      // wipe's removeItem is queued (so resetRacedRead sees a matching epoch and
      // returns the stale wallet). Idle chain → ~one microtask; an active wipe →
      // the read waits for it (the correct read-after-wipe). No reentrancy: the
      // enqueued task does ONLY getItem; migrateLegacyValue enqueues its OWN task
      // AFTER this read resolves — sequential, never nested. Parse/heal stay off
      // the chain (this returns just the raw string).
      const value = await this.enqueueWalletWrite(() => storage.getItem(key));
      if (value) {
        return value;
      }

      return await this.migrateLegacyValue(key);
    } catch (error) {
      console.error(`Failed to get stored value for key ${key}:`, error);
      return null;
    }
  }

  /**
   * STRICT, boot-only wallet-presence probe (TASK-213). Unlike getCurrentWallet()
   * — which swallows storage read errors and resolves `null`, making a genuine
   * read FAILURE indistinguishable from "no wallet" (the auth-init fail-OPEN) —
   * this variant THROWS on a genuine storage read failure (or a present-but-
   * corrupt/unparseable blob) and resolves `false` ONLY for genuine ABSENCE (no
   * wallet stored, or a stored wallet with zero accounts).
   *
   * It does NOT decrypt or return key material, does NOT heal-on-read, and does
   * NOT touch the module wallet cache — it only answers "does a usable wallet
   * exist?" so the auth-init path can distinguish absence from failure.
   *
   * Used EXCLUSIVELY by AuthContext.checkInitialAuthState so lock computation can
   * fail CLOSED (the "secure storage unavailable" recovery state) on a storage
   * read failure. Every OTHER caller must keep using getCurrentWallet(), whose
   * error-swallowing contract (resolve null on failure) is relied on across its
   * many call sites, including signing.
   */
  static async hasWalletWithAccountsStrict(): Promise<boolean> {
    // Strict raw read: a throw (keychain / AsyncStorage unavailable) propagates
    // to the caller instead of collapsing to null.
    const walletData = await this.getStoredValueStrict(this.WALLET_KEY);
    if (!walletData) {
      // Genuine ABSENCE — no wallet blob in either the primary or legacy location.
      return false;
    }
    // A present-but-corrupt blob is a read FAILURE, not absence: let JSON.parse
    // throw so the caller fails CLOSED rather than treating corruption as "no
    // wallet" (which would drop into the unlocked setup state).
    const parsed = JSON.parse(walletData) as Wallet;
    if (!Array.isArray(parsed.accounts)) {
      // Valid JSON but a structurally-corrupt wallet (missing / non-array
      // `accounts`, e.g. {"accounts":{}}). That is corruption, NOT absence —
      // fail CLOSED by throwing so the auth-init path enters recovery rather
      // than the unlocked setup state. Only a genuine EMPTY array below is the
      // intended absence-like "no accounts yet" ⇒ setup case.
      throw new Error(
        'Corrupt wallet blob: `accounts` is present but not an array'
      );
    }
    return parsed.accounts.length > 0;
  }

  /**
   * STRICT, boot-only probe: does a persisted wallet hold ≥1 locally-KEY-BEARING
   * (STANDARD) account? (TASK-213 Codex round-4). A STANDARD account stores its
   * private key encrypted under the user secret, and setupPin ALWAYS precedes the
   * key import (SecuritySetupScreen), so a STANDARD account can NEVER exist
   * without a PIN having been configured. WATCH / LEDGER / REMOTE_SIGNER accounts
   * hold no local PIN-wrapped key, so a PIN-less wallet of only those is legit.
   *
   * The auth-init path uses this as a corroborating durable signal (wallet
   * metadata lives in plaintext AsyncStorage, UNAFFECTED by an Android keystore
   * desync) to close the residual Android fail-OPEN the per-key presence sentinel
   * cannot cover: a PRE-sentinel install whose keystore breaks on its very first
   * boot after upgrade has no sentinel yet, so a swallowed-to-null PIN read looks
   * like genuine absence — but if a STANDARD account exists, that "absence" is
   * impossible and must be a read FAILURE ⇒ fail CLOSED.
   *
   * PROPAGATES a storage READ failure (fail closed, same as the sibling strict
   * reads); resolves `false` for genuine absence or a structurally-unusable blob
   * (whose corruption is already surfaced by hasWalletWithAccountsStrict). It only
   * ever answers a POSITIVE "a key-bearing account exists", never weakens a verdict.
   */
  static async hasKeyBearingAccountStrict(): Promise<boolean> {
    const walletData = await this.getStoredValueStrict(this.WALLET_KEY);
    if (!walletData) {
      return false;
    }
    try {
      const parsed = JSON.parse(walletData) as Wallet;
      if (!Array.isArray(parsed.accounts)) {
        return false;
      }
      return parsed.accounts.some((acc) => acc?.type === AccountType.STANDARD);
    } catch {
      // A corrupt blob is handled (thrown) by hasWalletWithAccountsStrict; here we
      // must not emit a false POSITIVE, so treat an unparseable blob as "unknown".
      return false;
    }
  }

  /**
   * Strict sibling of getStoredValue (TASK-213): reads the primary then the
   * legacy secure-store location but PROPAGATES storage read errors instead of
   * collapsing them to null. Resolves `null` ONLY for genuine absence (both
   * locations empty). No JSON parse, no migration WRITE, no cache side effect.
   */
  private static async getStoredValueStrict(
    key: string
  ): Promise<string | null> {
    // A throw here is a genuine read failure and propagates; `null` = absent.
    const value = await storage.getItem(key);
    if (value) {
      return value;
    }
    // TASK-212: for the wallet blob, honor the durable wipe tombstone BEFORE the
    // legacy fallback — a wiped wallet whose best-effort legacy delete failed must
    // read as ABSENT here too, so the strict boot probes never treat a surviving
    // legacy secure-store copy as a present wallet.
    if (key === this.WALLET_KEY) {
      const wiped = await storage.getItem(this.WIPE_TOMBSTONE_KEY);
      if (wiped != null) {
        return null;
      }
    }
    const legacy = await secureStorage.getItem(key);
    return legacy ?? null;
  }

  /**
   * Strip key material from every account before persistence. TASK-212: this is
   * now type-AGNOSTIC — it removes ALL SECRET_ACCOUNT_FIELDS (mnemonic +
   * privateKey) from every account regardless of `type`, matching the
   * type-agnostic read-path detector/scrubber (accountHasSecretMaterial /
   * stripAccountSecrets, F-22/TASK-179). A corrupt/mistyped account carrying key
   * material on a non-STANDARD type is now scrubbed on the write path too, not
   * just the read path. STANDARD accounts keep the persisted-schema shape (an
   * explicit empty `mnemonic`).
   */
  private static sanitizeWalletForPersistence(wallet: Wallet): Wallet {
    return {
      ...wallet,
      accounts: wallet.accounts.map((account) => {
        const record: Record<string, unknown> = {
          ...(account as unknown as Record<string, unknown>),
        };
        for (const field of SECRET_ACCOUNT_FIELDS) {
          delete record[field];
        }
        if (record.type === AccountType.STANDARD) {
          record.mnemonic = '';
        }
        return record as unknown as AccountMetadata;
      }),
    };
  }

  private static async migrateLegacyValue(key: string): Promise<string | null> {
    try {
      // TASK-212: capture the reset epoch for the WALLET_KEY migration BEFORE
      // reading the legacy blob, so a concurrent wipe isn't undone by
      // re-persisting the migrated blob (this is a third read-path write to
      // WALLET_KEY, alongside heal-on-read and legacy-strip).
      const migrationEpoch = walletResetEpoch;

      // Try to get from secure storage (legacy location)
      const legacyValue = await secureStorage.getItem(key);
      if (!legacyValue) {
        return null;
      }

      if (key === this.WALLET_KEY) {
        // Fail CLOSED: sanitize the legacy wallet blob BEFORE it can reach general
        // storage. A corrupt/unparseable blob may still carry plaintext key
        // material, so on any parse/sanitize failure we must NOT copy the raw
        // payload into AsyncStorage — leave the legacy copy and report absence.
        let sanitized: string;
        try {
          const legacyWallet = JSON.parse(legacyValue) as Wallet;
          sanitized = JSON.stringify(
            this.sanitizeWalletForPersistence(legacyWallet)
          );
        } catch (error) {
          console.warn(
            'Failed to sanitize legacy wallet payload; not migrating',
            error
          );
          return null;
        }

        // Serialize + epoch-guard the WALLET_KEY migration on the write chain.
        const migrated = await this.enqueueWalletWrite(async () => {
          if (migrationEpoch !== walletResetEpoch) {
            // A wipe/reset raced this migration — do NOT resurrect the blob.
            return false;
          }
          // TASK-212: re-check primary ABSENCE inside the serialized task. A
          // concurrent createWallet/restore may have written a fresh primary blob
          // while we awaited the legacy value; migrating the stale legacy blob
          // would clobber it (a reset epoch doesn't change in this race). Because
          // that write is also serialized on this chain, this read is atomic wrt
          // it.
          const current = await storage.getItem(key);
          if (current != null) {
            return false;
          }
          // TASK-212: honor the durable wipe tombstone. If the wallet was
          // intentionally wiped and not since re-created, a surviving legacy copy
          // must NOT resurrect it — this holds even across an app restart (when
          // the in-memory reset epoch has reset to 0). Any create/restore clears
          // the tombstone, at which point a primary exists and migration no
          // longer fires.
          const wiped = await storage.getItem(this.WIPE_TOMBSTONE_KEY);
          if (wiped != null) {
            return false;
          }
          await storage.setItem(key, sanitized);
          return true;
        });
        // Drop the legacy copy either way; the wipe path also clears it.
        await secureStorage.deleteItem(key).catch(() => {});
        return migrated ? sanitized : null;
      }

      await storage.setItem(key, legacyValue);
      await secureStorage.deleteItem(key).catch(() => {});
      return legacyValue;
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
