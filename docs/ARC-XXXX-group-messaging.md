# ARC-XXXX: Multi-Recipient Encrypted Messaging (V3)

## Abstract

This ARC extends the on-chain encrypted messaging protocol (ARC-XXXX v2) to support multiple recipients per message. This enables both sender-readable messages (where the sender can decrypt their own sent messages) and group messaging (where a message is delivered to multiple participants). The protocol uses a space-efficient binary payload format and a 4-byte recipient identifier scheme for indexing.

## Motivation

The existing v2 protocol encrypts messages exclusively to a single recipient. This creates limitations:

1. **Senders cannot read their own sent messages**: Once encrypted, only the recipient can decrypt. The sender must store plaintext locally, which is lost if the device is replaced.

2. **No group conversations**: Each message to a group requires N separate encrypted transactions, one per recipient—expensive and inefficient.

3. **Payload inefficiency**: The v2 JSON/Base64 format wastes significant space on-chain, limiting message size.

This proposal addresses all three by:
- Treating 1:1 messaging as a degenerate case of group messaging (group of 2: sender + recipient)
- Using a compact binary payload format
- Enabling efficient indexing via 4-byte recipient identifiers

## Specification

### Binary Payload Format

V3 uses a binary format instead of JSON/Base64 for space efficiency.

#### Transaction Note Format

```
voi-msg:v3:<binary_payload>
```

The 11-byte prefix `voi-msg:v3:` is followed by raw binary data.

#### Binary Payload Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ Header (96 bytes fixed)                                         │
├──────────────────┬──────────┬───────────────────────────────────┤
│ version          │ 1 byte   │ 0x03                              │
│ timestamp        │ 6 bytes  │ milliseconds since epoch (big-endian) │
│ sender_pubkey    │ 32 bytes │ sender's Ed25519 public key       │
│ ephemeral_pubkey │ 32 bytes │ ephemeral X25519 public key       │
│ nonce            │ 24 bytes │ secretbox nonce                   │
│ recipient_count  │ 1 byte   │ number of recipients (1-255)      │
├──────────────────┴──────────┴───────────────────────────────────┤
│ Recipients (52 bytes each)                                      │
├──────────────────┬──────────┬───────────────────────────────────┤
│ recipient_id     │ 4 bytes  │ first 4 bytes of messaging pubkey │
│ wrapped_key      │ 48 bytes │ encrypted message key (32) + tag (16) │
│ (repeat for recipient_count)                                    │
├──────────────────┴──────────┴───────────────────────────────────┤
│ Ciphertext (variable length)                                    │
├──────────────────┬──────────┬───────────────────────────────────┤
│ ciphertext       │ variable │ encrypted message + 16-byte Poly1305 tag │
└──────────────────┴──────────┴───────────────────────────────────┘
```

#### Field Descriptions

| Field | Size | Description |
|-------|------|-------------|
| `version` | 1 byte | Protocol version, always `0x03` for v3 |
| `timestamp` | 6 bytes | Unix timestamp in milliseconds, big-endian (supports dates until year 10889) |
| `sender_pubkey` | 32 bytes | Sender's Ed25519 public key for identification |
| `ephemeral_pubkey` | 32 bytes | Fresh X25519 public key for ECDH key agreement |
| `nonce` | 24 bytes | Random nonce for secretbox encryption |
| `recipient_count` | 1 byte | Number of recipients (1-255) |
| `recipient_id` | 4 bytes | First 4 bytes of recipient's X25519 messaging public key |
| `wrapped_key` | 48 bytes | Message key encrypted for this recipient (secretbox output) |
| `ciphertext` | variable | Message encrypted with the shared message key |

### Size Analysis

#### Overhead Comparison

| Component | V2 (JSON/Base64) | V3 (Binary) |
|-----------|------------------|-------------|
| Prefix | 11 bytes | 11 bytes |
| Version | ~8 bytes | 1 byte |
| Timestamp | ~18 bytes | 6 bytes |
| Sender pubkey | ~54 bytes | 32 bytes |
| Ephemeral pubkey | ~54 bytes | 32 bytes |
| Nonce | ~38 bytes | 24 bytes |
| Per recipient | N/A | 52 bytes |
| Base64 bloat | ~33% | 0% |

#### Capacity (assuming 1024-byte note limit)

| Recipients | Fixed Overhead | Available for Message |
|------------|----------------|----------------------|
| 2 (1:1 + sender) | 211 bytes | ~797 bytes |
| 5 | 367 bytes | ~641 bytes |
| 10 | 627 bytes | ~381 bytes |
| 15 | 887 bytes | ~121 bytes |

### Encryption Process

1. **Generate message key**: Create a random 32-byte symmetric key `K`

2. **Generate ephemeral keypair**: Create a fresh X25519 keypair for forward secrecy

3. **Encrypt message**: Using NaCl secretbox with key `K` and a random nonce:
   ```
   ciphertext = secretbox(plaintext, nonce, K)
   ```

4. **For each recipient** (including sender):
   a. Compute ECDH shared secret:
      ```
      raw_shared = X25519(ephemeral_secret, recipient_messaging_pubkey)
      ```
   b. Derive wrapping key via KDF:
      ```
      kdf_input = "voi-msg-wrap" || raw_shared || ephemeral_pubkey || recipient_messaging_pubkey
      wrapping_key = SHA-512(kdf_input)[0:32]
      ```
   c. Wrap the message key:
      ```
      wrapped_key = secretbox(K, nonce, wrapping_key)
      ```
   d. Extract recipient ID:
      ```
      recipient_id = recipient_messaging_pubkey[0:4]
      ```

5. **Assemble payload**: Concatenate header, recipient entries, and ciphertext

6. **Zero-fill**: Clear all sensitive intermediate values (ephemeral secret, raw shared secrets, wrapping keys, message key)

### Decryption Process

1. **Parse payload**: Extract header, recipient entries, and ciphertext

2. **Find recipient entry**: Search for entry where `recipient_id` matches first 4 bytes of own messaging public key

3. **Compute shared secret**:
   ```
   raw_shared = X25519(own_messaging_secret, ephemeral_pubkey)
   ```

4. **Derive wrapping key**:
   ```
   kdf_input = "voi-msg-wrap" || raw_shared || ephemeral_pubkey || own_messaging_pubkey
   wrapping_key = SHA-512(kdf_input)[0:32]
   ```

5. **Unwrap message key**:
   ```
   K = secretbox.open(wrapped_key, nonce, wrapping_key)
   ```

6. **Decrypt message**:
   ```
   plaintext = secretbox.open(ciphertext, nonce, K)
   ```

7. **Zero-fill**: Clear all sensitive intermediate values

### Recipient Identifier Scheme

The 4-byte `recipient_id` serves two purposes:

1. **Payload lookup**: Recipients scan the recipient entries to find their wrapped key without trying all of them

2. **Index filtering**: External indexers can filter messages by recipient ID without decrypting

#### Collision Handling

With 4 bytes (32 bits), the probability of collision between any two random keys is approximately 1 in 4.3 billion. In practice:

- Collisions are rare but possible
- If a recipient finds a matching ID but decryption fails, the message was not for them
- Clients MUST handle decryption failure gracefully (silent discard)

The cryptographic decryption is the true access control; the 4-byte ID is merely an optimization.

### Transaction Structure

#### Message Transaction

- **Type**: Payment transaction
- **Sender**: Message author's address
- **Receiver**: For 1:1 (2 recipients), use the other party's address; for groups (3+ recipients), use sender's own address (self-transfer)
- **Amount**: 0
- **Note**: `voi-msg:v3:<binary_payload>`

**Rationale for receiver selection**: Using the other party's address for 1:1 messages maintains backward compatibility with simple indexer queries. Group messages use self-transfer since there's no single "primary" recipient.

### Domain Separation

V3 introduces a new domain tag for key wrapping:

| Tag | Usage |
|-----|-------|
| `voi-msg-decrypt` | Key derivation from signature (unchanged) |
| `voi-msg-shared` | Shared secret KDF (v2, deprecated in v3) |
| `voi-msg-wrap` | Key wrapping KDF (v3) |
| `voi-msg-key:v1:` | Key registration note prefix (unchanged) |
| `voi-msg:v3:` | V3 message note prefix |

### Indexing

#### The Indexing Problem

Unlike v2 where the transaction receiver identifies the recipient, v3 embeds multiple recipients inside the encrypted payload. Standard blockchain indexers cannot filter by recipient without parsing every message.

#### Custom Indexer Solution

Implementations SHOULD provide a custom indexer that:

1. **Triggers on note prefix**: Process transactions with notes starting with `voi-msg:v3:`

2. **Extracts recipient IDs**: Parse the binary header to extract all 4-byte recipient IDs

3. **Stores for lookup**: Maintain a table mapping recipient IDs to transactions

#### Recommended Schema

```sql
CREATE TABLE voi_messages (
  tx_id TEXT PRIMARY KEY,
  sender_address TEXT NOT NULL,
  recipient_ids BYTEA[] NOT NULL,     -- array of 4-byte identifiers
  payload BYTEA NOT NULL,             -- full binary payload
  timestamp_ms BIGINT NOT NULL,
  confirmed_round BIGINT NOT NULL
);

CREATE INDEX idx_messages_recipient_ids ON voi_messages USING GIN(recipient_ids);
CREATE INDEX idx_messages_timestamp ON voi_messages(timestamp_ms DESC);
```

#### Query Function

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
AS $$
  SELECT tx_id, sender_address, payload, timestamp_ms, confirmed_round
  FROM voi_messages
  WHERE recipient_ids @> ARRAY[recipient_id]
    AND timestamp_ms > since_timestamp
  ORDER BY timestamp_ms DESC
  LIMIT max_results;
$$;
```

#### Client Query Flow

```typescript
async function fetchMessages(myMessagingPubKey: Uint8Array): Promise<Message[]> {
  // Derive 4-byte ID from messaging public key
  const myId = myMessagingPubKey.slice(0, 4);

  // Query custom indexer
  const rows = await rpc.getMessagesForRecipientId(myId, lastTimestamp);

  const messages: Message[] = [];

  for (const row of rows) {
    try {
      const payload = decodeMessageV3(row.payload);
      const plaintext = decryptMessageV3(payload, myMessagingKeyPair);
      messages.push({
        id: row.tx_id,
        content: plaintext,
        timestamp: row.timestamp_ms,
        sender: row.sender_address,
      });
    } catch {
      // Not for us (ID collision) or corrupted—skip silently
      continue;
    }
  }

  return messages;
}
```

## Security Considerations

### Forward Secrecy

Each message uses a fresh ephemeral keypair. Compromising a recipient's long-term messaging key does not reveal past messages.

### Sender Inclusion

Including the sender as a recipient allows them to decrypt their own sent messages. This is a deliberate design choice with tradeoffs:

- **Pro**: Sender can recover message history on new devices
- **Pro**: Consistent UX for conversation view
- **Con**: 52 bytes additional overhead per message
- **Con**: Sender's messaging key compromise reveals their sent messages

Implementations MAY omit sender from recipients if sender-readability is not desired.

### Recipient Privacy

The 4-byte recipient IDs are derived from messaging public keys, not account addresses. However:

- Recipient IDs are visible in the payload (not encrypted)
- An observer can determine which messaging keys received a message
- Linking messaging keys to addresses requires access to key registration transactions

For higher privacy, future versions could explore encrypted recipient IDs or stealth addressing.

### Collision Attacks

An attacker could theoretically generate a messaging keypair with a specific 4-byte prefix to intercept messages. However:

- They still cannot decrypt without the actual recipient's secret key
- The attack only causes the victim to receive (and fail to decrypt) extra messages
- This is a nuisance, not a security breach

### Memory Safety

Implementations MUST:
- Zero-fill the ephemeral secret key after use
- Zero-fill all raw ECDH shared secrets
- Zero-fill all derived wrapping keys
- Zero-fill the message key after encryption/decryption
- Use constant-time comparison for recipient ID matching

## Reference Implementation

### Encoding (TypeScript)

```typescript
const V3_VERSION = 0x03;
const HEADER_SIZE = 96;
const RECIPIENT_ENTRY_SIZE = 52;
const KDF_DOMAIN_WRAP = 'voi-msg-wrap';

function encodeMessageV3(
  senderPubKey: Uint8Array,         // 32 bytes
  ephemeralPubKey: Uint8Array,      // 32 bytes
  nonce: Uint8Array,                // 24 bytes
  recipients: Array<{
    id: Uint8Array;                 // 4 bytes
    wrappedKey: Uint8Array;         // 48 bytes
  }>,
  ciphertext: Uint8Array
): Uint8Array {
  const totalSize = HEADER_SIZE +
    (recipients.length * RECIPIENT_ENTRY_SIZE) +
    ciphertext.length;

  const buffer = new Uint8Array(totalSize);
  let offset = 0;

  // Version (1 byte)
  buffer[offset++] = V3_VERSION;

  // Timestamp (6 bytes, big-endian)
  const timestamp = Date.now();
  for (let i = 5; i >= 0; i--) {
    buffer[offset++] = (timestamp / Math.pow(256, i)) & 0xff;
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

  // Recipient entries (52 bytes each)
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
```

### Decoding (TypeScript)

```typescript
interface DecodedMessageV3 {
  version: number;
  timestamp: number;
  senderPubKey: Uint8Array;
  ephemeralPubKey: Uint8Array;
  nonce: Uint8Array;
  recipients: Array<{
    id: Uint8Array;
    wrappedKey: Uint8Array;
  }>;
  ciphertext: Uint8Array;
}

function decodeMessageV3(buffer: Uint8Array): DecodedMessageV3 {
  let offset = 0;

  // Version
  const version = buffer[offset++];
  if (version !== V3_VERSION) {
    throw new Error(`Unsupported version: ${version}`);
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

  // Recipients
  const recipients = [];
  for (let i = 0; i < recipientCount; i++) {
    const id = buffer.slice(offset, offset + 4);
    offset += 4;
    const wrappedKey = buffer.slice(offset, offset + 48);
    offset += 48;
    recipients.push({ id, wrappedKey });
  }

  // Ciphertext
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
```

### Encryption (TypeScript)

```typescript
import nacl from 'tweetnacl';

async function encryptMessageV3(
  plaintext: string,
  senderPubKey: Uint8Array,
  senderMessagingPubKey: Uint8Array,
  recipientMessagingPubKeys: Uint8Array[]
): Promise<Uint8Array> {
  // Include sender as first recipient
  const allRecipients = [senderMessagingPubKey, ...recipientMessagingPubKeys];

  // Generate random message key
  const messageKey = nacl.randomBytes(32);

  // Generate ephemeral keypair
  const ephemeral = nacl.box.keyPair();

  // Generate nonce
  const nonce = nacl.randomBytes(24);

  // Encrypt message with message key
  const messageBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(messageBytes, nonce, messageKey);

  // Wrap message key for each recipient
  const recipients = allRecipients.map(recipientPubKey => {
    // ECDH
    const rawShared = nacl.scalarMult(ephemeral.secretKey, recipientPubKey);

    // KDF for wrapping key
    const domainBytes = new TextEncoder().encode(KDF_DOMAIN_WRAP);
    const kdfInput = new Uint8Array(
      domainBytes.length + rawShared.length +
      ephemeral.publicKey.length + recipientPubKey.length
    );
    let off = 0;
    kdfInput.set(domainBytes, off); off += domainBytes.length;
    kdfInput.set(rawShared, off); off += rawShared.length;
    kdfInput.set(ephemeral.publicKey, off); off += ephemeral.publicKey.length;
    kdfInput.set(recipientPubKey, off);

    const wrappingKey = nacl.hash(kdfInput).slice(0, 32);

    // Wrap message key
    const wrappedKey = nacl.secretbox(messageKey, nonce, wrappingKey);

    // Extract recipient ID
    const id = recipientPubKey.slice(0, 4);

    // Zero-fill intermediates
    rawShared.fill(0);
    wrappingKey.fill(0);
    kdfInput.fill(0);

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
```

### Decryption (TypeScript)

```typescript
function decryptMessageV3(
  payload: DecodedMessageV3,
  myMessagingSecretKey: Uint8Array,
  myMessagingPubKey: Uint8Array
): string {
  // Find my recipient entry
  const myId = myMessagingPubKey.slice(0, 4);
  const myEntry = payload.recipients.find(r =>
    r.id[0] === myId[0] && r.id[1] === myId[1] &&
    r.id[2] === myId[2] && r.id[3] === myId[3]
  );

  if (!myEntry) {
    throw new Error('Not a recipient of this message');
  }

  // ECDH
  const rawShared = nacl.scalarMult(myMessagingSecretKey, payload.ephemeralPubKey);

  // KDF for wrapping key
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_WRAP);
  const kdfInput = new Uint8Array(
    domainBytes.length + rawShared.length +
    payload.ephemeralPubKey.length + myMessagingPubKey.length
  );
  let off = 0;
  kdfInput.set(domainBytes, off); off += domainBytes.length;
  kdfInput.set(rawShared, off); off += rawShared.length;
  kdfInput.set(payload.ephemeralPubKey, off); off += payload.ephemeralPubKey.length;
  kdfInput.set(myMessagingPubKey, off);

  const wrappingKey = nacl.hash(kdfInput).slice(0, 32);

  // Unwrap message key
  const messageKey = nacl.secretbox.open(myEntry.wrappedKey, payload.nonce, wrappingKey);

  if (!messageKey) {
    throw new Error('Failed to unwrap message key');
  }

  // Decrypt message
  const plaintext = nacl.secretbox.open(payload.ciphertext, payload.nonce, messageKey);

  // Zero-fill
  rawShared.fill(0);
  wrappingKey.fill(0);
  kdfInput.fill(0);
  messageKey.fill(0);

  if (!plaintext) {
    throw new Error('Failed to decrypt message');
  }

  return new TextDecoder().decode(plaintext);
}
```

### Indexer Trigger (PostgreSQL)

```sql
CREATE OR REPLACE FUNCTION process_voi_message_v3()
RETURNS TRIGGER AS $$
DECLARE
  prefix BYTEA := E'voi-msg:v3:'::BYTEA;
  prefix_len INT := 11;
  header_len INT := 95;  -- up to recipient_count
  recipient_count INT;
  recipient_ids BYTEA[];
  offset INT;
  i INT;
BEGIN
  -- Validate minimum length
  IF NEW.note IS NULL OR length(NEW.note) < prefix_len + header_len + 1 THEN
    RETURN NEW;
  END IF;

  -- Check prefix
  IF substring(NEW.note FROM 1 FOR prefix_len) != prefix THEN
    RETURN NEW;
  END IF;

  -- Parse recipient count (byte 96 after prefix)
  offset := prefix_len + header_len;
  recipient_count := get_byte(NEW.note, offset);
  offset := offset + 1;

  -- Extract recipient IDs
  recipient_ids := ARRAY[]::BYTEA[];
  FOR i IN 1..recipient_count LOOP
    recipient_ids := array_append(
      recipient_ids,
      substring(NEW.note FROM offset + 1 FOR 4)
    );
    offset := offset + 52;  -- 4-byte ID + 48-byte wrapped key
  END LOOP;

  -- Extract timestamp (bytes 2-7 after prefix, big-endian)
  INSERT INTO voi_messages (
    tx_id,
    sender_address,
    recipient_ids,
    payload,
    timestamp_ms,
    confirmed_round
  ) VALUES (
    NEW.tx_id,
    NEW.sender,
    recipient_ids,
    substring(NEW.note FROM prefix_len + 1),
    (get_byte(NEW.note, prefix_len + 1)::bigint << 40) |
    (get_byte(NEW.note, prefix_len + 2)::bigint << 32) |
    (get_byte(NEW.note, prefix_len + 3)::bigint << 24) |
    (get_byte(NEW.note, prefix_len + 4)::bigint << 16) |
    (get_byte(NEW.note, prefix_len + 5)::bigint << 8) |
    (get_byte(NEW.note, prefix_len + 6)::bigint),
    NEW.confirmed_round
  )
  ON CONFLICT (tx_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

## Backwards Compatibility

### Version Detection

Implementations MUST check the note prefix to determine the protocol version:

- `voi-msg:v2:` → V2 single-recipient (JSON/Base64)
- `voi-msg:v3:` → V3 multi-recipient (binary)

### Migration Path

1. Implement V3 encryption/decryption alongside V2
2. Update `parseMessageNote` to detect and route both versions
3. Send new messages as V3
4. Continue accepting V2 messages indefinitely

### Interoperability

Wallets implementing only V2 will not be able to decrypt V3 messages. The sender should verify recipient wallet capabilities before using V3 for new contacts, or fall back to V2 for maximum compatibility.

## Test Vectors

```
TODO: Add test vectors for:
- Binary encoding/decoding
- Multi-recipient encryption
- Recipient ID extraction
- Key wrapping/unwrapping
```

## Future Considerations

### Larger Groups

For groups exceeding the note size limit (~15 recipients), consider:

- **Off-chain payload storage**: Store encrypted payload on IPFS/Arweave, include hash in note
- **Multiple transactions**: Split large groups across multiple linked transactions

### Recipient Privacy

Future versions could explore:

- **Encrypted recipient IDs**: Derive IDs using a shared group secret
- **Stealth addresses**: One-time addresses for each message

### Group Membership Changes

The multi-recipient header approach intentionally avoids shared group keys:

- **Adding members**: Include new member's messaging pubkey in subsequent messages
- **Removing members**: Simply omit them from the recipients list
- **No key rotation required**: Each message has an independent random key `K`, wrapped per-recipient

Removed members cannot decrypt messages sent after their removal, even if they retain old messages. This is a key advantage over shared-key schemes.

## Copyright

This document is placed in the public domain.
