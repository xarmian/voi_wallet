/**
 * TASK-440 audit #8: the retry, the already-submitted reconcile and the
 * ambiguous-send end state live in NetworkService.submitTransaction (covered
 * in network/__tests__/confirmationWait.test.ts), so every submit path shares
 * them. submitWithRetries only picks the network and delegates once: a retry
 * here would resend after an outcome the network layer already classified.
 */

import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import {
  TransactionExpiredError,
  TransactionRejectedError,
} from '@/types/network';

const mockSubmitTransaction = jest.fn();

jest.mock('@/services/network', () => {
  const svc = {
    submitTransaction: (...args: unknown[]) => mockSubmitTransaction(...args),
  };
  return {
    __esModule: true,
    networkService: svc,
    NetworkService: { getInstance: () => svc },
  };
});

// The same module-graph stubs as construction.test.ts: none of these are
// touched by submitWithRetries, but TransactionService imports them.
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
  ledgerTransportService: {},
}));
jest.mock('@/services/ledger/algorand', () => ({
  __esModule: true,
  ledgerAlgorandService: {},
}));
jest.mock('@/services/secure/keyManager', () => ({
  __esModule: true,
  SecureKeyManager: {},
}));
jest.mock('@/services/security/transactionTracker', () => ({
  __esModule: true,
  TransactionTracker: {},
}));
jest.mock('@/services/wallet', () => ({ MultiAccountWalletService: {} }));
jest.mock('@/services/secure/AccountSecureStorage', () => ({
  AccountSecureStorage: {},
}));
jest.mock('@/services/remoteSigner/signingRouter', () => ({
  checkRemoteSigningRequired: () => ({ needsRemoteSigning: false }),
}));

import { TransactionService } from '@/services/transactions';

const ACCOUNT = makeAccount('submit-with-retries:sender');
const TXN = paymentTxn(ACCOUNT.addr);
const BLOB = TXN.signTxn(ACCOUNT.sk);
const EXPECTED_TX_ID = TXN.txID();
const REASON = 'overspend';

const submit = (blob: Uint8Array = BLOB) =>
  (TransactionService as any).submitWithRetries(blob);

describe('TransactionService.submitWithRetries (TASK-440 #8)', () => {
  beforeEach(() => mockSubmitTransaction.mockReset());

  it('delegates once and returns the network outcome, pending included', async () => {
    mockSubmitTransaction.mockResolvedValue({
      txId: EXPECTED_TX_ID,
      confirmed: false,
    });
    await expect(submit()).resolves.toEqual({
      txId: EXPECTED_TX_ID,
      confirmed: false,
    });
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    expect(mockSubmitTransaction).toHaveBeenCalledWith(BLOB);
  });

  it.each([
    ['a rejection', new TransactionRejectedError(EXPECTED_TX_ID, REASON)],
    ['an expiry', new TransactionExpiredError(EXPECTED_TX_ID, TXN.lastValid)],
    ['an unclassified error', new Error('Transaction failed: boom')],
  ])('propagates %s unchanged and never resends', async (_name, thrown) => {
    mockSubmitTransaction.mockRejectedValue(thrown);
    await expect(submit()).rejects.toBe(thrown);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });
});
