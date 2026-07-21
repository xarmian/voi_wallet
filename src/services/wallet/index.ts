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
        // Persist the pairing authentication level. Defaults conservatively to
        // 'v1-unsigned' until the import screen supplies a verified level
        // (TASK-144).
        authLevel: withDefaultAuthLevel(request.authLevel),
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
    await this.storeWallet(wallet);

    return remoteSignerAccount;
  }

  // Wallet Management
  static async getCurrentWallet(): Promise<Wallet | null> {
    try {
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

        await this.storeWallet(parsed);

        const sanitized = await this.mergeSettingsAndHeal(parsed);
        return this.deepCloneWallet(sanitized);
      }

      // (4) Sanitized path: the raw string carries no secret, so it is safe to
      // use as both the in-flight dedup key and the cache key. Collapse
      // concurrent cold-boot loads of the same raw string into one heal/validate
      // pass; every caller still receives its own deep clone.
      const inFlight = getCurrentWalletParsesInFlight.get(walletData);
      if (inFlight) {
        const shared = await inFlight;
        return shared ? this.deepCloneWallet(shared) : null;
      }

      const loadPromise = (async () => {
        const wallet = await this.mergeSettingsAndHeal(parsed);
        // Fail-closed: only memoize a wallet whose accounts hold NO secret
        // material, keyed on a secret-free raw string. hasSecretMaterial already
        // guaranteed this above; re-checking the healed result keeps the
        // invariant local to the write so a future refactor cannot silently cache
        // key material. (If heal-on-read re-stored a repaired address the stored
        // string also changed, so this entry is simply superseded on the next
        // read — never served stale, since every read compares the live string.)
        if (
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
  private static async mergeSettingsAndHeal(wallet: Wallet): Promise<Wallet> {
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
      await this.storeWallet(wallet);
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
      // Clears wallet METADATA only (the account list / active-account record).
      // Private keys in secure storage are NOT touched here; callers that need a
      // full reset must also call AccountSecureStorage.clearAll() — as
      // LockScreen.performReset() does immediately before invoking this method.
      await storage.removeItem(this.WALLET_KEY);
      await this.clearLegacyValue(this.WALLET_KEY);

      console.log('All wallet metadata cleared');
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
        accountMetadata.type === AccountType.WATCH
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
    await this.storeValue(this.WALLET_KEY, JSON.stringify(persistencePayload));
  }

  /**
   * TASK-111: Public wrapper used by the backup/restore flow to persist a
   * restored wallet through the same sanitizing path as every other write.
   * Delegates to the private storeWallet(), which strips per-account mnemonics
   * via sanitizeWalletForPersistence() and clears any legacy secure-store copy.
   * Restore code MUST use this instead of a raw storage.setItem so a restored
   * wallet can never leak a mnemonic into general storage.
   */
  static async persistRestoredWallet(wallet: Wallet): Promise<void> {
    await this.storeWallet(wallet);
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
    const legacy = await secureStorage.getItem(key);
    return legacy ?? null;
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
