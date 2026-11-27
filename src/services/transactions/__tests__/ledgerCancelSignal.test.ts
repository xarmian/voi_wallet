/**
 * Cancel during a Ledger signing must stop the send before it reaches the
 * network: the recovery loop, its backoff, a group's next entry and the final
 * submit all honour the signal. Once the send is issued, it is not stopped.
 */

import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import { LedgerDeviceNotConnectedError } from '@/types/wallet';

jest.mock('@/services/network', () => {
  const svc = {
    submitTransaction: jest.fn(),
    getCurrentNetworkId: () => 'voi-mainnet',
  };
  return {
    __esModule: true,
    networkService: svc,
    NetworkService: { getInstance: () => svc },
  };
});
jest.mock('@/services/mimir', () => ({ __esModule: true, default: {} }));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
jest.mock('@/store/walletStore', () => ({
  __esModule: true,
  useWalletStore: { getState: () => ({}) },
}));
jest.mock('@/services/ledger/transport', () => ({
  __esModule: true,
  ledgerTransportService: {
    getConnectedDevice: jest.fn(),
    getDevices: jest.fn(() => []),
    connect: jest.fn(),
  },
}));
jest.mock('@/services/ledger/algorand', () => ({
  __esModule: true,
  ledgerAlgorandService: { verifyApp: jest.fn() },
}));
jest.mock('@/services/secure/keyManager', () => ({
  __esModule: true,
  SecureKeyManager: {
    signTransaction: jest.fn(),
    getSigningInfo: jest.fn(),
    getLedgerSigningInfo: jest.fn(),
  },
}));
jest.mock('@/services/security/transactionTracker', () => ({
  __esModule: true,
  TransactionTracker: { recordTransaction: jest.fn() },
}));
jest.mock('@/services/wallet', () => ({ MultiAccountWalletService: {} }));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));
jest.mock('@/services/remoteSigner/signingRouter', () => ({
  checkRemoteSigningRequired: () => ({ needsRemoteSigning: false }),
}));

import { TransactionService } from '@/services/transactions';
import { SecureKeyManager } from '@/services/secure/keyManager';
import { TransactionTracker } from '@/services/security/transactionTracker';
import { ledgerTransportService } from '@/services/ledger/transport';
import { ledgerAlgorandService } from '@/services/ledger/algorand';

const ACCOUNT = makeAccount('ledger-cancel-signal:sender');
const TXN = paymentTxn(ACCOUNT.addr);
const TXN_2 = paymentTxn(ACCOUNT.addr, { amount: 2 });
const BLOB = TXN.signTxn(ACCOUNT.sk);
const TX_ID = TXN.txID();
const UNSIGNED = { txn: TXN, txnBytes: TXN.toByte() };
const ACCT = { address: ACCOUNT.addr, type: 'ledger' } as any;
const PARAMS = { from: ACCOUNT.addr, to: ACCOUNT.addr, amount: 1 } as any;

const deviceSign = SecureKeyManager.signTransaction as jest.Mock;
const recordTransaction = TransactionTracker.recordTransaction as jest.Mock;
const svc = TransactionService as any;

let submit: jest.SpyInstance;
let delay: jest.SpyInstance;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let i = 0; i < 50 && !predicate(); i += 1) await flush();
  expect(predicate()).toBe(true);
}

const callbacks = () => ({
  onLedgerPrompt: jest.fn(),
  onLedgerSigned: jest.fn(),
  onLedgerRejected: jest.fn(),
  onNetworkSubmit: jest.fn(),
  onNetworkConfirmed: jest.fn(),
});

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(svc, 'buildTransaction').mockResolvedValue(UNSIGNED);
  jest.spyOn(svc, 'buildRekeyTransaction').mockResolvedValue(UNSIGNED);
  jest.spyOn(svc, 'buildRekeyReverseTransaction').mockResolvedValue(UNSIGNED);
  jest.spyOn(svc, 'assertSignsAfterRekey').mockResolvedValue(undefined);
  jest
    .spyOn(svc, 'ensureLedgerSigningReadiness')
    .mockResolvedValue({ deviceId: 'device' });
  jest.spyOn(svc, 'notifyTransactionSuccess').mockImplementation(() => {});
  jest.spyOn(svc, 'notifyTransactionFailure').mockImplementation(() => {});
  submit = jest
    .spyOn(svc, 'submitWithRetries')
    .mockResolvedValue({ txId: TX_ID, confirmed: true });
  delay = jest.spyOn(svc, 'delay').mockResolvedValue(undefined);
  deviceSign.mockReset().mockResolvedValue(BLOB);
  recordTransaction.mockReset().mockResolvedValue(undefined);
  (SecureKeyManager.getSigningInfo as jest.Mock).mockResolvedValue({
    signingAddress: ACCOUNT.addr,
  });
  (SecureKeyManager.getLedgerSigningInfo as jest.Mock).mockResolvedValue({
    deviceId: 'device',
  });
  (ledgerTransportService.getConnectedDevice as jest.Mock).mockReturnValue({
    id: 'device',
  });
  (ledgerAlgorandService.verifyApp as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => jest.restoreAllMocks());

it('cancelDuringRecoveryRetryStopsBroadcast', async () => {
  const controller = new AbortController();
  const second = deferred<Uint8Array>();
  deviceSign
    .mockRejectedValueOnce(new LedgerDeviceNotConnectedError())
    .mockReturnValueOnce(second.promise);
  const cb = callbacks();
  const send = TransactionService.sendTransaction(PARAMS, ACCT, undefined, cb, {
    signal: controller.signal,
  });
  await until(() => deviceSign.mock.calls.length === 2);
  controller.abort();
  second.resolve(BLOB);
  await expect(send).rejects.toThrow(/^Signing cancelled$/);
  expect(submit).not.toHaveBeenCalled();
  expect(cb.onNetworkSubmit).not.toHaveBeenCalled();
  expect(recordTransaction).not.toHaveBeenCalled();
});

it('abortedAttemptFailureIsNotRetried', async () => {
  const controller = new AbortController();
  const second = deferred<Uint8Array>();
  deviceSign
    .mockRejectedValueOnce(new LedgerDeviceNotConnectedError())
    .mockReturnValueOnce(second.promise);
  const send = TransactionService.sendTransaction(
    PARAMS,
    ACCT,
    undefined,
    callbacks(),
    { signal: controller.signal }
  );
  await until(() => deviceSign.mock.calls.length === 2);
  controller.abort();
  const failure = new LedgerDeviceNotConnectedError();
  second.reject(failure);
  // Neither retried nor relabelled as a retryable Ledger error.
  await expect(send).rejects.toBe(failure);
  expect(deviceSign).toHaveBeenCalledTimes(2);
  expect(submit).not.toHaveBeenCalled();
});

it('abortDuringBackoffStartsNoNextAttempt', async () => {
  const controller = new AbortController();
  const backoff = deferred<void>();
  delay.mockReturnValueOnce(backoff.promise);
  deviceSign.mockRejectedValueOnce(new LedgerDeviceNotConnectedError());
  const cb = callbacks();
  const send = TransactionService.sendTransaction(PARAMS, ACCT, undefined, cb, {
    signal: controller.signal,
  });
  await until(() => delay.mock.calls.length === 1);
  controller.abort();
  backoff.resolve();
  await expect(send).rejects.toThrow(/^Signing cancelled$/);
  expect(deviceSign).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
  expect(cb.onNetworkSubmit).not.toHaveBeenCalled();
});

describe.each([
  [
    'sendRekeyTransaction',
    { fromAddress: ACCOUNT.addr, rekeyToAddress: ACCOUNT.addr },
  ],
  ['sendRekeyReverseTransaction', { fromAddress: ACCOUNT.addr }],
] as const)('rekeyAndReverseStopBeforeSubmit: %s', (method, params) => {
  it('stops when aborted during the device signature', async () => {
    const controller = new AbortController();
    const sign = deferred<Uint8Array>();
    deviceSign.mockReturnValueOnce(sign.promise);
    const cb = callbacks();
    const send = svc[method](params, ACCT, undefined, cb, {
      signal: controller.signal,
    });
    await until(() => deviceSign.mock.calls.length === 1);
    controller.abort();
    sign.resolve(BLOB);
    await expect(send).rejects.toThrow(/^Signing cancelled$/);
    expect(submit).not.toHaveBeenCalled();
    expect(cb.onNetworkSubmit).not.toHaveBeenCalled();
    expect(recordTransaction).not.toHaveBeenCalled();
  });

  it('stops when aborted during assertSignsAfterRekey', async () => {
    const controller = new AbortController();
    svc.assertSignsAfterRekey.mockImplementation(async () => {
      controller.abort();
    });
    const cb = callbacks();
    await expect(
      svc[method](params, ACCT, undefined, cb, { signal: controller.signal })
    ).rejects.toThrow(/^Signing cancelled$/);
    expect(submit).not.toHaveBeenCalled();
    expect(cb.onNetworkSubmit).not.toHaveBeenCalled();
  });
});

it('groupAbortStopsNextEntryPrompt', async () => {
  const controller = new AbortController();
  svc.buildTransaction.mockResolvedValue({
    transactions: [TXN, TXN_2],
    txnBytes: [TXN.toByte(), TXN_2.toByte()],
  });
  deviceSign.mockImplementationOnce(async () => {
    controller.abort();
    return BLOB;
  });
  const cb = callbacks();
  await expect(
    TransactionService.sendTransaction(PARAMS, ACCT, undefined, cb, {
      signal: controller.signal,
    })
  ).rejects.toThrow(/^Signing cancelled$/);
  expect(cb.onLedgerPrompt).toHaveBeenCalledTimes(1);
  expect(cb.onLedgerPrompt).toHaveBeenCalledWith({ index: 1, total: 2 });
  expect(deviceSign).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

// Guard: an abort after the send is issued must not stop or relabel it.
it('abortAfterNetworkSubmitDoesNotStopSend', async () => {
  const controller = new AbortController();
  const network = deferred<{ txId: string; confirmed: boolean }>();
  submit.mockReturnValueOnce(network.promise);
  const cb = callbacks();
  cb.onNetworkSubmit.mockImplementation(() => controller.abort());
  const send = TransactionService.sendTransaction(PARAMS, ACCT, undefined, cb, {
    signal: controller.signal,
  });
  await until(() => submit.mock.calls.length === 1);
  network.resolve({ txId: TX_ID, confirmed: true });
  await expect(send).resolves.toEqual({ txId: TX_ID, confirmed: true });
  expect(cb.onNetworkConfirmed).toHaveBeenCalledWith(TX_ID, true);
  expect(recordTransaction).toHaveBeenCalledTimes(1);
});
