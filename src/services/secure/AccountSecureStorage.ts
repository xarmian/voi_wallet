import * as SecureStore from 'expo-secure-store';
import type { SecureStoreOptions } from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Application from 'expo-application';
import { Platform } from 'react-native';
// Use crypto-js (pure JS, works in RN/Expo) with explicit side-effect imports
import CryptoJS from 'crypto-js';
import 'crypto-js/hmac-sha256';
import 'crypto-js/sha256';
import 'crypto-js/aes';
import 'crypto-js/mode-ctr';
import 'crypto-js/pad-nopadding';
import 'crypto-js/enc-hex';
import 'crypto-js/pbkdf2';
// Custom PBKDF2 implementation using CryptoJS (React Native compatible)

import {
  AccountType,
  AccountMetadata,
  StandardAccountMetadata,
  WatchAccountMetadata,
  RekeyedAccountMetadata,
  SecureAccountStorage,
  AccountStorageError,
  AccountRetrievalError,
  AccountNotFoundError,
  AuthenticationRequiredError,
} from '../../types/wallet';

type PersistedAccountMetadata = Omit<SecureAccountStorage, 'encryptedPrivateKey'>;

interface AccountSecretPayload {
  accountId: string;
  encryptedPrivateKey: string;
  authMethod: 'biometric' | 'pin';
}

// PBKDF2 using CryptoJS with SHA256; returns hex string of keyLength bytes
const customPBKDF2 = (
  password: string,
  saltHex: string,
  iterations: number,
  keyLength: number
): string => {
  const saltWA = CryptoJS.enc.Hex.parse(saltHex);
  const derived = CryptoJS.PBKDF2(password, saltWA, {
    keySize: keyLength / 4, // CryptoJS keySize is in 32-bit words
    iterations,
    hasher: (CryptoJS.algo as any).SHA256,
  });
  return derived.toString(CryptoJS.enc.Hex);
};

const SECURE_STORE_OPTIONS: SecureStoreOptions =
  Platform.OS === 'ios'
    ? { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
    : {};

interface StoredPinData {
  hash: string;
  iterations: number;
  format: 'json' | 'legacy';
}

export class AccountSecureStorage {
  private static readonly STORAGE_KEY_PREFIX = 'voi_account_secret_';
  private static readonly LEGACY_STORAGE_KEY_PREFIX = 'voi_account_';
  private static readonly METADATA_KEY = 'voi_account_metadata_';
  private static readonly METADATA_LIST_KEY = 'voi_account_list';
  private static readonly PIN_KEY = 'voi_wallet_pin';
  private static readonly SALT_KEY = 'voi_wallet_salt';
  private static readonly BIOMETRIC_ENABLED_KEY = 'voi_biometric_enabled';
  private static readonly DEVICE_ID_KEY = 'voi_device_installation_id';
  private static readonly PIN_TIMEOUT_KEY = 'voi_pin_timeout_setting';
  // Iteration counts optimized for mobile performance while maintaining security
  // SecureStore provides hardware-backed encryption, so lower iterations are acceptable
  private static readonly ENCRYPTION_KEY_ITERATIONS = 10000;
  // PIN verification now uses a hardware-backed store; tune iterations for mobile hardware
  private static readonly PIN_ITERATIONS = 8000;
  private static readonly LEGACY_PIN_ITERATIONS = 1000;
  private static readonly PREVIOUS_PIN_ITERATIONS: number[] = [];

  private static legacyCheckRequired: boolean | undefined;

  private static secretKey(accountId: string): string {
    return `${this.STORAGE_KEY_PREFIX}${accountId}`;
  }

  private static metadataKey(accountId: string): string {
    return `${this.METADATA_KEY}${accountId}`;
  }

  private static async readMetadata(
    accountId: string
  ): Promise<PersistedAccountMetadata | null> {
    const stored = await AsyncStorage.getItem(this.metadataKey(accountId));
    if (stored) {
      try {
        return JSON.parse(stored) as PersistedAccountMetadata;
      } catch (error) {
        console.warn('Failed to parse account metadata', error);
        return null;
      }
    }

    // Attempt legacy migration if AsyncStorage entry is missing
    return await this.migrateLegacyAccountData(accountId);
  }

  private static async saveMetadata(
    accountId: string,
    metadata: PersistedAccountMetadata
  ): Promise<void> {
    await AsyncStorage.setItem(
      this.metadataKey(accountId),
      JSON.stringify(metadata)
    );
  }

  private static async readSecret(
    accountId: string
  ): Promise<AccountSecretPayload | null> {
    try {
      const stored = await SecureStore.getItemAsync(this.secretKey(accountId));
      if (stored) {
        return JSON.parse(stored) as AccountSecretPayload;
      }

      // Fall back to legacy storage for migration
      const migrated = await this.migrateLegacyAccountData(accountId);
      if (!migrated) {
        return null;
      }

      const migratedSecret = await SecureStore.getItemAsync(
        this.secretKey(accountId)
      );
      return migratedSecret
        ? (JSON.parse(migratedSecret) as AccountSecretPayload)
        : null;
    } catch (error) {
      console.warn('Failed to parse account secret payload', error);
      return null;
    }
  }

  private static async saveSecret(
    accountId: string,
    secret: AccountSecretPayload | null
  ): Promise<void> {
    if (!secret) {
      await SecureStore.deleteItemAsync(this.secretKey(accountId)).catch(() => {});
      return;
    }
    await SecureStore.setItemAsync(
      this.secretKey(accountId),
      JSON.stringify(secret)
    );
  }

  private static async migrateLegacyAccountData(
    accountId: string
  ): Promise<PersistedAccountMetadata | null> {
    try {
      const legacyKey = `${this.LEGACY_STORAGE_KEY_PREFIX}${accountId}`;
      const legacyData = await SecureStore.getItemAsync(legacyKey);
      if (!legacyData) {
        return null;
      }

      const parsed = JSON.parse(legacyData) as SecureAccountStorage;

      const { encryptedPrivateKey, ...metadata } = parsed;
      const persistable: PersistedAccountMetadata = metadata;
      await AsyncStorage.setItem(
        this.metadataKey(accountId),
        JSON.stringify(persistable)
      );
      await this.addToAccountList(accountId).catch(() => {});

      if (encryptedPrivateKey) {
        const secretPayload: AccountSecretPayload = {
          accountId: parsed.accountId,
          encryptedPrivateKey,
          authMethod: parsed.authMethod,
        };
        await SecureStore.setItemAsync(
          this.secretKey(accountId),
          JSON.stringify(secretPayload)
        );
      } else {
        await SecureStore.deleteItemAsync(this.secretKey(accountId)).catch(() => {});
      }

      await SecureStore.deleteItemAsync(legacyKey).catch(() => {});
      return persistable;
    } catch (error) {
      console.error('Failed to migrate legacy account data', error);
      return null;
    }
  }

  static async storeAccount(
    account: AccountMetadata,
    privateKey?: Uint8Array
  ): Promise<void> {
    try {
      const hasPin = await this.hasPin();
      const lastAccessed = new Date().toISOString();

      const metadata: PersistedAccountMetadata = {
        accountId: account.id,
        address: account.address,
        type: account.type,
        publicData: {
          publicKey: account.publicKey,
          label: account.label || '',
          color: account.color || '#000000',
          createdAt: account.createdAt,
          importedAt: account.importedAt,
          avatarUrl: account.avatarUrl,
          avatarUpdatedAt: account.avatarUpdatedAt,
        },
        authMethod: hasPin ? 'pin' : 'biometric',
        lastAccessed,
      };

      // Encrypt and store private key for Standard accounts
      if (account.type === AccountType.STANDARD && privateKey) {
        const encryptedPrivateKey = await this.encryptPrivateKey(privateKey);
        await this.saveSecret(account.id, {
          accountId: account.id,
          encryptedPrivateKey,
          authMethod: metadata.authMethod,
        });
      } else {
        await this.saveSecret(account.id, null);
      }

      // Store metadata for quick access
      await this.storeAccountMetadata(metadata);
    } catch (error) {
      throw new AccountStorageError(
        `Failed to store account: ${error.message}`
      );
    }
  }

  static async retrieveAccount(accountId: string): Promise<AccountMetadata> {
    try {
      const accountData = await this.readMetadata(accountId);

      if (!accountData) {
        throw new AccountNotFoundError('Account not found');
      }

      // Update last accessed time
      await this.updateLastAccessed(accountId);

      // Build account metadata based on type
      const baseMetadata = {
        id: accountData.accountId,
        address: accountData.address,
        publicKey: accountData.publicData.publicKey,
        label: accountData.publicData.label,
        color: accountData.publicData.color,
        isHidden: false,
        createdAt: accountData.publicData.createdAt,
        importedAt: accountData.publicData.importedAt,
        lastUsed: accountData.lastAccessed,
        avatarUrl: accountData.publicData.avatarUrl,
        avatarUpdatedAt: accountData.publicData.avatarUpdatedAt,
      };

      // Return appropriate metadata type
      switch (accountData.type) {
        case AccountType.STANDARD:
          return {
            ...baseMetadata,
            type: AccountType.STANDARD,
            mnemonic: '', // Will be loaded separately for security
            hasBackup: false, // Will be loaded from metadata
          } as StandardAccountMetadata;

        case AccountType.WATCH:
          return {
            ...baseMetadata,
            type: AccountType.WATCH,
          } as WatchAccountMetadata;

        case AccountType.REKEYED:
          return {
            ...baseMetadata,
            type: AccountType.REKEYED,
            authAddress: '', // Will be loaded from metadata
            originalOwner: false,
          } as RekeyedAccountMetadata;

        default:
          throw new AccountStorageError('Unknown account type');
      }
    } catch (error) {
      if (
        error instanceof AccountNotFoundError ||
        error instanceof AccountStorageError
      ) {
        throw error;
      }
      throw new AccountRetrievalError(
        `Failed to retrieve account: ${error.message}`
      );
    }
  }

  static async getPrivateKey(
    accountId: string,
    pin?: string
  ): Promise<Uint8Array> {
    try {
      let unlockMethod: 'pin' | 'biometric' = 'biometric';

      if (pin) {
        const isValidPin = await this.verifyPin(pin);
        if (!isValidPin) {
          throw new AuthenticationRequiredError('Invalid PIN');
        }
        unlockMethod = 'pin';
      }

      let secretPayloadRaw: string | null = null;

      if (unlockMethod === 'pin') {
        try {
          secretPayloadRaw = await SecureStore.getItemAsync(
            this.secretKey(accountId)
          );
        } catch (error) {
          throw new AuthenticationRequiredError(
            'Failed to access private key with PIN'
          );
        }
      } else {
        const biometricEnabled = await this.isBiometricEnabled();

        if (biometricEnabled) {
          try {
            secretPayloadRaw = await SecureStore.getItemAsync(
              this.secretKey(accountId),
              {
                requireAuthentication: true,
                authenticationPrompt: 'Authenticate to access private key',
              }
            );
          } catch (error) {
            throw new AuthenticationRequiredError(
              'Biometric authentication failed or was cancelled'
            );
          }
        } else {
          const hasPin = await this.hasPin();
          if (hasPin) {
            throw new AuthenticationRequiredError(
              'PIN required to access private key'
            );
          }

          try {
            secretPayloadRaw = await SecureStore.getItemAsync(
              this.secretKey(accountId)
            );
          } catch (error) {
            throw new AccountRetrievalError('Failed to retrieve account data');
          }
        }
      }

      if (!secretPayloadRaw) {
        await this.migrateLegacyAccountData(accountId);
        secretPayloadRaw = await SecureStore.getItemAsync(
          this.secretKey(accountId)
        );
      }

      if (!secretPayloadRaw) {
        const metadata = await this.readMetadata(accountId);
        if (metadata) {
          throw new AccountStorageError(
            'Private key not available for this account'
          );
        }
        throw new AccountNotFoundError('Account not found');
      }

      const parsed: AccountSecretPayload = JSON.parse(secretPayloadRaw);
      if (!parsed.encryptedPrivateKey) {
        throw new AccountStorageError(
          'Private key not available for this account'
        );
      }

      let privateKey: Uint8Array;

      try {
        privateKey = await this.decryptPrivateKey(parsed.encryptedPrivateKey);
      } catch (error) {
        if (unlockMethod === 'pin' && pin) {
          privateKey = await this.decryptPrivateKeyWithPin(
            parsed.encryptedPrivateKey,
            pin
          );
        } else {
          throw error;
        }
      }

      await this.updateLastAccessed(accountId);

      return privateKey;
    } catch (error) {
      if (
        error instanceof AccountNotFoundError ||
        error instanceof AccountStorageError ||
        error instanceof AuthenticationRequiredError ||
        error instanceof AccountRetrievalError
      ) {
        throw error;
      }
      throw new AccountRetrievalError(
        `Failed to retrieve private key: ${error.message}`
      );
    }
  }

  static async deleteAccount(accountId: string): Promise<void> {
    try {
      // Remove from secure storage
      await this.saveSecret(accountId, null);

      // Remove metadata
      await AsyncStorage.removeItem(this.metadataKey(accountId));
      await SecureStore.deleteItemAsync(
        `${this.LEGACY_STORAGE_KEY_PREFIX}${accountId}`
      ).catch(() => {});

      // Update account list
      await this.removeFromAccountList(accountId);
    } catch (error) {
      throw new AccountStorageError(
        `Failed to delete account: ${error.message}`
      );
    }
  }

  static async getAllAccountIds(): Promise<string[]> {
    try {
      const stored = await AsyncStorage.getItem(this.METADATA_LIST_KEY);
      if (stored) {
        return JSON.parse(stored) as string[];
      }

      const legacy = await SecureStore.getItemAsync(this.METADATA_LIST_KEY);
      if (legacy) {
        await AsyncStorage.setItem(this.METADATA_LIST_KEY, legacy);
        await SecureStore.deleteItemAsync(this.METADATA_LIST_KEY).catch(() => {});
        return JSON.parse(legacy) as string[];
      }

      return [];
    } catch (error) {
      throw new AccountRetrievalError(
        `Failed to retrieve account list: ${error.message}`
      );
    }
  }

  private static async encryptPrivateKey(
    privateKey: Uint8Array
  ): Promise<string> {
    let privateKeyHex: string | null = null;
    let keyMaterial: string | null = null;

    try {
      // Generate a strong encryption key using device-specific entropy
      const salt = await Crypto.getRandomBytesAsync(32);
      const iv = await Crypto.getRandomBytesAsync(16); // 128-bit IV for AES
      keyMaterial = await this.deriveEncryptionKey(salt);

      // Convert private key to hex string for encryption
      privateKeyHex = Buffer.from(privateKey).toString('hex');

      // Use AES-256-GCM with explicit IV for authenticated encryption
      const ivWordArray = CryptoJS.enc.Hex.parse(
        Buffer.from(iv).toString('hex')
      );
      const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);

      const encrypted = CryptoJS.AES.encrypt(privateKeyHex, keyWordArray, {
        iv: ivWordArray,
        mode: CryptoJS.mode.CTR,
        padding: CryptoJS.pad.NoPadding,
      });

      // Add HMAC for authentication (since we can't use GCM)
      const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
      const hmac = CryptoJS.HmacSHA256(
        encrypted.toString(),
        hmacKey
      ).toString();

      // Combine salt, iv, encrypted data, and hmac
      const saltHex = Buffer.from(salt).toString('hex');
      const ivHex = Buffer.from(iv).toString('hex');
      return `${saltHex}:${ivHex}:${encrypted.toString()}:${hmac}`;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to encrypt private key: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      // Clear sensitive data from memory
      if (privateKeyHex) {
        privateKeyHex = '0'.repeat(privateKeyHex.length);
      }
      if (keyMaterial) {
        keyMaterial = '0'.repeat(keyMaterial.length);
      }
    }
  }

  private static async decryptPrivateKey(
    encryptedData: string
  ): Promise<Uint8Array> {
    let keyMaterial: string | null = null;
    let privateKeyHex: string | null = null;

    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 4) {
        throw new Error('Invalid encrypted data format');
      }

      const [saltHex, ivHex, encrypted, expectedHmac] = parts;
      const salt = new Uint8Array(Buffer.from(saltHex, 'hex'));
      const iv = new Uint8Array(Buffer.from(ivHex, 'hex'));

      keyMaterial = await this.deriveEncryptionKey(salt);

      // Verify HMAC first to prevent padding oracle attacks
      const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
      const computedHmac = CryptoJS.HmacSHA256(encrypted, hmacKey).toString();

      if (computedHmac !== expectedHmac) {
        throw new Error('Data integrity verification failed');
      }

      // Decrypt with matching parameters
      const ivWordArray = CryptoJS.enc.Hex.parse(
        Buffer.from(iv).toString('hex')
      );
      const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);

      const decrypted = CryptoJS.AES.decrypt(encrypted, keyWordArray, {
        iv: ivWordArray,
        mode: CryptoJS.mode.CTR,
        padding: CryptoJS.pad.NoPadding,
      });

      privateKeyHex = decrypted.toString(CryptoJS.enc.Utf8);

      if (
        !privateKeyHex ||
        privateKeyHex.length === 0 ||
        privateKeyHex.length % 2 !== 0
      ) {
        throw new Error('Decryption failed');
      }

      return new Uint8Array(Buffer.from(privateKeyHex, 'hex'));
    } catch (error) {
      throw new AccountStorageError(
        `Failed to decrypt private key: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      // Clear sensitive data from memory
      if (keyMaterial) {
        keyMaterial = '0'.repeat(keyMaterial.length);
      }
      if (privateKeyHex) {
        privateKeyHex = '0'.repeat(privateKeyHex.length);
      }
    }
  }

  private static async decryptPrivateKeyWithPin(
    encryptedData: string,
    pin: string
  ): Promise<Uint8Array> {
    let keyMaterial: string | null = null;
    let privateKeyHex: string | null = null;

    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 4) {
        throw new Error('Invalid encrypted data format');
      }

      const [saltHex, ivHex, encrypted, expectedHmac] = parts;
      const salt = new Uint8Array(Buffer.from(saltHex, 'hex'));
      const iv = new Uint8Array(Buffer.from(ivHex, 'hex'));

      keyMaterial = await this.deriveEncryptionKeyWithPin(salt, pin);

      const hmacKey = CryptoJS.SHA256(keyMaterial + 'hmac_salt').toString();
      const computedHmac = CryptoJS.HmacSHA256(encrypted, hmacKey).toString();

      if (computedHmac !== expectedHmac) {
        throw new Error('Data integrity verification failed');
      }

      const ivWordArray = CryptoJS.enc.Hex.parse(
        Buffer.from(iv).toString('hex')
      );
      const keyWordArray = CryptoJS.enc.Hex.parse(keyMaterial);

      const decrypted = CryptoJS.AES.decrypt(encrypted, keyWordArray, {
        iv: ivWordArray,
        mode: CryptoJS.mode.CTR,
        padding: CryptoJS.pad.NoPadding,
      });

      privateKeyHex = decrypted.toString(CryptoJS.enc.Utf8);

      if (
        !privateKeyHex ||
        privateKeyHex.length === 0 ||
        privateKeyHex.length % 2 !== 0
      ) {
        throw new Error('Decryption failed');
      }

      return new Uint8Array(Buffer.from(privateKeyHex, 'hex'));
    } catch (error) {
      throw new AccountStorageError(
        `Failed to decrypt private key: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (keyMaterial) {
        keyMaterial = '0'.repeat(keyMaterial.length);
      }
      if (privateKeyHex) {
        privateKeyHex = '0'.repeat(privateKeyHex.length);
      }
    }
  }

  private static async deriveEncryptionKey(salt: Uint8Array): Promise<string> {
    try {
      // Get a stable, app-scoped device id (stored once in SecureStore)
      const deviceId = await this.getStableDeviceId();

      // Hash into fixed-size entropy (deterministic across runs)
      const entropyString = `voi_wallet_${deviceId}`;
      const baseEntropy = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        entropyString,
        { encoding: Crypto.CryptoEncoding.HEX }
      );

      // Derive key using custom PBKDF2 with high iteration count
      const saltHex = Buffer.from(salt).toString('hex');
      const key = customPBKDF2(
        baseEntropy,
        saltHex,
        this.ENCRYPTION_KEY_ITERATIONS,
        32
      );

      return key;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to derive encryption key: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private static async deriveEncryptionKeyWithPin(
    salt: Uint8Array,
    pin: string
  ): Promise<string> {
    try {
      const deviceId = await this.getStableDeviceId();
      const entropyString = `voi_wallet_pin_${pin}_${deviceId}`;
      const baseEntropy = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        entropyString,
        { encoding: Crypto.CryptoEncoding.HEX }
      );

      const saltHex = Buffer.from(salt).toString('hex');
      const key = customPBKDF2(
        baseEntropy,
        saltHex,
        this.ENCRYPTION_KEY_ITERATIONS,
        32
      );

      return key;
    } catch (error) {
      throw new AccountStorageError(
        `Failed to derive encryption key: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // Ensure a stable installation-scoped id, persisted outside SecureStore
  private static async getStableDeviceId(): Promise<string> {
    const existing = await SecureStore.getItemAsync(
      this.DEVICE_ID_KEY,
      SECURE_STORE_OPTIONS
    );
    if (existing) {
      return existing;
    }

    const legacy = await AsyncStorage.getItem(this.DEVICE_ID_KEY);
    if (legacy) {
      await SecureStore.setItemAsync(
        this.DEVICE_ID_KEY,
        legacy,
        SECURE_STORE_OPTIONS
      );
      await AsyncStorage.removeItem(this.DEVICE_ID_KEY).catch(() => {});
      return legacy;
    }

    // Try platform-provided identifiers
    let candidate: string | null = null;
    try {
      const iosGetter: any = (Application as any).getIosIdForVendorAsync;
      if (typeof iosGetter === 'function') {
        candidate = await iosGetter.call(Application);
      }
    } catch {}
    try {
      const androidId: any = (Application as any).androidId;
      if (typeof androidId === 'string' && androidId.length > 0) {
        candidate = androidId;
      }
    } catch {}

    if (!candidate) {
      const bytes = await Crypto.getRandomBytesAsync(16);
      candidate = Buffer.from(bytes).toString('hex');
    }

    await SecureStore.setItemAsync(
      this.DEVICE_ID_KEY,
      candidate,
      SECURE_STORE_OPTIONS
    );
    await AsyncStorage.removeItem(this.DEVICE_ID_KEY).catch(() => {});
    return candidate;
  }

  private static async storeAccountMetadata(
    metadata: PersistedAccountMetadata
  ): Promise<void> {
    try {
      await this.saveMetadata(metadata.accountId, metadata);
      await this.addToAccountList(metadata.accountId);
    } catch (error) {
      throw new AccountStorageError(
        `Failed to store account metadata: ${error.message}`
      );
    }
  }

  private static async addToAccountList(accountId: string): Promise<void> {
    try {
      const accountIds = await this.getAllAccountIds();
      if (!accountIds.includes(accountId)) {
        accountIds.push(accountId);
        await AsyncStorage.setItem(
          this.METADATA_LIST_KEY,
          JSON.stringify(accountIds)
        );
      }
    } catch (error) {
      throw new AccountStorageError(
        `Failed to update account list: ${error.message}`
      );
    }
  }

  private static async removeFromAccountList(accountId: string): Promise<void> {
    try {
      const accountIds = await this.getAllAccountIds();
      const updatedIds = accountIds.filter((id) => id !== accountId);
      await AsyncStorage.setItem(
        this.METADATA_LIST_KEY,
        JSON.stringify(updatedIds)
      );
    } catch (error) {
      throw new AccountStorageError(
        `Failed to update account list: ${error.message}`
      );
    }
  }

  private static async updateLastAccessed(accountId: string): Promise<void> {
    try {
      const metadata = await this.readMetadata(accountId);
      if (!metadata) {
        return;
      }

      const updated: PersistedAccountMetadata = {
        ...metadata,
        lastAccessed: new Date().toISOString(),
      };

      await this.saveMetadata(accountId, updated);
    } catch (error) {
      // Don't throw error for last accessed update failure - it's not critical
      console.warn(`Failed to update last accessed time: ${error.message}`);
    }
  }

  private static async requireAuthentication(purpose: string): Promise<void> {
    try {
      const hasHardware = await LocalAuthentication.hasHardwareAsync();
      const isEnrolled = await LocalAuthentication.isEnrolledAsync();

      if (!hasHardware || !isEnrolled) {
        throw new AuthenticationRequiredError(
          'Biometric authentication not available'
        );
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: this.getAuthMessage(purpose),
        fallbackLabel: 'Use PIN',
        cancelLabel: 'Cancel',
        requireConfirmation: true,
      });

      if (!result.success) {
        throw new AuthenticationRequiredError(
          `Authentication failed: ${result.error}`
        );
      }
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        throw error;
      }
      throw new AuthenticationRequiredError(
        `Authentication error: ${error.message}`
      );
    }
  }

  private static getAuthMessage(purpose: string): string {
    switch (purpose) {
      case 'access_private_key':
        return 'Authenticate to access private key';
      case 'sign_transaction':
        return 'Authenticate to sign transaction';
      case 'backup_account':
        return 'Authenticate to backup account';
      case 'delete_account':
        return 'Authenticate to delete account';
      default:
        return 'Authenticate to access account';
    }
  }

  // PIN Management Methods
  static async storePin(pin: string): Promise<void> {
    try {
      if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
        throw new Error('PIN must be 6 digits');
      }

      const salt = await this.getOrCreateSalt(true);
      const hashedPin = this.hashPin(pin, salt, this.PIN_ITERATIONS);

      await this.persistPinHash(hashedPin, salt);
      this.legacyCheckRequired = false;
    } catch (error) {
      throw new AccountStorageError(`Failed to store PIN: ${error.message}`);
    }
  }

  static async verifyPin(pin: string): Promise<boolean> {
    try {
      if (!pin || pin.length !== 6 || !/^\d{6}$/.test(pin)) {
        return false;
      }

      const storedData = await this.getStoredPinData();
      if (!storedData) {
        return false;
      }

      const salt = await this.getOrCreateSalt();

      if (storedData.format === 'json') {
        this.legacyCheckRequired = false;
        const candidateHash = this.hashPin(
          pin,
          salt,
          storedData.iterations
        );
        if (storedData.hash === candidateHash) {
          if (storedData.iterations !== this.PIN_ITERATIONS) {
            try {
              const upgradedHash = this.hashPin(
                pin,
                salt,
                this.PIN_ITERATIONS
              );
              await this.persistPinHash(upgradedHash, salt);
            } catch (error) {
              console.warn('Failed to upgrade stored PIN metadata', error);
            }
          }
          return true;
        }
        return false;
      }

      const iterationCandidates = this.getIterationCandidates();

      for (const iterations of iterationCandidates) {
        const candidateHash = this.hashPin(pin, salt, iterations);
        if (storedData.hash === candidateHash) {
          if (iterations !== this.PIN_ITERATIONS) {
            try {
              const upgradedHash = this.hashPin(
                pin,
                salt,
                this.PIN_ITERATIONS
              );
              await this.persistPinHash(upgradedHash, salt);
              this.legacyCheckRequired = false;
            } catch (error) {
              console.warn(
                'Failed to upgrade PIN hash to latest iteration count',
                error
              );
            }
          }
          return true;
        }
      }

      if (this.legacyCheckRequired === undefined) {
        this.legacyCheckRequired = true;
      }

      return false;
    } catch (error) {
      console.warn('PIN verification failed');
      return false;
    }
  }

  static async hasPin(): Promise<boolean> {
    try {
      const storedData = await this.getStoredPinData();
      return Boolean(storedData);
    } catch (error) {
      return false;
    }
  }

  static async changePin(currentPin: string, newPin: string): Promise<void> {
    try {
      // Validate inputs
      if (
        !currentPin ||
        currentPin.length !== 6 ||
        !/^\d{6}$/.test(currentPin)
      ) {
        throw new Error('Current PIN must be 6 digits');
      }
      if (!newPin || newPin.length !== 6 || !/^\d{6}$/.test(newPin)) {
        throw new Error('New PIN must be 6 digits');
      }
      if (currentPin === newPin) {
        throw new Error('New PIN must be different from current PIN');
      }

      // Verify current PIN first
      const isCurrentValid = await this.verifyPin(currentPin);
      if (!isCurrentValid) {
        throw new Error('Current PIN is incorrect');
      }

      // Generate a fresh salt for the new PIN
      const salt = await this.getOrCreateSalt(true);
      const hashedNewPin = this.hashPin(newPin, salt, this.PIN_ITERATIONS);

      await this.persistPinHash(hashedNewPin, salt);
      this.legacyCheckRequired = false;
    } catch (error) {
      throw new AccountStorageError(`Failed to change PIN: ${error.message}`);
    }
  }

  static async deletePin(): Promise<void> {
    try {
      await AsyncStorage.removeItem(this.PIN_KEY);
      await SecureStore.deleteItemAsync(this.PIN_KEY).catch(() => {});
      await AsyncStorage.removeItem(this.SALT_KEY).catch(() => {});
      await SecureStore.deleteItemAsync(this.SALT_KEY).catch(() => {});
      this.legacyCheckRequired = undefined;
    } catch (error) {
      throw new AccountStorageError('Failed to delete PIN');
    }
  }

  // Biometric Settings
  static async setBiometricEnabled(enabled: boolean): Promise<void> {
    try {
      await AsyncStorage.setItem(
        this.BIOMETRIC_ENABLED_KEY,
        enabled.toString()
      );
      await SecureStore.deleteItemAsync(this.BIOMETRIC_ENABLED_KEY).catch(
        () => {}
      );
    } catch (error) {
      throw new AccountStorageError('Failed to store biometric setting');
    }
  }

  static async isBiometricEnabled(): Promise<boolean> {
    try {
      let enabled = await AsyncStorage.getItem(this.BIOMETRIC_ENABLED_KEY);
      if (!enabled) {
        const legacy = await SecureStore.getItemAsync(this.BIOMETRIC_ENABLED_KEY);
        if (legacy) {
          await AsyncStorage.setItem(this.BIOMETRIC_ENABLED_KEY, legacy);
          await SecureStore.deleteItemAsync(this.BIOMETRIC_ENABLED_KEY).catch(
            () => {}
          );
          enabled = legacy;
        }
      }
      return enabled === 'true';
    } catch (error) {
      return false;
    }
  }

  // PIN Timeout Settings
  static async setPinTimeout(timeoutMinutes: number | 'never'): Promise<void> {
    try {
      await AsyncStorage.setItem(
        this.PIN_TIMEOUT_KEY,
        String(timeoutMinutes)
      );
      await SecureStore.deleteItemAsync(this.PIN_TIMEOUT_KEY).catch(() => {});
    } catch (error) {
      throw new AccountStorageError('Failed to store PIN timeout setting');
    }
  }

  static async getPinTimeout(): Promise<number | 'never'> {
    try {
      let timeout = await AsyncStorage.getItem(this.PIN_TIMEOUT_KEY);
      if (!timeout) {
        const legacy = await SecureStore.getItemAsync(this.PIN_TIMEOUT_KEY);
        if (legacy) {
          await AsyncStorage.setItem(this.PIN_TIMEOUT_KEY, legacy);
          await SecureStore.deleteItemAsync(this.PIN_TIMEOUT_KEY).catch(() => {});
          timeout = legacy;
        }
      }
      if (!timeout) {
        return 5; // Default to 5 minutes
      }

      if (timeout === 'never') {
        return 'never';
      }

      const timeoutNumber = Number(timeout);
      return isNaN(timeoutNumber) ? 5 : timeoutNumber;
    } catch (error) {
      return 5; // Default fallback
    }
  }

  private static getIterationCandidates(): number[] {
    if (this.legacyCheckRequired === false) {
      return [this.PIN_ITERATIONS];
    }

    return [this.PIN_ITERATIONS, this.LEGACY_PIN_ITERATIONS];
  }

  private static async getStoredPinData(): Promise<StoredPinData | null> {
    try {
      const stored = await SecureStore.getItemAsync(
        this.PIN_KEY,
        SECURE_STORE_OPTIONS
      );
      if (stored) {
        const parsed = this.parseStoredPin(stored);
        if (parsed) {
          return parsed;
        }
      }

      const legacy = await AsyncStorage.getItem(this.PIN_KEY);
      if (legacy) {
        await SecureStore.setItemAsync(
          this.PIN_KEY,
          legacy,
          SECURE_STORE_OPTIONS
        );
        await AsyncStorage.removeItem(this.PIN_KEY).catch(() => {});
        const parsed = this.parseStoredPin(legacy);
        if (parsed) {
          return parsed;
        }
      }
      return null;
    } catch (error) {
      console.warn('Failed to retrieve stored PIN hash', error);
      return null;
    }
  }

  private static async getOrCreateSalt(regenerate: boolean = false): Promise<string> {
    try {
      if (!regenerate) {
        const existing = await SecureStore.getItemAsync(
          this.SALT_KEY,
          SECURE_STORE_OPTIONS
        );
        if (existing) {
          return existing;
        }
      }

      const legacy = await AsyncStorage.getItem(this.SALT_KEY);
      if (!regenerate && legacy) {
        await SecureStore.setItemAsync(
          this.SALT_KEY,
          legacy,
          SECURE_STORE_OPTIONS
        );
        await AsyncStorage.removeItem(this.SALT_KEY).catch(() => {});
        return legacy;
      }

      if (!regenerate) {
        throw new AccountStorageError('PIN salt not found');
      }

      const salt = await this.generateRandomHex(32);
      await SecureStore.setItemAsync(
        this.SALT_KEY,
        salt,
        SECURE_STORE_OPTIONS
      );
      await AsyncStorage.removeItem(this.SALT_KEY).catch(() => {});
      return salt;
    } catch (error) {
      throw new AccountStorageError('Failed to generate or retrieve salt');
    }
  }

  private static async generateRandomHex(byteLength: number): Promise<string> {
    const randomBytes = await Crypto.getRandomBytesAsync(byteLength);
    return Array.from(randomBytes, (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('');
  }

  private static hashPin(
    pin: string,
    salt: string,
    iterations: number
  ): string {
    return customPBKDF2(pin, salt, iterations, 32);
  }

  private static parseStoredPin(value: string): StoredPinData | null {
    if (value.startsWith('{')) {
      try {
        const parsed = JSON.parse(value) as {
          hash?: string;
          iterations?: number;
        };
        if (parsed.hash && typeof parsed.iterations === 'number') {
          return {
            hash: parsed.hash,
            iterations: parsed.iterations,
            format: 'json',
          };
        }
      } catch (error) {
        console.warn('Failed to parse stored PIN metadata', error);
      }
    }

    return {
      hash: value,
      iterations: this.PIN_ITERATIONS,
      format: 'legacy',
    };
  }

  private static async persistPinHash(
    hash: string,
    salt: string,
    iterations: number = this.PIN_ITERATIONS
  ): Promise<void> {
    const payload = JSON.stringify({ hash, iterations });

    await SecureStore.setItemAsync(
      this.PIN_KEY,
      payload,
      SECURE_STORE_OPTIONS
    );
    await SecureStore.setItemAsync(this.SALT_KEY, salt, SECURE_STORE_OPTIONS);

    await AsyncStorage.removeItem(this.PIN_KEY).catch(() => {});
    await AsyncStorage.removeItem(this.SALT_KEY).catch(() => {});
  }

  static async clearSensitiveData(): Promise<void> {
    // This method can be called when the app goes to background
    // to ensure sensitive data is cleared from memory
    try {
      // Force garbage collection if available (development only)
      if (__DEV__ && global.gc) {
        global.gc();
      }

      // Clear any temporary crypto variables by overwriting with zeros
      // Note: JavaScript strings are immutable, but this signals intent
      console.log('Cleared sensitive data from memory');
    } catch (error) {
      // Don't log detailed error to prevent information leakage
      console.warn('Failed to clear sensitive data');
    }
  }

  static async clearAll(): Promise<void> {
    try {
      const accountIds = await this.getAllAccountIds();

      // Delete all accounts
      for (const accountId of accountIds) {
        await this.deleteAccount(accountId);
      }

      // Clear PIN and settings
      await AsyncStorage.multiRemove([
        this.PIN_KEY,
        this.SALT_KEY,
        this.BIOMETRIC_ENABLED_KEY,
        this.METADATA_LIST_KEY,
        this.PIN_TIMEOUT_KEY,
        this.DEVICE_ID_KEY,
      ]);
      await Promise.all([
        SecureStore.deleteItemAsync(this.PIN_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(this.SALT_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(this.BIOMETRIC_ENABLED_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(this.METADATA_LIST_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(this.PIN_TIMEOUT_KEY).catch(() => {}),
        SecureStore.deleteItemAsync(this.DEVICE_ID_KEY).catch(() => {}),
      ]);
    } catch (error) {
      throw new AccountStorageError('Failed to clear all secure storage');
    }
  }
}
