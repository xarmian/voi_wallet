import { NetworkService } from '../index';
import {
  NetworkId,
  TransactionExpiredError,
  TransactionRejectedError,
} from '@/types/network';
import { mapError } from '@/utils/errorMapping';
import { makeAccount, paymentTxn } from '@/__tests__/fixtures/algorand';

/**
 * TASK-440 audit #8: every NetworkService confirmation wait (submitTransaction's
 * internal wait, the lost-response reconcile isTransactionConfirmed, and the
 * public waitForConfirmation) is bounded by a wall-clock deadline.
 *
 * Director 10-29: a pool error after a successful submit is one node's view,
 * not proof the transaction is dead, so it never reads as "rejected": the
 * outcome stays "not confirmed, may still land" until the node's own round is
 * past lastValid and a readable look still shows it unconfirmed ("expired").
 * A 4xx on the submit itself is the only hard rejection.
 */

// A real signed transaction, so submitTransaction decodes its lastValid
// (fixture SUGGESTED_PARAMS: lastValid 1001). Keys are fixtures, never logged.
const ACCOUNT = makeAccount('confirmation-wait:sender');
const TXN = paymentTxn(ACCOUNT.addr);
const BLOB = TXN.signTxn(ACCOUNT.sk);
const TX_ID = TXN.txID();
const LAST_VALID = TXN.lastValid;
const BEFORE_LAST_VALID = 100n;
const PAST_LAST_VALID = LAST_VALID + 5n;

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
    lastRound: BEFORE_LAST_VALID,
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

/** The shape algosdk's HTTP client throws for a non-2xx response. */
function httpError(status: number, message: string) {
  return Object.assign(
    new Error(`Network request error. Received status ${status}: ${message}`),
    { response: { status, body: new Uint8Array() } }
  );
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
  const POOL_ERROR = { poolError: 'overspend (account X)' };

  // The three waits, each with its round count (deadline 15 s + 5 s/round)
  // and how it reports confirmed and pending. All three know lastValid:
  // submitTransaction decodes it from the blob, the others take it.
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
      run: () => service.submitTransaction(BLOB),
      confirmed: { txId: TX_ID, confirmed: true },
      expectPending: (outcome) =>
        expect(outcome).toEqual({ txId: TX_ID, confirmed: false }),
    },
    {
      name: 'isTransactionConfirmed',
      rounds: 4,
      run: () => service.isTransactionConfirmed(TX_ID, LAST_VALID),
      confirmed: true,
      expectPending: (outcome) => expect(outcome).toBe(false),
    },
    {
      name: 'waitForConfirmation',
      rounds: 4,
      run: () => service.waitForConfirmation(TX_ID, 4, LAST_VALID),
      confirmed: CONFIRMED,
      expectPending: (outcome) => {
        expect(outcome).toBeInstanceOf(Error);
        expect(outcome).not.toBeInstanceOf(TransactionRejectedError);
        expect(outcome).not.toBeInstanceOf(TransactionExpiredError);
        expect((outcome as Error).message).toMatch(/may still be committed/);
      },
    },
  ];

  /** Resolve with the wait's value, or with the error it threw. */
  const settle = (p: Promise<unknown>) => p.catch((e: unknown) => e);

  const expectExpired = (outcome: unknown) => {
    expect(outcome).toBeInstanceOf(TransactionExpiredError);
    expect((outcome as TransactionExpiredError).txId).toBe(TX_ID);
    expect((outcome as TransactionExpiredError).lastValid).toBe(LAST_VALID);
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

    it('keeps polling after a pool error, and a later confirmation reads as confirmed', async () => {
      let calls = 0;
      install(fakeAlgod(async () => (++calls <= 2 ? POOL_ERROR : CONFIRMED)));
      expect(await settle(wait.run())).toEqual(wait.confirmed);
    });

    it('a look that shows a confirmed round after the loop reads as confirmed', async () => {
      let calls = 0;
      install(
        fakeAlgod(async () => (++calls <= wait.rounds ? POOL_ERROR : CONFIRMED))
      );
      expect(await settle(wait.run())).toEqual(wait.confirmed);
    });

    it('director 10-29: submit OK, then a pool error, is never "rejected" before lastValid', async () => {
      install(fakeAlgod(async () => POOL_ERROR));
      const outcome = await settle(wait.run());
      expect(outcome).not.toBeInstanceOf(TransactionRejectedError);
      expect(outcome).not.toBeInstanceOf(TransactionExpiredError);
      wait.expectPending(outcome);
    });

    it('past lastValid by the node’s own round, a readable unconfirmed look is expired', async () => {
      install(
        fakeAlgod(
          async () => POOL_ERROR,
          async () => ({ lastRound: PAST_LAST_VALID })
        )
      );
      expectExpired(await settle(wait.run()));
    });

    it('past lastValid with no pool error, a readable unconfirmed look is expired', async () => {
      install(
        fakeAlgod(
          async () => ({ confirmedRound: 0n }),
          async () => ({ lastRound: PAST_LAST_VALID })
        )
      );
      expectExpired(await settle(wait.run()));
    });

    it('past lastValid, a 404 look stays pending (a long-confirmed txn reads 404 too)', async () => {
      install(
        fakeAlgod(
          async () => {
            throw httpError(404, 'txn not found');
          },
          async () => ({ lastRound: PAST_LAST_VALID })
        )
      );
      wait.expectPending(await settle(wait.run()));
    });

    it('past lastValid, an unreadable node round at the expiry check stays pending', async () => {
      let statusCalls = 0;
      install(
        fakeAlgod(
          async () => POOL_ERROR,
          async () => {
            if (++statusCalls === 1) return { lastRound: PAST_LAST_VALID };
            throw new Error('connect ECONNREFUSED');
          }
        )
      );
      wait.expectPending(await settle(wait.run()));
    });

    it('round exhaustion with a still-pending look reads as pending', async () => {
      install(fakeAlgod(async () => ({ confirmedRound: 0n })));
      wait.expectPending(await settle(wait.run()));
    });

    it('an unreadable node reads as pending', async () => {
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

      it('a confirmation the loop reaches while the look is in flight reads as confirmed (Codex pass A)', async () => {
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, CONFIRMED)
              : after(10000, httpError(404, 'txn not found'))
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        expect(await run).toEqual(wait.confirmed);
      });

      it('a pool error the loop reaches while the look is in flight is still not a rejection', async () => {
        let calls = 0;
        install(
          fakeAlgod(() =>
            ++calls === 1
              ? after(deadline + 3000, POOL_ERROR)
              : after(10000, httpError(404, 'txn not found'))
          )
        );
        const run = settle(wait.run());
        await jest.advanceTimersByTimeAsync(deadline + 10000);
        wait.expectPending(await run);
      });
    });
  });

  describe('submitTransaction: a 4xx on the submit is the only hard rejection', () => {
    it('a 4xx throws TransactionRejectedError with its reason and never waits', async () => {
      const algod = fakeAlgod(async () => CONFIRMED);
      algod.sendRawTransaction.mockImplementation(() => ({
        do: async () => {
          throw httpError(400, 'overspend (account X)');
        },
      }));
      install(algod);
      const outcome = await settle(service.submitTransaction(BLOB));
      expect(outcome).toBeInstanceOf(TransactionRejectedError);
      expect((outcome as TransactionRejectedError).txId).toBe(TX_ID);
      expect((outcome as TransactionRejectedError).reason).toMatch(/overspend/);
      expect(algod.pendingTransactionInformation).not.toHaveBeenCalled();
    });

    it('"already in ledger" (a 400) is not a rejection: it is left to the reconcile', async () => {
      const algod = fakeAlgod(async () => CONFIRMED);
      algod.sendRawTransaction.mockImplementation(() => ({
        do: async () => {
          throw httpError(400, 'transaction already in ledger');
        },
      }));
      install(algod);
      const outcome = await settle(service.submitTransaction(BLOB));
      expect(outcome).not.toBeInstanceOf(TransactionRejectedError);
      expect((outcome as Error).message).toMatch(
        /^Transaction failed: .*already in ledger/
      );
    });

    it('a 5xx is not a rejection (a transient failure, retried by the caller)', async () => {
      const algod = fakeAlgod(async () => CONFIRMED);
      algod.sendRawTransaction.mockImplementation(() => ({
        do: async () => {
          throw httpError(503, 'unavailable');
        },
      }));
      install(algod);
      const outcome = await settle(service.submitTransaction(BLOB));
      expect(outcome).not.toBeInstanceOf(TransactionRejectedError);
      expect((outcome as Error).message).toMatch(/^Transaction failed:/);
    });
  });

  it('without lastValid, the public wait never reports expiry', async () => {
    install(
      fakeAlgod(
        async () => POOL_ERROR,
        async () => ({ lastRound: PAST_LAST_VALID })
      )
    );
    const outcome = await settle(service.waitForConfirmation(TX_ID, 4));
    expect(outcome).not.toBeInstanceOf(TransactionExpiredError);
    expect((outcome as Error).message).toMatch(/may still be committed/);
  });

  it('the outcomes map to their causes, and pending never maps to a rejection', () => {
    const rejected = new TransactionRejectedError(
      TX_ID,
      'overspend (account X)'
    );
    expect(mapError(rejected).type).toBe('insufficient_funds');
    expect(
      mapError(new Error(`Transaction failed: ${rejected.message}`)).type
    ).toBe('insufficient_funds');
    expect(mapError(new TransactionExpiredError(TX_ID, LAST_VALID)).type).toBe(
      'transaction_expired'
    );
    const pending = new Error(
      `Transaction ${TX_ID} is not confirmed yet and may still be committed; check its status before sending again`
    );
    expect(mapError(pending).type).not.toBe('transaction_rejected');
  });
});
