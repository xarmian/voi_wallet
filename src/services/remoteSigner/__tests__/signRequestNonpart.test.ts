/**
 * TASK-439 — the remote signer refuses a request carrying a nonpart=true
 * keyreg (permanent non-participation on Algorand/Voi) as a whole, before any
 * transaction in it is signed.
 */

import algosdk from 'algosdk';
import { Buffer } from 'buffer';
import {
  makeAccount,
  paymentTxn,
  SUGGESTED_PARAMS,
} from '@/__tests__/fixtures/algorand';

const mockSignTransaction = jest.fn(
  async (..._args: unknown[]) => new Uint8Array([1])
);
jest.mock('../../secure/keyManager', () => ({
  SecureKeyManager: {
    signTransaction: (...args: unknown[]) => mockSignTransaction(...args),
  },
}));
jest.mock('../../network', () => ({ NetworkService: {} }));

import { RemoteSignerServiceClass } from '../index';
import type { RemoteSignerRequest } from '@/types/remoteSigner';

const SIGNER = makeAccount('remote-nonpart');
const b64 = (txn: algosdk.Transaction) =>
  Buffer.from(algosdk.encodeUnsignedTransaction(txn)).toString('base64');
const request = (txns: algosdk.Transaction[]): RemoteSignerRequest =>
  ({
    v: 1,
    t: 'req',
    id: 'req-1',
    ts: Date.now(),
    net: 'voi',
    gh: '',
    txns: txns.map((txn, i) => ({ i, b: b64(txn), s: SIGNER.addr })),
  }) as RemoteSignerRequest;

beforeEach(() => mockSignTransaction.mockClear());

it('refuses the whole request before signing anything', async () => {
  const permanentOffline =
    algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
      sender: SIGNER.addr,
      suggestedParams: SUGGESTED_PARAMS,
      nonParticipation: true,
    });

  const response = await RemoteSignerServiceClass.getInstance().signRequest(
    request([paymentTxn(SIGNER.addr, { amount: 1 }), permanentOffline]),
    '1234'
  );

  expect(JSON.stringify(response)).toMatch(/permanently/);
  expect(mockSignTransaction).not.toHaveBeenCalled();
});

it('still signs a request with a plain offline keyreg', async () => {
  const offline = algosdk.makeKeyRegistrationTxnWithSuggestedParamsFromObject({
    sender: SIGNER.addr,
    suggestedParams: SUGGESTED_PARAMS,
  });

  await RemoteSignerServiceClass.getInstance().signRequest(
    request([offline]),
    '1234'
  );

  expect(mockSignTransaction).toHaveBeenCalledTimes(1);
});
