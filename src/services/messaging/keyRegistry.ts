/**
 * Messaging Key Registry Service
 *
 * Handles on-chain registration and lookup of messaging public keys.
 * Users must register their derived X25519 messaging public key before
 * they can receive encrypted messages.
 *
 * Key registration format (transaction note):
 *   voi-msg-key:v1:<base64_public_key>
 *
 * The registration is a self-transfer (sender = receiver) with minimal amount.
 */

import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { NetworkService } from '@/services/network';
import { TransactionService, TransactionParams } from '@/services/transactions';
import { NetworkId } from '@/types/network';
import { WalletAccount } from '@/types/wallet';
import {
  KEY_REGISTRATION_PREFIX,
  MessagingKeyRegistration,
} from './types';

/**
 * In-memory cache for looked-up messaging keys.
 * Keyed by account address.
 */
const keyLookupCache = new Map<string, MessagingKeyRegistration>();

/** Cache TTL for looked-up keys (5 minutes) */
const LOOKUP_CACHE_TTL_MS = 5 * 60 * 1000;

/** Track when each cache entry was added */
const cacheTimestamps = new Map<string, number>();

/**
 * Check if a cached entry is still valid.
 */
function isCacheValid(address: string): boolean {
  const timestamp = cacheTimestamps.get(address);
  if (!timestamp) return false;
  return Date.now() - timestamp < LOOKUP_CACHE_TTL_MS;
}

/**
 * Parse a key registration note and extract the public key.
 *
 * @param noteBase64 - Base64-encoded note from transaction
 * @returns Public key as Uint8Array, or null if not a valid registration
 */
function parseKeyRegistrationNote(noteBase64: string): Uint8Array | null {
  try {
    // Decode the note from base64
    const noteBytes = decodeBase64(noteBase64);
    const noteString = new TextDecoder().decode(noteBytes);

    // Check for key registration prefix
    if (!noteString.startsWith(KEY_REGISTRATION_PREFIX)) {
      return null;
    }

    // Extract the public key
    const publicKeyBase64 = noteString.slice(KEY_REGISTRATION_PREFIX.length);
    const publicKey = decodeBase64(publicKeyBase64);

    // Validate length (X25519 public key should be 32 bytes)
    if (publicKey.length !== 32) {
      return null;
    }

    return publicKey;
  } catch {
    return null;
  }
}

/**
 * Create a key registration note string.
 *
 * @param publicKey - X25519 public key (32 bytes)
 * @returns Note string for transaction
 */
export function createKeyRegistrationNote(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(
      `Invalid public key length: expected 32 bytes, got ${publicKey.length}`
    );
  }
  return `${KEY_REGISTRATION_PREFIX}${encodeBase64(publicKey)}`;
}

/**
 * Look up a user's messaging public key from the blockchain.
 *
 * Searches for the most recent key registration transaction.
 *
 * @param address - Algorand/Voi address to look up
 * @param forceRefresh - Bypass cache and fetch from blockchain
 * @returns MessagingKeyRegistration or null if not registered
 */
export async function lookupMessagingKey(
  address: string,
  forceRefresh = false
): Promise<MessagingKeyRegistration | null> {
  // Check cache first (unless forcing refresh)
  if (!forceRefresh && keyLookupCache.has(address) && isCacheValid(address)) {
    return keyLookupCache.get(address) || null;
  }

  try {
    const networkService = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    const indexer = networkService.getIndexerClient();

    // Query payment transactions for this address
    // Key registrations are self-transfers with the key in the note
    // We filter for self-transfers (sender === receiver) in the loop below
    const response = await indexer
      .lookupAccountTransactions(address)
      .txType('pay')
      .limit(50) // Check recent transactions
      .do();

    // Search for the most recent key registration
    // (Latest registration overwrites previous ones)
    let latestRegistration: MessagingKeyRegistration | null = null;
    let latestRound = 0;

    for (const txn of response.transactions || []) {
      // Skip if not a self-transfer (sender must equal receiver)
      if (txn.sender !== address) continue;

      // Get receiver from payment transaction
      const receiver = txn['payment-transaction']?.receiver || txn.paymentTransaction?.receiver;
      if (receiver !== address) continue;

      // Skip transactions without notes
      if (!txn.note) continue;

      // Get note as base64 string
      const noteBase64 =
        typeof txn.note === 'string'
          ? txn.note
          : Buffer.from(txn.note).toString('base64');

      // Try to parse as key registration
      const publicKey = parseKeyRegistrationNote(noteBase64);
      if (!publicKey) continue;

      // Get confirmed round
      const confirmedRound = txn.confirmedRound
        ? typeof txn.confirmedRound === 'bigint'
          ? Number(txn.confirmedRound)
          : txn.confirmedRound
        : 0;

      // Keep the latest registration
      if (confirmedRound > latestRound) {
        latestRound = confirmedRound;
        latestRegistration = {
          address,
          messagingPublicKey: encodeBase64(publicKey),
          registrationTxId: txn.id,
          registrationRound: confirmedRound,
          registeredAt: txn.roundTime ? txn.roundTime * 1000 : Date.now(),
        };
      }
    }

    // Update cache
    if (latestRegistration) {
      keyLookupCache.set(address, latestRegistration);
      cacheTimestamps.set(address, Date.now());
    } else {
      // Cache negative result too (user not registered)
      keyLookupCache.delete(address);
      cacheTimestamps.delete(address);
    }

    return latestRegistration;
  } catch (error) {
    console.error(`Failed to lookup messaging key for ${address}:`, error);
    return null;
  }
}

/**
 * Check if a user has registered their messaging key.
 *
 * @param address - Address to check
 * @returns true if registered
 */
export async function isMessagingKeyRegistered(address: string): Promise<boolean> {
  const registration = await lookupMessagingKey(address);
  return registration !== null;
}

/**
 * Register a messaging public key on-chain.
 *
 * Creates a self-transfer transaction with the public key in the note field.
 *
 * @param publicKey - X25519 messaging public key (32 bytes)
 * @param account - Wallet account to register for
 * @param pin - Optional PIN for transaction signing
 * @returns Transaction ID of the registration
 */
export async function registerMessagingKey(
  publicKey: Uint8Array,
  account: WalletAccount,
  pin?: string
): Promise<string> {
  // Create registration note
  const noteString = createKeyRegistrationNote(publicKey);

  // Build self-transfer transaction with 0 amount (just paying the fee)
  const params: TransactionParams = {
    from: account.address,
    to: account.address, // Self-transfer
    amount: 0,
    note: noteString,
    assetType: 'voi',
    networkId: NetworkId.VOI_MAINNET,
  };

  // Send the transaction
  const txId = await TransactionService.sendTransaction(params, account, pin);

  // Immediately update cache with the new registration
  const registration: MessagingKeyRegistration = {
    address: account.address,
    messagingPublicKey: encodeBase64(publicKey),
    registrationTxId: txId,
    registrationRound: 0, // Will be updated on confirmation
    registeredAt: Date.now(),
  };

  keyLookupCache.set(account.address, registration);
  cacheTimestamps.set(account.address, Date.now());

  return txId;
}

/**
 * Get the messaging public key for an address as Uint8Array.
 * Convenience wrapper around lookupMessagingKey.
 *
 * @param address - Address to look up
 * @returns Public key bytes or null if not registered
 */
export async function getMessagingPublicKey(
  address: string
): Promise<Uint8Array | null> {
  const registration = await lookupMessagingKey(address);
  if (!registration) return null;
  return decodeBase64(registration.messagingPublicKey);
}

/**
 * Clear the lookup cache for a specific address.
 *
 * @param address - Address to clear
 */
export function clearKeyLookupCache(address: string): void {
  keyLookupCache.delete(address);
  cacheTimestamps.delete(address);
}

/**
 * Clear the entire lookup cache.
 */
export function clearAllKeyLookupCache(): void {
  keyLookupCache.clear();
  cacheTimestamps.clear();
}
