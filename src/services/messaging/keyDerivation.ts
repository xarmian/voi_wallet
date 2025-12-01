/**
 * Key Derivation Service for Signature-Based Messaging Encryption
 *
 * This module derives X25519 messaging keypairs from Ed25519 signatures.
 * The key insight is that Ed25519 signatures are deterministic (RFC 8032),
 * so signing a fixed challenge message always produces the same signature,
 * which can be used to derive a stable keypair.
 *
 * Benefits:
 * - Private key is never directly used in ECDH operations
 * - Compatible with hardware wallets (Ledger) that only expose signing
 * - Deterministic: same keypair derived every session
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  createMessagingChallenge,
  KDF_DOMAIN_DECRYPTION_KEY,
  MESSAGING_KEY_CACHE_TTL_MS,
  MessagingKeyPair,
} from './types';

/**
 * Type for a function that signs arbitrary bytes.
 * For software wallets: uses nacl.sign.detached directly
 * For Ledger wallets: calls the hardware wallet to sign
 */
export type SignFunction = (message: Uint8Array) => Promise<Uint8Array>;

/**
 * In-memory cache for derived messaging keypairs.
 * Keyed by account address.
 */
const keyCache = new Map<string, MessagingKeyPair>();

/**
 * Derive an X25519 keypair from a signature.
 *
 * The signature is hashed with domain separation to produce a 32-byte
 * X25519 secret key. The public key is computed from the secret.
 *
 * @param signature - 64-byte Ed25519 signature
 * @returns X25519 keypair (32-byte secret, 32-byte public)
 */
function deriveKeyPairFromSignature(signature: Uint8Array): {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
} {
  if (signature.length !== 64) {
    throw new Error(
      `Invalid signature length: expected 64 bytes, got ${signature.length}`
    );
  }

  // Create KDF input with domain separation
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_DECRYPTION_KEY);
  const kdfInput = new Uint8Array(domainBytes.length + signature.length);
  kdfInput.set(domainBytes, 0);
  kdfInput.set(signature, domainBytes.length);

  // Hash to derive key material (SHA-512 -> 64 bytes)
  const keyMaterial = nacl.hash(kdfInput);

  // Use first 32 bytes as X25519 secret key
  const secretKey = keyMaterial.slice(0, 32);

  // Apply X25519 clamping (RFC 7748)
  // This ensures the key is in the correct form for scalar multiplication
  secretKey[0] &= 248;
  secretKey[31] &= 127;
  secretKey[31] |= 64;

  // Derive public key: publicKey = secretKey * basepoint
  const publicKey = nacl.scalarMult.base(secretKey);

  // Zero-fill ALL key material (security: prevent key leakage)
  keyMaterial.fill(0);
  kdfInput.fill(0);

  return { secretKey, publicKey };
}

/**
 * Derive messaging keypair for a software wallet.
 *
 * For software wallets, we have access to the Ed25519 secret key,
 * so we can sign the challenge programmatically without user interaction.
 *
 * @param ed25519SecretKey - 64-byte Ed25519 secret key
 * @param accountAddress - Account address for cache key
 * @returns Derived X25519 messaging keypair
 */
export function deriveMessagingKeyPairFromSecret(
  ed25519SecretKey: Uint8Array,
  accountAddress: string
): MessagingKeyPair {
  // Check cache first
  const cached = keyCache.get(accountAddress);
  const now = Date.now();

  if (cached && now - cached.derivedAt < MESSAGING_KEY_CACHE_TTL_MS) {
    return cached;
  }

  // Sign the account-specific challenge message
  const challenge = createMessagingChallenge(accountAddress);
  const challengeBytes = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(challengeBytes, ed25519SecretKey);

  // Derive keypair from signature
  const { secretKey, publicKey } = deriveKeyPairFromSignature(signature);

  // Zero-fill the signature
  signature.fill(0);

  // Create keypair object
  const keyPair: MessagingKeyPair = {
    secretKey: new Uint8Array(secretKey),
    publicKey: new Uint8Array(publicKey),
    accountAddress,
    derivedAt: now,
  };

  // Clear old cache entry if exists
  clearCachedKey(accountAddress);

  // Cache the new keypair
  keyCache.set(accountAddress, keyPair);

  return keyPair;
}

/**
 * Derive messaging keypair using a sign function (for Ledger/hardware wallets).
 *
 * For hardware wallets, we pass a sign function that prompts the user
 * to approve signing on their device. This only needs to happen once
 * per session.
 *
 * @param signFunction - Function that signs bytes (calls hardware wallet)
 * @param accountAddress - Account address for cache key
 * @returns Derived X25519 messaging keypair
 */
export async function deriveMessagingKeyPairWithSign(
  signFunction: SignFunction,
  accountAddress: string
): Promise<MessagingKeyPair> {
  // Check cache first
  const cached = keyCache.get(accountAddress);
  const now = Date.now();

  if (cached && now - cached.derivedAt < MESSAGING_KEY_CACHE_TTL_MS) {
    return cached;
  }

  // Sign the account-specific challenge message (user approves on hardware wallet)
  const challenge = createMessagingChallenge(accountAddress);
  const challengeBytes = new TextEncoder().encode(challenge);
  const signature = await signFunction(challengeBytes);

  // Derive keypair from signature
  const { secretKey, publicKey } = deriveKeyPairFromSignature(signature);

  // Zero-fill the signature
  signature.fill(0);

  // Create keypair object
  const keyPair: MessagingKeyPair = {
    secretKey: new Uint8Array(secretKey),
    publicKey: new Uint8Array(publicKey),
    accountAddress,
    derivedAt: now,
  };

  // Clear old cache entry if exists
  clearCachedKey(accountAddress);

  // Cache the new keypair
  keyCache.set(accountAddress, keyPair);

  return keyPair;
}

/**
 * Get a cached messaging keypair if available and not expired.
 *
 * @param accountAddress - Account address to look up
 * @returns Cached keypair or null if not found/expired
 */
export function getCachedKeyPair(accountAddress: string): MessagingKeyPair | null {
  const cached = keyCache.get(accountAddress);
  if (!cached) return null;

  const now = Date.now();
  if (now - cached.derivedAt >= MESSAGING_KEY_CACHE_TTL_MS) {
    clearCachedKey(accountAddress);
    return null;
  }

  return cached;
}

/**
 * Clear a cached messaging keypair, zeroing the secret key.
 *
 * @param accountAddress - Account address to clear
 */
export function clearCachedKey(accountAddress: string): void {
  const cached = keyCache.get(accountAddress);
  if (cached) {
    // Zero-fill the secret key
    cached.secretKey.fill(0);
    cached.publicKey.fill(0);
    keyCache.delete(accountAddress);
  }
}

/**
 * Clear all cached messaging keypairs.
 * Should be called when user logs out or app is backgrounded.
 */
export function clearAllCachedKeys(): void {
  for (const [address] of keyCache) {
    clearCachedKey(address);
  }
}

/**
 * Get the base64-encoded messaging public key for an account.
 * Useful for key registration.
 *
 * @param accountAddress - Account address
 * @returns Base64-encoded public key or null if not cached
 */
export function getMessagingPublicKeyBase64(accountAddress: string): string | null {
  const cached = getCachedKeyPair(accountAddress);
  if (!cached) return null;
  return encodeBase64(cached.publicKey);
}
