import { redactError } from '@/utils/logRedaction';
import { RequestCoordinator } from '../requestCoordinator';
import type { ExitReason, RequestRef } from '../requestCoordinator';
import { RequestQueue } from '../requestQueue';
import type {
  QueueCoordinator,
  QueueItem,
  QueueSnapshot,
} from '../requestQueue';

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

const keyOf = (ref: RequestRef): string =>
  JSON.stringify([ref.version, ref.kind, ref.topic, String(ref.id)]);
type CloseListener = (info: { reason: ExitReason }) => void;

class FakeCoordinator implements QueueCoordinator {
  open = new Set<string>();
  listeners = new Map<string, Set<CloseListener>>();
  recorded = new Map<string, CloseListener>();
  unsubscribed = new Map<string, number>();

  admit(ref: RequestRef): void {
    this.open.add(keyOf(ref));
  }

  isOpen(ref: RequestRef): boolean {
    return this.open.has(keyOf(ref));
  }

  subscribe(ref: RequestRef, listener: CloseListener): () => void {
    const key = keyOf(ref);
    const listeners = this.listeners.get(key) ?? new Set<CloseListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    this.recorded.set(key, listener);
    return () => {
      listeners.delete(listener);
      this.unsubscribed.set(key, (this.unsubscribed.get(key) ?? 0) + 1);
    };
  }

  close(ref: RequestRef, reason: ExitReason = 'expired'): void {
    this.open.delete(keyOf(ref));
    for (const listener of this.listeners.get(keyOf(ref)) ?? []) {
      listener({ reason });
    }
  }
}

const refFor = (
  id: number,
  kind: RequestRef['kind'] = 'request'
): RequestRef => ({
  version: 2,
  kind,
  topic: 'test-topic',
  id,
});
const itemFor = (ref: RequestRef): Omit<QueueItem, 'arrivalSeq' | 'kind'> => ({
  ref,
  payload: { opaque: true },
  firstSeenMs: 1_800_000_000_000,
});
const result = { title: 'Request ended' };
const assertInvariants = (snapshot: QueueSnapshot): void => {
  expect(snapshot.head !== null && snapshot.result !== null).toBe(false);
  expect(
    snapshot.head === null &&
      snapshot.result === null &&
      snapshot.waiting.length > 0
  ).toBe(false);
};

let coordinator: FakeCoordinator;
let queue: RequestQueue;
const push = (ref: RequestRef) => {
  coordinator.admit(ref);
  return queue.push(itemFor(ref));
};

beforeEach(() => {
  coordinator = new FakeCoordinator();
  queue = new RequestQueue({ coordinator });
});

afterEach(() => {
  jest.restoreAllMocks();
});

it('keeps a mixed proposal/request/proposal list in arrival order', () => {
  const refs = [refFor(30, 'proposal'), refFor(10), refFor(20, 'proposal')];
  expect(refs.map(push)).toEqual(['head', 'queued', 'queued']);
  const snapshot = queue.getSnapshot();
  expect([snapshot.head, ...snapshot.waiting]).toEqual(
    refs.map((ref, index) => ({
      ...itemFor(ref),
      kind: ref.kind,
      arrivalSeq: index + 1,
    }))
  );
  for (const ref of refs) {
    expect(queue.getSnapshot().head?.ref).toEqual(ref);
    expect(queue.finish(ref, result)).toBe(true);
    assertInvariants(queue.getSnapshot());
    if (queue.getSnapshot().waiting.length) expect(queue.advance()).toBe(true);
  }
});

it('REGRESSION two pushes in the same tick cannot both become head', () => {
  const statuses = [push(refFor(1)), push(refFor(2))];
  expect(statuses.filter((status) => status === 'head')).toHaveLength(1);
  expect(queue.getSnapshot().head?.ref).toEqual(refFor(1));
  expect(queue.getSnapshot().waiting.map((item) => item.ref)).toEqual([
    refFor(2),
  ]);
  assertInvariants(queue.getSnapshot());
});

it('deduplicates head and waiting refs with numeric/string ids without replacing them', () => {
  const head = refFor(5);
  const waiting = refFor(6);
  push(head);
  push(waiting);
  const snapshot = queue.getSnapshot();
  const listener = jest.fn();
  queue.subscribe(listener);
  for (const ref of [head, waiting]) {
    expect(
      queue.push({ ...itemFor({ ...ref, id: String(ref.id) }), payload: null })
    ).toBe('duplicate');
  }
  expect(queue.getSnapshot()).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  expect(coordinator.listeners.get(keyOf(head))?.size).toBe(1);
  expect(coordinator.listeners.get(keyOf(waiting))?.size).toBe(1);
  push(refFor(7));
  expect(queue.getSnapshot().waiting[1].arrivalSeq).toBe(3);
});

it('distinguishes version, kind and topic for the same id', () => {
  const ref = refFor(5);
  const refs: RequestRef[] = [
    ref,
    { ...ref, version: 1 },
    { ...ref, kind: 'proposal' },
    { ...ref, topic: 'other-topic' },
  ];
  expect(refs.map(push)).toEqual(['head', 'queued', 'queued', 'queued']);
  expect(queue.getSnapshot().waiting.map((item) => item.ref)).toEqual(
    refs.slice(1)
  );
});

it('refuses a ref that is not open before considering duplicates', () => {
  const snapshot = queue.getSnapshot();
  const listener = jest.fn();
  queue.subscribe(listener);
  expect(queue.push(itemFor(refFor(1)))).toBe('not-open');
  expect(queue.getSnapshot()).toBe(snapshot);
  expect(coordinator.recorded.size).toBe(0);
  push(refFor(1));
  coordinator.open.clear();
  const admitted = queue.getSnapshot();
  listener.mockClear();
  expect(queue.push(itemFor(refFor(1)))).toBe('not-open');
  expect(queue.getSnapshot()).toBe(admitted);
  expect(listener).not.toHaveBeenCalled();
});

it('finishes only the current head and ignores waiting, unknown and repeated finishes', () => {
  const head = refFor(1);
  const waiting = refFor(2);
  push(head);
  push(waiting);
  const listener = jest.fn();
  queue.subscribe(listener);
  const before = queue.getSnapshot();
  expect(queue.finish(waiting, result)).toBe(false);
  expect(queue.finish(refFor(99), result)).toBe(false);
  expect(queue.getSnapshot()).toBe(before);
  expect(listener).not.toHaveBeenCalled();
  expect(queue.finish({ ...head, id: '1' }, result)).toBe(true);
  const finished = queue.getSnapshot();
  expect(finished.head).toBeNull();
  expect(finished.result).toEqual({ ref: head, ...result });
  expect(listener).toHaveBeenCalledTimes(1);
  listener.mockClear();
  expect(queue.finish(head, { title: 'Sign transactions' })).toBe(false);
  expect(queue.getSnapshot()).toBe(finished);
  expect(listener).not.toHaveBeenCalled();
});

it('REGRESSION keeps the result visible with a successor until Next request', () => {
  const first = refFor(1);
  const next = refFor(2);
  push(first);
  push(next);
  queue.finish(first, result);
  const finished = queue.getSnapshot();
  expect(finished.result).toEqual({ ref: first, ...result });
  expect(finished.head).toBeNull();
  expect(finished.waiting[0].ref).toEqual(next);
  expect(push(refFor(3, 'proposal'))).toBe('queued');
  expect(queue.getSnapshot().result).toBe(finished.result);
  expect(queue.advance()).toBe(true);
  expect(queue.getSnapshot().head?.ref).toEqual(next);
  expect(queue.getSnapshot().result).toBeNull();
  // TASK-525: a stale view cannot finish its replacement.
  const advanced = queue.getSnapshot();
  expect(queue.finish(first, result)).toBe(false);
  expect(queue.getSnapshot()).toBe(advanced);
});

it('TASK-525 OS back cannot dismiss a result or advance while a request waits', () => {
  push(refFor(1));
  push(refFor(2));
  queue.finish(refFor(1), result);
  const snapshot = queue.getSnapshot();
  const listener = jest.fn();
  queue.subscribe(listener);
  expect(queue.dismissResult()).toBe(false);
  expect(queue.getSnapshot()).toBe(snapshot);
  expect(listener).not.toHaveBeenCalled();
  queue.advance();
  queue.finish(refFor(2), result);
  listener.mockClear();
  expect(queue.dismissResult()).toBe(true);
  expect(queue.getSnapshot()).toMatchObject({
    head: null,
    result: null,
    waiting: [],
  });
  expect(listener).toHaveBeenCalledTimes(1);
});

it('refuses advance without a result or without a successor, and dismiss without a result', () => {
  const listener = jest.fn();
  queue.subscribe(listener);
  const checkRefused = () => {
    const snapshot = queue.getSnapshot();
    listener.mockClear();
    expect(queue.advance()).toBe(false);
    if (!snapshot.result) expect(queue.dismissResult()).toBe(false);
    expect(queue.getSnapshot()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
  };
  checkRefused();
  push(refFor(1));
  checkRefused();
  queue.finish(refFor(1), result);
  checkRefused();
  queue.dismissResult();
  push(refFor(2));
  push(refFor(3));
  checkRefused();
});

it('removes closed waiting refs silently, preserving a pending result even for the last waiter', () => {
  push(refFor(1));
  push(refFor(2));
  push(refFor(3));
  coordinator.close(refFor(2));
  expect(queue.getSnapshot().head?.ref).toEqual(refFor(1));
  expect(queue.getSnapshot().result).toBeNull();
  queue.finish(refFor(1), result);
  const pending = queue.getSnapshot().result;
  coordinator.close(refFor(3));
  expect(queue.getSnapshot().waiting).toEqual([]);
  expect(queue.getSnapshot().result).toBe(pending);
  expect(queue.dismissResult()).toBe(true);
});

it('finishes a closed head with the supplied close description', () => {
  const describeClose = jest.fn(() => ({
    title: 'Request ended',
    message: 'Connect',
  }));
  queue = new RequestQueue({ coordinator, describeClose });
  push(refFor(1));
  coordinator.close(refFor(1), 'session-ended');
  expect(describeClose).toHaveBeenCalledWith('session-ended', 'request');
  expect(queue.getSnapshot().result).toEqual({
    ref: refFor(1),
    title: 'Request ended',
    message: 'Connect',
  });
  expect(queue.getSnapshot().head).toBeNull();
});

it('DEFECT closeHead delegates to finish with the queue close description', () => {
  const description = { title: 'Request ended', message: 'Connect' };
  const describeClose = jest.fn(() => description);
  queue = new RequestQueue({ coordinator, describeClose });
  const head = refFor(1);
  const waiting = refFor(2);
  push(head);
  push(waiting);
  const finish = jest.spyOn(queue, 'finish');
  const before = queue.getSnapshot();
  expect(queue.closeHead(waiting, 'expired')).toBe(false);
  expect(queue.getSnapshot()).toBe(before);
  expect(queue.closeHead(head, 'abandoned')).toBe(true);
  expect(describeClose.mock.calls).toEqual([
    ['expired', 'request'],
    ['abandoned', 'request'],
  ]);
  expect(finish.mock.calls).toEqual([
    [waiting, description],
    [head, description],
  ]);
  expect(queue.getSnapshot()).toMatchObject({
    head: null,
    result: { ref: head, ...description },
    waiting: [expect.objectContaining({ ref: waiting })],
  });
  const finished = queue.getSnapshot();
  expect(queue.closeHead(head, 'declined')).toBe(false);
  expect(queue.getSnapshot()).toBe(finished);
});

it('uses Request ended by default and the first finish wins over late callbacks', () => {
  push(refFor(1));
  const close = coordinator.recorded.get(keyOf(refFor(1)))!;
  coordinator.close(refFor(1));
  expect(queue.getSnapshot().result).toEqual({
    ref: refFor(1),
    title: 'Request ended',
  });
  const closed = queue.getSnapshot();
  expect(queue.finish(refFor(1), { title: 'Connect' })).toBe(false);
  close({ reason: 'declined' });
  expect(queue.getSnapshot()).toBe(closed);
  queue.dismissResult();
  push(refFor(2));
  const lateClose = coordinator.recorded.get(keyOf(refFor(2)))!;
  queue.finish(refFor(2), { title: 'Sign transactions' });
  const finished = queue.getSnapshot();
  coordinator.close(refFor(2));
  lateClose({ reason: 'expired' });
  close({ reason: 'expired' });
  expect(queue.getSnapshot()).toBe(finished);
});

it('publishes stable frozen snapshots and notifies once per mutation after updating state', () => {
  const initial = queue.getSnapshot();
  expect(queue.getSnapshot()).toBe(initial);
  expect(initial.revision).toBe(0);
  const observed: QueueSnapshot[] = [];
  const unsubscribe = queue.subscribe(() => observed.push(queue.getSnapshot()));
  push(refFor(1));
  push(refFor(2));
  queue.finish(refFor(1), result);
  queue.advance();
  queue.finish(refFor(2), result);
  queue.dismissResult();
  expect(observed.map((snapshot) => snapshot.revision)).toEqual([
    1, 2, 3, 4, 5, 6,
  ]);
  for (const snapshot of [initial, ...observed]) {
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.waiting)).toBe(true);
    assertInvariants(snapshot);
  }
  expect(initial).toMatchObject({ head: null, result: null, waiting: [] });
  expect(observed[0].head?.ref).toEqual(refFor(1));
  expect(observed[0].waiting).toEqual([]);
  unsubscribe();
  push(refFor(3));
  expect(observed).toHaveLength(6);
});

it('isolates throwing subscribers and logs only a fixed redacted warning', () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const secretError = 'private-topic private-id wc:private-pairing';
  queue.subscribe(() => {
    throw new Error(secretError);
  });
  const listener = jest.fn(() =>
    expect(queue.getSnapshot().head?.ref).toEqual(refFor(1))
  );
  queue.subscribe(listener);
  expect(() => push(refFor(1))).not.toThrow();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledWith(
    '[RequestQueue]',
    redactError(new Error('Request queue listener failed'))
  );
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secretError);
});

it('unsubscribes coordinator listeners on finish, removal and reset', () => {
  const refs = [refFor(1), refFor(2), refFor(3), refFor(4)];
  refs.forEach(push);
  queue.finish(refs[0], result);
  coordinator.close(refs[1]);
  const beforeReset = queue.getSnapshot();
  const observer = jest.fn();
  queue.subscribe(observer);
  queue.__resetForTests();
  expect(queue.getSnapshot()).toMatchObject({
    head: null,
    result: null,
    waiting: [],
    revision: beforeReset.revision + 1,
  });
  expect(observer).toHaveBeenCalledTimes(1);
  for (const ref of refs) {
    expect(coordinator.listeners.get(keyOf(ref))?.size).toBe(0);
    expect(coordinator.unsubscribed.get(keyOf(ref))).toBe(1);
  }
  const reset = queue.getSnapshot();
  refs.forEach((ref) =>
    coordinator.recorded.get(keyOf(ref))?.({ reason: 'expired' })
  );
  expect(queue.getSnapshot()).toBe(reset);
  push(refFor(5));
  expect(queue.getSnapshot().head?.arrivalSeq).toBe(1);
});

it('uses the default coordinator and exposes a stable singleton', () => {
  const getCoordinator = jest
    .spyOn(RequestCoordinator, 'getInstance')
    .mockReturnValue(coordinator as unknown as RequestCoordinator);
  const defaultQueue = new RequestQueue();
  coordinator.admit(refFor(1));
  expect(defaultQueue.push(itemFor(refFor(1)))).toBe('head');
  expect(getCoordinator).toHaveBeenCalled();
  expect(RequestQueue.getInstance()).toBe(RequestQueue.getInstance());
  defaultQueue.__resetForTests();
  RequestQueue.getInstance().__resetForTests();
});

it('preserves both invariants after 200 deterministic randomized operations', () => {
  let seed = 518;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const refs = Array.from({ length: 12 }, (_, index) =>
    refFor(index, index % 2 ? 'request' : 'proposal')
  );
  for (let index = 0; index < 200; index++) {
    const operation = random() % 9;
    const ref = refs[(random() >>> 8) % refs.length];
    switch (operation) {
      case 0:
      case 1:
        push(ref);
        break;
      case 2:
        queue.push(itemFor(ref));
        break;
      case 3:
        queue.finish(ref, result);
        break;
      case 4: {
        const head = queue.getSnapshot().head;
        if (head) queue.finish(head.ref, result);
        break;
      }
      case 5:
        queue.advance();
        break;
      case 6:
        queue.dismissResult();
        break;
      case 7:
        coordinator.close(ref);
        break;
      case 8:
        queue.__resetForTests();
        break;
    }
    assertInvariants(queue.getSnapshot());
  }
});

it.each(['matching', 'other', 'empty', 'head'] as const)(
  'DEFECT amendResult %s changes only matching current result',
  (state) => {
    const ref = refFor(1);
    if (state !== 'empty') push(ref);
    if (state === 'matching' || state === 'other') queue.finish(ref, result);
    const before = queue.getSnapshot();
    const listener = jest.fn();
    queue.subscribe(listener);
    const matches = state === 'matching';
    expect(
      queue.amendResult(state === 'other' ? refFor(2) : ref, {
        title: 'Connect',
        message: 'Sign transactions',
      })
    ).toBe(matches);
    if (matches) {
      const after = queue.getSnapshot();
      expect(after.result).toEqual({
        ref,
        title: 'Connect',
        message: 'Sign transactions',
      });
      expect(after.result).not.toBe(before.result);
      expect(Object.isFrozen(after.result)).toBe(true);
      expect(after.revision).toBe(before.revision + 1);
      expect(listener).toHaveBeenCalledTimes(1);
    } else {
      expect(queue.getSnapshot()).toBe(before);
      expect(listener).not.toHaveBeenCalled();
    }
  }
);

describe('result copy defaults (product ruling: by kind and reason)', () => {
  const proposalRef = refFor(9, 'proposal');
  it.each([
    ['request', 'declined', 'Transaction Request Rejected'],
    ['request', 'abandoned', 'Request ended'],
    ['request', 'expired', 'Request ended'],
    ['proposal', 'declined', 'Request ended'],
    ['proposal', 'abandoned', 'Request ended'],
  ] as const)('%s closed as %s reads %s', (kind, reason, title) => {
    queue = new RequestQueue({ coordinator });
    const ref = kind === 'request' ? refFor(1) : proposalRef;
    push(ref);
    expect(queue.closeHead(ref, reason)).toBe(true);
    expect(queue.getSnapshot().result?.title).toBe(title);
  });
  it.each([
    [
      'request',
      'Transaction Signed Successfully',
      'You can now return to the dApp.',
    ],
    ['proposal', 'Success', 'Successfully connected to dApp'],
  ] as const)('%s approved reads %s', (kind, title, message) => {
    queue = new RequestQueue({ coordinator });
    const ref = kind === 'request' ? refFor(1) : proposalRef;
    push(ref);
    expect(queue.finishApproved(ref)).toBe(true);
    expect(queue.getSnapshot().result).toMatchObject({ title, message });
  });
});
