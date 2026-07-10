# V3 Group Messaging Implementation Plan

## Overview

This document outlines the implementation plan for upgrading the Voi Mobile Wallet messaging system from V2 (single-recipient) to V3 (multi-recipient). The V3 protocol enables:

1. **Sender-readable messages**: Sender included as recipient, can decrypt their own sent messages
2. **Group messaging**: Multiple recipients per message
3. **Space efficiency**: Binary payload format instead of JSON/Base64
4. **Backward compatibility**: Existing key registrations work unchanged

## Current Architecture Summary

### Files to Modify

| File | Purpose |
|------|---------|
| `src/services/messaging/types.ts` | Add V3 types and constants |
| `src/services/messaging/crypto.ts` | Add V3 encode/decode/encrypt/decrypt |
| `src/services/messaging/index.ts` | Update send/fetch to use V3 |
| `src/services/messaging/keyRegistry.ts` | No changes (V1 key format unchanged) |
| `src/services/messaging/keyDerivation.ts` | No changes |
| `src/store/messagesStore.ts` | Update thread model for groups |
| `src/screens/social/ChatScreen.tsx` | Support group display |
| `src/screens/social/MessagesInboxScreen.tsx` | Show group threads |
| `src/screens/social/NewMessageScreen.tsx` | Add group creation flow |

### New Files

| File | Purpose |
|------|---------|
| `src/services/messaging/v3Binary.ts` | Binary encoding/decoding utilities |
| `src/screens/social/NewGroupScreen.tsx` | Group creation UI |
| `src/screens/social/GroupInfoScreen.tsx` | Group member management |
| `src/components/social/GroupAvatar.tsx` | Avatar for group threads |

### Backend (Supabase)

| Item | Purpose |
|------|---------|
| `voi_messages` table | Store indexed V3 messages |
| Message trigger function | Extract recipient IDs from V3 payloads |
| `get_messages_for_recipient_id` RPC | Query messages by 4-byte recipient ID |

---

## Phase 1: Core Protocol Implementation

### 1.1 Type Definitions

**File:** `src/services/messaging/types.ts`

Add V3 types alongside existing V2:

```typescript
// V3 Constants
export const MESSAGE_NOTE_PREFIX_V3 = 'voi-msg:v3:';
export const KDF_DOMAIN_WRAP = 'voi-msg-wrap';
export const V3_VERSION = 0x03;
export const V3_HEADER_SIZE = 96;
export const V3_RECIPIENT_ENTRY_SIZE = 52;

// V3 Decoded payload (after binary parsing)
export interface DecodedMessageV3 {
  version: number;
  timestamp: number;
  senderPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  nonce: Uint8Array;
  recipients: Array<{
    id: Uint8Array;        // 4 bytes
    wrappedKey: Uint8Array; // 48 bytes
  }>;
  ciphertext: Uint8Array;
}

// Extended Message type for groups
export interface MessageV3 extends Message {
  /** All recipient addresses (for group messages) */
  recipientAddresses?: string[];
  /** Group ID if this is a group message */
  groupId?: string;
}

// Group thread extends MessageThread
export interface GroupThread extends Omit<MessageThread, 'friendAddress'> {
  /** Unique group identifier (hash of sorted participant addresses) */
  groupId: string;
  /** All participant addresses including self */
  participants: string[];
  /** Participant Envoi names (if known) */
  participantNames?: Record<string, string>;
  /** Group display name (optional, user-set) */
  groupName?: string;
  /** Messages in this group */
  messages: MessageV3[];
}

// Union type for any thread
export type AnyThread = MessageThread | GroupThread;

// Type guard
export function isGroupThread(thread: AnyThread): thread is GroupThread {
  return 'groupId' in thread && 'participants' in thread;
}
```

### 1.2 Binary Encoding/Decoding

**File:** `src/services/messaging/v3Binary.ts`

```typescript
import { V3_VERSION, V3_HEADER_SIZE, V3_RECIPIENT_ENTRY_SIZE, DecodedMessageV3 } from './types';

/**
 * Encode a V3 message payload to binary format.
 */
export function encodeMessageV3(
  senderPubKey: Uint8Array,
  ephemeralPubKey: Uint8Array,
  nonce: Uint8Array,
  recipients: Array<{ id: Uint8Array; wrappedKey: Uint8Array }>,
  ciphertext: Uint8Array
): Uint8Array {
  const totalSize =
    V3_HEADER_SIZE +
    recipients.length * V3_RECIPIENT_ENTRY_SIZE +
    ciphertext.length;

  const buffer = new Uint8Array(totalSize);
  let offset = 0;

  // Version (1 byte)
  buffer[offset++] = V3_VERSION;

  // Timestamp (6 bytes, big-endian)
  const timestamp = Date.now();
  for (let i = 5; i >= 0; i--) {
    buffer[offset++] = Math.floor(timestamp / Math.pow(256, i)) & 0xff;
  }

  // Sender pubkey (32 bytes)
  buffer.set(senderPubKey, offset);
  offset += 32;

  // Ephemeral pubkey (32 bytes)
  buffer.set(ephemeralPubKey, offset);
  offset += 32;

  // Nonce (24 bytes)
  buffer.set(nonce, offset);
  offset += 24;

  // Recipient count (1 byte)
  buffer[offset++] = recipients.length;

  // Recipients (52 bytes each)
  for (const r of recipients) {
    buffer.set(r.id, offset);
    offset += 4;
    buffer.set(r.wrappedKey, offset);
    offset += 48;
  }

  // Ciphertext
  buffer.set(ciphertext, offset);

  return buffer;
}

/**
 * Decode a V3 binary payload.
 */
export function decodeMessageV3(buffer: Uint8Array): DecodedMessageV3 {
  if (buffer.length < V3_HEADER_SIZE) {
    throw new Error('Buffer too small for V3 message');
  }

  let offset = 0;

  // Version
  const version = buffer[offset++];
  if (version !== V3_VERSION) {
    throw new Error(`Unsupported V3 version: ${version}`);
  }

  // Timestamp (6 bytes, big-endian)
  let timestamp = 0;
  for (let i = 0; i < 6; i++) {
    timestamp = timestamp * 256 + buffer[offset++];
  }

  // Sender pubkey
  const senderPubKey = buffer.slice(offset, offset + 32);
  offset += 32;

  // Ephemeral pubkey
  const ephemeralPubKey = buffer.slice(offset, offset + 32);
  offset += 32;

  // Nonce
  const nonce = buffer.slice(offset, offset + 24);
  offset += 24;

  // Recipient count
  const recipientCount = buffer[offset++];

  // Validate buffer size
  const expectedSize =
    V3_HEADER_SIZE +
    recipientCount * V3_RECIPIENT_ENTRY_SIZE;
  if (buffer.length < expectedSize) {
    throw new Error('Buffer too small for recipient entries');
  }

  // Recipients
  const recipients: Array<{ id: Uint8Array; wrappedKey: Uint8Array }> = [];
  for (let i = 0; i < recipientCount; i++) {
    const id = buffer.slice(offset, offset + 4);
    offset += 4;
    const wrappedKey = buffer.slice(offset, offset + 48);
    offset += 48;
    recipients.push({ id, wrappedKey });
  }

  // Ciphertext (remaining bytes)
  const ciphertext = buffer.slice(offset);

  return {
    version,
    timestamp,
    senderPubKey,
    ephemeralPubKey,
    nonce,
    recipients,
    ciphertext,
  };
}

/**
 * Extract recipient IDs from a V3 payload without full decoding.
 * Useful for indexing.
 */
export function extractRecipientIds(buffer: Uint8Array): Uint8Array[] {
  if (buffer.length < V3_HEADER_SIZE) {
    return [];
  }

  const recipientCount = buffer[95]; // Byte 96 (0-indexed: 95)
  const ids: Uint8Array[] = [];

  let offset = V3_HEADER_SIZE;
  for (let i = 0; i < recipientCount; i++) {
    if (offset + 4 > buffer.length) break;
    ids.push(buffer.slice(offset, offset + 4));
    offset += V3_RECIPIENT_ENTRY_SIZE;
  }

  return ids;
}
```

### 1.3 V3 Encryption/Decryption

**File:** `src/services/messaging/crypto.ts`

Add new functions for V3:

```typescript
import { encodeMessageV3, decodeMessageV3 } from './v3Binary';
import {
  DecodedMessageV3,
  KDF_DOMAIN_WRAP,
  MESSAGE_NOTE_PREFIX_V3,
} from './types';

/**
 * Derive wrapping key for V3 key wrapping.
 */
function deriveWrappingKey(
  rawSharedSecret: Uint8Array,
  ephemeralPublic: Uint8Array,
  recipientPublic: Uint8Array
): Uint8Array {
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_WRAP);

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

  const hash = nacl.hash(kdfInput);
  const wrappingKey = hash.slice(0, 32);

  // Zero-fill intermediates
  kdfInput.fill(0);
  hash.fill(0);

  return wrappingKey;
}

/**
 * Encrypt a message for multiple recipients (V3).
 *
 * @param plaintext - Message content
 * @param senderPubKey - Sender's Ed25519 public key (for identification)
 * @param senderMessagingPubKey - Sender's X25519 messaging key (included as recipient)
 * @param recipientMessagingPubKeys - Other recipients' X25519 messaging keys
 * @returns Binary V3 payload
 */
export async function encryptMessageV3(
  plaintext: string,
  senderPubKey: Uint8Array,
  senderMessagingPubKey: Uint8Array,
  recipientMessagingPubKeys: Uint8Array[]
): Promise<Uint8Array> {
  // Validate message length
  if (plaintext.length > MAX_MESSAGE_LENGTH) {
    throw new Error(
      `Message too long: ${plaintext.length} characters (max ${MAX_MESSAGE_LENGTH})`
    );
  }

  // Include sender as first recipient
  const allRecipients = [senderMessagingPubKey, ...recipientMessagingPubKeys];

  // Generate random message key
  const messageKey = await platformCrypto.getRandomBytes(32);

  // Generate ephemeral keypair
  const ephemeral = nacl.box.keyPair();

  // Generate nonce
  const nonce = await generateNonce();

  // Encrypt message with message key
  const messageBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(messageBytes, nonce, messageKey);

  // Wrap message key for each recipient
  const recipients = allRecipients.map((recipientPubKey) => {
    // ECDH
    const rawShared = nacl.scalarMult(ephemeral.secretKey, recipientPubKey);

    // Derive wrapping key
    const wrappingKey = deriveWrappingKey(
      rawShared,
      ephemeral.publicKey,
      recipientPubKey
    );

    // Wrap message key (reuse nonce - safe because different key per recipient)
    const wrappedKey = nacl.secretbox(messageKey, nonce, wrappingKey);

    // Extract 4-byte recipient ID
    const id = recipientPubKey.slice(0, 4);

    // Zero-fill intermediates
    rawShared.fill(0);
    wrappingKey.fill(0);

    return { id, wrappedKey };
  });

  // Zero-fill secrets
  ephemeral.secretKey.fill(0);
  messageKey.fill(0);

  return encodeMessageV3(
    senderPubKey,
    ephemeral.publicKey,
    nonce,
    recipients,
    ciphertext
  );
}

/**
 * Decrypt a V3 message.
 *
 * @param payload - Decoded V3 payload
 * @param myMessagingSecretKey - Recipient's X25519 secret key
 * @param myMessagingPubKey - Recipient's X25519 public key
 * @returns Decrypted plaintext
 */
export function decryptMessageV3(
  payload: DecodedMessageV3,
  myMessagingSecretKey: Uint8Array,
  myMessagingPubKey: Uint8Array
): string {
  // Find my recipient entry by 4-byte ID
  const myId = myMessagingPubKey.slice(0, 4);
  const myEntry = payload.recipients.find(
    (r) =>
      r.id[0] === myId[0] &&
      r.id[1] === myId[1] &&
      r.id[2] === myId[2] &&
      r.id[3] === myId[3]
  );

  if (!myEntry) {
    throw new Error('Not a recipient of this message');
  }

  // ECDH
  const rawShared = nacl.scalarMult(myMessagingSecretKey, payload.ephemeralPubKey);

  // Derive wrapping key
  const wrappingKey = deriveWrappingKey(
    rawShared,
    payload.ephemeralPubKey,
    myMessagingPubKey
  );

  // Unwrap message key
  const messageKey = nacl.secretbox.open(
    myEntry.wrappedKey,
    payload.nonce,
    wrappingKey
  );

  if (!messageKey) {
    throw new Error('Failed to unwrap message key');
  }

  // Decrypt message
  const plaintext = nacl.secretbox.open(
    payload.ciphertext,
    payload.nonce,
    messageKey
  );

  // Zero-fill
  rawShared.fill(0);
  wrappingKey.fill(0);
  messageKey.fill(0);

  if (!plaintext) {
    throw new Error('Failed to decrypt message');
  }

  return new TextDecoder().decode(plaintext);
}

/**
 * Create transaction note from V3 binary payload.
 */
export function createMessageNoteV3(payload: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(MESSAGE_NOTE_PREFIX_V3);
  const note = new Uint8Array(prefix.length + payload.length);
  note.set(prefix, 0);
  note.set(payload, prefix.length);
  return note;
}

/**
 * Parse a V3 message note from transaction.
 */
export function parseMessageNoteV3(noteBytes: Uint8Array): DecodedMessageV3 | null {
  const prefix = new TextEncoder().encode(MESSAGE_NOTE_PREFIX_V3);

  // Check prefix
  if (noteBytes.length < prefix.length) return null;
  for (let i = 0; i < prefix.length; i++) {
    if (noteBytes[i] !== prefix[i]) return null;
  }

  // Decode payload
  const payload = noteBytes.slice(prefix.length);
  return decodeMessageV3(payload);
}

/**
 * Update parseMessageNoteAny to handle V3.
 */
export function parseMessageNoteAny(
  noteBase64: string
):
  | { version: 1; payload: EncryptedMessagePayload }
  | { version: 2; payload: EncryptedMessagePayloadV2 }
  | { version: 3; payload: DecodedMessageV3 }
  | null {
  try {
    const noteBytes = decodeBase64(noteBase64);
    const noteString = new TextDecoder().decode(noteBytes);

    // Check V3 first (binary format)
    if (noteString.startsWith(MESSAGE_NOTE_PREFIX_V3)) {
      const payload = parseMessageNoteV3(noteBytes);
      if (payload) {
        return { version: 3, payload };
      }
    }

    // Check V2 (JSON format)
    if (noteString.startsWith(MESSAGE_NOTE_PREFIX)) {
      // ... existing V2 parsing
    }

    // Check V1 (legacy)
    if (noteString.startsWith(MESSAGE_NOTE_PREFIX_V1)) {
      // ... existing V1 parsing
    }

    return null;
  } catch {
    return null;
  }
}
```

---

## Phase 2: Backend Indexer

### 2.1 Supabase Migration

**File:** `supabase/migrations/YYYYMMDD_create_voi_messages.sql`

```sql
-- Table for indexed V3 messages
CREATE TABLE voi_messages (
  tx_id TEXT PRIMARY KEY,
  sender_address TEXT NOT NULL,
  recipient_ids BYTEA[] NOT NULL,
  payload BYTEA NOT NULL,
  timestamp_ms BIGINT NOT NULL,
  confirmed_round BIGINT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for recipient lookup
CREATE INDEX idx_voi_messages_recipient_ids
  ON voi_messages USING GIN(recipient_ids);

-- Index for time-ordered queries
CREATE INDEX idx_voi_messages_timestamp
  ON voi_messages(timestamp_ms DESC);

-- Index for sender lookup
CREATE INDEX idx_voi_messages_sender
  ON voi_messages(sender_address);
```

### 2.2 RPC Function

```sql
CREATE OR REPLACE FUNCTION get_messages_for_recipient_id(
  recipient_id BYTEA,
  since_timestamp BIGINT DEFAULT 0,
  max_results INT DEFAULT 500
)
RETURNS TABLE (
  tx_id TEXT,
  sender_address TEXT,
  payload BYTEA,
  timestamp_ms BIGINT,
  confirmed_round BIGINT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    tx_id,
    sender_address,
    payload,
    timestamp_ms,
    confirmed_round
  FROM voi_messages
  WHERE recipient_ids @> ARRAY[recipient_id]
    AND timestamp_ms > since_timestamp
  ORDER BY timestamp_ms DESC
  LIMIT max_results;
$$;
```

### 2.3 Message Ingestion

The trigger to populate `voi_messages` depends on how blockchain data is ingested. Options:

**Option A: Conduit Pipeline**
- Configure Algorand Conduit to write to Supabase
- Add PostgreSQL trigger on the transactions table

**Option B: Polling Service**
- Background service polls indexer for new transactions with `voi-msg:v3:` prefix
- Parses and inserts into `voi_messages`

**Option C: Edge Function Webhook**
- Indexer sends webhook on new transactions
- Edge function parses and inserts

*Recommend Option B for simplicity—create a small Node.js service that polls and ingests.*

---

## Phase 3: Messaging Service Updates

### 3.1 Update MessagingService

**File:** `src/services/messaging/index.ts`

Key changes:

```typescript
/**
 * Send a message to one or more recipients (V3).
 */
async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
  const { senderAddress, recipientAddress, content } = request;

  // Get sender's keypair
  const senderKeyPair = await this.deriveMessagingKeyPair(senderAddress);
  const senderPubKey = getPublicKeyFromAddress(senderAddress);

  // Look up recipient's messaging key
  const recipientMessagingKey = await this.lookupKey(recipientAddress);
  if (!recipientMessagingKey) {
    throw new Error('Recipient has not registered a messaging key');
  }

  // Encrypt with V3 (sender + recipient)
  const payload = await encryptMessageV3(
    content,
    senderPubKey,
    senderKeyPair.publicKey,
    [recipientMessagingKey]
  );

  // Create note
  const note = createMessageNoteV3(payload);

  // Send transaction (receiver = recipient for 1:1)
  const txId = await TransactionService.sendPayment({
    from: senderAddress,
    to: recipientAddress,
    amount: 0,
    note,
  });

  return {
    txId,
    message: {
      id: txId,
      threadId: recipientAddress,
      direction: 'sent',
      content,
      timestamp: Date.now(),
      status: 'pending',
      fee: MESSAGE_FEE_MICRO,
    },
  };
}

/**
 * Send a group message (V3).
 */
async sendGroupMessage(
  senderAddress: string,
  recipientAddresses: string[],
  content: string
): Promise<SendMessageResult> {
  const senderKeyPair = await this.deriveMessagingKeyPair(senderAddress);
  const senderPubKey = getPublicKeyFromAddress(senderAddress);

  // Look up all recipient messaging keys
  const recipientKeys: Uint8Array[] = [];
  for (const addr of recipientAddresses) {
    const key = await this.lookupKey(addr);
    if (!key) {
      throw new Error(`Recipient ${addr} has not registered a messaging key`);
    }
    recipientKeys.push(key);
  }

  // Encrypt with V3
  const payload = await encryptMessageV3(
    content,
    senderPubKey,
    senderKeyPair.publicKey,
    recipientKeys
  );

  const note = createMessageNoteV3(payload);

  // Group messages use self-transfer
  const txId = await TransactionService.sendPayment({
    from: senderAddress,
    to: senderAddress,
    amount: 0,
    note,
  });

  // Generate group ID from sorted participants
  const allParticipants = [senderAddress, ...recipientAddresses].sort();
  const groupId = generateGroupId(allParticipants);

  return {
    txId,
    message: {
      id: txId,
      threadId: groupId,
      groupId,
      recipientAddresses: allParticipants,
      direction: 'sent',
      content,
      timestamp: Date.now(),
      status: 'pending',
      fee: MESSAGE_FEE_MICRO,
    },
  };
}

/**
 * Fetch messages using V3 indexer.
 */
async fetchMessagesV3(
  userAddress: string,
  keyPair: MessagingKeyPair,
  sinceTimestamp: number = 0
): Promise<Message[]> {
  // Compute 4-byte recipient ID
  const myId = keyPair.publicKey.slice(0, 4);

  // Query Supabase
  const { data, error } = await supabase.rpc('get_messages_for_recipient_id', {
    recipient_id: `\\x${Buffer.from(myId).toString('hex')}`,
    since_timestamp: sinceTimestamp,
  });

  if (error) throw error;

  const messages: Message[] = [];

  for (const row of data) {
    try {
      const payload = decodeMessageV3(new Uint8Array(row.payload));
      const plaintext = decryptMessageV3(
        payload,
        keyPair.secretKey,
        keyPair.publicKey
      );

      // Determine direction
      const senderAddress = algosdk.encodeAddress(payload.senderPubKey);
      const direction = senderAddress === userAddress ? 'sent' : 'received';

      messages.push({
        id: row.tx_id,
        threadId: this.determineThreadId(payload, userAddress),
        direction,
        content: plaintext,
        timestamp: row.timestamp_ms,
        status: 'confirmed',
        confirmedRound: row.confirmed_round,
        fee: MESSAGE_FEE_MICRO,
      });
    } catch {
      // Not for us (collision) or corrupted - skip
      continue;
    }
  }

  return messages;
}
```

### 3.2 Helper Functions

```typescript
/**
 * Generate deterministic group ID from participant addresses.
 */
function generateGroupId(participants: string[]): string {
  const sorted = [...participants].sort();
  const combined = sorted.join(':');
  // Simple hash for group ID
  const hash = nacl.hash(new TextEncoder().encode(combined));
  return encodeBase64(hash.slice(0, 16)); // 16 bytes = 22 chars base64
}

/**
 * Determine thread ID from V3 payload.
 */
function determineThreadId(
  payload: DecodedMessageV3,
  userAddress: string
): string {
  // For 2 recipients (1:1): use the other party's address
  // For 3+ recipients (group): use group ID

  if (payload.recipients.length === 2) {
    // 1:1 message - find the other party
    const senderAddress = algosdk.encodeAddress(payload.senderPubKey);
    if (senderAddress === userAddress) {
      // I'm the sender - thread ID is the recipient
      // Need to resolve 4-byte ID to address (lookup in registry)
      // For now, derive from transaction receiver
      return 'TODO: resolve from tx receiver';
    } else {
      // I'm the recipient - thread ID is sender
      return senderAddress;
    }
  } else {
    // Group message - generate group ID
    // Would need to resolve all recipient IDs to addresses
    return 'TODO: resolve group ID';
  }
}
```

---

## Phase 4: Store Updates

### 4.1 Update messagesStore

**File:** `src/store/messagesStore.ts`

Key changes:

```typescript
interface MessagesState {
  // Existing 1:1 threads (backward compatibility)
  threads: Record<string, MessageThread>;

  // New: Group threads
  groupThreads: Record<string, GroupThread>;

  // ... rest of state
}

// Add group-related actions
interface MessagesActions {
  // ... existing actions

  // Group actions
  addGroupThread: (thread: GroupThread) => void;
  addGroupMessage: (groupId: string, message: MessageV3) => void;
  getOrCreateGroupThread: (participants: string[]) => GroupThread;
}

// Add hooks
export const useGroupThread = (groupId: string) =>
  useMessagesStore((state) => state.groupThreads[groupId]);

export const useAllThreads = () =>
  useMessagesStore((state) => {
    const oneToOne = Object.values(state.threads);
    const groups = Object.values(state.groupThreads);
    return [...oneToOne, ...groups].sort(
      (a, b) => b.lastMessageTimestamp - a.lastMessageTimestamp
    );
  });
```

---

## Phase 5: UI Updates

### 5.1 MessagesInboxScreen

- Display both 1:1 and group threads in unified list
- Group threads show participant count or names
- Use `GroupAvatar` component for group threads

### 5.2 ChatScreen

- Detect if thread is group via `isGroupThread()`
- Show participant list header for groups
- Link to `GroupInfoScreen` for member management

### 5.3 NewGroupScreen (New)

- Multi-select recipient picker
- Validate all recipients have registered keys
- Create group and send initial message

### 5.4 GroupInfoScreen (New)

- List all participants with Envoi names
- Show when each participant joined
- Future: Add/remove participants

---

## Phase 6: Migration & Rollout

### 6.1 Backward Compatibility

1. **Reading**: Support V2 and V3 message parsing
2. **Writing**: Send as V3 only (simpler)
3. **Keys**: No changes to key registration

### 6.2 Rollout Steps

1. Deploy Supabase migration and ingestion service
2. Release app update with V3 support
3. New messages sent as V3
4. Old V2 messages still readable

### 6.3 Data Migration

No migration needed—V2 messages remain on-chain and readable. New messages use V3. The inbox will show a unified view of both.

---

## Implementation Checklist

### Phase 1: Core Protocol
- [ ] Add V3 types to `types.ts`
- [ ] Create `v3Binary.ts` with encode/decode
- [ ] Add `encryptMessageV3` to `crypto.ts`
- [ ] Add `decryptMessageV3` to `crypto.ts`
- [ ] Update `parseMessageNoteAny` for V3
- [ ] Add unit tests for V3 encoding/decoding
- [ ] Add unit tests for V3 encryption/decryption

### Phase 2: Backend
- [ ] Create Supabase migration for `voi_messages`
- [ ] Create `get_messages_for_recipient_id` RPC
- [ ] Build/deploy message ingestion service
- [ ] Test indexer with sample V3 messages

### Phase 3: Messaging Service
- [ ] Update `sendMessage` to use V3
- [ ] Add `sendGroupMessage` method
- [ ] Add `fetchMessagesV3` using Supabase
- [ ] Add group ID generation
- [ ] Update thread ID resolution

### Phase 4: Store
- [ ] Add `groupThreads` to state
- [ ] Add group-related actions
- [ ] Add group hooks
- [ ] Update persistence for groups

### Phase 5: UI
- [ ] Update `MessagesInboxScreen` for groups
- [ ] Update `ChatScreen` for groups
- [ ] Create `NewGroupScreen`
- [ ] Create `GroupInfoScreen`
- [ ] Create `GroupAvatar` component

### Phase 6: Testing & Rollout
- [ ] E2E test: 1:1 messaging with V3
- [ ] E2E test: Group messaging
- [ ] E2E test: V2 backward compatibility
- [ ] Deploy to testnet
- [ ] Deploy to mainnet

---

## Open Questions

1. **Group naming**: Should groups have user-defined names, or auto-generate from participants?

2. **Maximum group size**: The protocol supports ~15 recipients. Should we enforce a lower limit in the UI?

3. **Participant discovery**: When receiving a group message, how do we resolve 4-byte IDs back to addresses for display? Options:
   - Store participant list in first message
   - Query key registry by ID prefix (expensive)
   - Include full participant list in every message (payload overhead)

4. **Group persistence**: Should group membership be stored locally only, or should there be an on-chain group definition?

5. **V2 fallback**: Should we fall back to V2 for 1:1 messages to maximize compatibility with older wallets?
