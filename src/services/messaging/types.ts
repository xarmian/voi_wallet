/**
 * Messaging System Type Definitions
 *
 * Types for the E2E encrypted messaging system that uses blockchain
 * transaction notes to send encrypted messages between users.
 */

/** Message direction relative to the current user */
export type MessageDirection = 'sent' | 'received';

/** Message delivery/confirmation status */
export type MessageStatus = 'pending' | 'confirmed' | 'failed';

/**
 * Encrypted payload structure embedded in transaction notes.
 * Format: voi-msg:v1:<base64(JSON of this structure)>
 */
export interface EncryptedMessagePayload {
  /** 24-byte nonce encoded as base64 */
  nonce: string;
  /** Encrypted message ciphertext encoded as base64 */
  ciphertext: string;
  /** Sender's Ed25519 public key encoded as base64 (for verification) */
  senderPubKey: string;
  /** Unix timestamp in milliseconds when message was sent */
  timestamp: number;
}

/**
 * Decrypted message representation for display and storage
 */
export interface Message {
  /** Transaction ID (unique identifier) */
  id: string;
  /** Friend's address (used as conversation thread key) */
  threadId: string;
  /** Direction relative to current user */
  direction: MessageDirection;
  /** Decrypted message content */
  content: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Delivery status */
  status: MessageStatus;
  /** Blockchain round when confirmed (if available) */
  confirmedRound?: number;
  /** Transaction fee paid in microVOI */
  fee: number;
}

/**
 * Message thread (conversation) with a specific user
 */
export interface MessageThread {
  /** Friend's wallet address */
  friendAddress: string;
  /** Friend's Envoi name (if known) */
  friendEnvoiName?: string;
  /** Most recent message in the thread */
  lastMessage?: Message;
  /** Timestamp of the most recent message */
  lastMessageTimestamp: number;
  /** Number of unread messages */
  unreadCount: number;
  /** All messages in this thread, sorted by timestamp */
  messages: Message[];
}

/**
 * Request to send a new message
 */
export interface SendMessageRequest {
  /** Recipient's wallet address */
  recipientAddress: string;
  /** Message content (plaintext, will be encrypted) */
  content: string;
  /** Sender's wallet address */
  senderAddress: string;
}

/**
 * Result of sending a message
 */
export interface SendMessageResult {
  /** Transaction ID */
  txId: string;
  /** The created message object */
  message: Message;
}

/**
 * Raw message transaction from indexer
 */
export interface MessageTransaction {
  /** Transaction ID */
  txId: string;
  /** Sender address */
  sender: string;
  /** Receiver address */
  receiver: string;
  /** Base64 encoded note field */
  note: string;
  /** Unix timestamp (seconds) */
  timestamp: number;
  /** Confirmed round number */
  confirmedRound: number;
  /** Transaction fee in microVOI */
  fee: number;
}

/** Message note prefix for ARC-2 compliance (legacy v1) */
export const MESSAGE_NOTE_PREFIX_V1 = 'voi-msg:v1:';

/** Message note prefix for v2 signature-derived encryption */
export const MESSAGE_NOTE_PREFIX = 'voi-msg:v2:';

/** Key registration note prefix */
export const KEY_REGISTRATION_PREFIX = 'voi-msg-key:v1:';

/** Maximum message length (accounting for encryption overhead) */
export const MAX_MESSAGE_LENGTH = 850;

/** Transaction fee for sending a message (0.001 VOI in microVOI) */
export const MESSAGE_FEE_MICRO = 1000;

/** Message fee display string */
export const MESSAGE_FEE_DISPLAY = '0.001 VOI';

// ============================================================================
// V2 Signature-Derived Encryption Constants
// ============================================================================

/**
 * Challenge message prefix for key derivation.
 * The full challenge includes the account address to prevent signing attacks
 * where an attacker tricks a user into signing on a malicious site.
 *
 * Ed25519 signatures are deterministic (RFC 8032), so signing this message
 * always produces the same signature for a given key, which can be used
 * to derive a stable messaging keypair.
 */
export const MESSAGING_CHALLENGE_PREFIX = 'voi-wallet-messaging-v1:';

/**
 * Create the full challenge message for a specific account.
 * Including the address ensures the challenge is unique per account
 * and cannot be reused by malicious dApps.
 */
export function createMessagingChallenge(accountAddress: string): string {
  return `${MESSAGING_CHALLENGE_PREFIX}${accountAddress}`;
}

/** Domain separation tag for deriving the X25519 key from signature */
export const KDF_DOMAIN_DECRYPTION_KEY = 'voi-msg-decrypt';

/** Domain separation tag for deriving shared secret in ECDH */
export const KDF_DOMAIN_SHARED_SECRET = 'voi-msg-shared';

/** Cache TTL for derived messaging keys (30 minutes in ms) */
export const MESSAGING_KEY_CACHE_TTL_MS = 30 * 60 * 1000;

// ============================================================================
// V2 Payload Types
// ============================================================================

/**
 * V2 Encrypted payload structure using signature-derived encryption.
 * Format: voi-msg:v2:<base64(JSON of this structure)>
 *
 * Key differences from v1:
 * - Uses ephemeral X25519 keys for forward secrecy
 * - Recipients derive their decryption key from a signature
 * - Compatible with hardware wallets (Ledger)
 */
export interface EncryptedMessagePayloadV2 {
  /** Protocol version */
  v: 2;
  /** Sender's Ed25519 public key (base64) - for sender identification */
  from: string;
  /** Ephemeral X25519 public key (base64) - for ECDH key agreement */
  epk: string;
  /** 24-byte nonce (base64) */
  n: string;
  /** Encrypted ciphertext (base64) */
  c: string;
  /** Unix timestamp in milliseconds */
  t: number;
}

/**
 * Messaging key registration stored on-chain.
 * Users publish their derived messaging public key so others can encrypt to them.
 */
export interface MessagingKeyRegistration {
  /** User's Algorand/Voi address */
  address: string;
  /** X25519 messaging public key (base64) - derived from signature */
  messagingPublicKey: string;
  /** Transaction ID where key was registered */
  registrationTxId: string;
  /** Block round of registration */
  registrationRound: number;
  /** Timestamp of registration */
  registeredAt: number;
}

/**
 * Cached messaging keypair for a session.
 * Derived from signing the challenge message.
 */
export interface MessagingKeyPair {
  /** X25519 secret key (32 bytes) - derived from signature */
  secretKey: Uint8Array;
  /** X25519 public key (32 bytes) - computed from secret */
  publicKey: Uint8Array;
  /** Account address this keypair belongs to */
  accountAddress: string;
  /** When this key was derived */
  derivedAt: number;
}
