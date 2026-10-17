/**
 * Layer-1 tests for the cold-start route delivery seam (DR-10 / TASK-381).
 *
 * Readiness is injected: `ready` is a flag and `signal()` fires every
 * subscribed onReady callback, mirroring the NavigationContainer 'ready'
 * event the deep-link service wires it to.
 */

import { createPendingRouteQueue, PendingRouteDeps } from '../pendingRoute';

const makeHarness = (overrides: Partial<PendingRouteDeps> = {}) => {
  let ready = false;
  const listeners = new Set<() => void>();
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const queue = createPendingRouteQueue({
    isReady: () => ready,
    onReady: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    logger,
    ...overrides,
  });
  return {
    queue,
    logger,
    listeners,
    setReady: (value: boolean) => {
      ready = value;
    },
    signal: () => Array.from(listeners).forEach((cb) => cb()),
  };
};

/** Flush pending microtasks (promise chains inside the queue). */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('pendingRoute', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs immediately when navigation is already ready', async () => {
    const h = makeHarness();
    h.setReady(true);
    const run = jest.fn();

    await h.queue.deliver('url:voi://a', run);

    expect(run).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });

  it('queues until readiness arrives later than the old 100 ms window, then runs', async () => {
    const h = makeHarness();
    const run = jest.fn();

    const delivered = h.queue.deliver('url:voi://a', run);
    jest.advanceTimersByTime(100);
    await flush();
    // The old code gave up here and dropped the route.
    expect(run).not.toHaveBeenCalled();

    jest.advanceTimersByTime(400);
    h.setReady(true);
    h.signal();
    await delivered;

    expect(run).toHaveBeenCalledTimes(1);
    // Listener released once delivered.
    expect(h.listeners.size).toBe(0);
  });

  it('when readiness never comes it logs after the timeout, keeps the route queued, and still runs it when readiness finally comes', async () => {
    const h = makeHarness({ readyTimeoutMs: 1_000 });
    const run = jest.fn();

    const delivered = h.queue.deliver('url:voi://a', run);
    jest.advanceTimersByTime(1_000);
    await flush();

    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('still not ready')
    );
    expect(run).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60_000);
    h.setReady(true);
    h.signal();
    await delivered;

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('recovers a missed readiness signal at the timeout', async () => {
    const h = makeHarness({ readyTimeoutMs: 1_000 });
    const run = jest.fn();

    const delivered = h.queue.deliver('url:voi://a', run);
    h.setReady(true); // ready, but no signal fired
    jest.advanceTimersByTime(1_000);
    await delivered;

    expect(run).toHaveBeenCalledTimes(1);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it('ignores spurious signals while not ready', async () => {
    const h = makeHarness();
    const run = jest.fn();

    void h.queue.deliver('url:voi://a', run);
    h.signal();
    await flush();
    expect(run).not.toHaveBeenCalled();
  });

  it('dedupes by key: a queued key, then the same key again, runs once', async () => {
    const h = makeHarness();
    const run1 = jest.fn();
    const run2 = jest.fn();

    // getInitialURL and the first 'url' event for the same cold-start URL.
    const a = h.queue.deliver('url:voi://same', run1);
    const b = h.queue.deliver('url:voi://same', run2);
    h.setReady(true);
    h.signal();
    await Promise.all([a, b]);

    expect(run1).toHaveBeenCalledTimes(1);
    expect(run2).not.toHaveBeenCalled();
  });

  it('dedupes a repeat that arrives just after the first completed, but not after the dedupe window', async () => {
    let clock = 0;
    const h = makeHarness({ dedupeWindowMs: 5_000, now: () => clock });
    h.setReady(true);
    const run = jest.fn();

    await h.queue.deliver('url:voi://same', run);
    clock = 4_000;
    await h.queue.deliver('url:voi://same', run);
    expect(run).toHaveBeenCalledTimes(1);

    clock = 9_001;
    await h.queue.deliver('url:voi://same', run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe different keys', async () => {
    const h = makeHarness();
    h.setReady(true);
    const run = jest.fn();

    await h.queue.deliver('url:voi://a', run);
    await h.queue.deliver('url:voi://b', run);

    expect(run).toHaveBeenCalledTimes(2);
  });

  it('runs in arrival order and awaits each run: the second waits for the first', async () => {
    const h = makeHarness();
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = h.queue.deliver('k1', async () => {
      events.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push('first:end');
    });
    const second = h.queue.deliver('k2', async () => {
      events.push('second:start');
    });

    h.setReady(true);
    h.signal();
    await flush();
    expect(events).toEqual(['first:start']);

    // A delivery arriving mid-flush goes to the back of the queue.
    const third = h.queue.deliver('k3', () => {
      events.push('third');
    });
    await flush();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await Promise.all([first, second, third]);
    expect(events).toEqual([
      'first:start',
      'first:end',
      'second:start',
      'third',
    ]);
  });

  it('a throwing run is logged and does not block later runs', async () => {
    const h = makeHarness();
    h.setReady(true);
    const after = jest.fn();

    await expect(
      h.queue.deliver('k1', async () => {
        throw new Error('boom');
      })
    ).resolves.toBeUndefined();
    await h.queue.deliver('k2', after);

    expect(h.logger.error).toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('pauses again if readiness is lost mid-queue and resumes on the next signal', async () => {
    const h = makeHarness();
    const events: string[] = [];
    h.setReady(true);

    await h.queue.deliver('k1', () => {
      events.push('k1');
    });
    h.setReady(false);
    const second = h.queue.deliver('k2', () => {
      events.push('k2');
    });
    await flush();
    expect(events).toEqual(['k1']);

    h.setReady(true);
    h.signal();
    await second;
    expect(events).toEqual(['k1', 'k2']);
  });

  it('whenReady resolves once readiness arrives, even after the log timeout', async () => {
    const h = makeHarness({ readyTimeoutMs: 1_000 });
    const resolved = jest.fn();
    void h.queue.whenReady().then(resolved);

    jest.advanceTimersByTime(5_000);
    await flush();
    expect(resolved).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();

    h.setReady(true);
    h.signal();
    await flush();
    expect(resolved).toHaveBeenCalledTimes(1);
    expect(h.listeners.size).toBe(0);
  });

  it('a run that awaits whenReady() from inside the queue does not deadlock', async () => {
    const h = makeHarness();
    h.setReady(true);
    const navigated = jest.fn();

    await h.queue.deliver('k1', async () => {
      await h.queue.whenReady();
      navigated();
    });

    expect(navigated).toHaveBeenCalledTimes(1);
  });

  it('never logs the key (keys can carry WalletConnect symKeys)', async () => {
    const secret = 'wc:abc@2?relay-protocol=irn&symKey=SECRETSYMKEY';
    const h = makeHarness({ readyTimeoutMs: 10 });
    void h.queue.deliver(`url:${secret}`, jest.fn());
    void h.queue.deliver(`url:${secret}`, jest.fn());
    jest.advanceTimersByTime(10);

    const logged = JSON.stringify([
      h.logger.log.mock.calls,
      h.logger.warn.mock.calls,
      h.logger.error.mock.calls,
    ]);
    expect(logged).not.toContain('SECRETSYMKEY');
  });
});
