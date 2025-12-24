/**
 * Extension Crypto Adapter
 * Uses Web Crypto API for cryptographic operations
 */

import type { CryptoAdapter } from '../types';

export class ExtensionCryptoAdapter implements CryptoAdapter {
  async getRandomBytes(byteCount: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(byteCount);
    crypto.getRandomValues(buffer);
    return buffer;
  }

  getRandomBytesSync(byteCount: number): Uint8Array {
    const buffer = new Uint8Array(byteCount);
    crypto.getRandomValues(buffer);
    return buffer;
  }

  randomUUID(): string {
    return crypto.randomUUID();
  }

  async sha256(input: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

// Singleton instance
export const extensionCrypto = new ExtensionCryptoAdapter();
