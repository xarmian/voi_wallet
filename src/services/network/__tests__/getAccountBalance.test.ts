import {
  NetworkRekeyStatusService,
  REKEY_STATUS_TTL,
} from '@/services/wallet/networkRekeyStatus';
import { invalidateRekeyStatus } from '@/services/wallet/rekeyStatusInvalidation';
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

  // TASK-421 (c): a failed rekey lookup must be distinguishable from "not
  // rekeyed", so nothing persists a metadata conversion from the fallback.
  it('flags a failed bulk rekey lookup unavailable, never plain not-rekeyed', async () => {
    jest
      .spyOn(service, 'getAccountRekeyInfo')
      .mockRejectedValue(new Error('algod 503'));
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await service.getMultipleAccountRekeyInfo([ADDRESS]);
    expect(result[ADDRESS]).toEqual({ isRekeyed: false, unavailable: true });
  });

  it('flags the rekey fallback unavailable when the rekey lookup fails', async () => {
    let callCount = 0;
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => {
          callCount += 1;
          if (callCount === 1) {
            return { amount: 1n, minBalance: 100_000n, assets: [] };
          }
          throw new Error('algod 503');
        },
      }),
    };
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.getAccountBalance(ADDRESS);

    expect(result.rekeyInfo).toEqual({ isRekeyed: false, unavailable: true });
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

  it('invalidates cached authority and rejects caching a response from before invalidation', async () => {
    let finish!: (info: object) => void;
    const fetch = jest.fn(
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        })
    );
    (service as any).algodClient = {
      accountInformation: () => ({ do: fetch }),
    };
    const pending = service.getAccountRekeyInfo(ADDRESS, true);
    invalidateRekeyStatus();
    finish({ authAddr: { publicKey: AUTH_PUBLIC_KEY } });
    await pending;
    expect(
      (service as any).rekeyInfoCache.has(
        `${service.getCurrentNetworkId()}:${ADDRESS}`
      )
    ).toBe(false);
    fetch.mockResolvedValue({});
    await service.getAccountRekeyInfo(ADDRESS, true);
    expect(fetch).toHaveBeenCalledTimes(2);
    invalidateRekeyStatus();
    await service.getAccountRekeyInfo(ADDRESS, true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it('isolates cached authority across switches and rejects a late old-network response', async () => {
    jest
      .spyOn(service as any, 'initializeClients')
      .mockImplementation(() => {});
    jest
      .spyOn(service as any, 'initializeMimirService')
      .mockImplementation(() => {});
    jest
      .spyOn(service as any, 'configureEnvoiService')
      .mockImplementation(() => {});
    jest
      .spyOn(service, 'checkNetworkHealth')
      .mockResolvedValue(undefined as any);
    await service.switchNetwork(NetworkId.VOI_MAINNET);
    const fetch = jest
      .fn()
      .mockResolvedValue({ authAddr: { publicKey: AUTH_PUBLIC_KEY } });
    (service as any).algodClient = {
      accountInformation: () => ({ do: fetch }),
    };
    expect((await service.getAccountRekeyInfo(ADDRESS, true)).isRekeyed).toBe(
      true
    );
    let finish!: (info: object) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = service.getAccountRekeyInfo(ADDRESS, true, true);
    const rejected = expect(pending).rejects.toThrow('Network changed');
    await service.switchNetwork(NetworkId.ALGORAND_MAINNET);
    fetch.mockResolvedValue({});
    expect(await service.getAccountRekeyInfo(ADDRESS, true)).toEqual({
      isRekeyed: false,
    });
    finish({ authAddr: { publicKey: AUTH_PUBLIC_KEY } });
    await rejected;
    expect(await service.getAccountRekeyInfo(ADDRESS, true)).toEqual({
      isRekeyed: false,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('bounds aggregate staleness to one TTL with an almost-expired network entry', async () => {
    jest.useFakeTimers();
    const status = new NetworkRekeyStatusService();
    status.setNetworks([NetworkId.ALGORAND_MAINNET]);
    jest.spyOn(NetworkService, 'getInstance').mockReturnValue(service);
    const fetch = jest
      .fn()
      .mockResolvedValue({ authAddr: { publicKey: AUTH_PUBLIC_KEY } });
    (service as any).algodClient = {
      accountInformation: () => ({ do: fetch }),
    };
    try {
      await service.getAccountRekeyInfo(ADDRESS, true);
      jest.advanceTimersByTime(REKEY_STATUS_TTL - 1);
      fetch.mockResolvedValue({});
      await status.ensure(ADDRESS);
      expect(
        status.get(ADDRESS).perNetwork[NetworkId.ALGORAND_MAINNET]
      ).toEqual({ status: 'self' });
      expect(fetch).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(REKEY_STATUS_TTL);
      expect(
        status.get(ADDRESS).perNetwork[NetworkId.ALGORAND_MAINNET]
      ).toEqual({ status: 'unknown' });
    } finally {
      status.invalidate();
      jest.useRealTimers();
    }
  });

  it('returns a fresh cache entry without a network fetch (cache semantics preserved)', async () => {
    const cachedInfo = { isRekeyed: false };
    (service as any).rekeyInfoCache.set(
      `${service.getCurrentNetworkId()}:${ADDRESS}`,
      {
        info: cachedInfo,
        timestamp: Date.now(),
      }
    );
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

// TASK-440 #7: a stalled rekey lookup used to block balance publication, and
// every deduplicated refresh joined the stalled promise.
describe('NetworkService rekey lookups are bounded (TASK-440 #7)', () => {
  let service: NetworkService;
  const never = () => new Promise<never>(() => {});
  const TIMEOUT_MS = 15000;

  beforeEach(() => {
    jest.useFakeTimers();
    service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    (service as any).assetParamsCache.clear();
    (service as any).rekeyInfoCache.clear();
    jest.spyOn(service as any, 'getMimirAssets').mockResolvedValue([]);
    jest.spyOn(service, 'isFeatureAvailable').mockReturnValue(true);
    jest
      .spyOn(AlgorandPriceService, 'getAssetPrices')
      .mockResolvedValue(new Map<number, number>([[0, 1.5]]));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a stalled rekey accountInformation rejects at the deadline and caches nothing', async () => {
    (service as any).algodClient = {
      accountInformation: () => ({ do: never }),
    };

    const pending = service.getAccountRekeyInfo(ADDRESS, true);
    const rejected = expect(pending).rejects.toThrow(
      'rekey account info timed out'
    );
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    await rejected;
    expect(
      (service as any).rekeyInfoCache.has(
        `${service.getCurrentNetworkId()}:${ADDRESS}`
      )
    ).toBe(false);
  });

  it('a stalled rekey timestamp lookup degrades to rekeyedAt undefined', async () => {
    (service as any).algodClient = {
      accountInformation: () => ({
        do: async () => ({ authAddr: { publicKey: AUTH_PUBLIC_KEY } }),
      }),
    };
    (service as any).indexerClient = {
      lookupAccountTransactions: () => ({
        txType: () => ({ limit: () => ({ do: never }) }),
      }),
    };

    const pending = service.getAccountRekeyInfo(ADDRESS);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);

    await expect(pending).resolves.toEqual({
      isRekeyed: true,
      authAddress: AUTH_ADDR,
      rekeyedAt: undefined,
    });
  });

  it('getAccountBalance publishes with rekey unavailable when only the rekey fetch stalls', async () => {
    let calls = 0;
    (service as any).algodClient = {
      accountInformation: () => ({
        // Call 1 = the balance snapshot; call 2 = rekey's own fetch (DR-1).
        do: () => {
          calls += 1;
          return calls === 1
            ? Promise.resolve({ amount: 5n, minBalance: 1n, assets: [] })
            : never();
        },
      }),
    };

    const pending = service.getAccountBalance(ADDRESS);
    await jest.advanceTimersByTimeAsync(TIMEOUT_MS);
    const result = await pending;

    expect(calls).toBe(2);
    expect(result.rekeyInfo).toEqual({ isRekeyed: false, unavailable: true });
  });
});
