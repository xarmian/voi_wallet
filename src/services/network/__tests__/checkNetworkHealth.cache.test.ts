import { NetworkService } from '../index';
import { NetworkId, NetworkStatus } from '@/types/network';

// A completed, healthy probe result. performNetworkHealthCheck is stubbed so
// these tests exercise the TTL/in-flight wrapper (F-04) without real HTTP.
const HEALTHY: NetworkStatus = {
  isConnected: true,
  lastSync: 0,
  algodHeight: 100,
  indexerHealth: true,
};

describe('NetworkService.checkNetworkHealth TTL cache + dedup (F-04, TASK-178)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('dedupes concurrent health checks into a single underlying probe (in-flight)', async () => {
    const service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    (service as any).healthCheckCache.clear();
    (service as any).healthCheckInFlight.clear();

    let resolveProbe!: (status: NetworkStatus) => void;
    const spy = jest
      .spyOn(service as any, 'performNetworkHealthCheck')
      .mockImplementation(
        () =>
          new Promise<NetworkStatus>((resolve) => {
            resolveProbe = resolve;
          })
      );

    // Two callers race in the same tick; the second must reuse the first's
    // in-flight probe rather than issuing its own.
    const p1 = service.checkNetworkHealth();
    const p2 = service.checkNetworkHealth();

    expect(spy).toHaveBeenCalledTimes(1);

    resolveProbe(HEALTHY);
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.isConnected).toBe(true);
    expect(r2.isConnected).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('serves the cached status within the TTL and re-probes once it expires (or is forced)', async () => {
    const service = NetworkService.getInstance(NetworkId.ALGORAND_MAINNET);
    (service as any).healthCheckCache.clear();
    (service as any).healthCheckInFlight.clear();

    const spy = jest
      .spyOn(service as any, 'performNetworkHealthCheck')
      .mockResolvedValue(HEALTHY);

    await service.checkNetworkHealth();
    await service.checkNetworkHealth();
    // Second call is served from the TTL cache — no new probe.
    expect(spy).toHaveBeenCalledTimes(1);

    // Expire the cached entry and confirm the next call re-probes.
    const key = (service as any).currentNetworkId as NetworkId;
    const entry = (service as any).healthCheckCache.get(key);
    entry.timestamp =
      Date.now() - ((NetworkService as any).HEALTH_CHECK_TTL_MS + 1);

    await service.checkNetworkHealth();
    expect(spy).toHaveBeenCalledTimes(2);

    // force:true always re-probes, even within the TTL.
    await service.checkNetworkHealth({ force: true });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('invalidates the health-check cache on switchNetwork', async () => {
    const service = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    (service as any).healthCheckCache.clear();
    (service as any).healthCheckInFlight.clear();

    jest
      .spyOn(service as any, 'performNetworkHealthCheck')
      .mockResolvedValue(HEALTHY);

    await service.checkNetworkHealth();
    expect((service as any).healthCheckCache.has(NetworkId.VOI_MAINNET)).toBe(
      true
    );

    await service.switchNetwork(NetworkId.ALGORAND_MAINNET);

    // The pre-switch entry (keyed by the old network) must be gone so the
    // switched-to network can never be served a stale result.
    expect((service as any).healthCheckCache.has(NetworkId.VOI_MAINNET)).toBe(
      false
    );
    expect(service.getCurrentNetworkId()).toBe(NetworkId.ALGORAND_MAINNET);

    // Let the fire-and-forget post-switch probe settle to avoid dangling work.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('discards a post-switch stale probe (does not clobber status or re-add the cache)', async () => {
    const service = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    (service as any).healthCheckCache.clear();
    (service as any).healthCheckInFlight.clear();

    const baseline: NetworkStatus = {
      isConnected: false,
      lastSync: 111,
      algodHeight: 0,
      indexerHealth: false,
    };
    (service as any).networkStatus = { ...baseline };

    // Deferred raw algod client so the probe can settle AFTER we simulate a
    // switch. Exercises the REAL performNetworkHealthCheck (not a stub).
    let resolveAlgod!: (v: unknown) => void;
    (service as any).algodClient = {
      status: () => ({
        do: () =>
          new Promise((resolve) => {
            resolveAlgod = resolve;
          }),
      }),
    };
    (service as any).indexerClient = {
      makeHealthCheck: () => ({ do: async () => ({}) }),
    };

    // Probe starts on VOI, capturing the current generation.
    const probe = service.checkNetworkHealth();

    // Simulate switchNetwork's invalidation while the probe is in flight.
    (service as any).healthCheckCache.clear();
    (service as any).healthCheckInFlight.clear();
    (service as any).healthCheckGeneration++;

    resolveAlgod({ lastRound: 42 });
    await probe;

    // The stale (previous-network) result must neither overwrite the current
    // shared status nor re-populate the cache switchNetwork deliberately cleared.
    expect((service as any).networkStatus).toEqual(baseline);
    expect((service as any).healthCheckCache.has(NetworkId.VOI_MAINNET)).toBe(
      false
    );
  });

  it('does not block switchNetwork (cold launch to a non-default network) on a hung health probe', async () => {
    const service = NetworkService.getInstance(NetworkId.VOI_MAINNET);
    (service as any).healthCheckCache.clear();
    (service as any).healthCheckInFlight.clear();

    // Simulate an unavailable/hung node: the probe never settles.
    jest
      .spyOn(service as any, 'performNetworkHealthCheck')
      .mockImplementation(() => new Promise<NetworkStatus>(() => {}));

    // The switch performs client reconfiguration synchronously and must resolve
    // WITHOUT awaiting the health probe — otherwise a slow node stalls cold boot.
    await expect(
      service.switchNetwork(NetworkId.ALGORAND_MAINNET)
    ).resolves.toBeUndefined();
    expect(service.getCurrentNetworkId()).toBe(NetworkId.ALGORAND_MAINNET);
  });
});
