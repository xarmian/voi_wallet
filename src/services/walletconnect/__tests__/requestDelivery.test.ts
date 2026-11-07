/**
 * TransactionRequestQueue delivery states (TASK-257): claim / markDisplayed /
 * releaseClaim / forgetDelivery, and the atomic takeNext the startup drain
 * and the signing screen's "next request" step use. Real queue over the
 * AsyncStorage jest mock. The payloads are opaque placeholders; no key or
 * signature material.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  QueuedTransactionRequest,
  TransactionRequestQueue,
} from '../TransactionRequestQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const enqueue = (id: number, topic = 'topic-q') =>
  TransactionRequestQueue.enqueue({
    id,
    topic,
    params: { request: { method: 'algo_signTxn', params: [] }, chainId: 1 },
  });

const ids = async () =>
  (await TransactionRequestQueue.getAll()).map((r) => r.id);

/** As the screen does: take the next undisplayed request and show it. */
const showNext = async (
  show: (r: QueuedTransactionRequest) => void = () => {}
) => {
  const { request } = await TransactionRequestQueue.takeNext(show);
  return request?.id ?? null;
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('claim lifecycle', () => {
  it('a claim blocks repeats until released; release never undoes displayed', () => {
    expect(TransactionRequestQueue.claim(1, 't')).toBe(true);
    expect(TransactionRequestQueue.claim(1, 't')).toBe(false);
    TransactionRequestQueue.releaseClaim(1, 't');
    expect(TransactionRequestQueue.claim(1, 't')).toBe(true);

    expect(TransactionRequestQueue.markDisplayed(1, 't')).toBe(true);
    TransactionRequestQueue.releaseClaim(1, 't');
    expect(TransactionRequestQueue.claim(1, 't')).toBe(false);
    expect(TransactionRequestQueue.markDisplayed(1, 't')).toBe(false);
  });

  it('forgetDelivery clears a displayed request so a redelivery surfaces', () => {
    TransactionRequestQueue.claim(4, 't');
    TransactionRequestQueue.markDisplayed(4, 't');
    TransactionRequestQueue.forgetDelivery(4, 't');
    expect(TransactionRequestQueue.claim(4, 't')).toBe(true);
  });

  it('a queued request that goes stale releases its claim', async () => {
    const realNow = Date.now();
    TransactionRequestQueue.claim(2, 'topic-q');
    await enqueue(2);
    jest.spyOn(Date, 'now').mockReturnValue(realNow + 10 * 60_000);

    expect(await ids()).toEqual([]);
    expect(TransactionRequestQueue.claim(2, 'topic-q')).toBe(true);
  });

  it("dropping a dead session's queued requests releases their claims", async () => {
    TransactionRequestQueue.claim(3, 'topic-dead');
    await enqueue(3, 'topic-dead');

    expect(await TransactionRequestQueue.removeByTopic('topic-dead')).toBe(1);
    expect(TransactionRequestQueue.claim(3, 'topic-dead')).toBe(true);
  });

  it('eviction never forgets a request that is queued but not yet shown', () => {
    TransactionRequestQueue.claim('queued-early', 'topic-evict');
    for (let i = 0; i < 6000; i++) {
      TransactionRequestQueue.markDisplayed(i, 'topic-evict');
    }
    expect(TransactionRequestQueue.claim('queued-early', 'topic-evict')).toBe(
      false
    );
  });
});

describe('takeNext', () => {
  it('drops only already-displayed requests; a queued (claimed) one is shown', async () => {
    // 101 displayed this session; 102 claimed and queued; 103 from a prior
    // session (untracked).
    TransactionRequestQueue.markDisplayed(101, 'topic-q');
    TransactionRequestQueue.claim(102, 'topic-q');
    await enqueue(101);
    await enqueue(102);
    await enqueue(103);

    expect(await showNext()).toBe(102);
    expect(await ids()).toEqual([103]);
    // Showing it marked it displayed.
    expect(TransactionRequestQueue.markDisplayed(102, 'topic-q')).toBe(false);

    expect(await showNext()).toBe(103);
    expect(await showNext()).toBeNull();
  });

  it('a show that throws leaves the request queued, back to claimed', async () => {
    TransactionRequestQueue.claim(301, 'topic-q');
    await enqueue(301);

    await expect(
      showNext(() => {
        throw new Error('replace failed');
      })
    ).rejects.toThrow('replace failed');
    expect(await ids()).toEqual([301]);
    // Back to 'claimed' (queued, not shown): a redelivery is still dropped,
    // and it was not left marked displayed.
    expect(TransactionRequestQueue.claim(301, 'topic-q')).toBe(false);
    expect(TransactionRequestQueue.markDisplayed(301, 'topic-q')).toBe(true);
    TransactionRequestQueue.releaseClaim(301, 'topic-q');
    TransactionRequestQueue.forgetDelivery(301, 'topic-q');

    expect(await showNext()).toBe(301);
    expect(await ids()).toEqual([]);
  });

  it('two concurrent takers show a queued request exactly once (FL-353)', async () => {
    await enqueue(401);
    const show = jest.fn();
    // The startup drain and a screen completion racing; each yields between
    // finding the request and showing it, as the screen does (it awaited
    // size() between peekUndisplayed and showQueued before TASK-257b).
    const taker = async () => {
      await Promise.resolve();
      return TransactionRequestQueue.takeNext(show);
    };
    const results = await Promise.all([taker(), taker()]);

    expect(show).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.request?.id ?? null).sort()).toEqual([
      401,
      null,
    ]);
    expect(await ids()).toEqual([]);
  });

  it('reports what remains queued after the one it showed', async () => {
    await enqueue(501);
    await enqueue(502);
    const result = await TransactionRequestQueue.takeNext(() => {});
    expect(result.request?.id).toBe(501);
    expect(result.remaining).toBe(1);
  });
});
