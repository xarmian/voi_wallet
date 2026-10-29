/**
 * TASK-440 audit #8: a definitive rejection (TransactionRejectedError) is final
 * for a signed transaction. submitWithRetries must surface it with its reason,
 * never resend the same blob, and the lost-response reconcile must propagate
 * it rather than report "pending".
 *
 * Only the NetworkService boundary is mocked; the signed blob is real (algosdk
 * fixture keys, never logged) so the expected txId is derived as in production.
 */

import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';
import { TransactionRejectedError } from '@/types/network';

const mockSubmitTransaction = jest.fn();
const mockIsTransactionConfirmed = jest.fn();

jest.mock('@/services/network', () => {
  const svc = {
    submitTransaction: (...args: unknown[]) => mockSubmitTransaction(...args),
    isTransactionConfirmed: (...args: unknown[]) =>
      mockIsTransactionConfirmed(...args),
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
  beforeEach(() => {
    mockSubmitTransaction.mockReset();
    mockIsTransactionConfirmed.mockReset();
    jest.spyOn(TransactionService as any, 'delay').mockResolvedValue(undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('surfaces a rejection with its reason and never resends the blob', async () => {
    mockSubmitTransaction.mockRejectedValue(
      new TransactionRejectedError(EXPECTED_TX_ID, REASON)
    );
    const error = await submit().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransactionRejectedError);
    expect((error as TransactionRejectedError).reason).toBe(REASON);
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
  });

  it('still retries an ordinary submit failure (control)', async () => {
    mockSubmitTransaction
      .mockRejectedValueOnce(new Error('Transaction failed: socket hang up'))
      .mockResolvedValueOnce({ txId: EXPECTED_TX_ID, confirmed: true });
    await expect(submit()).resolves.toEqual({
      txId: EXPECTED_TX_ID,
      confirmed: true,
    });
    expect(mockSubmitTransaction).toHaveBeenCalledTimes(2);
  });

  describe('lost-response reconcile ("already in ledger")', () => {
    beforeEach(() => {
      mockSubmitTransaction.mockRejectedValue(
        new Error('Transaction failed: transaction already in ledger')
      );
    });

    it('propagates a rejection found while reconciling', async () => {
      mockIsTransactionConfirmed.mockRejectedValue(
        new TransactionRejectedError(EXPECTED_TX_ID, REASON)
      );
      const error = await submit().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TransactionRejectedError);
      expect(mockIsTransactionConfirmed).toHaveBeenCalledWith(EXPECTED_TX_ID);
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    });

    it('reports pending (not failure) when the reconcile errors otherwise', async () => {
      mockIsTransactionConfirmed.mockRejectedValue(new Error('node down'));
      await expect(submit()).resolves.toEqual({
        txId: EXPECTED_TX_ID,
        confirmed: false,
      });
      expect(mockSubmitTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
