import algosdk from 'algosdk';
import { NetworkService } from '../index';
import { NetworkId } from '@/types/network';
import AlgorandPriceService from '@/services/algorand-price';

// A syntactically valid address (all-zero public key) so isValidAddress passes.
const ADDRESS = algosdk.encodeAddress(new Uint8Array(32));
// A distinct, valid auth address for the rekeyed-account cases.
const AUTH_ADDR = algosdk.encodeAddress(new Uint8Array(32).fill(7));
const AUTH_PUBLIC_KEY = algosdk.decodeAddress(AUTH_ADDR).publicKey;

interface AlgodProbe {
  algodClient: any;
  accountInfoCalls: () => number;
  getAssetByIDIds: () => number[];
  maxInFlight: () => number;
}

/**
 * Build a mock algod client that records how many times accountInformation is
 * called (to prove the dedup) and the peak concurrency of getAssetByID (to
 * prove the batch is concurrency-capped, not unbounded).
 */
function makeAlgodProbe(accountResponse: any, assetDelayMs = 5): AlgodProbe {
  let accountInfoCalls = 0;
  const getAssetByIDIds: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const algodClient = {
    accountInformation: (_addr: string) => ({
      do: async () => {
        accountInfoCalls += 1;
        return accountResponse;
      },
    }),
    getAssetByID: (id: number) => ({
      do: async () => {
        getAssetByIDIds.push(id);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, assetDelayMs));
        inFlight -= 1;
        return {
          params: { decimals: 6, name: `Asset ${id}`, unitName: `A${id}` },
        };
      },
    }),
  };

  return {
    algodClient,
    accountInfoCalls: () => accountInfoCalls,
    getAssetByIDIds: () => [...getAssetByIDIds],
    maxInFlight: () => maxInFlight,
  };
}

function makeAssets(count: number, startId = 1000) {
  return Array.from({ length: count }, (_, i) => ({
    assetId: BigInt(startId + i),
    amount: BigInt(100 + i),
  }));
}

describe('NetworkService.getAccountBalance (batch + dedupe, TASK-46)', () => {
  let service: NetworkService;

  beforeEach(() => {
    service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    // Wipe shared-singleton caches so each test starts clean.
    (service as any).assetParamsCache.clear();
    (service as any).rekeyInfoCache.clear();
    // Neutralise the heavy side-paths so we can focus on batching + dedupe.
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([]);
    jest.spyOn(service, 'isFeatureAvailable').mockReturnValue(true);
    jest
      .spyOn(AlgorandPriceService, 'getAssetPrices')
      .mockResolvedValue(new Map<number, number>([[0, 1.5]]));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('reads rekey authority from an INDEPENDENT fetch, not the shared balance snapshot (DR-1); dedupes only pricing', async () => {
    // DR-1 guard: the balance snapshot is plain, but the rekey path's own
    // (distinct, later) request shows the account rekeyed. The returned
    // rekeyInfo MUST reflect rekey's own fetch — proving the shared balance
    // snapshot is never fed into the signing-authority path. This is why the
    // rekey fetch is intentionally NOT deduped (only pricing is).
    const balanceSnapshot = {
      amount: 5_000_000n,
      minBalance: 100_000n,
      assets: [],
    };
    const rekeySnapshot = {
      amount: 5_000_000n,
      minBalance: 100_000n,
      assets: [],
      authAddr: { publicKey: AUTH_PUBLIC_KEY },
    };
    let callCount = 0;
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => {
          callCount += 1;
          // Call 1 = balance (shared into pricing); call 2 = rekey's own fetch.
          return callCount === 1 ? balanceSnapshot : rekeySnapshot;
        },
      }),
    };
    (service as any).indexerClient = {
      lookupAccountTransactions: () => ({
        txType: () => ({
          limit: () => ({
            do: async () => ({
              transactions: [{ rekeyTo: AUTH_ADDR, roundTime: 1_700_000_000 }],
            }),
          }),
        }),
      }),
    };

    const result = await service.getAccountBalance(ADDRESS);

    // rekeyInfo reflects rekey's OWN (rekeyed) snapshot, not the plain balance
    // snapshot — byte-identical to pre-refactor independent-fetch behavior.
    expect(result.rekeyInfo).toEqual({
      isRekeyed: true,
      authAddress: AUTH_ADDR,
      rekeyedAt: 1_700_000_000 * 1000,
    });
    // Exactly 2 accountInformation calls on Algorand: balance (reused by
    // pricing) + rekey's independent fetch. Pre-refactor was 3 (pricing
    // re-fetched); the pricing dedup removes that third call.
    expect(callCount).toBe(2);
    // Pricing ran off the shared balance snapshot (no assets → just ALGO).
    expect(AlgorandPriceService.getAssetPrices).toHaveBeenCalledWith([0]);
  });

  it('resolves ASA metadata in a concurrency-capped batch (not serial, not unbounded)', async () => {
    const HOLDINGS = 20;
    const probe = makeAlgodProbe({
      amount: 5_000_000n,
      minBalance: 100_000n,
      assets: makeAssets(HOLDINGS),
    });
    (service as any).algodClient = probe.algodClient;

    const result = await service.getAccountBalance(ADDRESS);

    // Every holding is looked up...
    expect(probe.getAssetByIDIds()).toHaveLength(HOLDINGS);
    expect(result.assets).toHaveLength(HOLDINGS);
    // ...concurrently (peak > 1, so it's not the old serial loop)...
    expect(probe.maxInFlight()).toBeGreaterThan(1);
    // ...but bounded by the cap of 8 (never fans out to all 20 at once).
    expect(probe.maxInFlight()).toBeLessThanOrEqual(8);
    // Output order matches the account's holdings order.
    expect(result.assets.map((a) => a.assetId)).toEqual(
      makeAssets(HOLDINGS).map((a) => Number(a.assetId))
    );
  });

  it('preserves the assetParamsCache: a second load re-uses cached params (no repeat getAssetByID)', async () => {
    const probe = makeAlgodProbe({
      amount: 5_000_000n,
      minBalance: 100_000n,
      assets: makeAssets(4),
    });
    (service as any).algodClient = probe.algodClient;

    await service.getAccountBalance(ADDRESS);
    expect(probe.getAssetByIDIds()).toHaveLength(4);

    await service.getAccountBalance(ADDRESS);
    // Still 4 total — the second load hit the immutable-params cache.
    expect(probe.getAssetByIDIds()).toHaveLength(4);
  });

  it('omits (does not fabricate) an asset whose getAssetByID rejects, without failing the batch', async () => {
    const probe = makeAlgodProbe({
      amount: 5_000_000n,
      minBalance: 100_000n,
      assets: makeAssets(3),
    });
    // Make the middle asset's lookup reject; the other two must still resolve.
    const failingId = 1001;
    const originalGetAssetByID = probe.algodClient.getAssetByID;
    probe.algodClient.getAssetByID = (id: number) => {
      if (id === failingId) {
        return { do: async () => Promise.reject(new Error('boom')) };
      }
      return originalGetAssetByID(id);
    };
    (service as any).algodClient = probe.algodClient;

    const result = await service.getAccountBalance(ADDRESS);

    expect(result.assets.map((a) => a.assetId)).toEqual([1000, 1002]);
  });

  it('omits (and does not cache a fabricated 0 for) a FULFILLED asset with undefined/invalid decimals, but keeps a real decimals:0', async () => {
    const undefinedDecId = 1000; // fulfilled but params.decimals is missing
    const zeroDecId = 1001; // legitimate 0-decimals ASA (defined 0)
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => ({
          amount: 1n,
          minBalance: 1n,
          assets: [
            { assetId: BigInt(undefinedDecId), amount: 5n },
            { assetId: BigInt(zeroDecId), amount: 7n },
          ],
        }),
      }),
      getAssetByID: (id: number) => ({
        do: async () =>
          id === undefinedDecId
            ? { params: { name: 'No Decimals', unitName: 'NODEC' } }
            : {
                params: {
                  decimals: 0,
                  name: 'Zero Decimals',
                  unitName: 'ZERO',
                },
              },
      }),
    };

    const result = await service.getAccountBalance(ADDRESS);

    // Malformed-decimals asset omitted (never fabricated to 0); real 0 kept.
    expect(result.assets.map((a) => a.assetId)).toEqual([zeroDecId]);
    expect(result.assets.find((a) => a.assetId === zeroDecId)?.decimals).toBe(
      0
    );
    // No fabricated 0 cached for the malformed asset...
    expect((service as any).assetParamsCache.has(String(undefinedDecId))).toBe(
      false
    );
    // ...but the genuine 0-decimals asset IS cached.
    expect(
      (service as any).assetParamsCache.get(String(zeroDecId))?.decimals
    ).toBe(0);
  });
});

describe('NetworkService.getAccountRekeyInfo (independent fetch, DR-1)', () => {
  let service: NetworkService;

  const makeIndexer = () => ({
    lookupAccountTransactions: () => ({
      txType: () => ({
        limit: () => ({
          do: async () => ({
            transactions: [{ rekeyTo: AUTH_ADDR, roundTime: 1_700_000_000 }],
          }),
        }),
      }),
    }),
  });

  beforeEach(() => {
    service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    (service as any).rekeyInfoCache.clear();
    (service as any).indexerClient = makeIndexer();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a PLAIN account resolves to { isRekeyed: false } from its own accountInformation fetch', async () => {
    const plainAccount = { amount: 1n, minBalance: 1n, assets: [] };
    let accountInfoCalls = 0;
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => {
          accountInfoCalls += 1;
          return plainAccount;
        },
      }),
    };

    const result = await service.getAccountRekeyInfo(ADDRESS);

    expect(result).toEqual({ isRekeyed: false });
    expect(accountInfoCalls).toBe(1);
  });

  it('a REKEYED account resolves authAddress + rekeyedAt from its own fetch + indexer lookup', async () => {
    const rekeyedAccount = {
      amount: 1n,
      minBalance: 1n,
      assets: [],
      authAddr: { publicKey: AUTH_PUBLIC_KEY },
    };
    let accountInfoCalls = 0;
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => {
          accountInfoCalls += 1;
          return rekeyedAccount;
        },
      }),
    };

    const result = await service.getAccountRekeyInfo(ADDRESS);

    // This is the signing-authority surface persisted into canSign/authAddress.
    expect(result).toEqual({
      isRekeyed: true,
      authAddress: AUTH_ADDR,
      rekeyedAt: 1_700_000_000 * 1000,
    });
    expect(accountInfoCalls).toBe(1);
  });

  it('skips the rekeyedAt indexer lookup when skipTimestamp is true (signing path), unchanged', async () => {
    const rekeyedAccount = { authAddr: { publicKey: AUTH_PUBLIC_KEY } };
    (service as any).algodClient = {
      accountInformation: () => ({ do: async () => rekeyedAccount }),
    };
    let indexerCalls = 0;
    (service as any).indexerClient = {
      lookupAccountTransactions: () => {
        indexerCalls += 1;
        return makeIndexer().lookupAccountTransactions();
      },
    };

    const result = await service.getAccountRekeyInfo(ADDRESS, true);

    expect(result).toEqual({ isRekeyed: true, authAddress: AUTH_ADDR });
    expect(indexerCalls).toBe(0);
  });

  it('returns a fresh cache entry without a network fetch (cache semantics preserved)', async () => {
    const cachedInfo = { isRekeyed: false };
    (service as any).rekeyInfoCache.set(ADDRESS, {
      info: cachedInfo,
      timestamp: Date.now(),
    });
    let accountInfoCalls = 0;
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => {
          accountInfoCalls += 1;
          return { authAddr: { publicKey: AUTH_PUBLIC_KEY } };
        },
      }),
    };

    const result = await service.getAccountRekeyInfo(ADDRESS);

    expect(result).toBe(cachedInfo);
    expect(accountInfoCalls).toBe(0);
  });
});
