/**
 * Extension Secure Storage Adapter
 * Uses chrome.storage.local with AES-256-GCM encryption
 *
 * Since Chrome extensions don't have hardware-backed secure storage,
 * we encrypt all data with a key derived from an installation-specific secret.
 */

import type { SecureStorageAdapter } from '../types';
import { extensionStorage } from './storage';
import { extensionCrypto } from './crypto';

const ENCRYPTION_KEY_STORAGE = '__voi_encryption_key__';
const SECURE_PREFIX = '__secure__';

export class ExtensionSecureStorageAdapter implements SecureStorageAdapter {
  private encryptionKey: CryptoKey | null = null;

  /**
   * Get or create the master encryption key
   * This key is derived from a random secret stored in extension storage
   */
  private async getEncryptionKey(): Promise<CryptoKey> {
    if (this.encryptionKey) {
      return this.encryptionKey;
    }

    // Try to get existing key material
    let keyMaterial = await extensionStorage.getItem(ENCRYPTION_KEY_STORAGE);

    if (!keyMaterial) {
      // Generate new key material (32 bytes = 256 bits)
      const randomBytes = await extensionCrypto.getRandomBytes(32);
      keyMaterial = Array.from(randomBytes, (b) =>
        b.toString(16).padStart(2, '0')
      ).join('');
      await extensionStorage.setItem(ENCRYPTION_KEY_STORAGE, keyMaterial);
    }

    // Derive AES key from key material
    const encoder = new TextEncoder();
    const keyData = encoder.encode(keyMaterial);

    const baseKey = await crypto.subtle.importKey(
      'raw',
      keyData,
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey']
    );

    // Use PBKDF2 to derive the actual encryption key
    // Using a fixed salt since the key material itself is random
    const salt = encoder.encode('voi_wallet_extension_v1');

    this.encryptionKey = await crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        salt,
        iterations: 100000, // High iteration count for security
        hash: 'SHA-256',
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );

    return this.encryptionKey;
  }

  /**
   * Encrypt data using AES-256-GCM
   */
  private async encrypt(plaintext: string): Promise<string> {
    const key = await this.getEncryptionKey();
    const encoder = new TextEncoder();
    const data = encoder.encode(plaintext);

    // Generate random IV (12 bytes for GCM)
    const iv = await extensionCrypto.getRandomBytes(12);

    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      data
    );

    // Combine IV + ciphertext and encode as base64
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv);
    combined.set(new Uint8Array(ciphertext), iv.length);

    return btoa(String.fromCharCode(...combined));
  }

  /**
   * Decrypt data using AES-256-GCM
   */
  private async decrypt(encryptedData: string): Promise<string> {
    const key = await this.getEncryptionKey();

    // Decode base64
    const combined = new Uint8Array(
      atob(encryptedData)
        .split('')
        .map((c) => c.charCodeAt(0))
    );

    // Extract IV (first 12 bytes) and ciphertext
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );

    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  }

  async setItem(key: string, value: string): Promise<void> {
    const encrypted = await this.encrypt(value);
    await extensionStorage.setItem(`${SECURE_PREFIX}${key}`, encrypted);
  }

  async getItem(key: string): Promise<string | null> {
    const encrypted = await extensionStorage.getItem(`${SECURE_PREFIX}${key}`);
    if (!encrypted) {
      // Genuine ABSENCE (no stored item) — resolve null. A read FAILURE from the
      // underlying store already threw above and propagates.
      return null;
    }

    try {
      return await this.decrypt(encrypted);
    } catch {
      // A PRESENT-but-undecryptable item is a genuine read/decrypt FAILURE, NOT
      // absence. THROW so fail-closed callers (auth-init strict reads, TASK-213)
      // can distinguish it from "no value"; the error-swallowing callers
      // (hasPin/getCurrentWallet/...) still catch and resolve falsy, so their
      // contract is unchanged. Never log the ciphertext or decrypted plaintext.
      console.error('Failed to decrypt secure storage item');
      throw new Error('Secure storage decrypt failed');
    }
  }

  async deleteItem(key: string): Promise<void> {
    await extensionStorage.removeItem(`${SECURE_PREFIX}${key}`);
  }

  // WebAuthn authentication is handled separately
  // This method exists for API compatibility but doesn't add biometric protection
  async getItemWithAuth(
    key: string,
    _options: { prompt: string }
  ): Promise<string | null> {
    // In extension, we don't have hardware-backed biometric protection
    // WebAuthn would be handled at a higher level in the auth flow
    return this.getItem(key);
  }

  /**
   * Not supported on the extension: there is no hardware-backed auth-gated store
   * to provision (DOC-137 §2.5). The interface member is optional, so callers
   * that need a write-time auth gate must feature-detect and fall back. The
   * biometric-convenience item (the sole consumer) is a mobile-only feature.
   */
  async setItemWithAuth(
    _key: string,
    _value: string,
    _options: { prompt: string }
  ): Promise<void> {
    throw new Error(
      'setItemWithAuth is not supported on the extension platform'
    );
  }
}

// Singleton instance
export const extensionSecureStorage = new ExtensionSecureStorageAdapter();
