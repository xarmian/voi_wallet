// Tests for TransactionRequestQueue.removeByTopic (PLAN-260, TASK-258, DR-14).
//
// When a v1 session is dropped as unrestorable, any queued transaction request
// for that topic must go with it. Otherwise startup dequeues the request
// unconditionally, it lands on a screen with no approved live session, errors —
// and is lost, because dequeuing already removed it.

const mockKv = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    setItem: async (k: string, v: string) => {
      mockKv.set(k, v);
    },
    getItem: async (k: string) => (mockKv.has(k) ? mockKv.get(k)! : null),
    removeItem: async (k: string) => {
      mockKv.delete(k);
    },
    getAllKeys: async () => [...mockKv.keys()],
    multiRemove: async (keys: string[]) => {
      keys.forEach((k) => mockKv.delete(k));
    },
  },
}));

import { TransactionRequestQueue } from '../TransactionRequestQueue';

const enqueue = (id: number, topic: string, version: 1 | 2 = 1) =>
  TransactionRequestQueue.enqueue({
    id,
    topic,
    params: {
      request: { method: 'algo_signTxn', params: [[]] },
      chainId: 416001,
    },
    version,
  });

beforeEach(async () => {
  mockKv.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('removeByTopic', () => {
  it('drops every request for the dead topic and reports the count', async () => {
    await enqueue(1, 'dead-topic');
    await enqueue(2, 'dead-topic');
    await enqueue(3, 'live-topic');

    const removed = await TransactionRequestQueue.removeByTopic('dead-topic');

    expect(removed).toBe(2);
    const remaining = await TransactionRequestQueue.getAll();
    expect(remaining.map((r) => r.topic)).toEqual(['live-topic']);
  });

  it('leaves other topics — including v2 — untouched', async () => {
    await enqueue(1, 'v1-topic', 1);
    await enqueue(2, 'v2-topic', 2);

    await TransactionRequestQueue.removeByTopic('v1-topic');

    const remaining = await TransactionRequestQueue.getAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].version).toBe(2);
  });

  it('is a no-op when nothing matches', async () => {
    await enqueue(1, 'live-topic');
    const removed = await TransactionRequestQueue.removeByTopic('absent');

    expect(removed).toBe(0);
    expect(await TransactionRequestQueue.getAll()).toHaveLength(1);
  });

  it('is a no-op on an empty queue', async () => {
    expect(await TransactionRequestQueue.removeByTopic('anything')).toBe(0);
  });
});
