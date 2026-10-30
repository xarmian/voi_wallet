import algosdk from 'algosdk';
import { NetworkService } from '../index';
import { NetworkId } from '@/types/network';

// A syntactically valid address (all-zero public key) so isValidAddress passes.
const ADDRESS = algosdk.encodeAddress(new Uint8Array(32));
const TIMEOUT_MS = 15000;

const never = () => new Promise<never>(() => {});

// An indexer/algod request builder whose every chained call returns itself and
// whose .do() never settles: a node that accepted the socket and went quiet.
function stalledBuilder(): any {
  const builder: any = new Proxy(
    {},
    {
      get: (_target, prop) => (prop === 'do' ? never : () => builder),
    }
  );
  return builder;
}

const stalledClient = new Proxy(
  {},
  { get: () => () => stalledBuilder() }
) as any;

// TASK-448: the algod/indexer awaits off the balance path were unbounded, so a
// hung node left history screens, asset search and send prep spinning forever.
// Each row must still be pending just before the deadline and settle at it.
describe('NetworkService off-balance-path calls are bounded (TASK-448)', () => {
  let service: NetworkService;
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.useFakeTimers();
    service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    (service as any).algodClient = stalledClient;
    (service as any).indexerClient = stalledClient;
    (service as any).mimirService = null;
    global.fetch = jest.fn(() => never()) as any;
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  type Outcome = { rejects: string } | { resolves: unknown };
  const rows: [string, (s: NetworkService) => Promise<unknown>, Outcome][] = [
    [
      'getTransactionHistory',
      (s) => s.getTransactionHistory(ADDRESS),
      { rejects: 'transaction history timed out' },
    ],
    [
      'getAssetTransactionHistory (payments)',
      (s) => s.getAssetTransactionHistory(ADDRESS, 0),
      { rejects: 'payment transaction history timed out' },
    ],
    [
      'getAssetTransactionHistory (ASA)',
      (s) => s.getAssetTransactionHistory(ADDRESS, 1234),
      { rejects: 'asset transaction history timed out' },
    ],
    [
      'getAllTransactionHistory',
      (s) => s.getAllTransactionHistory(ADDRESS),
      { rejects: 'all transaction history timed out' },
    ],
    [
      'getFirstTransaction',
      (s) => s.getFirstTransaction(ADDRESS),
      { resolves: null },
    ],
    [
      'getAccountInfo',
      (s) => s.getAccountInfo(ADDRESS),
      { rejects: 'account info timed out' },
    ],
    [
      'getTransactionParams',
      (s) => s.getTransactionParams(),
      { rejects: 'transaction params timed out' },
    ],
    [
      'searchAssets',
      (s) => s.searchAssets('voi'),
      { rejects: 'request deadline exceeded' },
    ],
  ];

  it.each(rows)(
    '%s settles at the deadline, not before',
    async (_name, call, outcome) => {
      let settled = false;
      const pending = call(service).finally(() => {
        settled = true;
      });
      const assertion =
        'rejects' in outcome
          ? expect(pending).rejects.toThrow(outcome.rejects)
          : expect(pending).resolves.toEqual(outcome.resolves);

      await jest.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      await assertion;
    }
  );

  it('searchAssets bounds the unit-name fallback fetch too', async () => {
    (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ assets: [] }),
      json: async () => ({ assets: [] }),
    }));

    const pending = service.searchAssets('voi');
    const rejected = expect(pending).rejects.toThrow(
      'request deadline exceeded'
    );
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await rejected;
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  // Every send goes through submitTransaction, whose timeout is classified as
  // "may have been sent" (TASK-440 #8). The unbounded, unclassified
  // sendRawTransaction wrapper had no callers and is gone.
  it('exposes no raw send path beside submitTransaction', () => {
    expect((service as any).sendRawTransaction).toBeUndefined();
  });
});
