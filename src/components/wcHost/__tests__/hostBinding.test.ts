import { RequestQueue } from '@/services/walletconnect/requestQueue';
import type { QueueCoordinator } from '@/services/walletconnect/requestQueue';
import type { ExitReason } from '@/services/walletconnect/requestCoordinator';
import { getHeadSession } from '../headSession';
import { createHostBinding } from '../hostBinding';
import type { ReviewBinding } from '@/services/walletconnect/reviewBinding';

jest.mock('@/services/walletconnect/signRequestController', () => ({
  SignRequestController: jest.fn(),
}));
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

function setup() {
  const listeners = new Set<(info: { reason: ExitReason }) => void>();
  const coordinator: QueueCoordinator = {
    isOpen: () => true,
    subscribe: (_ref, listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const describeClose = jest.fn((reason: ExitReason) => ({ title: reason }));
  const queue = new RequestQueue({ coordinator, describeClose });
  queue.push({
    ref: { version: 2, kind: 'proposal', topic: 'fixture', id: 1 },
    payload: {},
    firstSeenMs: 0,
  });
  const session = getHeadSession(queue.getSnapshot().head!, {
    queue,
    coordinator,
  });
  const binding = createHostBinding(session, { queue });
  return { queue, coordinator, session, binding, describeClose, listeners };
}

it('DEFECT binding identity survives reacquisition and body remount', () => {
  const h = setup();
  expect(getHeadSession(h.session.item, h)).toBe(h.session);
  expect(createHostBinding(h.session, h)).toBe(h.binding);
  h.queue.__resetForTests();
});
it.each(['goBack', 'popOrReplace'] as const)(
  'DEFECT %s closes only its own head and ends once',
  (method) => {
    const h = setup();
    const leave = jest.fn();
    h.binding.onLeave(leave);
    expect(h.binding.nav.canGoBack()).toBe(true);
    // Main/params are ignored: approval reveals the app beneath the host.
    // behaviour question for product at cutover.
    expect(h.binding.nav[method]('Main', { screen: 'Home' })).toBe(true);
    expect(h.describeClose).toHaveBeenCalledWith('abandoned');
    expect(h.queue.getSnapshot().result?.title).toBe('abandoned');
    expect(leave).toHaveBeenCalledTimes(1);
    expect(h.binding.nav[method]('Main')).toBe(false);
    expect(h.binding.nav.canGoBack()).toBe(false);
    h.session.end();
    expect(leave).toHaveBeenCalledTimes(1);
  }
);
it('DEFECT last coordinator reason is scoped to the session', () => {
  const h = setup();
  // Notify the session directly; the queue subscriber ordinarily closes first.
  [...h.listeners].at(-1)!({ reason: 'background' });
  h.binding.nav.goBack();
  expect(h.describeClose).toHaveBeenLastCalledWith('background');
});
it('DEFECT replace refuses without changing the queue', () => {
  const h = setup();
  const snapshot = h.queue.getSnapshot();
  expect(h.binding.nav.replace('Main')).toBe(false);
  expect(h.queue.getSnapshot()).toBe(snapshot);
  h.queue.__resetForTests();
});
it.each([
  'nav.navigate',
  'navigation.canGoBack',
  'navigation.goBack',
  'navigation.navigate',
] as const)('DEFECT %s refuses with a fixed error', (method) => {
  const h = setup();
  const action =
    method === 'nav.navigate'
      ? h.binding.nav.navigate
      : h.binding.navigation[
          method.slice(
            'navigation.'.length
          ) as keyof ReviewBinding['navigation']
        ];
  expect(() => action()).toThrow('WalletConnect host cannot navigate');
  h.queue.__resetForTests();
});
it('DEFECT onLeave supports unsubscribe, discards listeners and ignores late registration', () => {
  const h = setup();
  const removed = jest.fn();
  const live = jest.fn();
  const late = jest.fn();
  h.binding.onLeave(removed)();
  h.binding.onLeave(live);
  h.session.end();
  h.binding.onLeave(late);
  h.session.end();
  expect(removed).not.toHaveBeenCalled();
  expect(live).toHaveBeenCalledTimes(1);
  expect(late).not.toHaveBeenCalled();
  h.queue.__resetForTests();
});
it.each(['finish', 'close', 'reset'] as const)(
  'DEFECT queue %s ends the session once even with no host mounted',
  async (event) => {
    const h = setup();
    const leave = jest.fn();
    h.binding.onLeave(leave);
    if (event === 'finish')
      h.queue.finish(h.session.item.ref, { title: 'done' });
    else if (event === 'reset') h.queue.__resetForTests();
    else
      for (const listener of [...h.listeners]) listener({ reason: 'expired' });
    // A queue-driven end waits one microtask so the review's own coordinator
    // listener marks its request decided first.
    expect(leave).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(leave).toHaveBeenCalledTimes(1);
    h.session.end();
    expect(leave).toHaveBeenCalledTimes(1);
  }
);
