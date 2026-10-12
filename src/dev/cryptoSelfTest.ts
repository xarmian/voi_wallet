/**
 * Dev-only Hermes crypto parity self-test (FR-374 / PLAN-375 DR-18).
 *
 * WHY: jest runs the crypto vectors under Node, but the app runs on Hermes V1
 * (RN 0.88). A Hermes-specific BigInt, TypedArray, TextEncoder or msgpack
 * regression would otherwise surface only in the device walk. Each vector below
 * runs the real code paths (algosdk, tweetnacl, @noble, bc-ur, the production
 * remote-signer verifier), reduces the output to a sha256 digest and compares it
 * with EXPECTED_DIGESTS. Those digests were produced by the jest run under Node
 * (src/dev/__tests__/cryptoSelfTest.test.ts) and committed, so a PASS on a
 * device means Hermes and Node produced byte-identical output.
 *
 * SAFETY:
 *  - Every key comes from a FIXED PUBLIC seed (`new Uint8Array(32).fill(n)`),
 *    the pattern in src/utils/__tests__/remoteSignerResponseVerification.test.ts.
 *    No user key, mnemonic, SecureStore or src/services/secure code is touched.
 *  - Only `PASS <vector>` / `FAIL <vector>` lines are logged; no output bytes,
 *    digests or error messages are logged.
 *  - Runs only when `__DEV__ && process.env.EXPO_PUBLIC_CRYPTO_SELFTEST === '1'`
 *    (call site: App.tsx), and metro.devOnlyResolver.js replaces this whole
 *    module with an empty one in every dev=false (release) bundle.
 *
 * The marker string below is unique to this module. The DR-18 release check
 * greps exported release bundles for it and requires zero hits.
 */
import algosdk from 'algosdk';
import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { scryptAsync } from '@noble/hashes/scrypt';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { verifyRemoteSignerResponse } from '@/utils/signatureVerification';
import { AnimatedQRService } from '@/services/remoteSigner/animatedQR';

export const CRYPTO_SELFTEST_MARKER = 'VOI_DR18_CRYPTO_SELFTEST';

/**
 * Copies of the production KDF parity KATs (scryptKdf.ts SCRYPT_PARITY_KAT,
 * pbkdf2Kdf.ts PBKDF2_PARITY_KAT). They are copied rather than imported so this
 * module never loads src/services/secure code; the jest test asserts the
 * copies still equal the originals.
 */
export const SCRYPT_KAT = {
  pw: 'voi-scrypt-parity-vector/v1',
  salt: 'voi-parity-salt-0123456789abcdef',
  params: { N: 1024, r: 8, p: 1, dkLen: 32 },
  expectedHex:
    '5679f6ba7791ebc92b0c092b6cf7e632de318fa3a0250dd8753a275bdc6cc6af',
} as const;

export const PBKDF2_KAT = {
  pw: 'voi-pbkdf2-parity-vector/v1',
  saltHex: '0123456789abcdef0123456789abcdef',
  iterations: 1000,
  dkLen: 32,
  expectedHex:
    '20457c536326859d20ce06a6422ecd283dab810e502acc2fd3abd689c916be66',
} as const;

export const VECTOR_NAMES = [
  'seed-address-mnemonic',
  'sign-payment',
  'msgpack-roundtrip',
  'remote-signer-verify',
  'animated-qr-roundtrip',
  'scrypt-kat',
  'pbkdf2-kat',
  'get-random-values-shape',
  'buffer-atob-url',
] as const;

export type VectorName = (typeof VECTOR_NAMES)[number];

/** sha256 digests of each vector's output, produced by jest under Node. */
export const EXPECTED_DIGESTS: Readonly<Record<VectorName, string>> = {
  'seed-address-mnemonic':
    '82bdb8fa4e576c50749f20832b33a78beb8a17cba012afeafbd72a3a9dad828f',
  'sign-payment':
    '4c40507206244ababc26938aee72de66da48f0e75d181a0ed52aa9c77811d50b',
  'msgpack-roundtrip':
    '0c96d094070a73bbea5d47d05882b72e7879379fb80828285c52e750c8cfae29',
  'remote-signer-verify':
    'bacff98749c542a07a9ef2d4fe06e241f4c2fa4cadde9747c1a364ec8d158a65',
  'animated-qr-roundtrip':
    'b6b46eb89cf8eae0491fc1f9b192fa4043d0f3272937d9c3ea176bfa884ef414',
  'scrypt-kat':
    '9366ae175cbc5161900e61fe03e5e29e17c61a2e31d24a98e36757de3e971ab1',
  'pbkdf2-kat':
    'dad014c202658f6f4482c8c395c84af33c2341c3bdccd99c6c47ce7beb6e951a',
  'get-random-values-shape':
    'a72aff5859833c35aaba6a1c6bbdbc70a1b47b2db2ef31e36fd3339b293e27a4',
  'buffer-atob-url':
    'fa82d501ad39de7ec652961d82cddad50e04ee93de1150075ab3a5440b429afa',
};

// ---------------------------------------------------------------------------
// Fixed public fixtures
// ---------------------------------------------------------------------------

interface SeededAccount {
  addr: string;
  sk: Uint8Array;
}

function seededAccount(seedByte: number): SeededAccount {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  return { addr: algosdk.encodeAddress(kp.publicKey), sk: kp.secretKey };
}

const GENESIS_HASH = new Uint8Array(32).fill(42);
// Above 2^53, so the msgpack and signing paths must carry a real BigInt.
const PAYMENT_AMOUNT = BigInt('9007199254740993');

function suggestedParams(): algosdk.SuggestedParams {
  return {
    fee: 1000,
    minFee: 1000,
    firstValid: 1000,
    lastValid: 2000,
    genesisID: 'voi-test-v1',
    genesisHash: GENESIS_HASH,
    flatFee: true,
  };
}

function payment(
  sender: string,
  receiver: string,
  amount: bigint
): algosdk.Transaction {
  return algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender,
    receiver,
    amount,
    note: utf8ToBytes('dr-18 self-test'),
    suggestedParams: suggestedParams(),
  });
}

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function check(condition: boolean): void {
  if (!condition) {
    throw new Error('self-test invariant failed');
  }
}

// ---------------------------------------------------------------------------
// Vectors: each returns the bytes or text whose sha256 is compared
// ---------------------------------------------------------------------------

function seedAddressMnemonic(): string {
  const a = seededAccount(1);
  const mnemonic = algosdk.secretKeyToMnemonic(a.sk);
  const restored = algosdk.mnemonicToSecretKey(mnemonic);
  check(restored.addr.toString() === a.addr);
  check(bytesEqual(restored.sk, a.sk));
  return `${a.addr}|${mnemonic}|${bytesToHex(restored.sk)}`;
}

function signPayment(): string {
  const a = seededAccount(1);
  const b = seededAccount(8);
  const signed = algosdk.signTransaction(
    payment(a.addr, b.addr, PAYMENT_AMOUNT),
    a.sk
  );
  return `${signed.txID}|${bytesToHex(signed.blob)}`;
}

function msgpackRoundtrip(): string {
  const a = seededAccount(1);
  const b = seededAccount(8);
  const txn = payment(a.addr, b.addr, PAYMENT_AMOUNT);

  const unsigned = algosdk.encodeUnsignedTransaction(txn);
  const decoded = algosdk.decodeUnsignedTransaction(unsigned);
  check(decoded.payment?.amount === PAYMENT_AMOUNT);
  check(decoded.txID() === txn.txID());
  const reencoded = algosdk.encodeUnsignedTransaction(decoded);
  check(bytesEqual(reencoded, unsigned));

  const blob = txn.signTxn(a.sk);
  const stxn = algosdk.decodeSignedTransaction(blob);
  check(stxn.txn.payment?.amount === PAYMENT_AMOUNT);
  const reblob = algosdk.encodeMsgpack(stxn);
  check(bytesEqual(reblob, blob));

  return `${bytesToHex(unsigned)}|${bytesToHex(reblob)}`;
}

async function remoteSignerVerify(): Promise<string> {
  const x = seededAccount(1); // paired remote signer
  const y = seededAccount(8); // receiver
  const w = seededAccount(9); // wrong key
  const requested = payment(x.addr, y.addr, BigInt(1000));
  const substituted = payment(x.addr, y.addr, BigInt(999999));

  const request = {
    txns: [
      {
        i: 0,
        b: b64(algosdk.encodeUnsignedTransaction(requested)),
        s: requested.sender.toString(),
      },
    ],
  };
  const respond = (blob: Uint8Array) => ({
    ok: true as const,
    sigs: [{ i: 0, b: b64(blob) }],
  });
  const deps = {
    resolveExpectedSigner: (sender: string) => sender,
    isPairedRemoteSigner: (address: string) => address === x.addr,
  };

  const valid = await verifyRemoteSignerResponse(
    request,
    respond(requested.signTxn(x.sk)),
    deps
  );
  const contentMismatch = await verifyRemoteSignerResponse(
    request,
    respond(substituted.signTxn(x.sk)),
    deps
  );
  const wrongKey = await verifyRemoteSignerResponse(
    request,
    respond(requested.signTxn(w.sk)),
    deps
  );
  check(valid.valid && !contentMismatch.valid && !wrongKey.valid);
  return `${valid.valid}|${contentMismatch.valid}|${wrongKey.valid}`;
}

function animatedQrRoundtrip(): string {
  const a = seededAccount(1);
  const b = seededAccount(8);
  const unsigned = algosdk.encodeUnsignedTransaction(
    payment(a.addr, b.addr, PAYMENT_AMOUNT)
  );
  // Padded past SINGLE_QR_MAX_BYTES so the multi-frame fountain path runs.
  const payload = JSON.stringify({
    v: 1,
    txn: b64(unsigned),
    pad: 'dr-18'.repeat(300),
  });

  const encoded = AnimatedQRService.encode(payload);
  check(encoded.isAnimated && encoded.frames.length > 1);

  const decoder = AnimatedQRService.createDecoder();
  let data: string | undefined;
  for (const frame of encoded.frames) {
    const state = AnimatedQRService.processFrame(decoder, frame);
    if (state.isComplete) {
      check(state.isSuccess);
      data = state.data;
      break;
    }
  }
  check(data === payload);
  return `${encoded.frames.join('\n')}|${data}`;
}

async function scryptKat(): Promise<string> {
  const out = await scryptAsync(
    utf8ToBytes(SCRYPT_KAT.pw),
    utf8ToBytes(SCRYPT_KAT.salt),
    { ...SCRYPT_KAT.params, maxmem: 256 * 1024 * 1024 }
  );
  const hex = bytesToHex(out);
  check(hex === SCRYPT_KAT.expectedHex);
  return hex;
}

async function pbkdf2Kat(): Promise<string> {
  const out = await pbkdf2Async(
    sha256,
    utf8ToBytes(PBKDF2_KAT.pw),
    hexToBytes(PBKDF2_KAT.saltHex),
    { c: PBKDF2_KAT.iterations, dkLen: PBKDF2_KAT.dkLen }
  );
  const hex = bytesToHex(out);
  check(hex === PBKDF2_KAT.expectedHex);
  return hex;
}

/** Random output can't be hashed, so this reduces the API's SHAPE to text. */
function getRandomValuesShape(): string {
  const parts: string[] = [];
  const typed: [
    string,
    (
      | Uint8Array<ArrayBuffer>
      | Uint16Array<ArrayBuffer>
      | Uint32Array<ArrayBuffer>
      | Int32Array<ArrayBuffer>
    ),
  ][] = [
    ['Uint8Array', new Uint8Array(32)],
    ['Uint16Array', new Uint16Array(16)],
    ['Uint32Array', new Uint32Array(8)],
    ['Int32Array', new Int32Array(8)],
  ];
  for (const [name, arr] of typed) {
    const returned = globalThis.crypto.getRandomValues(arr);
    parts.push(
      `${name}:${arr.length}:${returned === arr}:${arr.some((v) => v !== 0)}`
    );
  }
  const first = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const second = globalThis.crypto.getRandomValues(new Uint8Array(32));
  parts.push(`distinct:${!bytesEqual(first, second)}`);
  return parts.join('|');
}

function bufferAtobUrl(): string {
  const all = new Uint8Array(256);
  for (let i = 0; i < all.length; i++) all[i] = i;

  const buf = Buffer.from(all);
  const asB64 = buf.toString('base64');
  const asHex = buf.toString('hex');
  check(bytesEqual(new Uint8Array(Buffer.from(asB64, 'base64')), all));
  check(bytesEqual(new Uint8Array(Buffer.from(asHex, 'hex')), all));

  const binary = String.fromCharCode(...Array.from(all));
  const viaBtoa = btoa(binary);
  check(viaBtoa === asB64);
  check(atob(viaBtoa) === binary);

  const url = new URL(
    'https://user@example.com:8443/a/b%20c/?amount=1000&note=dr%2D18%20x#frag'
  );
  url.searchParams.append('label', 'voi & co');
  const fields = [
    url.protocol,
    url.username,
    url.hostname,
    url.port,
    url.pathname,
    url.searchParams.get('note'),
    url.hash,
    url.toString(),
  ];
  return `${asB64}|${asHex}|${fields.join('|')}`;
}

const VECTORS: Record<VectorName, () => string | Promise<string>> = {
  'seed-address-mnemonic': seedAddressMnemonic,
  'sign-payment': signPayment,
  'msgpack-roundtrip': msgpackRoundtrip,
  'remote-signer-verify': remoteSignerVerify,
  'animated-qr-roundtrip': animatedQrRoundtrip,
  'scrypt-kat': scryptKat,
  'pbkdf2-kat': pbkdf2Kat,
  'get-random-values-shape': getRandomValuesShape,
  'buffer-atob-url': bufferAtobUrl,
};

/**
 * Runs one vector and returns the sha256 hex of its output, or null if it threw
 * (an invariant failed). The output itself never leaves this function.
 */
export async function computeVectorDigest(
  name: VectorName
): Promise<string | null> {
  try {
    const output = await VECTORS[name]();
    return bytesToHex(sha256(utf8ToBytes(output)));
  } catch {
    return null;
  }
}

export interface CryptoSelfTestOptions {
  log?: (line: string) => void;
  expected?: Readonly<Record<VectorName, string>>;
}

export interface CryptoSelfTestResult {
  passed: VectorName[];
  failed: VectorName[];
}

/**
 * Runs every vector and logs one `PASS <name>` / `FAIL <name>` line each, then
 * `PASS all` or `FAIL all`. Never rejects.
 */
export async function runCryptoSelfTest(
  options: CryptoSelfTestOptions = {}
): Promise<CryptoSelfTestResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const expected = options.expected ?? EXPECTED_DIGESTS;
  const result: CryptoSelfTestResult = { passed: [], failed: [] };

  for (const name of VECTOR_NAMES) {
    const digest = await computeVectorDigest(name);
    const ok = digest !== null && digest === expected[name];
    (ok ? result.passed : result.failed).push(name);
    log(`[${CRYPTO_SELFTEST_MARKER}] ${ok ? 'PASS' : 'FAIL'} ${name}`);
  }
  log(
    `[${CRYPTO_SELFTEST_MARKER}] ${result.failed.length === 0 ? 'PASS' : 'FAIL'} all`
  );
  return result;
}
