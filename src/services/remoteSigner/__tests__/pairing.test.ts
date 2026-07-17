/**
 * Unit tests for the authenticated remote-signer pairing crypto core.
 *
 * These are Layer-1 pure tests: they build REAL Ed25519 material in-process
 * (algosdk accounts + tweetnacl) and assert the SPECIFICATION-correct behaviour
 * of `buildPairingMessage` / `verifyPairing`, then tamper each field and assert
 * fail-closed rejection.
 *
 * Signing here mirrors exactly what `signPairingMessage` does
 * (`nacl.sign.detached` over `buildPairingMessage` bytes) WITHOUT the
 * secure-storage graph, so the suite stays pure while covering the same bytes
 * the signer produces.
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

import {
  buildPairingMessage,
  verifyPairing,
  assertCanonicalAddressSet,
  PAIRING_MESSAGE_DOMAIN,
} from '../pairing';
import { PAIRING_VERSION } from '@/types/remoteSigner';
import { withDefaultAuthLevel } from '@/types/wallet';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

interface TestAccount {
  addr: string;
  sk: Uint8Array; // 64-byte ed25519 secret key (nacl-compatible)
  pk: Uint8Array; // 32-byte public key
}

/** Deterministic account from a fixed 32-byte seed (reproducible addresses). */
function seededAccount(seedByte: number): TestAccount {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  return {
    addr: algosdk.encodeAddress(kp.publicKey),
    sk: kp.secretKey,
    pk: kp.publicKey,
  };
}

const DEFAULT_DEV = 'voi-signer-11111111-2222-3333-4444-555555555555';
const DEFAULT_TS = 1700000000000;

const pkHex = (addr: string): string =>
  Buffer.from(algosdk.decodeAddress(addr).publicKey).toString('hex');

/** Sign a pairing message the same way `signPairingMessage` would. */
function signPairing(
  dev: string,
  ts: number,
  setAddrs: string[],
  addr: string,
  sk: Uint8Array
): string {
  const message = buildPairingMessage({
    dev,
    ts,
    accts: setAddrs.map((a) => ({ addr: a })),
    addr,
  });
  return Buffer.from(nacl.sign.detached(message, sk)).toString('base64');
}

interface PayloadAcct {
  addr: string;
  sk: Uint8Array;
  pk?: string;
  label?: string;
}

/** Assemble a valid v2 (signed) pairing payload from the given accounts. */
function makeV2Payload(
  accts: PayloadAcct[],
  opts?: { dev?: string; ts?: number; name?: string }
): Record<string, unknown> {
  const dev = opts?.dev ?? DEFAULT_DEV;
  const ts = opts?.ts ?? DEFAULT_TS;
  const setAddrs = accts.map((a) => a.addr);
  return {
    v: PAIRING_VERSION,
    t: 'pair',
    dev,
    ts,
    ...(opts?.name !== undefined ? { name: opts.name } : {}),
    accts: accts.map((a) => ({
      addr: a.addr,
      pk: a.pk ?? pkHex(a.addr),
      sig: signPairing(dev, ts, setAddrs, a.addr, a.sk),
      ...(a.label !== undefined ? { label: a.label } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// 1. Frozen test vector — the on-wire encoding must never silently drift.
// ---------------------------------------------------------------------------

describe('buildPairingMessage — frozen vector', () => {
  // Computed once, out-of-band, from the intended layout:
  //   "voi-remote-signer-pair/v2\n" + dev + "\n" + String(ts) + "\n" + setStr + "\n" + addr
  const FROZEN_HEX =
    '766f692d72656d6f74652d7369676e65722d706169722f76320a766f692d7369676e65722d66697865642d6465760a313730303030303030303030300a414444525f4f4e452c414444525f54574f0a414444525f4f4e45';

  it('encodes the exact frozen bytes (unsorted input is canonically sorted)', () => {
    const bytes = buildPairingMessage({
      dev: 'voi-signer-fixed-dev',
      ts: 1700000000000,
      // Deliberately UNSORTED — the serializer must sort the set.
      accts: [{ addr: 'ADDR_TWO' }, { addr: 'ADDR_ONE' }],
      addr: 'ADDR_ONE',
    });
    expect(Buffer.from(bytes).toString('hex')).toBe(FROZEN_HEX);
    expect(bytes.length).toBe(87);
  });

  it('starts with the domain-separation prefix beginning with 0x76 ("v")', () => {
    expect(PAIRING_MESSAGE_DOMAIN).toBe('voi-remote-signer-pair/v2\n');
    const bytes = buildPairingMessage({
      dev: 'd',
      ts: 1,
      accts: [{ addr: 'A' }],
      addr: 'A',
    });
    expect(bytes[0]).toBe(0x76); // 'v'
    // Disjoint from Algorand tx domain: must NOT begin with "TX".
    expect(bytes[0]).not.toBe(0x54); // 'T'
  });

  it('rejects a non-integer timestamp', () => {
    expect(() =>
      buildPairingMessage({
        dev: 'd',
        ts: 1.5,
        accts: [{ addr: 'A' }],
        addr: 'A',
      })
    ).toThrow(/integer/);
    expect(() =>
      buildPairingMessage({
        dev: 'd',
        ts: NaN,
        accts: [{ addr: 'A' }],
        addr: 'A',
      })
    ).toThrow(/integer/);
  });

  it('rejects non-ASCII dev or addr', () => {
    expect(() =>
      buildPairingMessage({
        dev: 'dëv',
        ts: 1,
        accts: [{ addr: 'A' }],
        addr: 'A',
      })
    ).toThrow(/ASCII/);
    expect(() =>
      buildPairingMessage({
        dev: 'd',
        ts: 1,
        accts: [{ addr: 'A' }],
        addr: 'Å',
      })
    ).toThrow(/ASCII/);
  });

  it('does not mutate the caller-supplied accts array', () => {
    const accts = [{ addr: 'ZZZ' }, { addr: 'AAA' }];
    buildPairingMessage({ dev: 'd', ts: 1, accts, addr: 'AAA' });
    expect(accts.map((a) => a.addr)).toEqual(['ZZZ', 'AAA']);
  });
});

// ---------------------------------------------------------------------------
// 2. Domain separation — a pairing sig and a txn sig are mutually non-verifying.
// ---------------------------------------------------------------------------

describe('domain separation: pairing sig <-> algorand txn sig', () => {
  const acct = seededAccount(1);
  const setAddrs = [acct.addr];

  const pairingMessage = buildPairingMessage({
    dev: DEFAULT_DEV,
    ts: DEFAULT_TS,
    accts: setAddrs.map((a) => ({ addr: a })),
    addr: acct.addr,
  });

  // A real algosdk transaction's bytesToSign (prefixed with "TX").
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: acct.addr,
    receiver: acct.addr,
    amount: 0,
    suggestedParams: {
      fee: 1000,
      firstValid: 1,
      lastValid: 1001,
      genesisID: 'voi-test-v1',
      genesisHash: new Uint8Array(32),
      flatFee: true,
      minFee: 1000,
    } as algosdk.SuggestedParams,
  });
  const txnBytesToSign = txn.bytesToSign();

  const pairingSig = nacl.sign.detached(pairingMessage, acct.sk);
  const txnSig = nacl.sign.detached(txnBytesToSign, acct.sk);

  it('the two signed byte-strings are disjoint at the domain prefix', () => {
    // Algorand tx bytes start with "TX"; pairing bytes start with "v".
    expect(txnBytesToSign[0]).toBe(0x54); // 'T'
    expect(pairingMessage[0]).toBe(0x76); // 'v'
  });

  it('a pairing signature does NOT verify as a transaction signature', () => {
    expect(nacl.sign.detached.verify(txnBytesToSign, pairingSig, acct.pk)).toBe(
      false
    );
  });

  it('a transaction signature does NOT verify as a pairing signature', () => {
    expect(nacl.sign.detached.verify(pairingMessage, txnSig, acct.pk)).toBe(
      false
    );
  });

  it('verifyPairing REJECTS a payload whose sig is actually a txn signature', () => {
    const payload = {
      v: PAIRING_VERSION,
      t: 'pair',
      dev: DEFAULT_DEV,
      ts: DEFAULT_TS,
      accts: [
        {
          addr: acct.addr,
          pk: pkHex(acct.addr),
          sig: Buffer.from(txnSig).toString('base64'),
        },
      ],
    };
    const result = verifyPairing(payload);
    expect(result.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 3. Round-trip — a correctly-signed payload verifies.
// ---------------------------------------------------------------------------

describe('verifyPairing — round-trip accept', () => {
  it('accepts a single-account v2 payload and derives the pubkey from addr', () => {
    const a = seededAccount(1);
    const payload = makeV2Payload([{ addr: a.addr, sk: a.sk, label: 'Cold' }]);

    const result = verifyPairing(payload);
    expect(result.status).toBe('v2-verified');
    if (result.status !== 'v2-verified') return;

    expect(result.pairing.authLevel).toBe('v2-signed');
    expect(result.pairing.dev).toBe(DEFAULT_DEV);
    expect(result.pairing.ts).toBe(DEFAULT_TS);
    expect(result.pairing.accounts).toHaveLength(1);
    expect(result.pairing.accounts[0].addr).toBe(a.addr);
    expect(result.pairing.accounts[0].publicKey).toBe(pkHex(a.addr));
    expect(result.pairing.accounts[0].label).toBe('Cold');
  });

  it('accepts a multi-account v2 payload (all set-bound sigs valid)', () => {
    const accts = [seededAccount(1), seededAccount(2), seededAccount(3)];
    const payload = makeV2Payload(
      accts.map((a) => ({ addr: a.addr, sk: a.sk }))
    );

    const result = verifyPairing(payload);
    expect(result.status).toBe('v2-verified');
    if (result.status !== 'v2-verified') return;
    expect(result.pairing.accounts.map((x) => x.addr).sort()).toEqual(
      accts.map((a) => a.addr).sort()
    );
  });

  it('IGNORES the transmitted pk and always derives from addr (T3)', () => {
    const a = seededAccount(1);
    const wrong = seededAccount(9);
    // Attacker desyncs pk from addr; sig is still a valid self-sig for addr.
    const payload = makeV2Payload([
      { addr: a.addr, sk: a.sk, pk: pkHex(wrong.addr) },
    ]);

    const result = verifyPairing(payload);
    expect(result.status).toBe('v2-verified');
    if (result.status !== 'v2-verified') return;
    // Verified pubkey is DERIVED from addr, not the transmitted (wrong) pk.
    expect(result.pairing.accounts[0].publicKey).toBe(pkHex(a.addr));
    expect(result.pairing.accounts[0].publicKey).not.toBe(pkHex(wrong.addr));
  });

  it('classifies a legacy v1 (unsigned) payload as v1-unsigned', () => {
    const a = seededAccount(1);
    const payload = {
      v: 1,
      t: 'pair',
      dev: DEFAULT_DEV,
      ts: DEFAULT_TS,
      accts: [{ addr: a.addr, pk: pkHex(a.addr), label: 'Legacy' }],
    };
    const result = verifyPairing(payload);
    expect(result.status).toBe('v1-unsigned');
    if (result.status !== 'v1-unsigned') return;
    expect(result.pairing.authLevel).toBe('v1-unsigned');
    expect(result.pairing.accounts[0].publicKey).toBe(pkHex(a.addr));
  });
});

// ---------------------------------------------------------------------------
// 4. Splice — a captured single-account sig cannot be reused in a larger set.
// ---------------------------------------------------------------------------

describe('verifyPairing — splice resistance (set-binding, T4)', () => {
  it('REJECTS an attacker account spliced under a victim single-account sig', () => {
    const victim = seededAccount(1);
    const attacker = seededAccount(2);

    // 1) Victim's genuine single-account pairing (set = {victim}).
    const victimOnly = makeV2Payload([{ addr: victim.addr, sk: victim.sk }]);
    expect(verifyPairing(victimOnly).status).toBe('v2-verified');

    const victimSig = (victimOnly.accts as Record<string, unknown>[])[0]
      .sig as string;

    // 2) Attacker splices in their own account under the SAME dev/ts, keeping
    //    the captured victim sig (which was over the set {victim}), and signs
    //    their own account over the NEW set {attacker,victim}.
    const setAddrs = [victim.addr, attacker.addr];
    const spliced = {
      v: PAIRING_VERSION,
      t: 'pair',
      dev: DEFAULT_DEV,
      ts: DEFAULT_TS,
      accts: [
        { addr: victim.addr, pk: pkHex(victim.addr), sig: victimSig },
        {
          addr: attacker.addr,
          pk: pkHex(attacker.addr),
          sig: signPairing(
            DEFAULT_DEV,
            DEFAULT_TS,
            setAddrs,
            attacker.addr,
            attacker.sk
          ),
        },
      ],
    };

    // The victim sig was bound to {victim}; recomputed setStr is {attacker,victim}
    // → victim sig no longer verifies → whole pairing rejected.
    const result = verifyPairing(spliced);
    expect(result.status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 5. All-or-nothing & mixed v1/v2.
// ---------------------------------------------------------------------------

describe('verifyPairing — all-or-nothing & mixed-version', () => {
  it('REJECTS if any single account signature is invalid', () => {
    const a = seededAccount(1);
    const b = seededAccount(2);
    const payload = makeV2Payload([
      { addr: a.addr, sk: a.sk },
      { addr: b.addr, sk: b.sk },
    ]);
    // Corrupt b's signature (still 64 bytes, but wrong).
    (payload.accts as Record<string, unknown>[])[1].sig = Buffer.from(
      new Uint8Array(64).fill(7)
    ).toString('base64');

    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('REJECTS a mixed payload: v2 with one account missing a sig', () => {
    const a = seededAccount(1);
    const b = seededAccount(2);
    const payload = makeV2Payload([
      { addr: a.addr, sk: a.sk },
      { addr: b.addr, sk: b.sk },
    ]);
    delete (payload.accts as Record<string, unknown>[])[1].sig;

    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('REJECTS a v1 payload that smuggles a signature', () => {
    const a = seededAccount(1);
    const payload = {
      v: 1,
      t: 'pair',
      dev: DEFAULT_DEV,
      ts: DEFAULT_TS,
      accts: [
        {
          addr: a.addr,
          pk: pkHex(a.addr),
          sig: signPairing(DEFAULT_DEV, DEFAULT_TS, [a.addr], a.addr, a.sk),
        },
      ],
    };
    expect(verifyPairing(payload).status).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
// 6. Hard input validation.
// ---------------------------------------------------------------------------

describe('verifyPairing — hard input validation', () => {
  const a = seededAccount(1);

  it('REJECTS non-plain-object payloads', () => {
    expect(verifyPairing(null).status).toBe('rejected');
    expect(verifyPairing(undefined).status).toBe('rejected');
    expect(verifyPairing('str').status).toBe('rejected');
    expect(verifyPairing(42).status).toBe('rejected');
    expect(verifyPairing([]).status).toBe('rejected');
    expect(verifyPairing([{ t: 'pair' }]).status).toBe('rejected');
  });

  it('REJECTS the wrong type discriminator', () => {
    const payload = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    payload.t = 'req';
    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('REJECTS an unsupported pairing version', () => {
    const payload = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    payload.v = 3;
    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('REJECTS empty / oversized account arrays', () => {
    const empty = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    empty.accts = [];
    expect(verifyPairing(empty).status).toBe('rejected');

    const huge = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    huge.accts = new Array(101).fill((huge.accts as unknown[])[0]);
    expect(verifyPairing(huge).status).toBe('rejected');
  });

  it('REJECTS a duplicate address', () => {
    const dup = seededAccount(5);
    // Two entries for the same address (both correctly signed over the set).
    const setAddrs = [dup.addr, dup.addr];
    const payload = {
      v: PAIRING_VERSION,
      t: 'pair',
      dev: DEFAULT_DEV,
      ts: DEFAULT_TS,
      accts: [
        {
          addr: dup.addr,
          pk: pkHex(dup.addr),
          sig: signPairing(DEFAULT_DEV, DEFAULT_TS, setAddrs, dup.addr, dup.sk),
        },
        {
          addr: dup.addr,
          pk: pkHex(dup.addr),
          sig: signPairing(DEFAULT_DEV, DEFAULT_TS, setAddrs, dup.addr, dup.sk),
        },
      ],
    };
    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('REJECTS a non-canonical / checksum-invalid address', () => {
    const payload = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    // Lowercased address is non-canonical.
    (payload.accts as Record<string, unknown>[])[0].addr = a.addr.toLowerCase();
    expect(verifyPairing(payload).status).toBe('rejected');

    const bad = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    (bad.accts as Record<string, unknown>[])[0].addr = 'NOT_AN_ADDRESS';
    expect(verifyPairing(bad).status).toBe('rejected');
  });

  it('REJECTS a signature that does not decode to exactly 64 bytes', () => {
    const short = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    (short.accts as Record<string, unknown>[])[0].sig = Buffer.from(
      new Uint8Array(63).fill(1)
    ).toString('base64');
    expect(verifyPairing(short).status).toBe('rejected');

    const long = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    (long.accts as Record<string, unknown>[])[0].sig = Buffer.from(
      new Uint8Array(65).fill(1)
    ).toString('base64');
    expect(verifyPairing(long).status).toBe('rejected');

    const notB64 = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    (notB64.accts as Record<string, unknown>[])[0].sig = 'not*valid*base64';
    expect(verifyPairing(notB64).status).toBe('rejected');
  });

  it('REJECTS an oversized sig string BEFORE base64-decoding (allocation bound)', () => {
    // The per-account sig length is bounded to the canonical 88 chars before
    // any Buffer.from(...,'base64'), so a hostile QR cannot force a large alloc.
    const huge = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    (huge.accts as Record<string, unknown>[])[0].sig = 'A'.repeat(100000);
    expect(verifyPairing(huge).status).toBe('rejected');
  });

  it('REJECTS a tampered signed field (ts changed after signing)', () => {
    const payload = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    // ts is inside the signed message → changing it invalidates every sig.
    payload.ts = DEFAULT_TS + 1;
    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('REJECTS a tampered signed field (dev changed after signing)', () => {
    const payload = makeV2Payload([{ addr: a.addr, sk: a.sk }]);
    payload.dev = 'voi-signer-other';
    expect(verifyPairing(payload).status).toBe('rejected');
  });

  it('ACCEPTS when only the cosmetic label (outside the message) changes', () => {
    const payload = makeV2Payload([
      { addr: a.addr, sk: a.sk, label: 'Original' },
    ]);
    // Label is NOT part of the signed message, so editing it must not break.
    (payload.accts as Record<string, unknown>[])[0].label = 'Renamed';
    const result = verifyPairing(payload);
    expect(result.status).toBe('v2-verified');
    if (result.status !== 'v2-verified') return;
    expect(result.pairing.accounts[0].label).toBe('Renamed');
  });

  it('REJECTS an over-long device name / label', () => {
    const longName = makeV2Payload([{ addr: a.addr, sk: a.sk }], {
      name: 'x'.repeat(200),
    });
    expect(verifyPairing(longName).status).toBe('rejected');

    const longLabel = makeV2Payload([
      { addr: a.addr, sk: a.sk, label: 'y'.repeat(200) },
    ]);
    expect(verifyPairing(longLabel).status).toBe('rejected');
  });

  it('does NOT hard-reject on a stale (old) timestamp', () => {
    // Freshness is advisory (DR-5): an old ts must still verify if signed.
    const a2 = seededAccount(1);
    const payload = makeV2Payload([{ addr: a2.addr, sk: a2.sk }], {
      ts: 1000000000000, // ~2001, very old
    });
    expect(verifyPairing(payload).status).toBe('v2-verified');
  });
});

// ---------------------------------------------------------------------------
// 7. authLevel legacy default.
// ---------------------------------------------------------------------------

describe('withDefaultAuthLevel — conservative legacy default', () => {
  it('defaults a missing level to v1-unsigned', () => {
    expect(withDefaultAuthLevel(undefined)).toBe('v1-unsigned');
  });

  it('preserves an explicit level', () => {
    expect(withDefaultAuthLevel('v1-unsigned')).toBe('v1-unsigned');
    expect(withDefaultAuthLevel('v2-signed')).toBe('v2-signed');
  });
});

// ---------------------------------------------------------------------------
// 8. assertCanonicalAddressSet — the signer must only sign a canonical set.
// ---------------------------------------------------------------------------

describe('assertCanonicalAddressSet — signer-side set guard', () => {
  it('accepts a canonical, de-duplicated set', () => {
    const a0 = seededAccount(7);
    const a1 = seededAccount(8);
    expect(() => assertCanonicalAddressSet([a0.addr, a1.addr])).not.toThrow();
  });

  it('throws on a non-canonical / checksum-invalid address', () => {
    expect(() => assertCanonicalAddressSet(['NOT-AN-ADDRESS'])).toThrow();
  });

  it('throws on a duplicate address', () => {
    const a0 = seededAccount(7);
    expect(() => assertCanonicalAddressSet([a0.addr, a0.addr])).toThrow(
      /duplicate/i
    );
  });

  it('throws on a non-ASCII address', () => {
    expect(() => assertCanonicalAddressSet(['évil'])).toThrow();
  });
});
