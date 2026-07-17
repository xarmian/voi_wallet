/**
 * Unit tests for the verify-result → wallet-import mapping.
 *
 * The security-critical invariants exercised here:
 *   - the import request's `publicKey` is the DERIVED pubkey from the verified
 *     pairing (never a wire `pk`), and
 *   - the request's `authLevel` faithfully carries the verified level so a v1
 *     (unauthenticated) pairing is persisted as such and a v2 (verified) pairing
 *     records that it proved control.
 */

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

import { mapVerifiedPairingToImportRequests } from '../pairingImport';
import type { VerifiedPairing } from '../pairing';
import { AccountType } from '@/types/wallet';

/** Deterministic canonical address + derived hex pubkey from a fixed seed. */
function seeded(seedByte: number): { addr: string; pkHex: string } {
  const seed = new Uint8Array(32).fill(seedByte);
  const kp = nacl.sign.keyPair.fromSeed(seed);
  const addr = algosdk.encodeAddress(kp.publicKey);
  const pkHex = Buffer.from(algosdk.decodeAddress(addr).publicKey).toString(
    'hex'
  );
  return { addr, pkHex };
}

const A = seeded(1);
const B = seeded(2);
const C = seeded(3);

const verifiedV2: VerifiedPairing = {
  dev: 'voi-signer-11111111-2222-3333-4444-555555555555',
  name: 'My Cold Phone',
  ts: 1700000000000,
  authLevel: 'v2-signed',
  accounts: [
    { addr: A.addr, publicKey: A.pkHex, label: 'Savings' },
    { addr: B.addr, publicKey: B.pkHex },
    { addr: C.addr, publicKey: C.pkHex, label: 'Ops' },
  ],
};

describe('mapVerifiedPairingToImportRequests', () => {
  it('maps a selected subset, preserving verified (canonical) order', () => {
    const reqs = mapVerifiedPairingToImportRequests(
      verifiedV2,
      new Set([C.addr, A.addr])
    );
    expect(reqs.map((r) => r.address)).toEqual([A.addr, C.addr]);
  });

  it('feeds the DERIVED pubkey (never a wire pk) and the verified authLevel', () => {
    const reqs = mapVerifiedPairingToImportRequests(
      verifiedV2,
      new Set([A.addr])
    );
    expect(reqs).toHaveLength(1);
    expect(reqs[0]).toEqual({
      type: AccountType.REMOTE_SIGNER,
      address: A.addr,
      publicKey: A.pkHex, // derived from addr by verifyPairing
      signerDeviceId: verifiedV2.dev,
      signerDeviceName: verifiedV2.name,
      label: 'Savings',
      authLevel: 'v2-signed',
    });
    // The derived pubkey must actually correspond to the address.
    expect(
      Buffer.from(algosdk.decodeAddress(A.addr).publicKey).toString('hex')
    ).toBe(reqs[0].publicKey);
  });

  it('carries authLevel "v1-unsigned" for an unauthenticated pairing', () => {
    const verifiedV1: VerifiedPairing = {
      ...verifiedV2,
      authLevel: 'v1-unsigned',
    };
    const reqs = mapVerifiedPairingToImportRequests(
      verifiedV1,
      new Set([A.addr, B.addr])
    );
    expect(reqs.every((r) => r.authLevel === 'v1-unsigned')).toBe(true);
  });

  it('omits addresses not present in the verified pairing', () => {
    const reqs = mapVerifiedPairingToImportRequests(
      verifiedV2,
      new Set([A.addr, 'NOT-A-PAIRED-ADDRESS'])
    );
    expect(reqs.map((r) => r.address)).toEqual([A.addr]);
  });

  it('returns an empty list when nothing is selected', () => {
    expect(mapVerifiedPairingToImportRequests(verifiedV2, new Set())).toEqual(
      []
    );
  });

  it('accepts an array of addresses as well as a Set', () => {
    const reqs = mapVerifiedPairingToImportRequests(verifiedV2, [B.addr]);
    expect(reqs.map((r) => r.address)).toEqual([B.addr]);
    expect(reqs[0].label).toBeUndefined();
  });
});
