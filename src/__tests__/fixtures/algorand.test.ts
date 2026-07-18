/**
 * Proves the shared fixtures (TASK-149) actually work with real algosdk v3 /
 * tweetnacl, and that transactions decode into the same field shape production
 * consumes. These assertions are the contract downstream P0 tests rely on.
 */

import algosdk from 'algosdk';
import { Buffer } from 'buffer';

import {
  makeAccount,
  makeAddress,
  paymentTxn,
  assetTransferTxn,
  assetConfigTxn,
  appCallTxn,
  arc200TransferTxn,
  roundTripTxn,
  createStoreHarness,
  harnessForStore,
  FIXTURE_ASSET_ID,
  FIXTURE_APP_ID,
} from './algorand';

describe('fixtures/algorand: deterministic account factory (real crypto)', () => {
  it('produces a real, well-formed algosdk account (seed(32)||pubkey(32))', () => {
    const a = makeAccount('alice');

    // 64-byte sk, 32-byte pk, valid checksummed address.
    expect(a.sk).toHaveLength(64);
    expect(a.pk).toHaveLength(32);
    expect(algosdk.isValidAddress(a.addr)).toBe(true);

    // The address is the Algorand encoding of the appended public key, and the
    // key really signs/verifies via algosdk — i.e. genuine Ed25519 crypto, not
    // fabricated bytes.
    expect(algosdk.encodeAddress(a.pk)).toBe(a.addr);
    const message = new TextEncoder().encode('fixture-signing-check');
    const sig = algosdk.signBytes(message, a.sk);
    expect(algosdk.verifyBytes(message, sig, a.addr)).toBe(true);
  });

  it('is deterministic per label and distinct across labels', () => {
    expect(makeAccount('alice').addr).toBe(makeAccount('alice').addr);
    expect(makeAccount(1).addr).toBe(makeAddress(1));
    expect(makeAccount('alice').addr).not.toBe(makeAccount('bob').addr);
  });

  it('round-trips through the algosdk mnemonic import path (Pera-compatible)', () => {
    const a = makeAccount('carol');
    const imported = algosdk.mnemonicToSecretKey(a.mnemonic);
    expect(imported.addr.toString()).toBe(a.addr);
    // Compare secret keys by equality result only — never serialize the key
    // itself, so a failure can't leak the private key into test logs (DR-3).
    expect(Buffer.from(imported.sk).equals(Buffer.from(a.sk))).toBe(true);
  });
});

describe('fixtures/algorand: transaction factory (production decode path)', () => {
  const sender = makeAddress('sender');
  const attacker = makeAddress('attacker');

  it('payment: exposes closeRemainderTo and rekeyTo where production reads them', () => {
    const decoded = roundTripTxn(
      paymentTxn(sender, {
        receiver: attacker,
        amount: 5,
        closeRemainderTo: attacker,
        rekeyTo: attacker,
      })
    );

    expect(decoded.type).toBe(algosdk.TransactionType.pay);
    expect(decoded.payment?.amount).toBe(5n);
    expect(decoded.payment?.closeRemainderTo?.toString()).toBe(attacker);
    expect(decoded.rekeyTo?.toString()).toBe(attacker);
  });

  it('asset-transfer close-out lands under assetTransfer.closeRemainderTo (S-01 shape)', () => {
    const decoded = roundTripTxn(
      assetTransferTxn(sender, {
        receiver: attacker,
        closeRemainderTo: attacker,
      })
    );

    expect(decoded.type).toBe(algosdk.TransactionType.axfer);
    expect(decoded.assetTransfer?.assetIndex).toBe(BigInt(FIXTURE_ASSET_ID));
    expect(decoded.assetTransfer?.closeRemainderTo?.toString()).toBe(attacker);
    // Production reads assetTransfer.closeRemainderTo — there is NO top-level field.
    expect(
      (decoded as unknown as { assetCloseTo?: unknown }).assetCloseTo
    ).toBeUndefined();
  });

  it('asset-config: carries the manager/reserve/freeze/clawback reconfig', () => {
    const decoded = roundTripTxn(assetConfigTxn(sender, { manager: attacker }));

    expect(decoded.type).toBe(algosdk.TransactionType.acfg);
    expect(decoded.assetConfig?.assetIndex).toBe(BigInt(FIXTURE_ASSET_ID));
    expect(decoded.assetConfig?.manager?.toString()).toBe(attacker);
  });

  it('app-call: appId lands under applicationCall.appIndex', () => {
    const decoded = roundTripTxn(appCallTxn(sender));

    expect(decoded.type).toBe(algosdk.TransactionType.appl);
    expect(decoded.applicationCall?.appIndex).toBe(BigInt(FIXTURE_APP_ID));
    expect(decoded.applicationCall?.onComplete).toBe(
      algosdk.OnApplicationComplete.NoOpOC
    );
  });

  it('ARC-200 transfer: real ABI selector + encoded (address, uint256) args', () => {
    const decoded = roundTripTxn(arc200TransferTxn(sender, attacker, 1000n));
    const method = algosdk.ABIMethod.fromSignature(
      'arc200_transfer(address,uint256)bool'
    );

    const args = decoded.applicationCall?.appArgs ?? [];
    expect(args).toHaveLength(3);
    // First arg is the real 4-byte method selector (not fabricated bytes).
    expect(Buffer.from(args[0]).toString('hex')).toBe(
      Buffer.from(method.getSelector()).toString('hex')
    );
    // Third arg decodes back to the amount via the real ABI type.
    const amount = algosdk.ABIType.from('uint256').decode(
      Uint8Array.from(args[2])
    );
    expect(amount).toBe(1000n);
  });
});

describe('fixtures/algorand: zustand store harness', () => {
  interface Counter {
    n: number;
    inc: () => void;
  }

  it('createStoreHarness drives a fresh store and resets to baseline', () => {
    const h = createStoreHarness<Counter>((set) => ({
      n: 0,
      inc: () => set((s) => ({ n: s.n + 1 })),
    }));

    expect(h.getState().n).toBe(0);
    h.getState().inc();
    h.getState().inc();
    expect(h.getState().n).toBe(2);

    h.reset();
    expect(h.getState().n).toBe(0);
  });

  it('harnessForStore snapshots an existing store and restores it', () => {
    const h = createStoreHarness<Counter>((set) => ({
      n: 5,
      inc: () => set((s) => ({ n: s.n + 1 })),
    }));
    const wrapped = harnessForStore(h.store);

    h.setState({ n: 99 });
    expect(wrapped.getState().n).toBe(99);

    wrapped.reset();
    expect(wrapped.getState().n).toBe(5);
  });
});
