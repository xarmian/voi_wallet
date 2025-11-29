/**
 * Mobile Crypto Adapter
 * Uses expo-crypto for cryptographic operations
 */

import * as Crypto from 'expo-crypto';
import type { CryptoAdapter } from '../types';

export class MobileCryptoAdapter implements CryptoAdapter {
  async getRandomBytes(byteCount: number): Promise<Uint8Array> {
    return await Crypto.getRandomBytesAsync(byteCount);
  }

  getRandomBytesSync(byteCount: number): Uint8Array {
    // expo-crypto may have sync version in some contexts
    if (typeof Crypto.getRandomBytes === 'function') {
      return Crypto.getRandomBytes(byteCount);
    }
    throw new Error('Synchronous random bytes not available on this platform');
  }

  randomUUID(): string {
    return Crypto.randomUUID();
  }

  async sha256(input: string): Promise<string> {
    return await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      input,
      { encoding: Crypto.CryptoEncoding.HEX }
    );
  }
}

// Singleton instance
export const mobileCrypto = new MobileCryptoAdapter();
