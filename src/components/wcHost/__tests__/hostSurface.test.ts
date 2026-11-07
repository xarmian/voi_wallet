import { RequestQueue } from '@/services/walletconnect/requestQueue';
import { getHeadSession } from '../headSession';
import { createHostSurface } from '../hostSurface';
import type { SigningReviewParams } from '@/services/walletconnect/signRequestController';
jest.mock('@/services/walletconnect/signRequestController', () => ({
  SignRequestController: jest.fn(() => ({ dispose: jest.fn() })),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);
function setup() {
  const listeners = new Set<
    (info: {
      reason: import('@/services/walletconnect/requestCoordinator').ExitReason;
    }) => void
  >();
  let open = true;
  const coordinator = {
    isOpen: () => open,
    subscribe: (
      _ref: unknown,
      listener: (info: {
        reason: import('@/services/walletconnect/requestCoordinator').ExitReason;
      }) => void
    ) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const queue = new RequestQueue({
    coordinator,
    describeClose: (reason) => ({ title: reason }),
  });
  for (const id of [1, 2])
    queue.push({
      ref: { version: 2, kind: 'request', topic: 'fixture', id },
      payload: {},
      firstSeenMs: 0,
    });
  const session = getHeadSession(queue.getSnapshot().head!, {
    queue,
    coordinator,
  });
  return {
    queue,
    session,
    listeners,
    setOpen: (value: boolean) => {
      open = value;
    },
    surface: createHostSurface(session, queue),
  };
}
it('DEFECT presentReview stores exact params and notifies subscribers', () => {
  const h = setup();
  const listener = jest.fn();
  h.session.subscribe(listener);
  const params = {} as SigningReviewParams;
  h.surface.presentReview(params);
  expect(h.session.getReviewParams()).toBe(params);
  expect(listener).toHaveBeenCalledTimes(1);
  h.queue.__resetForTests();
});
it('DEFECT presentError uses controller copy and ends once', () => {
  const h = setup();
  const leave = jest.fn();
  h.session.binding.onLeave(leave);
  h.surface.presentError('controller error');
  expect(h.queue.getSnapshot().result).toMatchObject({
    title: 'controller error',
  });
  expect(leave).toHaveBeenCalledTimes(1);
  expect(h.session.controller?.dispose).toHaveBeenCalledTimes(1);
});
it.each([false, true])(
  'DEFECT adoptNavigation object=%s changes nothing',
  (provided) => {
    const h = setup();
    const snapshot = h.queue.getSnapshot();
    const binding = h.session.binding;
    h.surface.adoptNavigation(provided ? binding.nav : undefined);
    expect(h.queue.getSnapshot()).toBe(snapshot);
    expect(h.session.binding).toBe(binding);
    h.queue.__resetForTests();
  }
);
it('DEFECT leave retains the result card', () => {
  const h = setup();
  h.surface.presentError('controller error');
  const snapshot = h.queue.getSnapshot();
  h.surface.leave();
  expect(h.queue.getSnapshot()).toBe(snapshot);
});
it('DEFECT queueSize counts only waiting items', async () => {
  const h = setup();
  expect(await h.surface.queueSize()).toBe(1);
  h.queue.__resetForTests();
  expect(await h.surface.queueSize()).toBe(0);
});
it.each([
  [undefined, true, 'abandoned'],
  [undefined, false, 'Transaction Signed Successfully'],
  ['expired', true, 'expired'],
  ['expired', false, 'expired'],
] as const)(
  'DEFECT takeNext closes with reason %s (coordinator open %s) as %s, never advances or touches a grant',
  async (reason, open, title) => {
    const h = setup();
    h.setOpen(open);
    h.session.lastReason = reason;
    const advance = jest.spyOn(h.queue, 'advance');
    const leave = jest.fn();
    h.session.binding.onLeave(leave);
    expect(await h.surface.queueSize()).toBe(1);
    await expect(h.surface.takeNext()).resolves.toEqual({
      request: null,
      remaining: 1,
    });
    expect(h.queue.getSnapshot().result?.title).toBe(title);
    expect(h.queue.getSnapshot().waiting).toHaveLength(1);
    expect(advance).not.toHaveBeenCalled();
    expect(leave).toHaveBeenCalledTimes(1);
  }
);

it.each(['load-failed', 'sign-failed', 'lapsed'] as const)(
  'DEFECT synchronous coordinator close %s preserves controller error',
  (reason) => {
    const h = setup();
    for (const listener of [...h.listeners]) listener({ reason });
    h.surface.presentError('controller error');
    expect(h.queue.getSnapshot().result?.title).toBe('controller error');
  }
);
