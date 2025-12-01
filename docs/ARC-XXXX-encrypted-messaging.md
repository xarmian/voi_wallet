# ARC-XXXX: On-Chain End-to-End Encrypted Messaging

## Abstract

This ARC defines a standard for end-to-end encrypted messaging using blockchain transactions as the transport layer. Messages are encrypted using a signature-derived key scheme that enables hardware wallet compatibility while providing forward secrecy. The protocol uses transaction note fields to carry encrypted payloads and on-chain key registration for recipient discovery.

## Motivation

Blockchain addresses provide a universal identity layer, but lack native private communication capabilities. Existing messaging solutions require:
- Centralized servers that can read messages
- Separate identity systems
- Complex key exchange protocols

This proposal enables:
- **True E2E encryption**: Only the intended recipient can decrypt messages
- **Hardware wallet compatibility**: Private keys never need to be exported; only signatures are required
- **Forward secrecy**: Compromising a key doesn't reveal past messages
- **Decentralized transport**: Messages are stored on-chain, requiring no trusted intermediaries
- **Universal addressing**: Any valid blockchain address can receive messages

## Specification

### Key Derivation

Recipients derive a dedicated X25519 messaging keypair from their Ed25519 signing key by signing a deterministic challenge message.

#### Challenge Message Format

```
voi-wallet-messaging-v1:<account_address>
```

The challenge includes the account address to prevent cross-account key confusion and signing attacks where a malicious dApp tricks users into signing the challenge.

#### Key Derivation Process

1. Sign the challenge message using Ed25519 (RFC 8032 deterministic signatures)
2. Hash the 64-byte signature with domain separation:
   ```
   key_material = SHA-512("voi-msg-decrypt" || signature)
   ```
3. Take the first 32 bytes as the X25519 secret key
4. Apply X25519 clamping (RFC 7748):
   ```
   secret[0] &= 248
   secret[31] &= 127
   secret[31] |= 64
   ```
5. Derive the public key: `public = X25519(secret, basepoint)`

**Rationale**: Ed25519 signatures are deterministic per RFC 8032, meaning the same key signing the same message always produces the same signature. This allows the messaging keypair to be derived consistently across sessions without storing additional secrets. Hardware wallets like Ledger support Ed25519 signing, enabling this scheme without ever exposing the private key.

### Key Registration

Before receiving messages, users must publish their X25519 messaging public key on-chain.

#### Registration Transaction Format

- **Type**: Payment transaction
- **Sender**: User's address
- **Receiver**: User's address (self-transfer)
- **Amount**: 0
- **Note**: `voi-msg-key:v1:<base64_public_key>`

Where `<base64_public_key>` is the 32-byte X25519 public key encoded in standard Base64.

#### Key Lookup

To find a recipient's messaging public key:
1. Query the indexer for payment transactions where sender equals receiver equals the target address
2. Filter for transactions with notes starting with `voi-msg-key:v1:`
3. Use the most recent registration (by confirmed round) as the active key

**Key Rotation**: Users can update their messaging key by submitting a new registration transaction. The most recent registration takes precedence.

### Message Encryption

Messages use ephemeral ECDH with the recipient's registered messaging public key, providing forward secrecy.

#### Encryption Process

1. **Validate** the message length (max 850 characters recommended)
2. **Lookup** the recipient's messaging public key from on-chain registration
3. **Generate** an ephemeral X25519 keypair for this message
4. **Compute** the raw shared secret:
   ```
   raw_shared = X25519(ephemeral_secret, recipient_public)
   ```
5. **Derive** the encryption key via KDF:
   ```
   kdf_input = "voi-msg-shared" || raw_shared || ephemeral_public || recipient_public
   encryption_key = SHA-512(kdf_input)[0:32]
   ```
6. **Generate** a random 24-byte nonce
7. **Encrypt** using NaCl secretbox (XSalsa20-Poly1305):
   ```
   ciphertext = secretbox(plaintext, nonce, encryption_key)
   ```
8. **Zero-fill** all sensitive intermediate values

#### Encrypted Payload Structure (v2)

```json
{
  "v": 2,
  "from": "<base64_sender_ed25519_public_key>",
  "epk": "<base64_ephemeral_x25519_public_key>",
  "n": "<base64_24_byte_nonce>",
  "c": "<base64_ciphertext>",
  "t": 1234567890000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `v` | integer | Protocol version (2) |
| `from` | string | Sender's Ed25519 public key (Base64, 32 bytes) |
| `epk` | string | Ephemeral X25519 public key (Base64, 32 bytes) |
| `n` | string | Random nonce (Base64, 24 bytes) |
| `c` | string | Encrypted ciphertext (Base64, variable length) |
| `t` | integer | Unix timestamp in milliseconds |

#### Message Transaction Format

- **Type**: Payment transaction
- **Sender**: Message sender's address
- **Receiver**: Message recipient's address
- **Amount**: 0
- **Note**: `voi-msg:v2:<base64_json_payload>`

Where `<base64_json_payload>` is the JSON payload structure above, encoded in Base64.

### Message Decryption

#### Decryption Process

1. **Derive** the messaging keypair by signing the challenge (once per session, can be cached)
2. **Parse** the encrypted payload from the transaction note
3. **Verify** the sender by comparing the `from` field with the transaction sender's public key
4. **Compute** the shared secret:
   ```
   raw_shared = X25519(recipient_secret, ephemeral_public)
   ```
5. **Derive** the same encryption key:
   ```
   recipient_public = X25519(recipient_secret, basepoint)
   kdf_input = "voi-msg-shared" || raw_shared || ephemeral_public || recipient_public
   encryption_key = SHA-512(kdf_input)[0:32]
   ```
6. **Decrypt** using NaCl secretbox.open:
   ```
   plaintext = secretbox.open(ciphertext, nonce, encryption_key)
   ```
7. **Zero-fill** all sensitive intermediate values

### Sender Verification

To prevent spoofing, implementations MUST verify that the transaction sender matches the public key in the payload:

1. Extract the Ed25519 public key from the sender's address
2. Decode the `from` field from the payload
3. Compare using constant-time comparison to prevent timing attacks
4. Reject messages where verification fails

### Domain Separation

The protocol uses domain separation tags to prevent cross-protocol attacks:

| Tag | Usage |
|-----|-------|
| `voi-msg-decrypt` | Key derivation from signature |
| `voi-msg-shared` | Shared secret KDF |
| `voi-msg-key:v1:` | Key registration note prefix |
| `voi-msg:v2:` | Message note prefix |

## Security Considerations

### Forward Secrecy

Each message uses a fresh ephemeral keypair. Compromising the recipient's long-term messaging key does not reveal the content of past messages, as the ephemeral private keys are discarded after encryption.

### Hardware Wallet Support

The signature-derived key scheme enables hardware wallet compatibility:
- Private keys never leave the secure element
- Only Ed25519 signatures are required
- Users approve signing on-device once per session

### Challenge Message Security

Including the account address in the challenge message prevents:
- **Cross-account confusion**: Different accounts derive different keypairs
- **Signing attacks**: Malicious dApps cannot trick users into signing a generic challenge that would expose their messaging key

### Memory Safety

Implementations SHOULD:
- Zero-fill all secret key material after use
- Zero-fill intermediate KDF values
- Use secure memory allocation where available
- Clear cached keys on app backgrounding or logout

### Timing Attacks

Implementations MUST use constant-time comparison for:
- Sender verification
- Any cryptographic comparisons

### Message Size Limits

The recommended maximum message size is 850 characters to ensure the encoded transaction note fits within blockchain limits after encryption overhead and Base64 encoding.

### Replay Protection

Messages include a timestamp field and are bound to specific transaction IDs. The blockchain itself provides ordering and immutability. Implementations SHOULD deduplicate messages by transaction ID.

## Reference Implementation

### Dependencies

- `tweetnacl`: NaCl cryptographic primitives
- `tweetnacl-util`: Base64 encoding utilities
- `algosdk`: Algorand SDK for address handling

### Key Derivation (TypeScript)

```typescript
import nacl from 'tweetnacl';

const MESSAGING_CHALLENGE_PREFIX = 'voi-wallet-messaging-v1:';
const KDF_DOMAIN_DECRYPTION_KEY = 'voi-msg-decrypt';

function createMessagingChallenge(accountAddress: string): string {
  return `${MESSAGING_CHALLENGE_PREFIX}${accountAddress}`;
}

function deriveMessagingKeyPair(
  ed25519SecretKey: Uint8Array,
  accountAddress: string
): { secretKey: Uint8Array; publicKey: Uint8Array } {
  // Sign the challenge
  const challenge = createMessagingChallenge(accountAddress);
  const challengeBytes = new TextEncoder().encode(challenge);
  const signature = nacl.sign.detached(challengeBytes, ed25519SecretKey);

  // KDF with domain separation
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_DECRYPTION_KEY);
  const kdfInput = new Uint8Array(domainBytes.length + signature.length);
  kdfInput.set(domainBytes, 0);
  kdfInput.set(signature, domainBytes.length);

  const keyMaterial = nacl.hash(kdfInput);
  const secretKey = keyMaterial.slice(0, 32);

  // X25519 clamping
  secretKey[0] &= 248;
  secretKey[31] &= 127;
  secretKey[31] |= 64;

  const publicKey = nacl.scalarMult.base(secretKey);

  // Zero-fill intermediates
  keyMaterial.fill(0);
  kdfInput.fill(0);
  signature.fill(0);

  return { secretKey, publicKey };
}
```

### Encryption (TypeScript)

```typescript
const KDF_DOMAIN_SHARED_SECRET = 'voi-msg-shared';

async function encryptMessage(
  plaintext: string,
  senderPublicKey: Uint8Array,
  recipientMessagingPublicKey: Uint8Array
): Promise<EncryptedPayload> {
  // Generate ephemeral keypair
  const ephemeral = nacl.box.keyPair();

  // ECDH
  const rawShared = nacl.scalarMult(ephemeral.secretKey, recipientMessagingPublicKey);

  // KDF
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_SHARED_SECRET);
  const kdfInput = new Uint8Array(
    domainBytes.length + rawShared.length + ephemeral.publicKey.length + recipientMessagingPublicKey.length
  );
  let offset = 0;
  kdfInput.set(domainBytes, offset); offset += domainBytes.length;
  kdfInput.set(rawShared, offset); offset += rawShared.length;
  kdfInput.set(ephemeral.publicKey, offset); offset += ephemeral.publicKey.length;
  kdfInput.set(recipientMessagingPublicKey, offset);

  const encryptionKey = nacl.hash(kdfInput).slice(0, 32);

  // Encrypt
  const nonce = nacl.randomBytes(24);
  const messageBytes = new TextEncoder().encode(plaintext);
  const ciphertext = nacl.secretbox(messageBytes, nonce, encryptionKey);

  // Zero-fill
  ephemeral.secretKey.fill(0);
  rawShared.fill(0);
  encryptionKey.fill(0);
  kdfInput.fill(0);

  return {
    v: 2,
    from: encodeBase64(senderPublicKey),
    epk: encodeBase64(ephemeral.publicKey),
    n: encodeBase64(nonce),
    c: encodeBase64(ciphertext),
    t: Date.now(),
  };
}
```

### Decryption (TypeScript)

```typescript
function decryptMessage(
  payload: EncryptedPayload,
  recipientSecretKey: Uint8Array
): string {
  const ephemeralPublic = decodeBase64(payload.epk);
  const nonce = decodeBase64(payload.n);
  const ciphertext = decodeBase64(payload.c);

  // Compute recipient public key
  const recipientPublic = nacl.scalarMult.base(recipientSecretKey);

  // ECDH
  const rawShared = nacl.scalarMult(recipientSecretKey, ephemeralPublic);

  // KDF (same as encryption)
  const domainBytes = new TextEncoder().encode(KDF_DOMAIN_SHARED_SECRET);
  const kdfInput = new Uint8Array(
    domainBytes.length + rawShared.length + ephemeralPublic.length + recipientPublic.length
  );
  let offset = 0;
  kdfInput.set(domainBytes, offset); offset += domainBytes.length;
  kdfInput.set(rawShared, offset); offset += rawShared.length;
  kdfInput.set(ephemeralPublic, offset); offset += ephemeralPublic.length;
  kdfInput.set(recipientPublic, offset);

  const encryptionKey = nacl.hash(kdfInput).slice(0, 32);

  // Decrypt
  const decrypted = nacl.secretbox.open(ciphertext, nonce, encryptionKey);

  // Zero-fill
  rawShared.fill(0);
  encryptionKey.fill(0);
  kdfInput.fill(0);
  recipientPublic.fill(0);

  if (!decrypted) {
    throw new Error('Decryption failed');
  }

  return new TextDecoder().decode(decrypted);
}
```

## Backwards Compatibility

This ARC introduces a new messaging protocol (v2). The `voi-msg:v2:` prefix distinguishes it from any prior implementations. Implementations MAY support multiple versions by checking the note prefix.

## Test Vectors

### Key Derivation

```
Account Address: H7W63MIQJMYBOEYPM5NJEGX3P54H54RZIV2G3OQ2255AULG6U74BE5KFC4
Challenge: voi-wallet-messaging-v1:H7W63MIQJMYBOEYPM5NJEGX3P54H54RZIV2G3OQ2255AULG6U74BE5KFC4

Ed25519 Secret Key (hex): [test vector needed]
Expected Signature (hex): [test vector needed]
Expected X25519 Public Key (base64): [test vector needed]
```

### Message Encryption

```
Plaintext: "Hello, World!"
Sender Public Key (base64): [test vector needed]
Recipient Messaging Public Key (base64): [test vector needed]
Ephemeral Secret Key (hex): [test vector needed]
Nonce (base64): [test vector needed]
Expected Ciphertext (base64): [test vector needed]
```

## Copyright

This document is placed in the public domain.
