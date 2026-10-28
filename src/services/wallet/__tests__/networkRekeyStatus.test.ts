import { NetworkId } from '@/types/network';
import type { RekeyInfo } from '@/services/network';
import {
  NetworkRekeyStatusService,
  classifyNetworkRekey,
  aggregateNetworkRekey,
  REKEY_STATUS_TTL,
} from '../networkRekeyStatus';
import {
  invalidateRekeyStatus,
  getRekeyStatusEpoch,
} from '../rekeyStatusInvalidation';
jest.mock('@/services/network', () => ({
  NetworkService: { getInstance: jest.fn() },
}));
const networks = [NetworkId.VOI_MAINNET, NetworkId.ALGORAND_MAINNET];
const delegated = { isRekeyed: true, authAddress: 'AUTH' };
const deferred = () => {
  let resolve!: (info: RekeyInfo) => void;
  const promise = new Promise<RekeyInfo>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
let service: NetworkRekeyStatusService;
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  service?.invalidate();
  jest.useRealTimers();
});

it.each([
  [{ isRekeyed: false }, { status: 'self' }],
  [{ isRekeyed: true, authAddress: 'SOURCE' }, { status: 'self' }],
  [delegated, { status: 'delegated', authAddress: 'AUTH' }],
  [{ isRekeyed: false, unavailable: true }, { status: 'unknown' }],
  [{ isRekeyed: true }, { status: 'unknown' }],
])('classifies %p', (info, expected) => {
  expect(classifyNetworkRekey('SOURCE', info)).toEqual(expected);
});
it('requires positive delegation on every network, including a newly configured network', async () => {
  service = new NetworkRekeyStatusService(jest.fn(async () => delegated));
  expect(service.get('SOURCE').delegatedEverywhere).toBe(false);
  await service.ensure('SOURCE');
  expect(service.get('SOURCE').delegatedEverywhere).toBe(true);
  service.setNetworks([...networks, 'future-network' as NetworkId]);
  expect(
    service.get('SOURCE').perNetwork['future-network' as NetworkId]
  ).toEqual({ status: 'unknown' });
  expect(service.get('SOURCE').delegatedEverywhere).toBe(false);
  expect(
    aggregateNetworkRekey([
      { status: 'delegated', authAddress: 'A' },
      { status: 'unknown' },
    ])
  ).toBe(false);
  expect(aggregateNetworkRekey([])).toBe(false);
});
it('reports independent self, unavailable, offline/error and loading states', async () => {
  const pending = deferred();
  const lookup = jest.fn((_a: string, n: NetworkId) =>
    n === networks[0] ? Promise.resolve(delegated) : pending.promise
  );
  service = new NetworkRekeyStatusService(lookup);
  const load = service.ensure('SOURCE');
  expect(service.get('SOURCE').perNetwork[networks[1]]).toEqual({
    status: 'unknown',
  });
  pending.resolve({ isRekeyed: false });
  await load;
  expect(service.get('SOURCE').perNetwork[networks[0]].status).toBe(
    'delegated'
  );
  expect(service.get('SOURCE').perNetwork[networks[1]].status).toBe('self');
  expect(service.get('SOURCE').delegatedEverywhere).toBe(false);
  service.invalidate();
  lookup.mockRejectedValue(new Error('offline'));
  await service.ensure('SOURCE');
  expect(
    Object.values(service.get('SOURCE').perNetwork).every(
      (v) => v.status === 'unknown'
    )
  ).toBe(true);
  expect(service.get('SOURCE').delegatedEverywhere).toBe(false);
  service.invalidate();
  lookup.mockResolvedValue({ isRekeyed: false, unavailable: true });
  await service.ensure('SOURCE');
  expect(service.get('SOURCE').delegatedEverywhere).toBe(false);
});
it('deduplicates concurrent misses, reuses fresh results and expires to unknown', async () => {
  const pending = deferred();
  const lookup = jest.fn(() => pending.promise);
  service = new NetworkRekeyStatusService(lookup);
  const first = service.ensure('SOURCE');
  const second = service.ensure('SOURCE');
  expect(lookup).toHaveBeenCalledTimes(2);
  pending.resolve(delegated);
  await Promise.all([first, second]);
  await service.ensure('SOURCE');
  expect(lookup).toHaveBeenCalledTimes(2);
  jest.advanceTimersByTime(REKEY_STATUS_TTL);
  expect(service.get('SOURCE').delegatedEverywhere).toBe(false);
  await service.ensure('SOURCE');
  expect(lookup).toHaveBeenCalledTimes(4);
});
it('bounds concurrency across addresses and discards invalidated in-flight and queued work', async () => {
  const old = deferred();
  const lookup = jest.fn(() => old.promise);
  service = new NetworkRekeyStatusService(lookup);
  const first = service.ensure('SOURCE');
  const queued = service.ensure('OTHER');
  expect(lookup).toHaveBeenCalledTimes(2);
  service.invalidate();
  lookup.mockResolvedValue({ isRekeyed: false });
  const fresh = service.ensure('SOURCE');
  old.resolve(delegated);
  await Promise.all([first, queued, fresh]);
  expect(lookup).toHaveBeenCalledTimes(4);
  expect(
    Object.values(service.get('SOURCE').perNetwork).every(
      (v) => v.status === 'self'
    )
  ).toBe(true);
  expect(service.get('OTHER').delegatedEverywhere).toBe(false);
});
it('advances the shared invalidation epoch for lower-layer cache rejection', () => {
  const before = getRekeyStatusEpoch();
  invalidateRekeyStatus();
  expect(getRekeyStatusEpoch()).toBe(before + 1);
});
