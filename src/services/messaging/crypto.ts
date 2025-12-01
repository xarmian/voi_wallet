/**
 * Messaging Cryptography Service
 *
 * Handles E2E encryption/decryption for the messaging system.
 *
 * V2 (Current): Signature-derived encryption
 * - Uses ephemeral X25519 keys for forward secrecy
 * - Recipients derive their decryption key from signing a challenge
 * - Compatible with hardware wallets (Ledger)
 * - Recipients must register their messaging public key on-chain
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as ed2curve from 'ed2curve';
import algosdk from 'algosdk';
import { crypto as platformCrypto } from '@/platform';
import {
  EncryptedMessagePayload,
  EncryptedMessagePayloadV2,
  MESSAGE_NOTE_PREFIX,
  MESSAGE_NOTE_PREFIX_V1,
  MAX_MESSAGE_LENGTH,
  KDF_DOMAIN_SHARED_SECRET,
} from './types';

/**
 * Convert a 64-byte Ed25519 secret key to a 32-byte Curve25519 secret key.
 *
 * @param ed25519Secret - 64-byte Ed25519 secret key (as returned by algosdk)
 * @returns 32-byte Curve25519 secret key for use with nacl.box
 * @throws Error if conversion fails
 */
export function ed25519SecretToCurve25519(ed25519Secret: Uint8Array): Uint8Array {
  if (ed25519Secret.length !== 64) {
    throw new Error(
      `Invalid Ed25519 secret key length: expected 64 bytes, got ${ed25519Secret.length}`
    );
  }

  const curve25519Secret = ed2curve.convertSecretKey(ed25519Secret);
  if (!curve25519Secret) {
    throw new Error('Failed to convert Ed25519 secret key to Curve25519');
  }

  return curve25519Secret;
}

/**
 * Convert a 32-byte Ed25519 public key to a 32-byte Curve25519 public key.
 *
 * @param ed25519Public - 32-byte Ed25519 public key
 * @returns 32-byte Curve25519 public key for use with nacl.box
 * @throws Error if conversion fails
 */
export function ed25519PublicToCurve25519(ed25519Public: Uint8Array): Uint8Array {
  if (ed25519Public.length !== 32) {
    throw new Error(
      `Invalid Ed25519 public key length: expected 32 bytes, got ${ed25519Public.length}`
    );
  }

  const curve25519Public = ed2curve.convertPublicKey(ed25519Public);
  if (!curve25519Public) {
    throw new Error('Failed to convert Ed25519 public key to Curve25519');
  }

  return curve25519Public;
}

/**
 * Extract the 32-byte Ed25519 public key from a 64-byte secret key.
 * In Ed25519, the secret key is [32-byte seed][32-byte public key].
 *
 * @param secretKey - 64-byte Ed25519 secret key
 * @returns 32-byte Ed25519 public key
 */
export function extractPublicKeyFromSecret(secretKey: Uint8Array): Uint8Array {
  if (secretKey.length !== 64) {
    throw new Error(
      `Invalid secret key length: expected 64 bytes, got ${secretKey.length}`
    );
  }
  // The public key is the last 32 bytes of the 64-byte secret key
  return secretKey.slice(32);
}

/**
 * Get the Ed25519 public key from an Algorand/Voi address.
 *
 * @param address - Algorand/Voi address string
 * @returns 32-byte Ed25519 public key
 */
export function getPublicKeyFromAddress(address: string): Uint8Array {
  return algosdk.decodeAddress(address).publicKey;
}

/**
 * Generate a cryptographically secure 24-byte nonce for NaCl box.
 *
 * @returns 24-byte random nonce
 */
export async function generateNonce(): Promise<Uint8Array> {
  return await platformCrypto.getRandomBytes(nacl.box.nonceLength); // 24 bytes
}

/**
 * Encrypt a message for a specific recipient.
 *
 * @param plaintext - Message content to encrypt
 * @param senderSecretKey - 64-byte Ed25519 secret key of the sender
 * @param recipientAddress - Algorand/Voi address of the recipient
 * @returns Encrypted payload structure ready to be encoded into a transaction note
 * @throws Error if message is too long or encryption fails
 */
export async function encryptMessage(
  plaintext: string,
  senderSecretKey: Uint8Array,
  recipientAddress: string
): Promise<EncryptedMessagePayload> {
  // Validate message length
  if (plaintext.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Message too long: ${plaintext.length} characters (max ${MAX_MESSAGE_LENGTH})`
    );
  }

  // Convert sender's Ed25519 secret to Curve25519
  const senderCurveSecret = ed25519SecretToCurve25519(senderSecretKey);

  // Get recipient's Ed25519 public key from address and convert to Curve25519
  const recipientEd25519Public = getPublicKeyFromAddress(recipientAddress);
  const recipientCurvePublic = ed25519PublicToCurve25519(recipientEd25519Public);

  // Generate random nonce
  const nonce = await generateNonce();

  // Encode message as UTF-8 bytes
  const messageBytes = new TextEncoder().encode(plaintext);

  // Encrypt using NaCl box (authenticated encryption)
  const ciphertext = nacl.box(
    messageBytes,
    nonce,
    recipientCurvePublic,
    senderCurveSecret
  );

  // Get sender's public key for inclusion in payload (for decryption verification)
  const senderPublicKey = extractPublicKeyFromSecret(senderSecretKey);

  // Zero-fill the converted secret key
  senderCurveSecret.fill(0);

  return {
    nonce: encodeBase64(nonce),
    ciphertext: encodeBase64(ciphertext),
    senderPubKey: encodeBase64(senderPublicKey),
    timestamp: Date.now(),
  };
}

/**
 * Decrypt a message received from another user.
 *
 * @param payload - Encrypted message payload from transaction note
 * @param recipientSecretKey - 64-byte Ed25519 secret key of the recipient
 * @returns Decrypted message content
 * @throws Error if decryption fails (tampered or corrupted message)
 */
export function decryptMessage(
  payload: EncryptedMessagePayload,
  recipientSecretKey: Uint8Array
): string {
  // Decode payload components from base64
  const nonce = decodeBase64(payload.nonce);
  const ciphertext = decodeBase64(payload.ciphertext);
  const senderEd25519Public = decodeBase64(payload.senderPubKey);

  // Convert keys to Curve25519
  const recipientCurveSecret = ed25519SecretToCurve25519(recipientSecretKey);
  const senderCurvePublic = ed25519PublicToCurve25519(senderEd25519Public);

  // Decrypt using NaCl box.open
  const decrypted = nacl.box.open(
    ciphertext,
    nonce,
    senderCurvePublic,
    recipientCurveSecret
  );

  // Zero-fill the converted secret key
  recipientCurveSecret.fill(0);

  if (!decrypted) {
    throw new Error('Decryption failed - message may be corrupted or tampered');
  }

  return new TextDecoder().decode(decrypted);
}

/**
 * Create an ARC-2 compliant note string from an encrypted payload.
 *
 * @param payload - Encrypted message payload
 * @returns Note string in format: voi-msg:v1:<base64_payload>
 */
export function createMessageNote(payload: EncryptedMessagePayload): string {
  const jsonPayload = JSON.stringify(payload);
  // Use encodeBase64 from tweetnacl-util for consistency
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(jsonPayload);
  const base64Payload = encodeBase64(payloadBytes);
  return `${MESSAGE_NOTE_PREFIX}${base64Payload}`;
}

/**
 * Parse an ARC-2 message note and extract the encrypted payload.
 *
 * @param noteBase64 - Base64-encoded note field from transaction
 * @returns Parsed encrypted payload, or null if not a valid message note
 */
export function parseMessageNote(noteBase64: string): EncryptedMessagePayload | null {
  try {
    // Decode the note from base64 (as it comes from the indexer)
    const noteBytes = decodeBase64(noteBase64);
    const noteString = new TextDecoder().decode(noteBytes);

    // Check for our message prefix
    if (!noteString.startsWith(MESSAGE_NOTE_PREFIX)) {
      return null;
    }

    // Extract and decode the payload
    const payloadBase64 = noteString.slice(MESSAGE_NOTE_PREFIX.length);
    const payloadBytes = decodeBase64(payloadBase64);
    const jsonPayload = new TextDecoder().decode(payloadBytes);

    const payload = JSON.parse(jsonPayload) as EncryptedMessagePayload;

    // Validate required fields
    if (!payload.nonce || !payload.ciphertext || !payload.senderPubKey || !payload.timestamp) {
      return null;
    }

    return payload;
  } catch {
    // Invalid note format
    return null;
  }
}

/**
 * Verify that a sender's address matches the public key in a message payload.
 *
 * @param senderAddress - Address that sent the transaction
 * @param payload - Encrypted message payload (v1 or v2)
 * @returns true if the address matches the public key in the payload
 */
export function verifySender(
  senderAddress: string,
  payload: EncryptedMessagePayload | EncryptedMessagePayloadV2
): boolean {
  try {
    const addressPublicKey = getPublicKeyFromAddress(senderAddress);

    // Handle both v1 and v2 payload formats
    const senderPubKeyBase64 =
      'v' in payload && payload.v === 2 ? payload.from : (payload as EncryptedMessagePayload).senderPubKey;

    const payloadPublicKey = decodeBase64(senderPubKeyBase64);

    if (addressPublicKey.length !== payloadPublicKey.length) {
      return false;
    }

    // Constant-time comparison to prevent timing attacks
    let diff = 0;
    for (let i = 0; i < addressPublicKey.length; i++) {
      diff |= addressPublicKey[i] ^ payloadPublicKey[i];
    }

    return diff === 0;
  } catch {
    return false;
  }
}

// ============================================================================
// V2 Signature-Derived Encryption Functions
// ============================================================================

/**
 * Derive a shared secret encryption key from ECDH result.
 *
 * Uses domain separation and includes public keys in the KDF input
 * to bind the key to the specific key agreement.
 *
 * @param rawSharedSecret - Raw ECDH shared secret
 * @param ephemeralPublic - Ephemeral public key from sender
 * @param recipientPublic - Recipient's messaging public key
 * @returns 32-byte encryption key for secretbox
 */
function deriveEncryptionKey(
  rawSharedSecret: Uint8Array,
  ephemeralPublic: Uint8Array,
  recipientPublic: Uint8Array
): Uint8Array {
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_SHARED_SECRET);

  // Concatenate: domain || sharedSecret || ephemeralPublic || recipientPublic
  const kdfInput = new Uint8Array(
    domainBytes.length +
      rawSharedSecret.length +
      ephemeralPublic.length +
      recipientPublic.length
  );

  let offset = 0;
  kdfInput.set(domainBytes, offset);
  offset += domainBytes.length;
  kdfInput.set(rawSharedSecret, offset);
  offset += rawSharedSecret.length;
  kdfInput.set(ephemeralPublic, offset);
  offset += ephemeralPublic.length;
  kdfInput.set(recipientPublic, offset);

  // SHA-512 and take first 32 bytes
  const hash = nacl.hash(kdfInput);
  const encryptionKey = hash.slice(0, 32);

  // Zero-fill ALL intermediate values (security: prevent key leakage)
  kdfInput.fill(0);
  hash.fill(0);

  return encryptionKey;
}

/**
 * Encrypt a message using v2 signature-derived encryption.
 *
 * This function uses ephemeral keys for forward secrecy:
 * 1. Generate ephemeral X25519 keypair
 * 2. ECDH with recipient's messaging public key
 * 3. Derive encryption key via KDF
 * 4. Encrypt with NaCl secretbox
 *
 * @param plaintext - Message content to encrypt
 * @param senderPublicKey - Sender's Ed25519 public key (for identification)
 * @param recipientMessagingPublicKey - Recipient's X25519 messaging public key
 * @returns Encrypted payload structure
 */
export async function encryptMessageV2(
  plaintext: string,
  senderPublicKey: Uint8Array,
  recipientMessagingPublicKey: Uint8Array
): Promise<EncryptedMessagePayloadV2> {
  // Validate message length
  if (plaintext.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Message too long: ${plaintext.length} characters (max ${MAX_MESSAGE_LENGTH})`
    );
  }

  // Validate recipient public key
  if (recipientMessagingPublicKey.length !== 32) {
    throw new Error(
      `Invalid recipient messaging public key length: expected 32 bytes, got ${recipientMessagingPublicKey.length}`
    );
  }

  // Generate ephemeral X25519 keypair for this message (forward secrecy)
  const ephemeralKeyPair = nacl.box.keyPair();

  // Perform ECDH: sharedSecret = X25519(ephemeralSecret, recipientPublic)
  const rawSharedSecret = nacl.scalarMult(
    ephemeralKeyPair.secretKey,
    recipientMessagingPublicKey
  );

  // Derive encryption key via KDF
  const encryptionKey = deriveEncryptionKey(
    rawSharedSecret,
    ephemeralKeyPair.publicKey,
    recipientMessagingPublicKey
  );

  // Generate random nonce
  const nonce = await generateNonce();

  // Encode message as UTF-8 bytes
  const messageBytes = new TextEncoder().encode(plaintext);

  // Encrypt using NaCl secretbox (symmetric authenticated encryption)
  const ciphertext = nacl.secretbox(messageBytes, nonce, encryptionKey);

  // Zero-fill sensitive data
  ephemeralKeyPair.secretKey.fill(0);
  rawSharedSecret.fill(0);
  encryptionKey.fill(0);

  return {
    v: 2,
    from: encodeBase64(senderPublicKey),
    epk: encodeBase64(ephemeralKeyPair.publicKey),
    n: encodeBase64(nonce),
    c: encodeBase64(ciphertext),
    t: Date.now(),
  };
}

/**
 * Decrypt a v2 message using the recipient's derived messaging keypair.
 *
 * @param payload - Encrypted v2 message payload
 * @param recipientMessagingSecretKey - Recipient's X25519 secret key (derived from signature)
 * @returns Decrypted message content
 * @throws Error if decryption fails
 */
export function decryptMessageV2(
  payload: EncryptedMessagePayloadV2,
  recipientMessagingSecretKey: Uint8Array
): string {
  // Validate payload version
  if (payload.v !== 2) {
    throw new Error(`Invalid payload version: expected 2, got ${payload.v}`);
  }

  // Validate secret key length
  if (recipientMessagingSecretKey.length !== 32) {
    throw new Error(
      `Invalid secret key length: expected 32 bytes, got ${recipientMessagingSecretKey.length}`
    );
  }

  // Decode payload components
  const ephemeralPublic = decodeBase64(payload.epk);
  const nonce = decodeBase64(payload.n);
  const ciphertext = decodeBase64(payload.c);

  // Validate decoded lengths
  if (ephemeralPublic.length !== 32) {
    throw new Error(
      `Invalid ephemeral public key length: expected 32 bytes, got ${ephemeralPublic.length}`
    );
  }

  if (nonce.length !== nacl.secretbox.nonceLength) {
    throw new Error(
      `Invalid nonce length: expected ${nacl.secretbox.nonceLength} bytes, got ${nonce.length}`
    );
  }

  // Compute recipient's public key from secret
  const recipientPublic = nacl.scalarMult.base(recipientMessagingSecretKey);

  // Perform ECDH: sharedSecret = X25519(recipientSecret, ephemeralPublic)
  const rawSharedSecret = nacl.scalarMult(
    recipientMessagingSecretKey,
    ephemeralPublic
  );

  // Derive the same encryption key the sender used
  const encryptionKey = deriveEncryptionKey(
    rawSharedSecret,
    ephemeralPublic,
    recipientPublic
  );

  // Decrypt using NaCl secretbox.open
  const decrypted = nacl.secretbox.open(ciphertext, nonce, encryptionKey);

  // Zero-fill sensitive data
  rawSharedSecret.fill(0);
  encryptionKey.fill(0);
  recipientPublic.fill(0);

  if (!decrypted) {
    throw new Error('Decryption failed - message may be corrupted or tampered');
  }

  return new TextDecoder().decode(decrypted);
}

/**
 * Create an ARC-2 compliant note string from a v2 encrypted payload.
 *
 * @param payload - Encrypted v2 message payload
 * @returns Note string in format: voi-msg:v2:<base64_payload>
 */
export function createMessageNoteV2(payload: EncryptedMessagePayloadV2): string {
  const jsonPayload = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(jsonPayload);
  const base64Payload = encodeBase64(payloadBytes);
  return `${MESSAGE_NOTE_PREFIX}${base64Payload}`;
}

/**
 * Parse a message note (v1 or v2) and extract the encrypted payload.
 *
 * @param noteBase64 - Base64-encoded note field from transaction
 * @returns Parsed payload with version indicator, or null if invalid
 */
export function parseMessageNoteAny(
  noteBase64: string
): { version: 1; payload: EncryptedMessagePayload } | { version: 2; payload: EncryptedMessagePayloadV2 } | null {
  try {
    // Decode the note from base64 (as it comes from the indexer)
    const noteBytes = decodeBase64(noteBase64);
    const noteString = new TextDecoder().decode(noteBytes);

    // Check for v2 prefix first (current version)
    if (noteString.startsWith(MESSAGE_NOTE_PREFIX)) {
      const payloadBase64 = noteString.slice(MESSAGE_NOTE_PREFIX.length);
      const payloadBytes = decodeBase64(payloadBase64);
      const jsonPayload = new TextDecoder().decode(payloadBytes);
      const payload = JSON.parse(jsonPayload) as EncryptedMessagePayloadV2;

      // Validate v2 required fields
      if (payload.v !== 2 || !payload.from || !payload.epk || !payload.n || !payload.c || !payload.t) {
        return null;
      }

      return { version: 2, payload };
    }

    // Check for v1 prefix (legacy)
    if (noteString.startsWith(MESSAGE_NOTE_PREFIX_V1)) {
      const payloadBase64 = noteString.slice(MESSAGE_NOTE_PREFIX_V1.length);
      const payloadBytes = decodeBase64(payloadBase64);
      const jsonPayload = new TextDecoder().decode(payloadBytes);
      const payload = JSON.parse(jsonPayload) as EncryptedMessagePayload;

      // Validate v1 required fields
      if (!payload.nonce || !payload.ciphertext || !payload.senderPubKey || !payload.timestamp) {
        return null;
      }

      return { version: 1, payload };
    }

    return null;
  } catch {
    return null;
  }
}
