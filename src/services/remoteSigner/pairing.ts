/**
 * Authenticated remote-signer pairing — pure crypto core (v2).
 *
 * This module is intentionally dependency-light (algosdk + the pure Ed25519
 * verifier only) so it can be unit-tested as a Layer-1 utility without pulling
 * in the secure-storage / wallet service graph. The key-touching helpers
 * (`signPairingMessage`, `createSignedPairingPayload`) live in `./index` and
 * import `buildPairingMessage` from here.
 *
 * A v2 pairing proves the signer device controls each exported account by
 * attaching a per-account Ed25519 self-signature over a DOMAIN-SEPARATED,
 * SET-BINDING message. The wallet re-derives every verification key from the
 * address (never from the transmitted `pk`) and requires ALL accounts to
 * verify, or the whole pairing is rejected (all-or-nothing). See DR-1..DR-8.
 */

import algosdk from 'algosdk';
import { verifyEd25519Signature } from '@/utils/signatureVerification';
import { PAIRING_VERSION, PAIRING_LIMITS } from '@/types/remoteSigner';
import type { RemoteSignerAuthLevel } from '@/types/wallet';

/**
 * Domain-separation prefix for the pairing message.
 *
 * Begins with 0x76 ('v') and is disjoint from every Algorand signing domain
 * ("TX"/"MX"/"Program"/"ProgData") and from the messaging challenge
 * ("voi-wallet-messaging-v1:", which diverges by byte 4). A pairing signature
 * therefore can NEVER be replayed as a transaction/logicsig/auth signature and
 * vice-versa. The trailing "\n" is part of the domain — do NOT change these
 * bytes (a frozen test vector guards them).
 */
export const PAIRING_MESSAGE_DOMAIN = 'voi-remote-signer-pair/v2\n';

/** Parameters for {@link buildPairingMessage}. */
export interface BuildPairingMessageParams {
  /** Signer device id (authenticated inside the message). */
  dev: string;
  /** Unix timestamp in ms (must be an integer). */
  ts: number;
  /**
   * The FULL set of accounts in the pairing. Only `.addr` is consumed; the
   * canonical sorted address set binds every signature to the whole pairing
   * (defeats splice attacks — T4).
   */
  accts: { addr: string }[];
  /** The specific account address this message is signed by. */
  addr: string;
}

/** True iff every code unit of `s` is a 7-bit ASCII character. */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Build the exact bytes signed/verified for a pairing account.
 *
 * SINGLE shared serializer used by BOTH the signer (sign) and the wallet
 * (verify) — there is intentionally only one place these bytes are produced.
 *
 * Layout (utf-8):
 *   "voi-remote-signer-pair/v2\n" + dev + "\n" + String(ts) + "\n" + setStr + "\n" + addr
 * where setStr = accts.map(a => a.addr).sort().join(",") (canonical sorted SET).
 *
 * @throws if `ts` is not an integer, or `dev`/`addr` contain non-ASCII.
 */
export function buildPairingMessage(
  params: BuildPairingMessageParams
): Uint8Array {
  const { dev, ts, accts, addr } = params;

  if (!Number.isInteger(ts)) {
    throw new Error('buildPairingMessage: ts must be an integer');
  }
  if (!isAscii(dev)) {
    throw new Error('buildPairingMessage: dev must be ASCII');
  }
  if (!isAscii(addr)) {
    throw new Error('buildPairingMessage: addr must be ASCII');
  }

  // `map` yields a fresh array, so sorting it does not mutate the caller's accts.
  const setStr = accts
    .map((a) => a.addr)
    .sort()
    .join(',');

  const message =
    PAIRING_MESSAGE_DOMAIN +
    dev +
    '\n' +
    String(ts) +
    '\n' +
    setStr +
    '\n' +
    addr;

  return new TextEncoder().encode(message);
}

/** A pairing account after verification — pubkey DERIVED from addr, never trusted from the wire. */
export interface VerifiedPairingAccount {
  /** Canonical Algorand address. */
  addr: string;
  /** Hex-encoded public key DERIVED from `addr` (never the transmitted `pk`). */
  publicKey: string;
  /** Cosmetic, UNVERIFIED label (outside the signed message). */
  label?: string;
}

/** The trusted, sanitized result of a successful {@link verifyPairing}. */
export interface VerifiedPairing {
  /** Signer device id (authenticated in v2). */
  dev: string;
  /** Cosmetic, UNVERIFIED device name. */
  name?: string;
  /** Unix timestamp in ms (advisory freshness — NOT hard-rejected on staleness). */
  ts: number;
  /** Authentication level of the whole pairing. */
  authLevel: RemoteSignerAuthLevel;
  /** Accounts with pubkeys derived from their addresses. */
  accounts: VerifiedPairingAccount[];
}

/** Discriminated result of {@link verifyPairing}. */
export type PairingVerificationResult =
  | { status: 'v2-verified'; pairing: VerifiedPairing }
  | { status: 'v1-unsigned'; pairing: VerifiedPairing }
  | { status: 'rejected'; reason: string };

/** True for a plain (Object.prototype / null-proto) object — rejects arrays & class instances. */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (typeof x !== 'object' || x === null) return false;
  if (Array.isArray(x)) return false;
  const proto = Object.getPrototypeOf(x);
  return proto === Object.prototype || proto === null;
}

/**
 * Strictly decode a base64 string, rejecting non-canonical encodings.
 * Returns null if the input is not canonical base64 (round-trip re-encode must match).
 */
function decodeStrictBase64(s: string): Uint8Array | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const buf = Buffer.from(s, 'base64');
    // Re-encode and compare to reject sloppy/non-canonical base64 (extra bits,
    // wrong padding, embedded whitespace, etc.).
    if (Buffer.from(buf).toString('base64') !== s) return null;
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** The canonical form of an address, or null if it is not a valid Algorand address. */
function canonicalAddress(addr: string): string | null {
  try {
    return algosdk.encodeAddress(algosdk.decodeAddress(addr).publicKey);
  } catch {
    return null;
  }
}

/**
 * Assert that a set of addresses is canonical and de-duplicated BEFORE it is
 * signed. `buildPairingMessage` binds the set by joining addresses with ",",
 * which is only collision-free when every address is a canonical Algorand
 * address (base32, never contains ",") and there are no duplicates. Algorand
 * addresses always satisfy this, but the signer validates defensively so the
 * set-binding guarantee holds for every producer of a pairing signature — it
 * mirrors the checks {@link verifyPairing} runs on the wire.
 *
 * @throws if any address is non-canonical / checksum-invalid, or duplicated.
 */
export function assertCanonicalAddressSet(addresses: string[]): void {
  const seen = new Set<string>();
  for (const addr of addresses) {
    if (typeof addr !== 'string' || !isAscii(addr)) {
      throw new Error('assertCanonicalAddressSet: address is not ASCII');
    }
    const canonical = canonicalAddress(addr);
    if (canonical === null || canonical !== addr) {
      throw new Error(
        'assertCanonicalAddressSet: address is not canonical / checksum-invalid'
      );
    }
    if (seen.has(addr)) {
      throw new Error('assertCanonicalAddressSet: duplicate address');
    }
    seen.add(addr);
  }
}

/**
 * Verify a scanned pairing payload — ALL-OR-NOTHING, set-bound, fail-closed.
 *
 * Hard input validation runs FIRST (never trust the wire). Then, for a v2
 * (signed) payload, EVERY account's set-binding self-signature must verify
 * against the pubkey DERIVED FROM ITS ADDRESS (the transmitted `pk` is ignored),
 * or the whole pairing is rejected. Legacy v1 (no signatures) is returned as
 * `v1-unsigned` for the caller to gate behind an explicit confirmation.
 *
 * Version/signature consistency:
 *   - v === PAIRING_VERSION (2): every account MUST carry a valid 64-byte sig.
 *   - v === 1: NO account may carry a sig (a v1 payload with any sig is rejected).
 *   - a mixed payload (some signed, some not) is rejected under either version.
 *
 * `ts` staleness is NOT a hard reject (freshness is advisory — a later screen
 * may warn).
 *
 * @param payload untrusted, freshly-parsed QR data
 */
export function verifyPairing(payload: unknown): PairingVerificationResult {
  const reject = (reason: string): PairingVerificationResult => ({
    status: 'rejected',
    reason,
  });

  try {
    // --- 1. Envelope shape -------------------------------------------------
    if (!isPlainObject(payload)) return reject('Payload is not a plain object');
    const p = payload;

    if (p.t !== 'pair') return reject('Payload type is not "pair"');

    const v = p.v;
    if (v !== 1 && v !== PAIRING_VERSION) {
      return reject(`Unsupported pairing version: ${String(v)}`);
    }

    if (
      typeof p.dev !== 'string' ||
      p.dev.length === 0 ||
      p.dev.length > PAIRING_LIMITS.MAX_DEVICE_ID_LENGTH
    ) {
      return reject('Invalid device id');
    }
    if (!isAscii(p.dev)) return reject('Device id contains non-ASCII');

    if (
      p.name !== undefined &&
      (typeof p.name !== 'string' ||
        p.name.length > PAIRING_LIMITS.MAX_NAME_LENGTH)
    ) {
      return reject('Invalid device name');
    }

    if (typeof p.ts !== 'number' || !Number.isInteger(p.ts)) {
      return reject('Invalid timestamp');
    }

    if (!Array.isArray(p.accts) || p.accts.length === 0) {
      return reject('No accounts in pairing');
    }
    if (p.accts.length > PAIRING_LIMITS.MAX_ACCOUNTS) {
      return reject('Too many accounts in pairing');
    }

    // --- 2. Per-account shape, canonical addr, dedupe, sig-presence --------
    const addrs: string[] = [];
    const seen = new Set<string>();
    let sigCount = 0;

    for (const raw of p.accts) {
      if (!isPlainObject(raw)) return reject('Account is not a plain object');

      if (typeof raw.addr !== 'string')
        return reject('Account addr is not a string');
      if (!isAscii(raw.addr)) return reject('Account addr contains non-ASCII');

      const canonical = canonicalAddress(raw.addr);
      if (canonical === null || canonical !== raw.addr) {
        return reject('Account addr is not canonical / checksum-invalid');
      }
      if (seen.has(raw.addr)) return reject('Duplicate account addr');
      seen.add(raw.addr);
      addrs.push(raw.addr);

      if (
        raw.label !== undefined &&
        (typeof raw.label !== 'string' ||
          raw.label.length > PAIRING_LIMITS.MAX_LABEL_LENGTH)
      ) {
        return reject('Invalid account label');
      }

      if (raw.sig !== undefined) {
        if (typeof raw.sig !== 'string')
          return reject('Account sig is not a string');
        // Bound the string length BEFORE base64-decoding (step 4) so a hostile
        // payload cannot force an unbounded allocation ahead of the 64-byte check.
        if (raw.sig.length !== PAIRING_LIMITS.SIGNATURE_B64_LENGTH)
          return reject('Account sig has invalid length');
        sigCount++;
      }
    }

    // --- 3. Version / signature consistency (reject mixed v1/v2) -----------
    if (v === PAIRING_VERSION) {
      if (sigCount !== p.accts.length) {
        return reject('v2 pairing has account(s) missing a signature');
      }
    } else {
      // v === 1 (legacy, unsigned)
      if (sigCount !== 0) {
        return reject('v1 pairing must not carry signatures');
      }
      return {
        status: 'v1-unsigned',
        pairing: buildVerifiedPairing(p, addrs, 'v1-unsigned'),
      };
    }

    // --- 4. Verify every set-bound signature (all-or-nothing) -------------
    const setAccts = addrs.map((addr) => ({ addr }));
    for (const raw of p.accts as Record<string, unknown>[]) {
      const addr = raw.addr as string;
      const sigBytes = decodeStrictBase64(raw.sig as string);
      if (!sigBytes || sigBytes.length !== PAIRING_LIMITS.SIGNATURE_BYTES) {
        return reject('Account signature is not exactly 64 bytes');
      }
      const message = buildPairingMessage({
        dev: p.dev,
        ts: p.ts,
        accts: setAccts,
        addr,
      });
      // Derive the verification key from the ADDRESS — never trust `pk`.
      const pub = algosdk.decodeAddress(addr).publicKey;
      if (!verifyEd25519Signature(message, sigBytes, pub)) {
        return reject('Account signature failed verification');
      }
    }

    return {
      status: 'v2-verified',
      pairing: buildVerifiedPairing(p, addrs, 'v2-signed'),
    };
  } catch (error) {
    // Fail closed on any unexpected error.
    const message = error instanceof Error ? error.message : 'unknown error';
    return reject(`Pairing verification error: ${message}`);
  }
}

/** Build the sanitized VerifiedPairing (pubkeys DERIVED from addresses). */
function buildVerifiedPairing(
  p: Record<string, unknown>,
  addrs: string[],
  authLevel: RemoteSignerAuthLevel
): VerifiedPairing {
  const rawAccts = p.accts as Record<string, unknown>[];
  const accounts: VerifiedPairingAccount[] = addrs.map((addr, i) => {
    const label = rawAccts[i].label;
    return {
      addr,
      publicKey: Buffer.from(algosdk.decodeAddress(addr).publicKey).toString(
        'hex'
      ),
      label: typeof label === 'string' ? label : undefined,
    };
  });

  return {
    dev: p.dev as string,
    name: typeof p.name === 'string' ? p.name : undefined,
    ts: p.ts as number,
    authLevel,
    accounts,
  };
}
