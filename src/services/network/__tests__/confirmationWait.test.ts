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

  const CONFIRMED = { confirmedRound: 104n, txn: {} };
  const REASON = 'overspend (account X, data {_struct:{} Status:Offline})';

  // The three waits, each with its round count (deadline 15 s + 5 s/round)
  // and how it reports confirmed and pending (the table in the PR).
  const WAITS: {
    name: string;
    rounds: number;
    run: () => Promise<unknown>;
    confirmed: unknown;
    expectPending: (outcome: unknown) => void;
  }[] = [
    {
      name: 'submitTransaction',
      rounds: 10,
      run: () => service.submitTransaction(new Uint8Array([1])),
      confirmed: { txId: TX_ID, confirmed: true },
      expectPending: (outcome) =>
        expect(outcome).toEqual({ txId: TX_ID, confirmed: false }),
    },
    {
      name: 'isTransactionConfirmed',
      rounds: 4,
      run: () => service.isTransactionConfirmed(TX_ID),
      confirmed: true,
      expectPending: (outcome) => expect(outcome).toBe(false),
    },
    {
      name: 'waitForConfirmation',
      rounds: 4,
      run: () => service.waitForConfirmation(TX_ID, 4),
      confirmed: CONFIRMED,
      expectPending: (outcome) => {
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome).not.toBeInstanceOf(TransactionRejectedError);
        expect((outcome as Error).message).toMatch(/not confirmed yet/);
      },
    },
  ];

  /** Resolve with the wait's value, or with the error it threw. */
  const settle = (p: Promise<unknown>) => p.catch((e: unknown) => e);

  const expectRejected = (outcome: unknown) => {
    expect(outcome).toBeInstanceOf(TransactionRejectedError);
    expect((outcome as TransactionRejectedError).txId).toBe(TX_ID);
    expect((outcome as TransactionRejectedError).reason).toBe(REASON);
    expect((outcome as Error).message).toContain(REASON);
  };

  /** Resolve `value` (or reject with it, if an Error) after `ms` fake ms. */
  const after = (ms: number, value: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) =>
      setTimeout(
        () =>
          value instanceof Error
            ? reject(value)
            : resolve(value as Record<string, unknown>),
        ms
      )
    );

  describe.each(WAITS)('$name', (wait) => {
    const deadline = 15000 + wait.rounds * 5000;

    it('confirmed inside the loop reads as confirmed', async () => {
      install(fakeAlgod(async () => CONFIRMED));
      expect(await settle(wait.run())).toEqual(wait.confirmed);
    });

    it('a look that shows a confirmed round after the loop reads as confirmed', async () => {
      let calls = 0;
      install(fakeAlgod(async () => (++calls <= wait.rounds ? {} : CONFIRMED)));
      expect(await settle(wait.run())).toEqual(wait.confirmed);
    });

    it('a pool error inside the loop throws TransactionRejectedError, unwrapped', async () => {
      install(fakeAlgod(async () => ({ poolError: REASON })));
      expectRejected(await settle(wait.run()));
    });

    it('a pool error seen only by the post-wait look throws TransactionRejectedError', async () => {
      // algosdk's loop reads 404 (load-balanced algod) until it runs out of
      // rounds; the follow-up look finds the reason.
      let calls = 0;
      install(
        fakeAlgod(async () => {
          if (++calls <= wait.rounds) throw new Error('404 not found');
          return { poolError: REASON };
        })
      );
      expectRejected(await settle(wait.run()));
    });

    it('round exhaustion with a still-pending look reads as pending', async () => {
      install(fakeAlgod(async () => ({ confirmedRound: 0n })));
      wait.expectPending(await settle(wait.run()));
    });

    it('an unreadable node reads as pending, not rejected', async () => {
      install(
        fakeAlgod(async () => {
          throw new Error('connect ECONNREFUSED');
        })
      );
      wait.expectPending(await settle(wait.run()));
    });

    describe('under the wall-clock deadline', () => {
      beforeEach(() => jest.useFakeTimers());

      it('a hung node stays unsettled until the deadline, then reads as pending after the look', async () => {
        install(fakeAlgod(never, never));
        let outcome: unknown = 'unsettled';
        const run = settle(wait.run()).then((o) => (outcome = o));
        await jest.advanceTimersByTimeAsync(deadline - 1);
        expect(outcome).toBe('unsettled');
        // Deadline, then one bounded pending-info look (15 s), which also hangs.
        await jest.advanceTimersByTimeAsync(1 + 15000 - 1);
        expect(outcome).toBe('unsettled');
        await jest.advanceTimersByTimeAsync(1);
        await run;
        wait.expectPending(outcome);
      });

      it('a rejection algosdk reaches while the look is in flight is not lost (Codex pass A)', async () => {
        // algosdk's first pending read is slow and returns the pool error
        // 3 s after the deadline; the look hits another node, which 404s.
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, { poolError: REASON })
              : after(10000, new Error('404 not found'))
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        expectRejected(await run);
      });

      it('a confirmation algosdk reaches while the look is in flight reads as confirmed', async () => {
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, CONFIRMED)
              : after(10000, new Error('404 not found'))
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        expect(await run).toEqual(wait.confirmed);
      });

      it('a late loop rejection survives a readable but still-pending look (Codex table attack)', async () => {
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, { poolError: REASON })
              : after(10000, { confirmedRound: 0n })
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        expectRejected(await run);
      });

      // Codex confirm: the loop and the look may read different nodes and
      // disagree. A confirmed round is a ledger fact and outranks a pool
      // error, whichever side saw which (decision on the TASK-440 trail).
      it('a late loop rejection is outranked by a look that shows a confirmed round', async () => {
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, { poolError: REASON })
              : after(10000, CONFIRMED)
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        expect(await run).toEqual(wait.confirmed);
      });

      it('a late loop confirmation outranks a look that shows a pool error', async () => {
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, CONFIRMED)
              : after(10000, { poolError: REASON })
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        expect(await run).toEqual(wait.confirmed);
      });

      it('a hung block wait reads as pending at the deadline plus the look', async () => {
        const algod = fakeAlgod(async () => ({}));
        algod.statusAfterBlock.mockImplementation(() => ({ do: never }));
        install(algod);
        let outcome: unknown = 'unsettled';
        const run = settle(wait.run()).then((o) => (outcome = o));
        await jest.advanceTimersByTimeAsync(deadline - 1);
        expect(outcome).toBe('unsettled');
        // The look answers at once, still pending.
        await jest.advanceTimersByTimeAsync(1);
        await run;
        wait.expectPending(outcome);
      });
    });

    it('a node that 404s through the final look reads as pending', async () => {
      install(
        fakeAlgod(async () => {
          throw new Error('404 not found');
        })
      );
      wait.expectPending(await settle(wait.run()));
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
});
