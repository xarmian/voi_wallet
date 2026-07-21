/**
 * Mobile Secure Storage Adapter
 * Uses expo-secure-store for hardware-backed encrypted storage
 */

import * as SecureStore from 'expo-secure-store';
import type { SecureStoreOptions } from 'expo-secure-store';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SecureStorageAdapter } from '../types';

const SECURE_STORE_OPTIONS: SecureStoreOptions =
  Platform.OS === 'ios'
    ? { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
    : {};

// TASK-213 (Android fail-closed): on Android, expo-secure-store SWALLOWS a
// decrypt/keystore read FAILURE to `null` — indistinguishable from genuine
// ABSENCE — for the exact keystore-desync classes this guards against: a missing
// KeyStore key after reinstall/restore (deleteItemImpl + return null), a
// KeyPermanentlyInvalidatedException (return null), and a BadPaddingException /
// AEAD auth-tag mismatch = corruption (deleteItemImpl + return null). See
// node_modules/expo-secure-store/android/.../SecureStoreModule.kt readJSONEncodedItem.
// Two of those paths ALSO delete the item, which (without this guard) makes the
// fail-OPEN permanent: the next boot sees genuine absence and the app offers to
// set a NEW PIN — a lock-takeover vector on an unlocked device. iOS THROWS a
// KeyChainException on any keychain status other than errSecItemNotFound, so a
// `null` there is already unambiguous absence; this reconstruction is Android-only.
//
// Mechanism: a PLAINTEXT presence sentinel in AsyncStorage records which secure
// keys currently hold a value. It stores KEY NAMES ONLY (never a value — a key
// name like `voi_wallet_pin` is not secret) so a key that was written and not
// deleted through this adapter is known to be present. If the native read then
// yields `null` for a sentinel-present key, that `null` is a read FAILURE (not
// absence) — surface it as a THROW so the fail-closed auth-init strict probes
// (hasPinStrict, TASK-213) enter the recovery state instead of the unlocked setup
// state. Genuine absence (no sentinel) still resolves `null`, unchanged. On a
// HEALTHY keystore the native read always returns the value, so the throw branch
// is never reached — the happy path is byte-for-byte unchanged.
const IS_ANDROID = Platform.OS === 'android';
const PRESENCE_SENTINEL_PREFIX = '__voi_ss_present__';

export class MobileSecureStorageAdapter implements SecureStorageAdapter {
  private sentinelKey(key: string): string {
    return `${PRESENCE_SENTINEL_PREFIX}${key}`;
  }

  private async wasPresent(key: string): Promise<boolean> {
    // A throw here (AsyncStorage genuinely unavailable) PROPAGATES — that is
    // itself a read failure and must fail closed, not silently resolve absence.
    return (await AsyncStorage.getItem(this.sentinelKey(key))) !== null;
  }

  async setItem(key: string, value: string): Promise<void> {
    // Write the secure value FIRST, THEN record presence. Ordering matters: if
    // the native write throws, no sentinel is left behind (a dangling sentinel
    // would later masquerade as a decrypt failure); if the sentinel write throws,
    // it surfaces to the caller and the item is simply re-writable.
    await SecureStore.setItemAsync(key, value, SECURE_STORE_OPTIONS);
    if (IS_ANDROID) {
      await AsyncStorage.setItem(this.sentinelKey(key), '1');
    }
  }

  async getItem(key: string): Promise<string | null> {
    const value = await SecureStore.getItemAsync(key, SECURE_STORE_OPTIONS);
    if (!IS_ANDROID) {
      // iOS getItemAsync throws on any keychain failure other than
      // errSecItemNotFound, so `null` here is already unambiguous absence.
      return value;
    }
    if (value !== null) {
      // Present AND decryptable. Self-heal the sentinel for a pre-sentinel install
      // (an item written by an older build, or the first successful read after
      // upgrade) so the NEXT boot is fail-closed. Read-then-write keeps the common
      // steady-state read path write-free (the sentinel already exists). This is
      // BEST-EFFORT: a sentinel bookkeeping hiccup must NEVER turn a good secure
      // read into a failure — the value was read fine, so return it regardless.
      try {
        if (!(await this.wasPresent(key))) {
          await AsyncStorage.setItem(this.sentinelKey(key), '1');
        }
      } catch (error) {
        console.warn('Secure-store presence sentinel self-heal failed', error);
      }
      return value;
    }
    // Android returned `null`: genuine absence OR a swallowed decrypt/keystore
    // failure that expo-secure-store collapsed (and possibly deleted). A value we
    // recorded but can no longer read is a FAILURE, not absence — fail closed.
    if (await this.wasPresent(key)) {
      throw new Error(
        'Secure storage read failed: a stored item is present but unreadable ' +
          '(keystore desync / decrypt failure)'
      );
    }
    return null;
  }

  async deleteItem(key: string): Promise<void> {
    try {
      await SecureStore.deleteItemAsync(key);
    } finally {
      // Clear the sentinel in a `finally` so it runs EVEN IF the native delete
      // threw (Codex round-4 P2): on a broken keystore the native delete can fail
      // and clearAll() swallows that error, so without clearing here the sentinel
      // would survive and the next strict read would still throw — permanently
      // stranding the recovery-screen reset. The caller's INTENT is removal, so
      // the next getItem must resolve genuine ABSENCE (→ Onboarding). Best-effort
      // and isolated so it never masks the native error. (No fail-open risk: if
      // the item is actually still readable, getItem's value!=null path returns it
      // and self-heals the sentinel.)
      if (IS_ANDROID) {
        await AsyncStorage.removeItem(this.sentinelKey(key)).catch(() => {});
      }
    }
  }

  async getItemWithAuth(
    key: string,
    options: { prompt: string }
  ): Promise<string | null> {
    // Intentionally NOT sentinel-guarded: the sole consumer is the biometric-
    // convenience item, which is DESIGNED to be OS-invalidated on enrollment
    // change / lock removal and must fall back to PIN entry (never the mnemonic).
    // Coercing its invalidation into a throw would break that graceful fallback.
    return await SecureStore.getItemAsync(key, {
      ...SECURE_STORE_OPTIONS,
      requireAuthentication: true,
      authenticationPrompt: options.prompt,
    });
  }

  /**
   * Store a value behind a mandatory device-auth gate, provisioning the
   * access-control flag AT WRITE time (DOC-137 §2.5). Requesting
   * `requireAuthentication` on the WRITE is what actually enclave-binds the
   * item (the prior code only requested auth on read, which enclave-bound
   * nothing — the write-time-ACL bug). Reserved for the biometric-convenience
   * item ONLY; the resulting item is intentionally OS-invalidated on
   * enrollment change / lock removal.
   */
  async setItemWithAuth(
    key: string,
    value: string,
    options: { prompt: string }
  ): Promise<void> {
    await SecureStore.setItemAsync(key, value, {
      ...SECURE_STORE_OPTIONS,
      requireAuthentication: true,
      authenticationPrompt: options.prompt,
    });
  }
}

// Singleton instance
export const mobileSecureStorage = new MobileSecureStorageAdapter();
