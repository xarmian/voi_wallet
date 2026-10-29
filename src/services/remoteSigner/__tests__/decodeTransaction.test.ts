/**
 * Layer-1 tests for `RemoteSignerService.decodeTransaction` (TASK-393).
 *
 * The air-gapped signer's review screen renders ONLY what this decoder
 * returns. Under algosdk 3.x the payment / asset-transfer fields live under
 * `txn.payment.*` / `txn.assetTransfer.*` (not the v2 top-level names), so a
 * v2-shaped decode showed a blank amount, receiver, asset id and close-to.
 *
 * Fixtures are REAL algosdk transactions built from fixed public seeds and
 * encoded with the real msgpack codec (no mocked keys or signatures). No
 * private key material is created beyond the deterministic public test seeds.
 */

// The service module graph statically imports the @ledgerhq native transports
// (untranspiled ESM) and AsyncStorage (absent native module) — same stubs as
// signingRouter.test.ts. Decoding touches none of them.
jest.mock('@ledgerhq/react-native-hw-transport-ble', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@ledgerhq/react-native-hid', () => ({
  __esModule: true,
  default: {},
}));
jest.mock('@ledgerhq/hw-transport', () => ({
  __esModule: true,
  default: class {},
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async () => null),
    setItem: jest.fn(async () => {}),
    removeItem: jest.fn(async () => {}),
    multiGet: jest.fn(async () => []),
    multiSet: jest.fn(async () => {}),
  },
}));

import algosdk from 'algosdk';
import nacl from 'tweetnacl';

import { RemoteSignerService } from '../index';

/** Deterministic Algorand address from a fixed 32-byte public test seed. */
function seededAddress(seedByte: number): string {
  const kp = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(seedByte));
  return algosdk.encodeAddress(kp.publicKey);
}

const SENDER = seededAddress(1);
const RECEIVER = seededAddress(2);
const CLOSE_TO = seededAddress(3);
const REKEY_TO = seededAddress(4);

const GENESIS_HASH = new Uint8Array(32).fill(7);
const PARAMS: algosdk.SuggestedParams = {
  fee: 1000n,
  minFee: 1000n,
  flatFee: true,
  firstValid: 1000n,
  lastValid: 2000n,
  genesisID: 'voimain-v1.0',
  genesisHash: GENESIS_HASH,
};

const toB64 = (txn: algosdk.Transaction): string =>
  Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64');

describe('RemoteSignerService.decodeTransaction (algosdk v3 fields)', () => {
  it('decodes a native payment: amount, receiver, close-to, rekey-to', () => {
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: SENDER,
      receiver: RECEIVER,
      amount: 1_234_567n,
      closeRemainderTo: CLOSE_TO,
      rekeyTo: REKEY_TO,
      suggestedParams: PARAMS,
    });

    const d = RemoteSignerService.decodeTransaction(toB64(txn));

    expect(d.type).toBe('payment');
    expect(d.sender).toBe(SENDER);
    expect(d.receiver).toBe(RECEIVER);
    expect(d.amount).toBe(1_234_567n);
    expect(d.assetId).toBeUndefined();
    expect(d.closeRemainderTo).toBe(CLOSE_TO);
    expect(d.assetCloseTo).toBeUndefined();
    expect(d.rekeyTo).toBe(REKEY_TO);
    expect(d.fee).toBe(1000n);
    expect(d.firstValid).toBe(1000n);
    expect(d.lastValid).toBe(2000n);
    expect(d.genesisId).toBe('voimain-v1.0');
  });

  it('decodes a plain payment with no close-to / rekey-to', () => {
    const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
      sender: SENDER,
      receiver: RECEIVER,
      amount: 5n,
      suggestedParams: PARAMS,
    });

    const d = RemoteSignerService.decodeTransaction(toB64(txn));

    expect(d.receiver).toBe(RECEIVER);
    expect(d.amount).toBe(5n);
    expect(d.closeRemainderTo).toBeUndefined();
    expect(d.rekeyTo).toBeUndefined();
  });

  it('decodes an asset transfer: amount, receiver, asset id, asset close-to, rekey-to', () => {
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: SENDER,
      receiver: RECEIVER,
      amount: 250n,
      assetIndex: 302190n,
      closeRemainderTo: CLOSE_TO,
      rekeyTo: REKEY_TO,
      suggestedParams: PARAMS,
    });

    const d = RemoteSignerService.decodeTransaction(toB64(txn));

    expect(d.type).toBe('asset_transfer');
    expect(d.sender).toBe(SENDER);
    expect(d.receiver).toBe(RECEIVER);
    expect(d.amount).toBe(250n);
    expect(d.assetId).toBe(302190n);
    // An asset close-out sweeps the ASA, not the native balance.
    expect(d.assetCloseTo).toBe(CLOSE_TO);
    expect(d.closeRemainderTo).toBeUndefined();
    expect(d.rekeyTo).toBe(REKEY_TO);
    expect(d.assetSender).toBeUndefined();
  });

  it('decodes a clawback: the clawed-from account is surfaced, not just the authority', () => {
    const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: SENDER,
      assetSender: CLOSE_TO,
      receiver: RECEIVER,
      amount: 9n,
      assetIndex: 302190n,
      suggestedParams: PARAMS,
    });

    const d = RemoteSignerService.decodeTransaction(toB64(txn));

    expect(d.type).toBe('asset_transfer');
    expect(d.sender).toBe(SENDER);
    expect(d.assetSender).toBe(CLOSE_TO);
    expect(d.receiver).toBe(RECEIVER);
    expect(d.amount).toBe(9n);
  });

  // TASK-445 (folded into TASK-440 #243): the signer device's review gets the
  // same danger list as the wallet. Negative control: at 50993c5 the decoded
  // info had no danger list, so an acfg hand-over was never shown.
  it('carries the shared danger list, including asset authority changes', () => {
    const txn = algosdk.makeAssetConfigTxnWithSuggestedParamsFromObject({
      sender: SENDER,
      assetIndex: 302190n,
      manager: REKEY_TO,
      strictEmptyAddressChecking: false,
      suggestedParams: PARAMS,
    });

    const d = RemoteSignerService.decodeTransaction(toB64(txn));

    expect(d.dangers).toEqual(
      expect.arrayContaining([
        {
          sender: SENDER,
          kind: 'assetAuthority',
          assetId: 302190n,
          role: 'manager',
          target: REKEY_TO,
        },
        {
          sender: SENDER,
          kind: 'assetAuthorityRemoved',
          assetId: 302190n,
          role: 'clawback',
        },
      ])
    );
  });

  it('decodes an app call id', () => {
    const txn = algosdk.makeApplicationNoOpTxnFromObject({
      sender: SENDER,
      appIndex: 4242n,
      suggestedParams: PARAMS,
    });

    const d = RemoteSignerService.decodeTransaction(toB64(txn));

    expect(d.type).toBe('app_call');
    expect(d.appId).toBe(4242n);
    expect(d.amount).toBeUndefined();
    expect(d.receiver).toBeUndefined();
  });
});
