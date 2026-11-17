import AsyncStorage from '@react-native-async-storage/async-storage';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  HandledRef,
  HandledStore,
  HANDLED_STORE_MAX_ENTRIES,
  SEEN_ONLY_TTL_MS,
} from '../handledStore';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const KEY = '@walletconnect_handled_v1';
const ref: HandledRef = {
  version: 2,
  kind: 'request',
  topic: 'private-topic-for-persistence-test',
  id: 'private-request-identity',
};
const hash = (r: HandledRef) =>
  bytesToHex(
    sha256(
      utf8ToBytes(JSON.stringify([r.version, r.kind, r.topic, String(r.id)]))
    )
  );
const read = async (): Promise<{
  v: number;
  e: { h: string; s: number; d?: number; o?: string }[];
}> => JSON.parse((await AsyncStorage.getItem(KEY)) ?? '{}');
let now: number;
let store: HandledStore;

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  now = 1_800_000_000_000;
  store = new HandledStore({ now: () => now });
});
afterEach(() => jest.restoreAllMocks());

it('DEFECT handled identity survives a restart', async () => {
  await store.markHandled(ref, 'approved');
  const restarted = new HandledStore();
  await restarted.load();
  expect(restarted.isHandled(ref)).toBe(true);
});

it('DEFECT persistence contains only the hash, timestamps and outcome, no raw ref', async () => {
  await store.markHandled(ref, 'rejected');
  const raw = (await AsyncStorage.getItem(KEY)) ?? '';
  expect(raw).not.toContain(ref.topic);
  expect(raw).not.toContain(String(ref.id));
  const saved = await read();
  expect(saved).toEqual({
    v: 1,
    e: [{ h: hash(ref), s: now, d: now, o: 'rejected' }],
  });
  expect(saved.e[0].h).toMatch(/^[0-9a-f]{64}$/);
});

it('DEFECT firstSeen is stable across redelivery and restart without repeat writes', async () => {
  const t0 = now;
  expect(await store.noteSeen(ref)).toBe(t0);
  now += 4 * 60_000;
  expect(await store.noteSeen(ref)).toBe(t0);
  expect(store.firstSeen(ref)).toBe(t0);
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
  now = t0 + 10 * 60_000;
  const restarted = new HandledStore({ now: () => now });
  expect(await restarted.noteSeen(ref)).toBe(t0);
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
});

it('DEFECT kind and version separate identities while numeric and string ids collide', async () => {
  const numeric = { ...ref, id: 5 };
  await store.markHandled(numeric, 'approved');
  expect(store.isHandled({ ...numeric, id: '5' })).toBe(true);
  expect(store.isHandled({ ...numeric, kind: 'proposal' })).toBe(false);
  expect(store.isHandled({ ...numeric, version: 1 })).toBe(false);
  await store.markHandled({ ...numeric, kind: 'proposal' }, 'rejected');
  await store.markHandled({ ...numeric, version: 1 }, 'rejected');
  expect((await read()).e).toHaveLength(3);
});

it('REGRESSION first decision wins and its outcome is never overwritten', async () => {
  expect(await store.markHandled(ref, 'approved')).toBe(true);
  now++;
  expect(await store.markHandled(ref, 'rejected')).toBe(false);
  expect((await read()).e[0]).toMatchObject({ o: 'approved', d: now - 1 });
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(1);
});

it('DEFECT bound evicts stale seen-only before handled, then oldest decisions, protecting the write', async () => {
  expect(HANDLED_STORE_MAX_ENTRIES).toBe(2000);
  store = new HandledStore({ now: () => now, maxEntries: 2 });
  const oldest = { ...ref, id: 'oldest' };
  const seen = { ...ref, id: 'seen' };
  const newer = { ...ref, id: 'newer' };
  await store.markHandled(oldest, 'approved');
  now++;
  await store.noteSeen(seen);
  now += SEEN_ONLY_TTL_MS + 1;
  await store.markHandled(newer, 'rejected');
  expect(store.firstSeen(seen)).toBeNull();
  expect(store.isHandled(oldest)).toBe(true);
  now++;
  await store.markHandled(ref, 'expired');
  expect(store.isHandled(oldest)).toBe(false);
  expect(store.isHandled(newer)).toBe(true);
  expect((await read()).e).toHaveLength(2);
  // A backwards clock must not evict the entry being written.
  now = 1;
  const written = { ...ref, id: 'clock-backwards' };
  await store.markHandled(written, 'failed');
  expect(store.isHandled(written)).toBe(true);
  expect(store.isHandled(newer)).toBe(false);
});

it.each([
  'not JSON private-topic-for-persistence-test',
  JSON.stringify({ v: 2, e: [] }),
  JSON.stringify({ v: 1, e: {} }),
  JSON.stringify({ v: 1, e: [{ s: 1 }] }),
  JSON.stringify({ v: 1, e: [{ h: 'hash' }] }),
])(
  'REGRESSION corrupt storage starts empty and removes the key (%#)',
  async (raw) => {
    await AsyncStorage.setItem(KEY, raw);
    await store.load();
    expect(store.isHandled(ref)).toBe(false);
    expect(await AsyncStorage.getItem(KEY)).toBeNull();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith(KEY);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(jest.mocked(console.warn).mock.calls)).not.toContain(
      ref.topic
    );
  }
);

it('REGRESSION invalid decision fields are dropped individually among good entries', async () => {
  await AsyncStorage.setItem(
    KEY,
    JSON.stringify({
      v: 1,
      e: [
        { h: hash(ref), s: now, d: now, o: 'approved' },
        { h: hash({ ...ref, id: 'bad-d' }), s: now, d: 'bad' },
        { h: hash({ ...ref, id: 'bad-o' }), s: now, o: 42 },
        { h: hash({ ...ref, id: 'bad-label' }), s: now, o: 'surprise' },
      ],
    })
  );
  await store.load();
  expect(store.isHandled(ref)).toBe(true);
  for (const id of ['bad-d', 'bad-o', 'bad-label']) {
    expect(store.firstSeen({ ...ref, id })).toBeNull();
  }
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
});

it('DEFECT a failed write rolls memory and pruning back, rejects, and can be retried', async () => {
  store = new HandledStore({ now: () => now, maxEntries: 1 });
  const existing = { ...ref, id: 'existing' };
  await store.markHandled(existing, 'approved');
  jest
    .mocked(AsyncStorage.setItem)
    .mockRejectedValueOnce(new Error('write failed'));
  await expect(store.markHandled(ref, 'failed')).rejects.toThrow(
    'write failed'
  );
  expect(store.isHandled(ref)).toBe(false);
  expect(store.isHandled(existing)).toBe(true);
  expect(await store.markHandled(ref, 'rejected')).toBe(true);
  jest
    .mocked(AsyncStorage.setItem)
    .mockRejectedValueOnce(new Error('seen failed'));
  await expect(store.noteSeen(existing)).rejects.toThrow('seen failed');
  expect(store.firstSeen(existing)).toBeNull();
});

it('REGRESSION concurrent mutations serialize and preserve every entry', async () => {
  await Promise.all(
    Array.from({ length: 20 }, (_, id) =>
      id % 2
        ? store.noteSeen({ ...ref, id })
        : store.markHandled({ ...ref, id }, 'approved')
    )
  );
  expect((await read()).e).toHaveLength(20);
  expect(AsyncStorage.setItem).toHaveBeenCalledTimes(20);
  const results = await Promise.all([
    store.markHandled(ref, 'approved'),
    store.markHandled(ref, 'failed'),
    store.noteSeen(ref),
  ]);
  expect(results).toEqual([true, false, now]);
});

it('REGRESSION load is shared and reads require a completed load', async () => {
  expect(() => store.isHandled(ref)).toThrow('HandledStore not loaded');
  expect(() => store.firstSeen(ref)).toThrow('HandledStore not loaded');
  await Promise.all([store.load(), store.load(), store.load()]);
  await store.load();
  expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
  expect(store.firstSeen(ref)).toBeNull();
});

it('DEFECT mutations resolve only after persistence and a failed load can retry', async () => {
  jest
    .mocked(AsyncStorage.getItem)
    .mockRejectedValueOnce(new Error('read failed'));
  await expect(store.load()).rejects.toThrow('read failed');
  await store.load();
  let complete: (() => void) | undefined;
  jest.mocked(AsyncStorage.setItem).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      })
  );
  let resolved = false;
  const pending = store.markHandled(ref, 'approved').then(() => {
    resolved = true;
  });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(resolved).toBe(false);
  expect(complete).toBeDefined();
  complete?.();
  await pending;
  expect(resolved).toBe(true);
});
