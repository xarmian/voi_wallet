/**
 * Offline gating of the four retry ladders (TASK-191).
 *
 * These exercise the REAL gate against a mocked platform connectivity adapter,
 * so what is under test is the wiring — a service that stopped importing the
 * gate, or one that started importing it when it should not have, fails here.
 *
 * Scope is exactly four services: mimir, price, algorand-price, envoi. The last
 * describe block pins the two that are deliberately NOT gated
 * (token-mapping, snowball) so a later change cannot silently widen it.
 */

import algosdk from 'algosdk';
import type { ConnectivityState } from '@/platform';

// token-mapping (one of the deliberately-ungated services asserted below)
// reaches AsyncStorage, whose native module is absent under jest.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const mockSubscribe = jest.fn();
const mockGetState = jest.fn();

jest.mock('@/platform', () => {
  const actual = jest.requireActual('@/platform');
  return {
    ...actual,
    connectivity: {
      subscribe: (listener: (state: ConnectivityState) => void) =>
        mockSubscribe(listener),
      getState: () => mockGetState(),
    },
  };
});

import {
  getOfflineCounters,
  getReachability,
  resetOfflineGate,
} from '../offline';
import MimirApiService, { MimirApiError } from '@/services/mimir';
import VoiPriceService from '@/services/price';
import AlgorandPriceService from '@/services/algorand-price';
import EnvoiService from '@/services/envoi';
import tokenMappingService from '@/services/token-mapping';
import snowballService from '@/services/snowball';

const ONLINE: ConnectivityState = {
  isConnected: true,
  isInternetReachable: true,
  type: 'wifi',
};

const OFFLINE: ConnectivityState = {
  isConnected: false,
  isInternetReachable: false,
  type: 'none',
};

type Deferred = {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const jsonResponse = (body: unknown) => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  json: async () => body,
});

const envoi = EnvoiService.getInstance();
const snowball = snowballService;

describe('offline gating of retry ladders (TASK-191)', () => {
  let emit: (state: ConnectivityState) => void;
  let fetchMock: jest.Mock;

  const goOffline = () => emit(OFFLINE);
  const goOnline = () => emit(ONLINE);

  beforeEach(() => {
    mockSubscribe.mockImplementation(
      (listener: (state: ConnectivityState) => void) => {
        emit = listener;
        return jest.fn();
      }
    );
    // Never settles: the subscription is the only source of truth here.
    mockGetState.mockImplementation(() => new Promise(() => {}));
    resetOfflineGate();
    // The gate primes lazily on first read; read once here so `emit` exists.
    // Reachability is still `unknown` (nothing emitted yet) until a test calls
    // goOnline()/goOffline().
    getReachability();

    fetchMock = jest.fn();
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});

    // Short ladders so the ONLINE cases never sleep for real.
    MimirApiService.updateConfig({
      retryAttempts: 3,
      retryDelay: 0,
      timeout: 50,
    });
    VoiPriceService.updateConfig({
      retryAttempts: 3,
      retryDelay: 0,
      timeout: 50,
    });
    VoiPriceService.clearCache();
    AlgorandPriceService.updateConfig({
      retryAttempts: 3,
      retryDelay: 0,
      timeout: 50,
    });
    AlgorandPriceService.clearCache();
    // Envoi exposes no config setter; its ladder delay is shortened directly.
    // Each envoi test uses a freshly generated address, so its cache needs no
    // reset between tests. The abort timer matters too: none of these services
    // clears it on a REJECTED fetch, so a 10s default would outlive the run.
    const envoiConfig = (envoi as unknown as { config: Record<string, number> })
      .config;
    envoiConfig.retryDelay = 0;
    envoiConfig.timeout = 50;
  });

  afterEach(() => {
    resetOfflineGate();
    jest.restoreAllMocks();
  });

  describe('MimirApiService', () => {
    it('skips the ladder entirely while offline', async () => {
      goOffline();

      await expect(
        MimirApiService.getArc200TokensMetadata([1])
      ).rejects.toBeInstanceOf(MimirApiError);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getOfflineCounters().offlineSkipsByScope.mimir).toBe(1);
    });

    it('fails with the SAME shape the exhausted ladder produces', async () => {
      goOffline();

      // Deliberately not a distinguishable offline error: callers keep the one
      // failure contract they already handle.
      await expect(
        MimirApiService.getArc200TokensMetadata([1])
      ).rejects.toMatchObject({
        name: 'MimirApiError',
        code: 'NETWORK_ERROR',
      });
    });

    it('leaves the ladder intact while online', async () => {
      goOnline();
      fetchMock.mockRejectedValue(new Error('boom'));

      await expect(
        MimirApiService.getArc200TokensMetadata([1])
      ).rejects.toBeInstanceOf(MimirApiError);
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(getOfflineCounters().offlineSkips).toBe(0);
    });

    it('leaves a successful request untouched while online', async () => {
      goOnline();
      fetchMock.mockResolvedValue(jsonResponse({ tokens: [] }));

      await expect(
        MimirApiService.getArc200TokensMetadata([1])
      ).resolves.toMatchObject({ tokens: [] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('VoiPriceService', () => {
    it('skips the ladder and falls back exactly as a failed fetch does', async () => {
      goOffline();

      // No cached price → the existing fallback is 0, unchanged.
      await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getOfflineCounters().offlineSkipsByScope['voi-price']).toBe(1);
    });

    it('serves the retained stale price while offline', async () => {
      goOnline();
      fetchMock.mockResolvedValue(
        jsonResponse({
          marketData: [],
          aggregates: {
            totalVolume: 0,
            totalTvl: 0,
            weightedAveragePrice: 0.42,
          },
          circulatingSupply: { circulatingSupply: 0, percentDistributed: 0 },
        })
      );
      await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.42);

      const nowSpy = jest
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + 60 * 60 * 1000);
      goOffline();
      fetchMock.mockClear();

      await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0.42);
      expect(fetchMock).not.toHaveBeenCalled();
      nowSpy.mockRestore();
    });

    it('leaves the ladder intact while online', async () => {
      goOnline();
      fetchMock.mockRejectedValue(new Error('boom'));

      await expect(VoiPriceService.getVoiPrice()).resolves.toBe(0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('AlgorandPriceService', () => {
    it('skips the ladder while offline and applies the stale fallback', async () => {
      goOffline();

      await expect(
        AlgorandPriceService.getAssetPrices([31566704])
      ).resolves.toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getOfflineCounters().offlineSkipsByScope['algorand-price']).toBe(
        1
      );
    });

    it('leaves the ladder intact while online', async () => {
      goOnline();
      fetchMock.mockRejectedValue(new Error('boom'));

      await AlgorandPriceService.getAssetPrices([31566704]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('leaves a successful request untouched while online', async () => {
      goOnline();
      fetchMock.mockResolvedValue(
        jsonResponse([
          {
            network_id: 0,
            asset_id: 31566704,
            denominating_asset_id: 31566704,
            price: 1,
            confidence: 1,
            total_lockup: 0,
          },
        ])
      );

      const prices = await AlgorandPriceService.getAssetPrices([31566704]);
      expect(prices.get(31566704)).toBe(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('EnvoiService', () => {
    const freshAddress = () => algosdk.generateAccount().addr.toString();

    it('skips the ladder while offline and still resolves to null', async () => {
      goOffline();

      await expect(envoi.getName(freshAddress())).resolves.toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(getOfflineCounters().offlineSkipsByScope.envoi).toBe(1);
    });

    it('leaves the ladder intact while online', async () => {
      goOnline();
      fetchMock.mockRejectedValue(new Error('boom'));

      await expect(envoi.getName(freshAddress())).resolves.toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not leave isLoading stuck when the device goes offline mid-flight', async () => {
      goOnline();
      const address = freshAddress();

      let deferred!: Deferred;
      fetchMock.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            deferred = { resolve, reject };
          })
      );

      const inFlight = envoi.getName(address);
      await flush();

      // Connectivity drops while the request is outstanding. The gate is
      // checked on entry, not mid-ladder, so the outstanding request keeps its
      // existing behaviour: it fails and the remaining attempts fail too.
      goOffline();
      fetchMock.mockRejectedValue(new Error('network lost'));
      deferred.reject(new Error('network lost'));

      await expect(inFlight).resolves.toBeNull();

      const cache = (
        envoi as unknown as {
          cache: { namesByAddress: Map<string, { isLoading: boolean }> };
        }
      ).cache.namesByAddress;
      expect(cache.get(address)?.isLoading).toBe(false);

      const pending = (
        envoi as unknown as { pendingNameRequests: Map<string, unknown> }
      ).pendingNameRequests;
      expect(pending.has(address)).toBe(false);
    });
  });

  describe('cold start (unknown reachability)', () => {
    it('does not gate anything before the adapter has answered', async () => {
      // No emit(): the snapshot is still `unknown`, which must fail OPEN.
      fetchMock.mockResolvedValue(jsonResponse({ tokens: [] }));

      await MimirApiService.getArc200TokensMetadata([1]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getOfflineCounters().offlineSkips).toBe(0);
    });
  });

  describe('services deliberately NOT gated', () => {
    it('token-mapping still runs its retry ladder while offline', async () => {
      goOffline();

      // Cached mappings already make an offline failure cheap here, so gating
      // it would be scope creep. Pin that it is untouched.
      tokenMappingService.updateConfig({
        apiUrl: 'https://example.invalid/mappings',
        retryAttempts: 3,
        timeout: 50,
      });
      jest
        .spyOn(
          tokenMappingService as unknown as { sleep: () => Promise<void> },
          'sleep'
        )
        .mockResolvedValue(undefined);
      fetchMock.mockRejectedValue(new Error('boom'));

      await tokenMappingService.getTokenMappings(true);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(getOfflineCounters().offlineSkips).toBe(0);
    });

    it('snowball still attempts the request while offline', async () => {
      goOffline();

      // User-initiated swap-quote path: failing fast is already acceptable, so
      // it is out of scope. A non-retryable rejection keeps this assertion on
      // "the request went out", without sitting through snowball's fixed
      // (non-configurable) 1s/2s/3s backoff.
      fetchMock.mockRejectedValue(new Error('boom'));

      await expect(snowball.healthCheck()).rejects.toThrow();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getOfflineCounters().offlineSkips).toBe(0);
    });
  });
});
