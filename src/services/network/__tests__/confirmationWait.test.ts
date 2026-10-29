import { NetworkService } from '../index';
import { NetworkId, TransactionRejectedError } from '@/types/network';
import { mapError } from '@/utils/errorMapping';

/**
 * TASK-440 audit #8: every NetworkService confirmation wait (submitTransaction's
 * internal wait, the lost-response reconcile isTransactionConfirmed, and the
 * public waitForConfirmation) is bounded by a wall-clock deadline, and a
 * definitive rejection throws TransactionRejectedError with algod's reason
 * instead of reading as "pending".
 */

const TX_ID = 'TXID';
const never = <T>() => new Promise<T>(() => {});

type FakeAlgod = {
  status: jest.Mock;
  statusAfterBlock: jest.Mock;
  pendingTransactionInformation: jest.Mock;
  sendRawTransaction: jest.Mock;
};

function fakeAlgod(
  pending: () => Promise<Record<string, unknown>>,
  status: () => Promise<Record<string, unknown>> = async () => ({
    lastRound: 100n,
  })
): FakeAlgod {
  return {
    status: jest.fn(() => ({ do: status })),
    statusAfterBlock: jest.fn(() => ({ do: async () => ({}) })),
    pendingTransactionInformation: jest.fn(() => ({ do: pending })),
    sendRawTransaction: jest.fn(() => ({
      do: async () => ({ txid: TX_ID }),
    })),
  };
}

describe('NetworkService confirmation waits (TASK-440 #8)', () => {
  let service: NetworkService;

  beforeEach(() => {
    service = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const install = (algod: FakeAlgod) => {
    (service as any).algodClient = algod;
  };

  describe('a hung node reads as pending at the deadline', () => {
    beforeEach(() => jest.useFakeTimers());

    it('submitTransaction returns confirmed=false after 65 s + the 15 s look', async () => {
      install(fakeAlgod(never, never));
      let settled: unknown;
      const run = service.submitTransaction(new Uint8Array([1])).then(
        (r) => (settled = r),
        (e) => (settled = e)
      );
      // 10 rounds: 15 s + 10 × 5 s.
      await jest.advanceTimersByTimeAsync(64999);
      expect(settled).toBeUndefined();
      await jest.advanceTimersByTimeAsync(1);
      // Then one bounded pending-info look (15 s), which also hangs.
      await jest.advanceTimersByTimeAsync(15000);
      await run;
      expect(settled).toEqual({ txId: TX_ID, confirmed: false });
    });

    it('isTransactionConfirmed returns false after 35 s + the 15 s look', async () => {
      install(fakeAlgod(never, never));
      const run = service.isTransactionConfirmed(TX_ID);
      await jest.advanceTimersByTimeAsync(35000 + 15000);
      await expect(run).resolves.toBe(false);
    });

    it('waitForConfirmation throws not-confirmed (not a rejection) after its deadline', async () => {
      install(fakeAlgod(never, never));
      const run = service.waitForConfirmation(TX_ID, 4);
      const outcome = run.catch((e) => e);
      await jest.advanceTimersByTimeAsync(35000 + 15000);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(TransactionRejectedError);
      expect((error as Error).message).toMatch(/not confirmed yet/);
    });
  });

  describe('a pool error throws TransactionRejectedError with its reason', () => {
    const REASON = 'overspend (account X, data {_struct:{} Status:Offline})';

    const expectRejected = async (p: Promise<unknown>) => {
      const error = await p.catch((e) => e);
      expect(error).toBeInstanceOf(TransactionRejectedError);
      expect((error as TransactionRejectedError).txId).toBe(TX_ID);
      expect((error as TransactionRejectedError).reason).toBe(REASON);
      expect((error as Error).message).toContain(REASON);
    };

    beforeEach(() => install(fakeAlgod(async () => ({ poolError: REASON }))));

    it('from submitTransaction, unwrapped', async () => {
      await expectRejected(service.submitTransaction(new Uint8Array([1])));
    });

    it('from isTransactionConfirmed', async () => {
      await expectRejected(service.isTransactionConfirmed(TX_ID));
    });

    it('from waitForConfirmation', async () => {
      await expectRejected(service.waitForConfirmation(TX_ID));
    });

    it('when only the post-wait look sees the pool error', async () => {
      // algosdk's loop sees an unreadable pending-info (404 behind a load
      // balancer), runs out of rounds, and the follow-up look finds the reason.
      let calls = 0;
      install(
        fakeAlgod(async () => {
          calls += 1;
          if (calls <= 4) throw new Error('404 not found');
          return { poolError: REASON };
        })
      );
      await expectRejected(service.isTransactionConfirmed(TX_ID));
    });
  });

  it('the rejection message still maps to its specific cause, and wrapped by a caller', () => {
    const error = new TransactionRejectedError(TX_ID, 'overspend (account X)');
    expect(mapError(error).type).toBe('insufficient_funds');
    expect(
      mapError(new Error(`Transaction failed: ${error.message}`)).type
    ).toBe('insufficient_funds');
    expect(
      mapError(new TransactionRejectedError(TX_ID, 'something new')).type
    ).toBe('transaction_rejected');
  });

  it('a not-confirmed wait whose look shows a confirmed round reads as confirmed', async () => {
    let calls = 0;
    const confirmed = { confirmedRound: 104n, txn: {} };
    install(
      fakeAlgod(async () => {
        calls += 1;
        if (calls <= 4) return {};
        return confirmed;
      })
    );
    await expect(service.isTransactionConfirmed(TX_ID)).resolves.toBe(true);
    calls = 0;
    await expect(service.waitForConfirmation(TX_ID, 4)).resolves.toBe(
      confirmed
    );
  });

  it('an unreadable node is pending, not rejected', async () => {
    install(
      fakeAlgod(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );
    await expect(
      service.submitTransaction(new Uint8Array([1]))
    ).resolves.toEqual({ txId: TX_ID, confirmed: false });
  });
});
